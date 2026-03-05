import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import RAPIER3D from "@dimforge/rapier3d-compat";
import { PixelPerfectIsoView } from "@common/render";
import { bindPixelPerfectIsoViewInput } from "@common/input";
import type { EID } from "@common/gameplay";
import type { ExperimentModule } from "../runtime/types";

import {
  createPhysics3dResource,
  type Physics3dResource,
  type Physics3dConvexHullPart
} from "../settlement-builder-ecs/game-physics-3d";
import {
  rootPoseFromBodyPose,
  bodyTranslationFromRootPose,
  type PhysicsQuaternion
} from "../settlement-builder-ecs/prop-physics-math";
import {
  collisionGroups,
  PHYSICS_LAYER,
  PHYSICS_MASK,
  PHYSICS_MATERIAL_PRESETS
} from "../settlement-builder-ecs/physics-settings";

/* ------------------------------------------------------------------ */
/* Types                                                               */
/* ------------------------------------------------------------------ */

type ForgeV2PropMeta = {
  id: string;
  bbox: { width: number; height: number; depth: number };
  collider: ForgeV2Collider | null;
  physics: {
    mass: number;
    friction: number;
    restitution: number;
    linearDamping: number;
    angularDamping: number;
  };
};

type ForgeV2Collider =
  | { type: "compound-convex-hulls"; parts: Physics3dConvexHullPart[] }
  | { type: "box"; halfExtents: THREE.Vector3; centerOffset: THREE.Vector3 };

type PropInstance = {
  eid: EID;
  propId: string;
  visual: THREE.Group;
  localRootOffset: { x: number; y: number; z: number };
};

/* ------------------------------------------------------------------ */
/* Rapier init                                                         */
/* ------------------------------------------------------------------ */

let rapierReady: Promise<void> | null = null;
function initRapier(): Promise<void> {
  if (!rapierReady) rapierReady = RAPIER3D.init();
  return rapierReady;
}

/* ------------------------------------------------------------------ */
/* Forge-v2 meta parsing                                               */
/* ------------------------------------------------------------------ */

