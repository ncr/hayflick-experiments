import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import RAPIER3D from "@dimforge/rapier3d-compat";
import { IsoGameView } from "@common/render";
import { bindIsoGameViewInput } from "@common/input";
import type { EID } from "@common/gameplay";
import type { ExperimentModule } from "../runtime/types";

import {
  createPhysics3dResource,
  type Physics3dBoxPart,
  type Physics3dConvexHullPart,
  type Physics3dResource
} from "./physics/game-physics-3d";
import {
  rootPoseFromBodyPose,
  bodyTranslationFromRootPose,
  type PhysicsQuaternion
} from "./physics/prop-physics-math";
import {
  collisionGroups,
  PHYSICS_LAYER,
  PHYSICS_MASK,
  PHYSICS_MATERIAL_PRESETS
} from "./physics/physics-settings";
import { parseForgePropMeta, type ForgePropMetaSnapshot } from "./forge-props";
import {
  deriveRoomSupportFloorPart,
  omitRoomSupportSurfaceParts,
  parseRoomCompoundColliderAsset,
  scaleCompoundConvexHullParts
} from "./room-compound-collider";
import {
  createCompoundBoxPreview,
  createCompoundConvexHullPreview
} from "./collider-preview";
import { prepareImportedObjectShadows } from "./shadow-utils";
import { generatePropPlacements } from "./placement-layout";

/* ------------------------------------------------------------------ */
/* Types                                                               */
/* ------------------------------------------------------------------ */

type PropInstance = {
  eid: EID;
  propId: string;
  visual: THREE.Group | null;
  colliderVisual: THREE.Group;
  localRootOffset: { x: number; y: number; z: number };
};

type DisplayMode = "mesh" | "collider";

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

async function loadRoomColliderParts(): Promise<Physics3dConvexHullPart[]> {
  try {
    const url = `/api/assets/read?path=${encodeURIComponent("empty+room+interior+3d+collider-balanced.json")}`;
    const res = await fetch(url);
    if (!res.ok) {
      return [];
    }
    const data = await res.json();
    const parsed = typeof data.content === "string" ? JSON.parse(data.content) : data;
    return parseRoomCompoundColliderAsset(parsed);
  } catch {
    return [];
  }
}

async function loadPropGlb(propId: string): Promise<THREE.Group | null> {
  const url = `/api/forge/props/${encodeURIComponent(propId)}/processed-glb`;
  return loadGlbFromUrl(url);
}

async function listForgeProps(): Promise<string[]> {
  const res = await fetch("/api/forge/props");
  if (!res.ok) return [];
  const items = (await res.json()) as Array<{ id: string }>;
  return items.map((item) => item.id);
}

