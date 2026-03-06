import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import RAPIER3D from "@dimforge/rapier3d-compat";
import { PixelPerfectIsoView } from "@common/render";
import { bindPixelPerfectIsoViewInput } from "@common/input";
import type { EID } from "@common/gameplay";
import type { ExperimentModule } from "../runtime/types";

import {
  createPhysics3dResource,
  type Physics3dResource
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
import { parseForgeV2PropMeta, type ForgeV2PropMeta } from "./forge-v2-props";
import { prepareImportedObjectShadows } from "./shadow-utils";

/* ------------------------------------------------------------------ */
/* Types                                                               */
/* ------------------------------------------------------------------ */

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
    return parseForgeV2PropMeta(propId, parsed as Record<string, unknown>);
  } catch {
    return {
      id: propId,
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
  // Lower sun angle so prop shadows travel farther across the floor.
  key.position.set(center.x + reach * 1.35, center.y + reach * 0.95, center.z + reach * 1.1);
  key.target.position.copy(center);
  key.castShadow = true;
  // Shadow frustum covers the prop area (not the full room) for adequate
  // texel density.  Props are placed within ~5 units of center.
  const shadowReach = Math.min(reach, 8);
  key.shadow.mapSize.set(2048, 2048);
  key.shadow.camera.near = 0.5;
  key.shadow.camera.far = reach * 5;
  key.shadow.camera.left = -shadowReach;
  key.shadow.camera.right = shadowReach;
  key.shadow.camera.top = shadowReach;
  key.shadow.camera.bottom = -shadowReach;
  key.shadow.bias = -0.002;
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
  title: "Level as Prop",
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
        prepareImportedObjectShadows(roomGroup);
        scene.add(roomGroup);

        const bounds = measureRoomBounds(roomGroup);

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
          prepareImportedObjectShadows(visual);
          if (!meta.collider) return;

          const slot = slots[i];
          const eid = nextEid++ as EID;
          const localRootOffset = meta.collider.localRootOffset;

          // Asset-forge props are bottom-center rooted, so 10cm means root=10cm.
          const dropY = DROP_HEIGHT;
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

          physics.createDynamicCompoundConvexHullEntity(eid, {
            translation: bodyTranslation,
            rotation,
            parts: meta.collider.parts,
            mass: meta.physics.mass,
            friction: meta.physics.friction,
            restitution: meta.physics.restitution,
            linearDamping: meta.physics.linearDamping,
            angularDamping: meta.physics.angularDamping,
            ccd: true,
            collisionGroups: collisionGroup
          });

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