function parseForgeV2Meta(id: string, raw: Record<string, unknown>): ForgeV2PropMeta {
  const processing = raw.processing as Record<string, unknown> | undefined;
  const meshProc = processing?.mesh as Record<string, unknown> | undefined;
  const bboxRaw = meshProc?.bboxProcessed as Record<string, number> | undefined;
  const bbox = {
    width: bboxRaw?.width ?? 0,
    height: bboxRaw?.height ?? 0,
    depth: bboxRaw?.depth ?? 0
  };

  // Parse collider from the first available preset
  let collider: ForgeV2Collider | null = null;
  const collidersSection = raw.colliders as Record<string, unknown> | undefined;
  const presets = collidersSection?.presets as Array<Record<string, unknown>> | undefined;

  if (presets && presets.length > 0) {
    // Prefer presets with most hulls (usually "high-detail" or "balanced")
    const bestPreset = presets.reduce((best, p) => {
      const gen = p.generation as Record<string, unknown> | undefined;
      const count = (gen?.hullCount as number) ?? 0;
      const bestGen = best.generation as Record<string, unknown> | undefined;
      const bestCount = (bestGen?.hullCount as number) ?? 0;
      return count > bestCount ? p : best;
    }, presets[0]);

    const col = bestPreset.collider as Record<string, unknown> | undefined;
    if (col?.type === "compound-convex-hulls") {
      const params = col.params as Record<string, unknown> | undefined;
      const rawParts = params?.parts as Array<Record<string, unknown>> | undefined;
      if (rawParts && rawParts.length > 0) {
        const parts: Physics3dConvexHullPart[] = [];
        for (const part of rawParts) {
          const pos = part.position as [number, number, number];
          const points = part.points as Array<[number, number, number]>;
          if (!points || points.length < 4) continue;
          const flat = new Float32Array(points.length * 3);
          for (let i = 0; i < points.length; i++) {
            flat[i * 3] = points[i][0];
            flat[i * 3 + 1] = points[i][1];
            flat[i * 3 + 2] = points[i][2];
          }
          parts.push({
            translation: { x: pos[0], y: pos[1], z: pos[2] },
            vertices: flat
          });
        }
        if (parts.length > 0) {
          collider = { type: "compound-convex-hulls", parts };
        }
      }
    }
  }

  // Fallback: box collider from bbox
  if (!collider && bbox.width > 0 && bbox.height > 0 && bbox.depth > 0) {
    collider = {
      type: "box",
      halfExtents: new THREE.Vector3(bbox.width * 0.5, bbox.height * 0.5, bbox.depth * 0.5),
      centerOffset: new THREE.Vector3(0, -bbox.height * 0.5, 0)
    };
  }

  // Parse physics overrides
  const physicsSection = raw.physics as Record<string, unknown> | undefined;
  const overrides = physicsSection?.overrides as Record<string, unknown> | undefined;
  const materialName = (overrides?.material as string) ?? "default";
  const preset =
    PHYSICS_MATERIAL_PRESETS[materialName as keyof typeof PHYSICS_MATERIAL_PRESETS] ??
    PHYSICS_MATERIAL_PRESETS.default;

  const volume = Math.max(0, bbox.width) * Math.max(0, bbox.height) * Math.max(0, bbox.depth);
  const autoMass = Math.max(0.08, Math.min(40, volume * preset.density * 0.01));

  return {
    id,
    bbox,
    collider,
    physics: {
      mass: (overrides?.manualMass as number) ?? autoMass,
      friction: (overrides?.friction as number) ?? preset.friction,
      restitution: (overrides?.restitution as number) ?? preset.restitution,
      linearDamping: (overrides?.linearDamping as number) ?? preset.linearDamping,
      angularDamping: (overrides?.angularDamping as number) ?? preset.angularDamping
    }
  };
}

/* ------------------------------------------------------------------ */
/* Asset loading                                                       */
/* ------------------------------------------------------------------ */

const gltfLoader = new GLTFLoader();

async function loadGlbFromUrl(url: string): Promise<THREE.Group | null> {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const buffer = await res.arrayBuffer();
    const gltf = await new Promise<{ scene: THREE.Group }>((resolve, reject) => {
      gltfLoader.parse(buffer, "", resolve, reject);
    });
    return gltf.scene;
  } catch {
    return null;
  }
}

async function loadRoomGlb(): Promise<THREE.Group | null> {
  const url = `/api/assets/read?path=${encodeURIComponent("empty+room+interior+3d+model.glb")}`;
  return loadGlbFromUrl(url);
}

async function loadPropGlb(propId: string): Promise<THREE.Group | null> {
  const url = `/api/fs-v2/read?path=${encodeURIComponent(`props/${propId}/processed/model.glb`)}`;
  return loadGlbFromUrl(url);
}

async function listForgeV2Props(): Promise<string[]> {
  const res = await fetch(`/api/fs-v2/list?dir=props`);
  if (!res.ok) return [];
  return res.json();
}

async function loadPropMeta(propId: string): Promise<ForgeV2PropMeta> {
  try {
    const res = await fetch(
      `/api/fs-v2/read?path=${encodeURIComponent(`props/${propId}/meta.json`)}`
    );
    if (!res.ok) throw new Error("not found");
    const data = await res.json();
    const parsed = typeof data.content === "string" ? JSON.parse(data.content) : data;
    return parseForgeV2Meta(propId, parsed as Record<string, unknown>);
  } catch {
    return {
      id: propId,
      bbox: { width: 0, height: 0, depth: 0 },
      collider: null,
      physics: {
        mass: 0.65,
        friction: PHYSICS_MATERIAL_PRESETS.default.friction,
        restitution: PHYSICS_MATERIAL_PRESETS.default.restitution,
        linearDamping: PHYSICS_MATERIAL_PRESETS.default.linearDamping,
        angularDamping: PHYSICS_MATERIAL_PRESETS.default.angularDamping
      }
    };
  }
}

