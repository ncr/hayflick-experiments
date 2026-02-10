/**
 * Per-frame flow for this physics validation experiment:
 * 1) Input + intent systems write player velocity into ECS resources/components.
 * 2) Physics sync-in converts ECS velocity into a Rapier desired movement delta.
 * 3) Rapier steps on a fixed 1/60 timestep using an accumulator for FPS stability.
 * 4) Physics sync-out copies authoritative Rapier body positions back into ECS Transform.
 * 5) Door clicks toggle both ECS LevelResource blocked data and Rapier door colliders.
 * 6) Save/load rebuilds ECS + physics from scratch and reapplies door states by placementId.
 */

import * as THREE from "three";
import RAPIER, {
  type ColliderHandle,
  type KinematicCharacterController,
  type RigidBodyHandle,
  type World as RapierWorld
} from "@dimforge/rapier2d-compat";
import {
  DataStore,
  KeyboardTracker,
  World,
  createInputSystem,
  type EID,
  type System
} from "@common/gameplay";
import {
  createMutableGridLevelResource,
  type MutableGridLevelResource
} from "@common/level-editor";
import { makeRenderer } from "@common/render_legacy";
import type { ExperimentModule } from "../runtime/types";

type Cell = {
  x: number;
  y: number;
};

type DoorPlacement = {
  id: string;
  cellX: number;
  cellY: number;
  rot: number;
  open: boolean;
  locked?: boolean;
};

type MockLevelDefinition = {
  id: string;
  version: number;
  width: number;
  height: number;
  wallCells: Cell[];
  doors: DoorPlacement[];
  playerSpawn: {
    x: number;
    y: number;
  };
};

type PhysicsBodyComponent = {
  bodyHandle: RigidBodyHandle;
};

type PhysicsColliderComponent = {
  colliderHandle: ColliderHandle;
};

type DoorComponent = {
  placementId: string;
  cellX: number;
  cellY: number;
  open: boolean;
  locked?: boolean;
};

type DoorSave = {
  placementId: string;
  open: boolean;
  locked?: boolean;
};

type PhysicsRapierSave = {
  schemaVersion: 1;
  player: {
    x: number;
    y: number;
  };
  doors: DoorSave[];
};

type PhysicsResource = {
  rapierWorld: RapierWorld;
  characterController: KinematicCharacterController;
  accumulator: number;
  fixedDt: number;
  eidToBody: Map<EID, RigidBodyHandle>;
  eidToCollider: Map<EID, ColliderHandle>;
  colliderToEid: Map<number, EID>;
  createKinematicCapsuleForEid(
    eid: EID,
    x: number,
    y: number,
    radius: number,
    halfHeight?: number
  ): { bodyHandle: RigidBodyHandle; colliderHandle: ColliderHandle };
  createStaticBoxCollider(x: number, y: number, width: number, height: number): ColliderHandle;
  setColliderEnabled(handle: ColliderHandle, enabled: boolean): void;
  step(dt: number): void;
  dispose(): void;
};

type RuntimeState = {
  world: World;
  levelResource: MutableGridLevelResource;
  physics: PhysicsResource;
  systems: {
    inputSystem: System;
  };
  playerEid: EID;
  doors: DataStore<DoorComponent>;
  physicsBodies: DataStore<PhysicsBodyComponent>;
  physicsColliders: DataStore<PhysicsColliderComponent>;
  doorByPlacementId: Map<string, EID>;
  doorColliderByPlacementId: Map<string, ColliderHandle>;
  doorMeshByPlacementId: Map<string, THREE.Mesh>;
  interactionQueue: string[];
};

type HudHandles = {
  root: HTMLDivElement;
  hints: HTMLDivElement;
  status: HTMLDivElement;
  stats: HTMLDivElement;
  destroy(): void;
};

const LOCAL_STORAGE_SAVE_KEY = "physics_rapier_save_v1";

const LEVEL_WIDTH = 20;
const LEVEL_HEIGHT = 20;

const FIXED_DT = 1 / 60;
const MAX_STEPS_PER_FRAME = 8;
const PLAYER_SPEED = 4.2;
const PLAYER_RADIUS = 0.28;

const CAMERA_PITCH = THREE.MathUtils.degToRad(35.26438968);
const CAMERA_YAW = THREE.MathUtils.degToRad(45);
const CAMERA_DISTANCE = 26;
const ORTHO_HEIGHT = 20;
const ZOOM_MIN = 0.7;
const ZOOM_MAX = 2.4;