async function loadPropMeta(propId: string): Promise<ForgePropMetaSnapshot> {
  try {
    const res = await fetch(`/api/forge/props/${encodeURIComponent(propId)}`);
    if (!res.ok) throw new Error("not found");
    const data = (await res.json()) as { meta?: Record<string, unknown> };
    return parseForgePropMeta(propId, (data.meta ?? {}) as Record<string, unknown>);
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
/* Room physics colliders                                                */
/* ------------------------------------------------------------------ */

/** Measure the scaled bounding box of the room group to auto-size physics boxes. */
function measureRoomBounds(group: THREE.Group): THREE.Box3 {
  group.updateMatrixWorld(true);
  return new THREE.Box3().setFromObject(group);
}

function createRoomCompoundHullColliders(
  physics: Physics3dResource,
  roomGroup: THREE.Group,
  parts: Physics3dConvexHullPart[],
  nextEid: () => EID
): number {
  if (parts.length <= 0) {
    return 0;
  }

  const cg = collisionGroups(PHYSICS_LAYER.WORLD_STATIC, PHYSICS_MASK.WORLD_STATIC);
  const scaledParts = scaleCompoundConvexHullParts(parts, roomGroup.scale);
  const rotation = roomGroup.quaternion;
  physics.createFixedCompoundConvexHullEntity(nextEid(), {
    translation: {
      x: roomGroup.position.x,
      y: roomGroup.position.y,
      z: roomGroup.position.z
    },
    rotation: { x: rotation.x, y: rotation.y, z: rotation.z, w: rotation.w },
    parts: scaledParts,
    friction: 0.9,
    restitution: 0.01,
    collisionGroups: cg
  });
  return scaledParts.length;
}

function createFallbackRoomBoxParts(bounds: THREE.Box3): Physics3dBoxPart[] {
  const size = new THREE.Vector3();
  const center = new THREE.Vector3();
  bounds.getSize(size);
  bounds.getCenter(center);

  const wallThickness = 0.5;
  const wallHeight = size.y * 0.5;
  const wallY = bounds.min.y + wallHeight;

  return [
    {
      translation: { x: center.x, y: bounds.min.y - 0.05, z: center.z },
      halfExtents: { x: size.x * 0.5, y: 0.05, z: size.z * 0.5 }
    },
    {
      translation: { x: bounds.min.x - wallThickness * 0.5, y: wallY, z: center.z },
      halfExtents: { x: wallThickness * 0.5, y: wallHeight, z: size.z * 0.5 }
    },
    {
      translation: { x: bounds.max.x + wallThickness * 0.5, y: wallY, z: center.z },
      halfExtents: { x: wallThickness * 0.5, y: wallHeight, z: size.z * 0.5 }
    },
    {
      translation: { x: center.x, y: wallY, z: bounds.min.z - wallThickness * 0.5 },
      halfExtents: { x: size.x * 0.5, y: wallHeight, z: wallThickness * 0.5 }
    },
    {
      translation: { x: center.x, y: wallY, z: bounds.max.z + wallThickness * 0.5 },
      halfExtents: { x: size.x * 0.5, y: wallHeight, z: wallThickness * 0.5 }
    }
  ];
}

function createFallbackRoomBoxColliders(
  physics: Physics3dResource,
  bounds: THREE.Box3,
  nextEid: () => EID
): void {
  const cg = collisionGroups(PHYSICS_LAYER.WORLD_STATIC, PHYSICS_MASK.WORLD_STATIC);
  const opts = { friction: 0.9, restitution: 0.01, collisionGroups: cg };

  for (const part of createFallbackRoomBoxParts(bounds)) {
    physics.createFixedCuboidEntity(nextEid(), {
      translation: part.translation,
      halfExtents: part.halfExtents,
      ...opts
    });
  }
}

function createRoomCompoundHullPreview(
  roomGroup: THREE.Group,
  parts: Physics3dConvexHullPart[]
): THREE.Group {
  const preview = new THREE.Group();
  const hullPreview = createCompoundConvexHullPreview(omitRoomSupportSurfaceParts(parts));
  preview.add(hullPreview);

  const supportFloor = deriveRoomSupportFloorPart(parts);
  if (supportFloor) {
    preview.add(createCompoundBoxPreview([supportFloor]));
  }

  preview.position.copy(roomGroup.position);
  preview.quaternion.copy(roomGroup.quaternion);
  preview.scale.copy(roomGroup.scale);
  return preview;
}

function setDisplayModeVisibility(
  mode: DisplayMode,
  roomMeshVisual: THREE.Object3D | null,
  roomColliderVisual: THREE.Object3D | null,
  propInstances: PropInstance[]
): void {
  const showMesh = mode === "mesh";
  if (roomMeshVisual) {
    roomMeshVisual.visible = showMesh;
  }
  if (roomColliderVisual) {
    roomColliderVisual.visible = !showMesh;
  }
  for (const inst of propInstances) {
    if (inst.visual) {
      inst.visual.visible = showMesh;
    }
    inst.colliderVisual.visible = !showMesh;
  }
}

function createRoomSupportFloorCollider(
  physics: Physics3dResource,
  parts: Physics3dConvexHullPart[],
  nextEid: () => EID
): void {
  const supportFloor = deriveRoomSupportFloorPart(parts);
  if (!supportFloor) {
    return;
  }

  physics.createFixedCuboidEntity(nextEid(), {
    translation: supportFloor.translation,
    halfExtents: supportFloor.halfExtents,
    friction: 0.9,
    restitution: 0.01,
    collisionGroups: collisionGroups(
      PHYSICS_LAYER.WORLD_STATIC,
      PHYSICS_MASK.WORLD_STATIC
    )
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
/* HUD overlay                                                         */
/* ------------------------------------------------------------------ */

function createHud(mount: HTMLElement): {
  el: HTMLDivElement;
  update: (propCount: number, awake: number) => void;
  setDisplayMode: (mode: DisplayMode) => void;
  setToggleHandler: (handler: () => void) => void;
} {
  const el = document.createElement("div");
  el.style.cssText =
    "position:absolute;top:8px;left:8px;padding:6px 10px;background:rgba(0,0,0,0.6);" +
    "color:#eee;font:12px/1.4 monospace;border-radius:4px;z-index:10;";
  mount.style.position = "relative";
  mount.appendChild(el);
  const stats = document.createElement("div");
  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.style.cssText =
    "margin-top:6px;padding:4px 8px;border:1px solid rgba(255,255,255,0.2);" +
    "background:rgba(255,255,255,0.08);color:#eee;border-radius:4px;cursor:pointer;" +
    "font:12px/1.2 monospace;";
  let toggleHandler = () => {};
  toggle.addEventListener("pointerdown", (event) => {
    event.stopPropagation();
  });
  toggle.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    toggleHandler();
  });
  el.append(stats, toggle);
  const update = (propCount: number, awake: number) => {
    stats.textContent = `Props: ${propCount} | Awake: ${awake}`;
  };
  const setDisplayMode = (mode: DisplayMode) => {
    toggle.textContent = `View: ${mode === "mesh" ? "Mesh" : "Collider"} [C]`;
  };
  const setToggleHandler = (handler: () => void) => {
    toggleHandler = handler;
  };
  return { el, update, setDisplayMode, setToggleHandler };
}

/* ------------------------------------------------------------------ */
/* Experiment                                                          */
/* ------------------------------------------------------------------ */

const DROP_HEIGHT = 1.0; // 1m above floor

const experiment: ExperimentModule = {
  id: "physics-prop-drop",
  title: "Level as Prop",
  tags: ["threejs", "rapier", "physics", "props", "pixel-perfect", "isometric"],
  init: ({ mount, width, height }) => {
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x2a2e38);

    const view = new IsoGameView({
      mount,
      width,
      height,
      scene,
      // Adopts the locked iso contract (R = 32·√2). Previously had a
      // baseOrthoHeight: 5.0 override; that path is no longer permitted on
      // IsoGameView. Tools that need different framing use PixelPerfectPane.
      cameraDistance: 30,
      rotationAnimationRate: 12,
      rotationAnimationEpsilon: 0.005,
      clearColor: 0x2a2e38,
      outlines: false,
      toneMapping: "aces",
      shadows: true
    });

    // The ACES tone map runs at exposure 1.25 for this scene. Exposure is
    // not part of the declarative config, so keep it as a direct renderer
    // tweak; the pane's toneMapping hook reads whatever exposure was set.
    view.renderer.toneMappingExposure = 1.25;

    const unbindInput = bindIsoGameViewInput({ view });

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
    let displayMode: DisplayMode = "mesh";
    hud.setDisplayMode(displayMode);

    // State
    let physics: Physics3dResource | null = null;
    let nextEid = 1;
    const propInstances: PropInstance[] = [];
    let roomMeshVisual: THREE.Object3D | null = null;
    let roomColliderVisual: THREE.Object3D | null = null;
    let disposed = false;

    const applyDisplayMode = () => {
      setDisplayModeVisibility(
        displayMode,
        roomMeshVisual,
        roomColliderVisual,
        propInstances
      );
      hud.setDisplayMode(displayMode);
    };
    const toggleDisplayMode = () => {
      displayMode = displayMode === "mesh" ? "collider" : "mesh";
      applyDisplayMode();
    };
    hud.setToggleHandler(toggleDisplayMode);
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.repeat || event.code !== "KeyC") {
        return;
      }
      event.preventDefault();
      toggleDisplayMode();
    };
    window.addEventListener("keydown", onKeyDown);

    // --- Async init ---
    const initPromise = (async () => {
      await initRapier();
      if (disposed) return;

      physics = createPhysics3dResource({ gravity: { x: 0, y: -9.81, z: 0 } });

      // Load room visual + precomputed compound hull collider asset.
      const [roomGroup, roomColliderParts] = await Promise.all([
        loadRoomGlb(),
        loadRoomColliderParts()
      ]);
      if (disposed) return;

      if (roomGroup) {
        // Scale room 10x
        roomGroup.scale.setScalar(10);
        prepareImportedObjectShadows(roomGroup);
        scene.add(roomGroup);
        roomMeshVisual = roomGroup;

        const bounds = measureRoomBounds(roomGroup);

        // Set up lighting sized to the room
        createLighting(scene, bounds);

        roomColliderVisual =
          roomColliderParts.length > 0
            ? createRoomCompoundHullPreview(roomGroup, roomColliderParts)
            : createCompoundBoxPreview(createFallbackRoomBoxParts(bounds));
        scene.add(roomColliderVisual);
        applyDisplayMode();

        // Use the precomputed VHACD compound hull asset for the room so the
        // level follows the same collider model as forge props.
        if (physics) {
          const scaledRoomColliderParts = scaleCompoundConvexHullParts(
            roomColliderParts,
            roomGroup.scale
          );
          const structuralRoomColliderParts = omitRoomSupportSurfaceParts(roomColliderParts);
          const colliderCount = createRoomCompoundHullColliders(
            physics,
            roomGroup,
            structuralRoomColliderParts,
            () => nextEid++ as EID
          );
          createRoomSupportFloorCollider(
            physics,
            scaledRoomColliderParts,
            () => nextEid++ as EID
          );
          if (colliderCount <= 0) {
            createFallbackRoomBoxColliders(physics, bounds, () => nextEid++ as EID);
          }
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
        roomMeshVisual = floor;
        roomColliderVisual = createCompoundBoxPreview([
          {
            translation: { x: 0, y: -0.05, z: 0 },
            halfExtents: { x: 10, y: 0.05, z: 10 }
          }
        ]);
        scene.add(roomColliderVisual);
        applyDisplayMode();

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
      const propIds = await listForgeProps();
      if (disposed) return;

      const metas = await Promise.all(propIds.map((id) => loadPropMeta(id)));
      if (disposed) return;

      // Filter to props that have valid colliders
      const validProps = metas.filter((m) => m.collider !== null);

      // Generate placement slots
      const slots = generatePropPlacements(
        validProps.map((meta) => ({
          width: meta.collider?.dimensions.width ?? 1,
          depth: meta.collider?.dimensions.depth ?? 1
        })),
        2.0
      );

      // Load visuals and create physics bodies in parallel
      await Promise.all(
        validProps.map(async (meta, i) => {
          if (disposed || !physics) return;

          if (!meta.collider) return;
          const visual = await loadPropGlb(meta.id);
          if (disposed || !physics) return;
          if (visual) {
            prepareImportedObjectShadows(visual);
          }

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

          let visualRoot: THREE.Group | null = null;
          if (visual) {
            visual.position.set(slot.x, dropY, slot.z);
            visual.quaternion.set(rotation.x, rotation.y, rotation.z, rotation.w);
            scene.add(visual);
            visualRoot = visual;
          }

          const colliderVisual = createCompoundConvexHullPreview(meta.collider.parts);
          colliderVisual.position.set(
            bodyTranslation.x,
            bodyTranslation.y,
            bodyTranslation.z
          );
          colliderVisual.quaternion.set(rotation.x, rotation.y, rotation.z, rotation.w);
          scene.add(colliderVisual);

          const instance: PropInstance = {
            eid,
            propId: meta.id,
            visual: visualRoot,
            colliderVisual,
            localRootOffset
          };
          propInstances.push(instance);
          setDisplayModeVisibility(displayMode, roomMeshVisual, roomColliderVisual, [instance]);
        })
      );

      if (!disposed) {
        applyDisplayMode();
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
            if (inst.visual) {
              inst.visual.position.set(root.worldX, root.worldY, root.worldZ);
              inst.visual.quaternion.set(rot.x, rot.y, rot.z, rot.w);
            }
            inst.colliderVisual.position.set(pos.x, pos.y, pos.z);
            inst.colliderVisual.quaternion.set(rot.x, rot.y, rot.z, rot.w);
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
      window.removeEventListener("keydown", onKeyDown);
      hud.el.remove();
      void initPromise.then(() => {
        physics?.dispose();
      });
      view.dispose();
    };
  }
};

export default experiment;