/* ------------------------------------------------------------------ */
/* Room physics collider (simplified boxes, not trimesh)                */
/* ------------------------------------------------------------------ */

/** Measure the scaled bounding box of the room group to auto-size physics boxes. */
function measureRoomBounds(group: THREE.Group): THREE.Box3 {
  group.updateMatrixWorld(true);
  return new THREE.Box3().setFromObject(group);
}

/**
 * Create simple box colliders for the room: floor + 4 walls.
 * Much faster than a 1.4M-triangle trimesh.
 */
function createRoomBoxColliders(
  physics: Physics3dResource,
  bounds: THREE.Box3,
  nextEid: () => EID
): void {
  const size = new THREE.Vector3();
  const center = new THREE.Vector3();
  bounds.getSize(size);
  bounds.getCenter(center);

  const wallThickness = 0.5;
  const cg = collisionGroups(PHYSICS_LAYER.WORLD_STATIC, PHYSICS_MASK.WORLD_STATIC);
  const opts = { friction: 0.9, restitution: 0.01, collisionGroups: cg };

  // Floor
  physics.createFixedCuboidEntity(nextEid(), {
    translation: { x: center.x, y: bounds.min.y - 0.05, z: center.z },
    halfExtents: { x: size.x * 0.5, y: 0.05, z: size.z * 0.5 },
    ...opts
  });

  // Walls: -X, +X, -Z, +Z
  const wallHeight = size.y * 0.5;
  const wallY = bounds.min.y + wallHeight;

  // -X wall
  physics.createFixedCuboidEntity(nextEid(), {
    translation: { x: bounds.min.x - wallThickness * 0.5, y: wallY, z: center.z },
    halfExtents: { x: wallThickness * 0.5, y: wallHeight, z: size.z * 0.5 },
    ...opts
  });
  // +X wall
  physics.createFixedCuboidEntity(nextEid(), {
    translation: { x: bounds.max.x + wallThickness * 0.5, y: wallY, z: center.z },
    halfExtents: { x: wallThickness * 0.5, y: wallHeight, z: size.z * 0.5 },
    ...opts
  });
  // -Z wall
  physics.createFixedCuboidEntity(nextEid(), {
    translation: { x: center.x, y: wallY, z: bounds.min.z - wallThickness * 0.5 },
    halfExtents: { x: size.x * 0.5, y: wallHeight, z: wallThickness * 0.5 },
    ...opts
  });
  // +Z wall
  physics.createFixedCuboidEntity(nextEid(), {
    translation: { x: center.x, y: wallY, z: bounds.max.z + wallThickness * 0.5 },
    halfExtents: { x: size.x * 0.5, y: wallHeight, z: wallThickness * 0.5 },
    ...opts
  });
}

/* ------------------------------------------------------------------ */
/* Scene setup                                                         */
/* ------------------------------------------------------------------ */

function createLighting(scene: THREE.Scene, roomBounds?: THREE.Box3): THREE.DirectionalLight {
  const ambient = new THREE.AmbientLight(0xffffff, 0.7);
  scene.add(ambient);

  const center = new THREE.Vector3();
  const size = new THREE.Vector3();
  if (roomBounds) {
    roomBounds.getCenter(center);
    roomBounds.getSize(size);
  } else {
    size.set(20, 10, 20);
  }
  const reach = Math.max(size.x, size.z) * 0.6;

  const key = new THREE.DirectionalLight(0xfff4e0, 2.0);
  key.position.set(center.x + reach, center.y + reach * 2, center.z + reach * 0.8);
  key.target.position.copy(center);
  key.castShadow = true;
  key.shadow.mapSize.set(4096, 4096);
  key.shadow.camera.near = 1;
  key.shadow.camera.far = reach * 5;
  key.shadow.camera.left = -reach;
  key.shadow.camera.right = reach;
  key.shadow.camera.top = reach;
  key.shadow.camera.bottom = -reach;
  key.shadow.bias = -0.0005;
  key.shadow.normalBias = 0.02;
  scene.add(key);
  scene.add(key.target);

  const fill = new THREE.DirectionalLight(0xb0c4de, 0.5);
  fill.position.set(center.x - reach * 0.6, center.y + reach, center.z - reach * 0.5);
  scene.add(fill);

  const hemi = new THREE.HemisphereLight(0xe8edf5, 0x8a8070, 0.5);
  scene.add(hemi);

  return key;
}