const FLOOR_HEIGHT = 0.05;
const WALL_HEIGHT = 1.1;
const DOOR_HEIGHT = 1.1;

let rapierInitPromise: Promise<void> | null = null;

function ensureRapierReady(): Promise<void> {
  if (!rapierInitPromise) {
    rapierInitPromise = RAPIER.init();
  }
  return rapierInitPromise;
}

function toCellKey(x: number, y: number): string {
  return `${x},${y}`;
}

function cellCenter(cellX: number, cellY: number): { x: number; y: number } {
  return {
    x: cellX + 0.5,
    y: cellY + 0.5
  };
}

function createHud(mount: HTMLElement): HudHandles {
  const root = document.createElement("div");
  root.style.position = "absolute";
  root.style.left = "12px";
  root.style.top = "12px";
  root.style.maxWidth = "330px";
  root.style.display = "flex";
  root.style.flexDirection = "column";
  root.style.gap = "8px";
  root.style.padding = "10px 12px";
  root.style.borderRadius = "10px";
  root.style.background = "rgba(10, 20, 30, 0.82)";
  root.style.border = "1px solid rgba(130, 170, 210, 0.5)";
  root.style.backdropFilter = "blur(2px)";
  root.style.fontFamily = "monospace";
  root.style.fontSize = "12px";
  root.style.color = "#d9e8f7";
  root.style.pointerEvents = "none";

  const title = document.createElement("div");
  title.textContent = "Physics Rapier";
  title.style.fontWeight = "700";
  title.style.fontSize = "13px";
  title.style.color = "#f4fbff";

  const hints = document.createElement("div");
  hints.textContent = "WASD/Arrows move, click door toggles, K save, L load";
  hints.style.color = "#b3d2ed";

  const status = document.createElement("div");
  status.textContent = "Ready.";

  const stats = document.createElement("div");
  stats.style.whiteSpace = "pre-line";
  stats.style.color = "#c4dfd0";

  root.append(title, hints, status, stats);
  mount.appendChild(root);

  return {
    root,
    hints,
    status,
    stats,
    destroy(): void {
      root.remove();
    }
  };
}

function createMockLevelDefinition(): MockLevelDefinition {
  const wallSet = new Set<string>();

  const addWall = (x: number, y: number): void => {
    if (x < 0 || y < 0 || x >= LEVEL_WIDTH || y >= LEVEL_HEIGHT) {
      return;
    }
    wallSet.add(toCellKey(x, y));
  };

  for (let x = 2; x <= 17; x += 1) {
    addWall(x, 2);
    addWall(x, 17);
  }

  for (let y = 2; y <= 17; y += 1) {
    addWall(2, y);
    addWall(17, y);
  }

  for (let y = 3; y <= 16; y += 1) {
    if (y === 9) {
      continue;
    }
    addWall(10, y);
  }

  const wallCells = [...wallSet]
    .map((key) => {
      const [xStr, yStr] = key.split(",");
      return { x: Number(xStr), y: Number(yStr) };
    })
    .sort((a, b) => a.y - b.y || a.x - b.x);

  return {
    id: "physics-rapier-mockup",
    version: 1,
    width: LEVEL_WIDTH,
    height: LEVEL_HEIGHT,
    wallCells,
    doors: [
      {
        id: "door-main",
        cellX: 10,
        cellY: 9,
        rot: 1,
        open: false
      }
    ],
    playerSpawn: {
      x: 5.5,
      y: 9.5
    }
  };
}