/* ------------------------------------------------------------------ */
/* Prop placement layout                                               */
/* ------------------------------------------------------------------ */

type PlacementSlot = {
  x: number;
  z: number;
  rotY: number;
};

function generatePropPlacements(count: number, roomRadius: number): PlacementSlot[] {
  const placements: PlacementSlot[] = [];
  const spacing = roomRadius * 0.5;
  const cols = Math.ceil(Math.sqrt(count));

  for (let i = 0; i < count; i++) {
    const col = i % cols;
    const row = Math.floor(i / cols);
    const x = (col - (cols - 1) * 0.5) * spacing;
    const z = (row - (Math.ceil(count / cols) - 1) * 0.5) * spacing;
    const rotY = (i * 0.7) % (Math.PI * 2);
    placements.push({ x, z, rotY });
  }

  return placements;
}

/* ------------------------------------------------------------------ */
/* HUD overlay                                                         */
/* ------------------------------------------------------------------ */

function createHud(mount: HTMLElement): {
  el: HTMLDivElement;
  update: (propCount: number, awake: number) => void;
} {
  const el = document.createElement("div");
  el.style.cssText =
    "position:absolute;top:8px;left:8px;padding:6px 10px;background:rgba(0,0,0,0.6);" +
    "color:#eee;font:12px/1.4 monospace;border-radius:4px;pointer-events:none;z-index:10;";
  mount.style.position = "relative";
  mount.appendChild(el);
  const update = (propCount: number, awake: number) => {
    el.textContent = `Props: ${propCount} | Awake: ${awake}`;
  };
  return { el, update };
}

/* ------------------------------------------------------------------ */
/* Experiment                                                          */
/* ------------------------------------------------------------------ */

const DROP_HEIGHT = 0.1; // 10cm above floor