function createPhysicsResource(rapier: typeof RAPIER): PhysicsResource {
  const rapierWorld = new rapier.World({ x: 0, y: 0 });
  const characterController = rapierWorld.createCharacterController(0.01);
  characterController.setSlideEnabled(true);
  characterController.setUp({ x: 0, y: 1 });

  const eidToBody = new Map<EID, RigidBodyHandle>();
  const eidToCollider = new Map<EID, ColliderHandle>();
  const colliderToEid = new Map<number, EID>();

  return {
    rapierWorld,
    characterController,
    accumulator: 0,
    fixedDt: FIXED_DT,
    eidToBody,
    eidToCollider,
    colliderToEid,
    createKinematicCapsuleForEid(
      eid: EID,
      x: number,
      y: number,
      radius: number,
      halfHeight = 0
    ): { bodyHandle: RigidBodyHandle; colliderHandle: ColliderHandle } {
      const bodyDesc = rapier.RigidBodyDesc.kinematicPositionBased()
        .setTranslation(x, y)
        .lockRotations();
      const body = rapierWorld.createRigidBody(bodyDesc);
      const colliderDesc =
        halfHeight > 0
          ? rapier.ColliderDesc.capsule(halfHeight, radius)
          : rapier.ColliderDesc.ball(radius);
      const collider = rapierWorld.createCollider(colliderDesc, body);

      eidToBody.set(eid, body.handle);
      eidToCollider.set(eid, collider.handle);
      colliderToEid.set(collider.handle, eid);

      return {
        bodyHandle: body.handle,
        colliderHandle: collider.handle
      };
    },
    createStaticBoxCollider(x: number, y: number, width: number, height: number): ColliderHandle {
      const bodyDesc = rapier.RigidBodyDesc.fixed().setTranslation(x, y);
      const body = rapierWorld.createRigidBody(bodyDesc);
      const colliderDesc = rapier.ColliderDesc.cuboid(width * 0.5, height * 0.5);
      const collider = rapierWorld.createCollider(colliderDesc, body);
      return collider.handle;
    },
    setColliderEnabled(handle: ColliderHandle, enabled: boolean): void {
      const collider = rapierWorld.colliders.get(handle);
      if (collider) {
        collider.setEnabled(enabled);
      }
    },
    step(dt: number): void {
      rapierWorld.timestep = dt;
      rapierWorld.step();
    },
    dispose(): void {
      rapierWorld.removeCharacterController(characterController);
      rapierWorld.free();
      eidToBody.clear();
      eidToCollider.clear();
      colliderToEid.clear();
    }
  };
}