const experiment: ExperimentModule = {
  id: "physics-prop-drop",
  title: "Physics Prop Drop",
  tags: ["threejs", "rapier", "physics", "props", "pixel-perfect", "isometric"],
  init: ({ mount, width, height }) => {
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x2a2e38);

    const view = new PixelPerfectIsoView({
      mount,
      width,
      height,
      scene,
      fixedRenderHeight: 240,
      baseOrthoHeight: 5.0,
      cameraDistance: 30,
      cameraPitch: Math.asin(1 / Math.sqrt(3)),
      cameraYaw: Math.PI / 4,
      basePixelZoom: 1,
      zoomMin: 1,
      zoomMax: 8,
      zoomStep: 1,
      zoomAnimationRate: 12,
      zoomAnimationBurstRate: 24,
      zoomAnimationEpsilon: 0.01,
      rotationAnimationRate: 12,
      rotationAnimationEpsilon: 0.005,
      zoomBurstIdleMs: 300,
      outputOverscanLowPixels: 2,
      clearColor: 0x2a2e38
    });

    view.renderer.shadowMap.enabled = true;
    view.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    view.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    view.renderer.toneMappingExposure = 1.25;

    const unbindInput = bindPixelPerfectIsoViewInput({ view });

    // Resize
    const resizeObserver = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const { width: w, height: h } = entry.contentRect;
        if (w > 0 && h > 0) view.resize(w, h);
      }
    });
    resizeObserver.observe(mount);

    // HUD
    const hud = createHud(mount);
    hud.update(0, 0);

    // State
    let physics: Physics3dResource | null = null;
    let nextEid = 1;
    const propInstances: PropInstance[] = [];
    let disposed = false;

    // --- Async init ---
    const initPromise = (async () => {
      await initRapier();
      if (disposed) return;

      physics = createPhysics3dResource({ gravity: { x: 0, y: -9.81, z: 0 } });

      // Load room
      const roomGroup = await loadRoomGlb();
      if (disposed) return;

      if (roomGroup) {
        // Scale room 10x
        roomGroup.scale.setScalar(10);

        // Room meshes: cast shadows but don't need to receive
        // (a dedicated ground plane handles shadow receiving)
        roomGroup.traverse((child) => {
          if (child instanceof THREE.Mesh) {
            child.castShadow = true;
            child.receiveShadow = false;
          }
        });
        scene.add(roomGroup);

        const bounds = measureRoomBounds(roomGroup);

        // Add a shadow-receiving ground plane at the room floor level.
        // The room GLB floor geometry has bad normals / doubleSided materials
        // that prevent reliable shadow reception, so we overlay a dedicated plane.
        const floorGeo = new THREE.PlaneGeometry(
          bounds.max.x - bounds.min.x,
          bounds.max.z - bounds.min.z
        );
        const floorMat = new THREE.ShadowMaterial({ opacity: 0.4 });
        const shadowFloor = new THREE.Mesh(floorGeo, floorMat);
        shadowFloor.rotation.x = -Math.PI / 2;
        shadowFloor.position.set(
          (bounds.min.x + bounds.max.x) * 0.5,
          bounds.min.y + 0.01,
          (bounds.min.z + bounds.max.z) * 0.5
        );
        shadowFloor.receiveShadow = true;
        scene.add(shadowFloor);

        // Set up lighting sized to the room
        createLighting(scene, bounds);

        // Create simplified box colliders for room (floor + walls).
        if (physics) {
          createRoomBoxColliders(physics, bounds, () => nextEid++ as EID);
        }
      } else {
        // Fallback: create a simple floor
        createLighting(scene);

        const geo = new THREE.PlaneGeometry(20, 20);
        const mat = new THREE.MeshStandardMaterial({
          color: 0xb0ad9e,
          roughness: 0.92
        });
        const floor = new THREE.Mesh(geo, mat);
        floor.rotation.x = -Math.PI / 2;
        floor.receiveShadow = true;
        scene.add(floor);

        if (physics) {
          const floorEid = nextEid++ as EID;
          physics.createFixedCuboidEntity(floorEid, {
            translation: { x: 0, y: -0.05, z: 0 },
            halfExtents: { x: 10, y: 0.05, z: 10 },
            friction: 0.9,
            restitution: 0.01,
            collisionGroups: collisionGroups(
              PHYSICS_LAYER.WORLD_STATIC,
              PHYSICS_MASK.WORLD_STATIC
            )
          });
        }
      }

      // Load props
      const propIds = await listForgeV2Props();
      if (disposed) return;

      const metas = await Promise.all(propIds.map((id) => loadPropMeta(id)));
      if (disposed) return;

      // Filter to props that have valid colliders
      const validProps = metas.filter((m) => m.collider !== null);

      // Generate placement slots
      const slots = generatePropPlacements(validProps.length, 2.0);

      // Load visuals and create physics bodies in parallel
      await Promise.all(
        validProps.map(async (meta, i) => {
          if (disposed || !physics) return;

          const visual = await loadPropGlb(meta.id);
          if (disposed || !visual || !physics) return;

          visual.traverse((child) => {
            if (child instanceof THREE.Mesh) {
              child.castShadow = true;
              child.receiveShadow = true;
              const mats = Array.isArray(child.material) ? child.material : [child.material];
              for (const mat of mats) {
                if (mat) {
                  mat.side = THREE.FrontSide;
                  mat.shadowSide = THREE.BackSide;
                  mat.needsUpdate = true;
                }
              }
            }
          });

          const slot = slots[i];
          const eid = nextEid++ as EID;

          // Determine root offset for this collider type
          const localRootOffset =
            meta.collider!.type === "box"
              ? {
                  x: meta.collider!.centerOffset.x,
                  y: meta.collider!.centerOffset.y,
                  z: meta.collider!.centerOffset.z
                }
              : { x: 0, y: 0, z: 0 };

          // Place prop above the floor
          const dropY = meta.bbox.height * 0.5 + DROP_HEIGHT;
          const rotation: PhysicsQuaternion = {
            x: 0,
            y: Math.sin(slot.rotY * 0.5),
            z: 0,
            w: Math.cos(slot.rotY * 0.5)
          };

          const bodyTranslation = bodyTranslationFromRootPose(
            slot.x,
            dropY,
            slot.z,
            localRootOffset,
            rotation
          );

          const collisionGroup = collisionGroups(
            PHYSICS_LAYER.PROP_LOOSE,
            PHYSICS_MASK.PROP_LOOSE
          );

          if (meta.collider!.type === "compound-convex-hulls") {
            physics.createDynamicCompoundConvexHullEntity(eid, {
              translation: bodyTranslation,
              rotation,
              parts: meta.collider!.parts,
              mass: meta.physics.mass,
              friction: meta.physics.friction,
              restitution: meta.physics.restitution,
              linearDamping: meta.physics.linearDamping,
              angularDamping: meta.physics.angularDamping,
              ccd: true,
              collisionGroups: collisionGroup
            });
          } else {
            physics.createDynamicCuboidEntity(eid, {
              translation: bodyTranslation,
              rotation,
              halfExtents: meta.collider!.halfExtents,
              mass: meta.physics.mass,
              friction: meta.physics.friction,
              restitution: meta.physics.restitution,
              linearDamping: meta.physics.linearDamping,
              angularDamping: meta.physics.angularDamping,
              ccd: true,
              collisionGroups: collisionGroup
            });
          }

          // Set initial visual position
          visual.position.set(slot.x, dropY, slot.z);
          visual.quaternion.set(rotation.x, rotation.y, rotation.z, rotation.w);
          scene.add(visual);

          propInstances.push({ eid, propId: meta.id, visual, localRootOffset });
        })
      );

      if (!disposed) {
        hud.update(propInstances.length, propInstances.length);
      }
    })();

    // --- Animation loop ---
    let raf = 0;
    let prevTime = performance.now();

    const animate = () => {
      raf = requestAnimationFrame(animate);
      const now = performance.now();
      const dt = Math.min((now - prevTime) / 1000, 0.1);
      prevTime = now;

      // Step physics
      if (physics) {
        physics.step(dt);

        // Sync physics → visuals
        let awakeCount = 0;
        for (const inst of propInstances) {
          const pos = physics.getEntityTranslation(inst.eid);
          const rot = physics.getEntityRotation(inst.eid);
          if (pos && rot) {
            const root = rootPoseFromBodyPose(pos, inst.localRootOffset, rot);
            inst.visual.position.set(root.worldX, root.worldY, root.worldZ);
            inst.visual.quaternion.set(rot.x, rot.y, rot.z, rot.w);
          }
          if (!physics.isEntitySleeping(inst.eid)) {
            awakeCount++;
          }
        }
        hud.update(propInstances.length, awakeCount);
      }

      view.frame(now, dt);
    };
    animate();

    // --- Cleanup ---
    return () => {
      disposed = true;
      cancelAnimationFrame(raf);
      resizeObserver.disconnect();
      unbindInput();
      hud.el.remove();
      void initPromise.then(() => {
        physics?.dispose();
      });
      view.dispose();
    };
  }
};

export default experiment;