function rebuildGroup(group: THREE.Group): void {
  while (group.children.length > 0) {
    const child = group.children.pop();
    if (child) {
      group.remove(child);
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function parseSave(raw: unknown): PhysicsRapierSave | null {
  if (!isRecord(raw)) {
    return null;
  }

  if (raw.schemaVersion !== 1) {
    return null;
  }

  if (!isRecord(raw.player) || !Array.isArray(raw.doors)) {
    return null;
  }

  const px = raw.player.x;
  const py = raw.player.y;
  if (typeof px !== "number" || !Number.isFinite(px) || typeof py !== "number" || !Number.isFinite(py)) {
    return null;
  }

  const doors: DoorSave[] = [];
  for (const entry of raw.doors) {
    if (!isRecord(entry)) {
      return null;
    }

    const placementId = entry.placementId;
    const open = entry.open;
    const lockedRaw = entry.locked;

    if (typeof placementId !== "string" || typeof open !== "boolean") {
      return null;
    }

    if (lockedRaw !== undefined && typeof lockedRaw !== "boolean") {
      return null;
    }

    doors.push({
      placementId,
      open,
      locked: lockedRaw
    });
  }

  return {
    schemaVersion: 1,
    player: {
      x: px,
      y: py
    },
    doors
  };
}

function setDoorVisual(mesh: THREE.Mesh, open: boolean): void {
  mesh.userData.open = open;
  mesh.scale.y = open ? 0.45 : 1;
  mesh.position.y = (DOOR_HEIGHT * mesh.scale.y) * 0.5;

  const material = mesh.material as THREE.MeshStandardMaterial;
  material.color.setHex(open ? 0x7fbc7a : 0x9f694a);
}

function setDoorOpenState(
  runtime: RuntimeState,
  placementId: string,
  open: boolean,
  locked?: boolean
): boolean {
  const doorEid = runtime.doorByPlacementId.get(placementId);
  if (doorEid === undefined) {
    return false;
  }

  const door = runtime.doors.get(doorEid);
  if (!door) {
    return false;
  }

  door.open = open;
  if (locked !== undefined) {
    door.locked = locked;
  }

  runtime.levelResource.setBlocked(door.cellX, door.cellY, !door.open);

  const colliderHandle = runtime.doorColliderByPlacementId.get(placementId);
  if (colliderHandle !== undefined) {
    runtime.physics.setColliderEnabled(colliderHandle, !door.open);
  }

  const mesh = runtime.doorMeshByPlacementId.get(placementId);
  if (mesh) {
    setDoorVisual(mesh, door.open);
  }

  return true;
}

function runDoorInteractionSystem(runtime: RuntimeState): void {
  while (runtime.interactionQueue.length > 0) {
    const placementId = runtime.interactionQueue.shift();
    if (!placementId) {
      continue;
    }

    const doorEid = runtime.doorByPlacementId.get(placementId);
    if (doorEid === undefined) {
      continue;
    }

    const door = runtime.doors.get(doorEid);
    if (!door || door.locked) {
      continue;
    }

    setDoorOpenState(runtime, placementId, !door.open);
  }
}

function runPhysicsSyncIn(runtime: RuntimeState): void {
  const dt = runtime.physics.fixedDt;

  for (const eid of runtime.world.queryTransformPlayer()) {
    const velocity = runtime.world.velocities.get(eid);
    const physicsBody = runtime.physicsBodies.get(eid);
    const physicsCollider = runtime.physicsColliders.get(eid);
    if (!velocity || !physicsBody || !physicsCollider) {
      continue;
    }

    const body = runtime.physics.rapierWorld.bodies.get(physicsBody.bodyHandle);
    const collider = runtime.physics.rapierWorld.colliders.get(physicsCollider.colliderHandle);
    if (!body || !collider) {
      continue;
    }

    const desired = {
      x: velocity.vx * dt,
      y: velocity.vy * dt
    };

    runtime.physics.characterController.computeColliderMovement(collider, desired);
    const corrected = runtime.physics.characterController.computedMovement();
    const current = body.translation();

    body.setNextKinematicTranslation({
      x: current.x + corrected.x,
      y: current.y + corrected.y
    });
  }
}

function runPhysicsSyncOut(runtime: RuntimeState): void {
  for (const eid of runtime.physicsBodies.entries()) {
    if (!runtime.world.transforms.has(eid)) {
      continue;
    }

    const bodyComponent = runtime.physicsBodies.get(eid);
    if (!bodyComponent) {
      continue;
    }

    const body = runtime.physics.rapierWorld.bodies.get(bodyComponent.bodyHandle);
    const transform = runtime.world.transforms.get(eid);
    if (!body || !transform) {
      continue;
    }

    const translation = body.translation();
    transform.x = translation.x;
    transform.y = translation.y;
  }
}

function saveGame(runtime: RuntimeState, status: (message: string) => void): void {
  const player = runtime.world.transforms.get(runtime.playerEid);
  if (!player) {
    status("Save failed: player transform missing.");
    return;
  }

  const doors: DoorSave[] = [];
  for (const eid of runtime.doors.entries()) {
    const door = runtime.doors.get(eid);
    if (!door) {
      continue;
    }

    doors.push({
      placementId: door.placementId,
      open: door.open,
      locked: door.locked
    });
  }

  doors.sort((a, b) => a.placementId.localeCompare(b.placementId));

  const payload: PhysicsRapierSave = {
    schemaVersion: 1,
    player: {
      x: player.x,
      y: player.y
    },
    doors
  };

  localStorage.setItem(LOCAL_STORAGE_SAVE_KEY, JSON.stringify(payload));
  const message = `Saved game to ${LOCAL_STORAGE_SAVE_KEY} | player=(${player.x.toFixed(2)}, ${player.y.toFixed(2)})`;
  console.log(message, payload);
  status(message);
}

function loadGameFromLocalStorage(): PhysicsRapierSave | null {
  const raw = localStorage.getItem(LOCAL_STORAGE_SAVE_KEY);
  if (!raw) {
    return null;
  }

  try {
    const parsed: unknown = JSON.parse(raw);
    return parseSave(parsed);
  } catch {
    return null;
  }
}

function createRuntimeState(options: {
  systems: {
    inputSystem: System;
  };
  wallGroup: THREE.Group;
  doorGroup: THREE.Group;
  wallGeometry: THREE.BoxGeometry;
  wallMaterial: THREE.MeshStandardMaterial;
  doorGeometry: THREE.BoxGeometry;
  save?: PhysicsRapierSave;
  status: (message: string) => void;
}): RuntimeState {
  const {
    systems,
    wallGroup,
    doorGroup,
    wallGeometry,
    wallMaterial,
    doorGeometry,
    save,
    status
  } = options;

  rebuildGroup(wallGroup);
  rebuildGroup(doorGroup);

  const def = createMockLevelDefinition();
  const saveDoorState = new Map<string, DoorSave>(
    (save?.doors ?? []).map((entry) => [entry.placementId, entry])
  );

  const doors = new DataStore<DoorComponent>();
  const physicsBodies = new DataStore<PhysicsBodyComponent>();
  const physicsColliders = new DataStore<PhysicsColliderComponent>();

  const doorByPlacementId = new Map<string, EID>();
  const doorColliderByPlacementId = new Map<string, ColliderHandle>();
  const doorMeshByPlacementId = new Map<string, THREE.Mesh>();

  const blocked = new Set<string>(def.wallCells.map((cell) => toCellKey(cell.x, cell.y)));

  for (const door of def.doors) {
    const override = saveDoorState.get(door.id);
    const open = override ? override.open : door.open;
    if (!open) {
      blocked.add(toCellKey(door.cellX, door.cellY));
    }
  }

  const blockedCells = [...blocked].map((key) => {
    const [xStr, yStr] = key.split(",");
    return {
      x: Number(xStr),
      y: Number(yStr)
    };
  });

  const levelResource = createMutableGridLevelResource({
    id: def.id,
    version: def.version,
    width: def.width,
    height: def.height,
    blockedCells
  });

  const world = new World({ level: levelResource });
  const physics = createPhysicsResource(RAPIER);

  for (const cell of def.wallCells) {
    const center = cellCenter(cell.x, cell.y);
    physics.createStaticBoxCollider(center.x, center.y, 1, 1);

    const mesh = new THREE.Mesh(wallGeometry, wallMaterial);
    mesh.position.set(center.x, WALL_HEIGHT * 0.5, center.y);
    wallGroup.add(mesh);
  }

  for (const placement of def.doors) {
    const override = saveDoorState.get(placement.id);
    const open = override ? override.open : placement.open;
    const locked = override?.locked ?? placement.locked;

    const eid = world.createEntity();
    doors.add(eid, {
      placementId: placement.id,
      cellX: placement.cellX,
      cellY: placement.cellY,
      open,
      locked
    });
    doorByPlacementId.set(placement.id, eid);

    const center = cellCenter(placement.cellX, placement.cellY);
    const doorColliderHandle = physics.createStaticBoxCollider(center.x, center.y, 0.95, 0.95);
    doorColliderByPlacementId.set(placement.id, doorColliderHandle);

    physicsColliders.add(eid, { colliderHandle: doorColliderHandle });
    physics.colliderToEid.set(doorColliderHandle, eid);

    const mesh = new THREE.Mesh(
      doorGeometry,
      new THREE.MeshStandardMaterial({
        color: open ? 0x7fbc7a : 0x9f694a,
        roughness: 0.5,
        metalness: 0.05
      })
    );
    mesh.rotation.y = placement.rot * (Math.PI * 0.5);
    mesh.position.set(center.x, DOOR_HEIGHT * 0.5, center.y);
    mesh.userData.placementId = placement.id;
    setDoorVisual(mesh, open);
    doorMeshByPlacementId.set(placement.id, mesh);
    doorGroup.add(mesh);

    levelResource.setBlocked(placement.cellX, placement.cellY, !open);
    physics.setColliderEnabled(doorColliderHandle, !open);
  }

  const playerEid = world.createEntity();
  world.playerTags.add(playerEid, true);
  world.persistents.add(playerEid, { kind: "player" });

  const playerX = save ? THREE.MathUtils.clamp(save.player.x, 0.5, def.width - 0.5) : def.playerSpawn.x;
  const playerY = save ? THREE.MathUtils.clamp(save.player.y, 0.5, def.height - 0.5) : def.playerSpawn.y;

  world.transforms.add(playerEid, {
    x: playerX,
    y: playerY
  });
  world.velocities.add(playerEid, { vx: 0, vy: 0 });

  const playerPhysics = physics.createKinematicCapsuleForEid(playerEid, playerX, playerY, PLAYER_RADIUS);
  physicsBodies.add(playerEid, {
    bodyHandle: playerPhysics.bodyHandle
  });
  physicsColliders.add(playerEid, {
    colliderHandle: playerPhysics.colliderHandle
  });

  status(
    save
      ? `Loaded save from ${LOCAL_STORAGE_SAVE_KEY}.`
      : "Initialized mock level with ECS LevelResource + Rapier colliders."
  );

  return {
    world,
    levelResource,
    physics,
    systems,
    playerEid,
    doors,
    physicsBodies,
    physicsColliders,
    doorByPlacementId,
    doorColliderByPlacementId,
    doorMeshByPlacementId,
    interactionQueue: []
  };
}

function disposeRuntime(runtime: RuntimeState | null): void {
  if (!runtime) {
    return;
  }

  for (const mesh of runtime.doorMeshByPlacementId.values()) {
    const material = mesh.material as THREE.Material;
    material.dispose();
  }

  runtime.physics.dispose();
  runtime.doors.clear();
  runtime.physicsBodies.clear();
  runtime.physicsColliders.clear();
  runtime.doorByPlacementId.clear();
  runtime.doorColliderByPlacementId.clear();
  runtime.doorMeshByPlacementId.clear();
}

function updateHud(runtime: RuntimeState, hud: HudHandles): void {
  const player = runtime.world.transforms.get(runtime.playerEid);
  const playerLine = player
    ? `player: (${player.x.toFixed(2)}, ${player.y.toFixed(2)})`
    : "player: missing";

  const doorLines: string[] = [];
  for (const eid of runtime.doors.entries()) {
    const door = runtime.doors.get(eid);
    if (!door) {
      continue;
    }
    doorLines.push(`${door.placementId}: ${door.open ? "open" : "closed"}`);
  }

  hud.stats.textContent = [
    playerLine,
    `frame: ${runtime.world.time.frame}`,
    `fixedDt: ${runtime.physics.fixedDt.toFixed(4)}`,
    `doors: ${doorLines.join(", ")}`
  ].join("\n");
}

const experiment: ExperimentModule = {
  id: "physics-rapier",
  title: "Physics Rapier",
  tags: ["threejs", "ecs", "physics", "rapier", "collision", "save-load"],
  init: async ({ mount, width, height, dpr }) => {
    await ensureRapierReady();

    mount.style.position = "relative";

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x0d1a27);

    const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 200);
    const cameraTarget = new THREE.Vector3(LEVEL_WIDTH * 0.5, 0, LEVEL_HEIGHT * 0.5);
    let zoom = 1;

    const renderer = makeRenderer(width, height, dpr);
    renderer.domElement.style.touchAction = "none";
    renderer.domElement.style.outline = "none";
    renderer.domElement.tabIndex = 0;
    mount.appendChild(renderer.domElement);

    const hud = createHud(mount);

    const hemiLight = new THREE.HemisphereLight(0xdceeff, 0x30485c, 0.95);
    scene.add(hemiLight);

    const keyLight = new THREE.DirectionalLight(0xfff2d5, 1.1);
    keyLight.position.set(14, 22, 8);
    scene.add(keyLight);

    const fillLight = new THREE.DirectionalLight(0xb3d7ff, 0.45);
    fillLight.position.set(-8, 11, -9);
    scene.add(fillLight);

    const floorMesh = new THREE.Mesh(
      new THREE.PlaneGeometry(LEVEL_WIDTH, LEVEL_HEIGHT),
      new THREE.MeshStandardMaterial({
        color: 0x41613f,
        roughness: 0.95,
        metalness: 0.01
      })
    );
    floorMesh.rotation.x = -Math.PI * 0.5;
    floorMesh.position.set(LEVEL_WIDTH * 0.5, 0, LEVEL_HEIGHT * 0.5);
    scene.add(floorMesh);

    const grid = new THREE.GridHelper(LEVEL_WIDTH, LEVEL_WIDTH, 0x8eb38f, 0x5f8b62);
    grid.position.set(LEVEL_WIDTH * 0.5, FLOOR_HEIGHT, LEVEL_HEIGHT * 0.5);
    (grid.material as THREE.Material).transparent = true;
    (grid.material as THREE.Material).opacity = 0.36;
    scene.add(grid);

    const wallGroup = new THREE.Group();
    const doorGroup = new THREE.Group();
    scene.add(wallGroup);
    scene.add(doorGroup);

    const wallGeometry = new THREE.BoxGeometry(1, WALL_HEIGHT, 1);
    const wallMaterial = new THREE.MeshStandardMaterial({
      color: 0x7c8b97,
      roughness: 0.7,
      metalness: 0.05
    });

    const doorGeometry = new THREE.BoxGeometry(0.9, DOOR_HEIGHT, 0.2);

    const playerMesh = new THREE.Mesh(
      new THREE.CylinderGeometry(PLAYER_RADIUS, PLAYER_RADIUS, 0.6, 24),
      new THREE.MeshStandardMaterial({
        color: 0xffc862,
        roughness: 0.45,
        metalness: 0.06
      })
    );
    playerMesh.position.y = 0.3;
    scene.add(playerMesh);

    const keyboard = new KeyboardTracker(window);
    const systems = {
      inputSystem: createInputSystem(keyboard)
    };

    let statusMessage = "Ready.";
    const setStatus = (message: string): void => {
      statusMessage = message;
      hud.status.textContent = message;
      console.log(message);
    };

    let runtime: RuntimeState | null = createRuntimeState({
      systems,
      wallGroup,
      doorGroup,
      wallGeometry,
      wallMaterial,
      doorGeometry,
      status: setStatus
    });

    function applyCamera(): void {
      const viewportWidth = Math.max(1, mount.clientWidth || width);
      const viewportHeight = Math.max(1, mount.clientHeight || height);
      const aspect = viewportWidth / viewportHeight;
      const halfHeight = (ORTHO_HEIGHT * 0.5) / zoom;
      const halfWidth = halfHeight * aspect;

      camera.left = -halfWidth;
      camera.right = halfWidth;
      camera.top = halfHeight;
      camera.bottom = -halfHeight;

      const horizontalDistance = Math.cos(CAMERA_PITCH) * CAMERA_DISTANCE;
      camera.position.set(
        cameraTarget.x + Math.cos(CAMERA_YAW) * horizontalDistance,
        cameraTarget.y + Math.sin(CAMERA_PITCH) * CAMERA_DISTANCE,
        cameraTarget.z + Math.sin(CAMERA_YAW) * horizontalDistance
      );
      camera.lookAt(cameraTarget);
      camera.updateProjectionMatrix();
    }

    const inputRight = new THREE.Vector3();
    const inputForward = new THREE.Vector3();

    // Screen-relative movement: W/Up always moves toward the top of the viewport.
    function runCameraRelativePlayerInputSystem(world: World): void {
      let inputX = 0;
      let inputY = 0;

      if (world.input.left) inputX -= 1;
      if (world.input.right) inputX += 1;
      if (world.input.up) inputY += 1;
      if (world.input.down) inputY -= 1;

      inputRight.set(1, 0, 0).applyQuaternion(camera.quaternion);
      inputRight.y = 0;
      if (inputRight.lengthSq() > 0.000001) {
        inputRight.normalize();
      }

      inputForward.set(0, 0, -1).applyQuaternion(camera.quaternion);
      inputForward.y = 0;
      if (inputForward.lengthSq() > 0.000001) {
        inputForward.normalize();
      }

      let moveX = inputRight.x * inputX + inputForward.x * inputY;
      let moveY = inputRight.z * inputX + inputForward.z * inputY;

      const length = Math.hypot(moveX, moveY);
      if (length > 0) {
        moveX /= length;
        moveY /= length;
      }

      const vx = moveX * PLAYER_SPEED;
      const vy = moveY * PLAYER_SPEED;

      for (const eid of world.queryTransformPlayer()) {
        if (!world.velocities.has(eid)) {
          world.velocities.add(eid, { vx: 0, vy: 0 });
        }

        const velocity = world.velocities.get(eid);
        if (!velocity) {
          continue;
        }

        velocity.vx = vx;
        velocity.vy = vy;
      }
    }

    function rebuildFromSave(save: PhysicsRapierSave): void {
      const prev = runtime;
      runtime = createRuntimeState({
        systems,
        wallGroup,
        doorGroup,
        wallGeometry,
        wallMaterial,
        doorGeometry,
        save,
        status: setStatus
      });
      disposeRuntime(prev);
    }

    const raycaster = new THREE.Raycaster();
    const ndc = new THREE.Vector2();
    let pointerDown = false;
    let pointerMoved = false;
    let pointerDownX = 0;
    let pointerDownY = 0;

    function queueDoorClick(event: PointerEvent): void {
      if (!runtime) {
        return;
      }

      const rect = renderer.domElement.getBoundingClientRect();
      ndc.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
      ndc.y = -(((event.clientY - rect.top) / rect.height) * 2 - 1);

      raycaster.setFromCamera(ndc, camera);
      const hit = raycaster
        .intersectObjects([...runtime.doorMeshByPlacementId.values()], false)
        .find((entry) => typeof entry.object.userData.placementId === "string");

      if (!hit) {
        return;
      }

      const placementId = hit.object.userData.placementId as string;
      runtime.interactionQueue.push(placementId);
    }

    function onPointerDown(event: PointerEvent): void {
      if (event.button !== 0) {
        return;
      }

      pointerDown = true;
      pointerMoved = false;
      pointerDownX = event.clientX;
      pointerDownY = event.clientY;
      renderer.domElement.setPointerCapture(event.pointerId);
    }

    function onPointerMove(event: PointerEvent): void {
      if (!pointerDown) {
        return;
      }

      if (Math.abs(event.clientX - pointerDownX) > 4 || Math.abs(event.clientY - pointerDownY) > 4) {
        pointerMoved = true;
      }
    }

    function onPointerUp(event: PointerEvent): void {
      if (!pointerDown) {
        return;
      }

      pointerDown = false;
      renderer.domElement.releasePointerCapture(event.pointerId);
      if (!pointerMoved) {
        queueDoorClick(event);
      }
    }

    function onPointerCancel(event: PointerEvent): void {
      if (!pointerDown) {
        return;
      }
      pointerDown = false;
      renderer.domElement.releasePointerCapture(event.pointerId);
    }

    function onWheel(event: WheelEvent): void {
      const zoomDelta = event.deltaY > 0 ? 0.93 : 1.07;
      zoom = THREE.MathUtils.clamp(zoom * zoomDelta, ZOOM_MIN, ZOOM_MAX);
      applyCamera();
      event.preventDefault();
    }

    renderer.domElement.addEventListener("pointerdown", onPointerDown);
    renderer.domElement.addEventListener("pointermove", onPointerMove);
    renderer.domElement.addEventListener("pointerup", onPointerUp);
    renderer.domElement.addEventListener("pointercancel", onPointerCancel);
    renderer.domElement.addEventListener("wheel", onWheel, { passive: false });

    const resizeObserver = new ResizeObserver(() => {
      const rect = mount.getBoundingClientRect();
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
      renderer.setSize(Math.max(1, rect.width), Math.max(1, rect.height), true);
      applyCamera();
    });
    resizeObserver.observe(mount);

    applyCamera();

    let raf = 0;
    let previousNow = performance.now();

    const loop = (now: number): void => {
      const frameDt = Math.min(0.25, (now - previousNow) / 1000);
      previousNow = now;

      let shouldLoad = false;

      if (runtime) {
        runtime.physics.accumulator += frameDt;

        let steps = 0;
        while (runtime.physics.accumulator >= runtime.physics.fixedDt && steps < MAX_STEPS_PER_FRAME) {
          const stepDt = runtime.physics.fixedDt;
          runtime.physics.accumulator -= stepDt;
          steps += 1;

          runtime.world.time.dt = stepDt;
          runtime.world.time.t += stepDt;
          runtime.world.time.frame += 1;

          runtime.systems.inputSystem(runtime.world);
          runCameraRelativePlayerInputSystem(runtime.world);
          runPhysicsSyncIn(runtime);
          runtime.physics.step(stepDt);
          runPhysicsSyncOut(runtime);
          runDoorInteractionSystem(runtime);

          if (runtime.world.input.savePressed) {
            saveGame(runtime, setStatus);
          }

          if (runtime.world.input.loadPressed) {
            shouldLoad = true;
            break;
          }
        }

        const playerTransform = runtime.world.transforms.get(runtime.playerEid);
        if (playerTransform) {
          playerMesh.position.x = playerTransform.x;
          playerMesh.position.z = playerTransform.y;
        }

        updateHud(runtime, hud);
      }

      if (shouldLoad) {
        const loaded = loadGameFromLocalStorage();
        if (!loaded) {
          setStatus(`No valid game save found in ${LOCAL_STORAGE_SAVE_KEY}.`);
        } else {
          rebuildFromSave(loaded);
        }
      }

      if (hud.status.textContent !== statusMessage) {
        hud.status.textContent = statusMessage;
      }

      renderer.render(scene, camera);
      raf = requestAnimationFrame(loop);
    };

    raf = requestAnimationFrame(loop);

    return () => {
      cancelAnimationFrame(raf);
      resizeObserver.disconnect();

      renderer.domElement.removeEventListener("pointerdown", onPointerDown);
      renderer.domElement.removeEventListener("pointermove", onPointerMove);
      renderer.domElement.removeEventListener("pointerup", onPointerUp);
      renderer.domElement.removeEventListener("pointercancel", onPointerCancel);
      renderer.domElement.removeEventListener("wheel", onWheel);

      keyboard.dispose(window);
      disposeRuntime(runtime);

      rebuildGroup(wallGroup);
      rebuildGroup(doorGroup);

      floorMesh.geometry.dispose();
      (floorMesh.material as THREE.Material).dispose();
      (grid.material as THREE.Material).dispose();
      wallGeometry.dispose();
      wallMaterial.dispose();
      doorGeometry.dispose();
      playerMesh.geometry.dispose();
      (playerMesh.material as THREE.Material).dispose();

      hud.destroy();
      renderer.dispose();
      renderer.domElement.remove();
      mount.style.position = "";
    };
  }
};

export default experiment;
