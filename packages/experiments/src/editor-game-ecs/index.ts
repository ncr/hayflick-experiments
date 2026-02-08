/**
 * Per-frame flow for this combined editor + game experiment:
 * 1) EDITOR mode mutates a pure LevelModel (tiles + placements) via pointer painting.
 * 2) F5 bakes LevelModel into a mutable ECS LevelResource (derived blocked arrays).
 * 3) GAME mode runs ECS systems in order: Input -> PlayerInput -> DoorSystem -> Movement -> Event.
 * 4) Door interactions are queued from clicks, then DoorSystem toggles state and walkability.
 * 5) K/L in GAME save/load full game state (LevelModel + player + door states by placementId).
 * 6) ESC returns to EDITOR without mutating LevelModel from runtime-only door toggles.
 */

import * as THREE from "three";
import { makeRenderer } from "@common/render";
import {
  TILE_WALKABLE,
  TILE_WALL,
  addDoorPlacement,
  bakeTileLevel,
  cloneLevelModel,
  createDefaultLevelModel,
  findDoorPlacementAt,
  getTileAt,
  inBounds,
  nextPlacementId,
  parseLevelModel,
  removeDoorPlacementAt,
  serializeLevelModel,
  setTileAt,
  type DoorPlacementData,
  type LevelModel,
  type MutableGridLevelResource,
  type Placement
} from "@common/level-editor";
import {
  DataStore,
  KeyboardTracker,
  World,
  createEventSystem,
  createInputSystem,
  createMovementSystem,
  type EID
} from "@common/gameplay";
import type { ExperimentModule } from "../runtime/types";

type Mode = "EDITOR" | "GAME";

type EditorBrush = "wall" | "walkable" | "door" | "erase-door";

type DragState = {
  pointerId: number;
  mode: "pan" | "paint" | "game-click";
  lastClientX: number;
  lastClientY: number;
  lastWorld: THREE.Vector3 | null;
  moved: boolean;
};

type DoorComponent = {
  placementId: string;
  cellX: number;
  cellY: number;
  rot: number;
  open: boolean;
  locked?: boolean;
};

type DoorVisual = {
  root: THREE.Group;
  leafPivot: THREE.Group;
};

type DoorGeometrySet = {
  leftJamb: THREE.BoxGeometry;
  rightJamb: THREE.BoxGeometry;
  header: THREE.BoxGeometry;
  threshold: THREE.BoxGeometry;
  leaf: THREE.BoxGeometry;
  handle: THREE.BoxGeometry;
};

type DoorOverride = {
  open: boolean;
  locked?: boolean;
};

type GameRuntime = {
  world: World;
  levelResource: MutableGridLevelResource;
  keyboard: KeyboardTracker;
  systems: {
    inputSystem: ReturnType<typeof createInputSystem>;
    movementSystem: ReturnType<typeof createMovementSystem>;
    eventSystem: ReturnType<typeof createEventSystem>;
  };
  playerEid: EID;
  doors: DataStore<DoorComponent>;
  doorByPlacementId: Map<string, EID>;
  placementIdByCell: Map<string, string>;
  doorVisuals: Map<string, DoorVisual>;
  interactionQueue: Array<{ cellX: number; cellY: number }>;
};

type GameSaveDoor = {
  placementId: string;
  open: boolean;
  locked?: boolean;
};

type GameSave = {
  schemaVersion: number;
  levelModel: LevelModel;
  player: {
    x: number;
    y: number;
  };
  doors: GameSaveDoor[];
};

const LEVEL_MODEL_STORAGE_KEY = "editor_game_ecs_level_model_v1";
const GAME_SAVE_STORAGE_KEY = "editor_game_ecs_game_save_v1";
const GAME_SAVE_SCHEMA_VERSION = 1;

const CAMERA_PITCH = THREE.MathUtils.degToRad(35.26438968);
const CAMERA_BASE_YAW = THREE.MathUtils.degToRad(45);
const CAMERA_DISTANCE = 30;
const ORTHO_HEIGHT = 24;
const ZOOM_MIN = 0.5;
const ZOOM_MAX = 3.4;

const PLAYER_SPEED = 3.8;
const PLAYER_SPAWN = { x: 2.5, y: 2.5 };

function cellKey(x: number, y: number): string {
  return `${x},${y}`;
}

function readRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  return value as Record<string, unknown>;
}

function readFiniteNumber(record: Record<string, unknown>, key: string): number | null {
  const value = record[key];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return null;
  }
  return value;
}

function createGridGeometry(width: number, height: number, y: number): THREE.BufferGeometry {
  const lines: number[] = [];
  const originX = -(width * 0.5);
  const originY = -(height * 0.5);

  for (let x = 0; x <= width; x += 1) {
    const worldX = originX + x;
    lines.push(worldX, y, originY, worldX, y, originY + height);
  }

  for (let yCell = 0; yCell <= height; yCell += 1) {
    const worldY = originY + yCell;
    lines.push(originX, y, worldY, originX + width, y, worldY);
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(lines, 3));
  return geometry;
}

function toWorldX(level: LevelModel, cellX: number): number {
  return -(level.width * 0.5) + cellX + 0.5;
}

function toWorldZ(level: LevelModel, cellY: number): number {
  return -(level.height * 0.5) + cellY + 0.5;
}

function toWorldCoordX(level: LevelModel, x: number): number {
  return x - level.width * 0.5;
}

function toWorldCoordZ(level: LevelModel, y: number): number {
  return y - level.height * 0.5;
}

function worldToCell(level: LevelModel, worldX: number, worldZ: number): { x: number; y: number } | null {
  const cellX = Math.floor(worldX + level.width * 0.5);
  const cellY = Math.floor(worldZ + level.height * 0.5);

  if (!inBounds(level, cellX, cellY)) {
    return null;
  }

  return { x: cellX, y: cellY };
}

function createDoorVisual(
  geometries: DoorGeometrySet,
  materials: {
  frame: THREE.Material;
  leaf: THREE.Material;
  handle: THREE.Material;
}
): DoorVisual {
  const root = new THREE.Group();

  const leftJamb = new THREE.Mesh(geometries.leftJamb, materials.frame);
  leftJamb.position.set(-0.39, 0.9, 0);
  root.add(leftJamb);

  const rightJamb = new THREE.Mesh(geometries.rightJamb, materials.frame);
  rightJamb.position.set(0.39, 0.9, 0);
  root.add(rightJamb);

  const header = new THREE.Mesh(geometries.header, materials.frame);
  header.position.set(0, 1.72, 0);
  root.add(header);

  const threshold = new THREE.Mesh(geometries.threshold, materials.frame);
  threshold.position.set(0, 0.03, 0);
  root.add(threshold);

  const leafPivot = new THREE.Group();
  leafPivot.position.set(-0.33, 0, 0);

  const leaf = new THREE.Mesh(geometries.leaf, materials.leaf);
  leaf.position.set(0.33, 0.78, 0);
  leafPivot.add(leaf);

  const handle = new THREE.Mesh(geometries.handle, materials.handle);
  handle.position.set(0.61, 0.82, 0.06);
  leafPivot.add(handle);

  root.add(leafPivot);

  return { root, leafPivot };
}

function setDoorVisualOpen(door: DoorVisual, open: boolean): void {
  door.leafPivot.rotation.y = open ? -Math.PI * 0.5 : 0;
}

function findPlayerTransform(world: World): { x: number; y: number } | null {
  for (const eid of world.queryTransformPlayer()) {
    const transform = world.transforms.get(eid);
    if (transform) {
      return { x: transform.x, y: transform.y };
    }
  }
  return null;
}

function parseGameSave(raw: unknown): GameSave | null {
  const record = readRecord(raw);
  if (!record) {
    return null;
  }

  const schemaVersion = readFiniteNumber(record, "schemaVersion");
  if (schemaVersion === null || schemaVersion !== GAME_SAVE_SCHEMA_VERSION) {
    return null;
  }

  const playerRaw = readRecord(record.player);
  const levelRaw = record.levelModel;
  const doorsRaw = record.doors;

  if (!playerRaw || !Array.isArray(doorsRaw)) {
    return null;
  }

  const levelModel = parseLevelModel(levelRaw);
  if (!levelModel) {
    return null;
  }

  const playerX = readFiniteNumber(playerRaw, "x");
  const playerY = readFiniteNumber(playerRaw, "y");
  if (playerX === null || playerY === null) {
    return null;
  }

  const doors: GameSaveDoor[] = [];

  for (const doorRaw of doorsRaw) {
    const door = readRecord(doorRaw);
    if (!door) {
      return null;
    }

    const placementId = door.placementId;
    const open = door.open;
    const locked = door.locked;

    if (typeof placementId !== "string" || typeof open !== "boolean") {
      return null;
    }

    if (locked !== undefined && typeof locked !== "boolean") {
      return null;
    }

    doors.push({
      placementId,
      open,
      locked
    });
  }

  return {
    schemaVersion,
    levelModel,
    player: {
      x: playerX,
      y: playerY
    },
    doors
  };
}

const experiment: ExperimentModule = {
  id: "editor-game-ecs",
  title: "Editor + Game (ECS)",
  tags: ["threejs", "editor", "ecs", "level-bake", "save-load"],
  init: ({ mount, width, height, dpr }) => {
    mount.style.position = "relative";

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x101821);

    const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 200);
    let viewportWidth = Math.max(1, width);
    let viewportHeight = Math.max(1, height);

    const renderer = makeRenderer(viewportWidth, viewportHeight, dpr);
    renderer.setPixelRatio(dpr);
    renderer.setSize(viewportWidth, viewportHeight, true);
    renderer.domElement.style.touchAction = "none";
    renderer.domElement.style.outline = "none";
    renderer.domElement.style.display = "block";
    renderer.domElement.tabIndex = 0;
    mount.appendChild(renderer.domElement);

    const hemiLight = new THREE.HemisphereLight(0xd3e9ff, 0x2f3944, 0.95);
    scene.add(hemiLight);

    const keyLight = new THREE.DirectionalLight(0xfff0d8, 1.14);
    keyLight.position.set(20, 26, 14);
    scene.add(keyLight);

    const fillLight = new THREE.DirectionalLight(0xc2deff, 0.45);
    fillLight.position.set(-10, 12, -10);
    scene.add(fillLight);

    const floorGroup = new THREE.Group();
    const wallGroup = new THREE.Group();
    const editorDoorGroup = new THREE.Group();
    const gameDoorGroup = new THREE.Group();
    const gameplayGroup = new THREE.Group();

    scene.add(floorGroup);
    scene.add(wallGroup);
    scene.add(editorDoorGroup);
    scene.add(gameDoorGroup);
    scene.add(gameplayGroup);

    let minorGridGeometry = createGridGeometry(18, 18, 0.01);
    const minorGridMaterial = new THREE.LineBasicMaterial({ color: 0x42617c, transparent: true, opacity: 0.65 });
    const gridLines = new THREE.LineSegments(minorGridGeometry, minorGridMaterial);
    scene.add(gridLines);

    const floorGeometry = new THREE.BoxGeometry(1, 0.06, 1);
    const wallCoreGeometry = new THREE.BoxGeometry(0.94, 1.6, 0.94);
    const wallCapGeometry = new THREE.BoxGeometry(1, 0.12, 1);
    const playerBodyGeometry = new THREE.CylinderGeometry(0.25, 0.25, 1.0, 14);
    const playerHeadGeometry = new THREE.SphereGeometry(0.2, 12, 10);
    const doorGeometries: DoorGeometrySet = {
      leftJamb: new THREE.BoxGeometry(0.12, 1.8, 0.16),
      rightJamb: new THREE.BoxGeometry(0.12, 1.8, 0.16),
      header: new THREE.BoxGeometry(0.9, 0.16, 0.16),
      threshold: new THREE.BoxGeometry(0.86, 0.06, 0.12),
      leaf: new THREE.BoxGeometry(0.66, 1.48, 0.08),
      handle: new THREE.BoxGeometry(0.06, 0.06, 0.06)
    };

    const floorMaterial = new THREE.MeshStandardMaterial({ color: 0x7592a7, roughness: 0.9, metalness: 0.03 });
    const wallMaterial = new THREE.MeshStandardMaterial({ color: 0xbec9d2, roughness: 0.72, metalness: 0.04 });
    const wallCapMaterial = new THREE.MeshStandardMaterial({ color: 0xa6b6c4, roughness: 0.58, metalness: 0.08 });

    const doorMaterials = {
      frame: new THREE.MeshStandardMaterial({ color: 0xbd986f, roughness: 0.66, metalness: 0.04 }),
      leaf: new THREE.MeshStandardMaterial({ color: 0x93613e, roughness: 0.61, metalness: 0.03 }),
      handle: new THREE.MeshStandardMaterial({ color: 0xe2cb89, roughness: 0.24, metalness: 0.45 })
    };

    const playerBodyMaterial = new THREE.MeshStandardMaterial({ color: 0x74b8db, roughness: 0.58, metalness: 0.05 });
    const playerHeadMaterial = new THREE.MeshStandardMaterial({ color: 0xe8f3ff, roughness: 0.4, metalness: 0.03 });

    const hoverMaterial = new THREE.MeshBasicMaterial({
      color: 0x72b9ff,
      transparent: true,
      opacity: 0.38,
      depthWrite: false
    });
    const hoverMesh = new THREE.Mesh(new THREE.BoxGeometry(1, 0.04, 1), hoverMaterial);
    hoverMesh.visible = false;
    hoverMesh.position.y = 0.03;
    scene.add(hoverMesh);

    const playerMesh = new THREE.Group();
    const playerBody = new THREE.Mesh(playerBodyGeometry, playerBodyMaterial);
    playerBody.position.y = 0.5;
    playerMesh.add(playerBody);

    const playerHead = new THREE.Mesh(playerHeadGeometry, playerHeadMaterial);
    playerHead.position.y = 1.15;
    playerMesh.add(playerHead);

    gameplayGroup.add(playerMesh);
    playerMesh.visible = false;

    const hud = document.createElement("div");
    hud.style.position = "absolute";
    hud.style.inset = "12px";
    hud.style.display = "flex";
    hud.style.justifyContent = "space-between";
    hud.style.alignItems = "flex-start";
    hud.style.pointerEvents = "none";
    hud.style.fontFamily = "\"IBM Plex Sans\", \"Segoe UI\", sans-serif";
    hud.style.color = "#daecf9";
    hud.style.gap = "10px";
    mount.appendChild(hud);

    const panelStyle = (panel: HTMLDivElement): void => {
      panel.style.pointerEvents = "auto";
      panel.style.background = "rgba(8, 15, 24, 0.78)";
      panel.style.border = "1px solid rgba(115, 148, 175, 0.42)";
      panel.style.borderRadius = "10px";
      panel.style.padding = "10px";
      panel.style.display = "flex";
      panel.style.flexDirection = "column";
      panel.style.gap = "8px";
      panel.style.backdropFilter = "blur(6px)";
    };

    const leftPanel = document.createElement("div");
    panelStyle(leftPanel);
    leftPanel.style.width = "min(430px, 58vw)";
    hud.appendChild(leftPanel);

    const rightPanel = document.createElement("div");
    panelStyle(rightPanel);
    rightPanel.style.minWidth = "300px";
    hud.appendChild(rightPanel);

    const title = document.createElement("div");
    title.textContent = "Editor + Game (ECS)";
    title.style.fontWeight = "600";
    title.style.letterSpacing = "0.02em";
    leftPanel.appendChild(title);

    const subtitle = document.createElement("div");
    subtitle.textContent = "Build LevelModel in EDITOR, bake to LevelResource, then run ECS gameplay in GAME mode.";
    subtitle.style.fontSize = "12px";
    subtitle.style.lineHeight = "1.35";
    subtitle.style.opacity = "0.9";
    leftPanel.appendChild(subtitle);

    function makeRow(label: string): HTMLDivElement {
      const row = document.createElement("div");
      row.style.display = "grid";
      row.style.gridTemplateColumns = "72px 1fr";
      row.style.alignItems = "center";
      row.style.gap = "8px";

      const caption = document.createElement("span");
      caption.textContent = label;
      caption.style.fontSize = "12px";
      caption.style.opacity = "0.85";
      row.appendChild(caption);

      const controls = document.createElement("div");
      controls.style.display = "flex";
      controls.style.flexWrap = "wrap";
      controls.style.gap = "6px";
      row.appendChild(controls);

      leftPanel.appendChild(row);
      return controls;
    }

    function makeButton(label: string, onClick: () => void): HTMLButtonElement {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = label;
      button.style.border = "1px solid rgba(118, 150, 178, 0.62)";
      button.style.background = "rgba(17, 30, 42, 0.95)";
      button.style.color = "#daecf9";
      button.style.padding = "4px 8px";
      button.style.borderRadius = "8px";
      button.style.fontSize = "12px";
      button.style.cursor = "pointer";
      button.addEventListener("click", (event) => {
        event.preventDefault();
        onClick();
        renderer.domElement.focus({ preventScroll: true });
      });
      return button;
    }

    function setButtonActive(button: HTMLButtonElement, active: boolean): void {
      if (active) {
        button.style.background = "rgba(69, 134, 184, 0.92)";
        button.style.borderColor = "rgba(150, 199, 233, 0.94)";
        button.style.color = "#f2fbff";
      } else {
        button.style.background = "rgba(17, 30, 42, 0.95)";
        button.style.borderColor = "rgba(118, 150, 178, 0.62)";
        button.style.color = "#daecf9";
      }
    }

    const modeButtons = new Map<Mode, HTMLButtonElement>();
    const brushButtons = new Map<EditorBrush, HTMLButtonElement>();

    let mode: Mode = "EDITOR";
    let editorBrush: EditorBrush = "wall";
    let editorDoorRot = 0;
    let statusMessage = "Ready.";

    const modeRow = makeRow("Mode");
    const editorButton = makeButton("EDITOR (ESC)", () => {
      enterEditor();
    });
    const gameButton = makeButton("GAME (F5)", () => {
      enterGame();
    });
    modeButtons.set("EDITOR", editorButton);
    modeButtons.set("GAME", gameButton);
    modeRow.append(editorButton, gameButton);

    const brushRow = makeRow("Brush");
    const wallButton = makeButton("Wall (1)", () => {
      editorBrush = "wall";
      syncHud();
    });
    const walkableButton = makeButton("Walkable (2)", () => {
      editorBrush = "walkable";
      syncHud();
    });
    const doorButton = makeButton("Door (3)", () => {
      editorBrush = "door";
      syncHud();
    });
    const eraseDoorButton = makeButton("Erase Door (4)", () => {
      editorBrush = "erase-door";
      syncHud();
    });

    brushButtons.set("wall", wallButton);
    brushButtons.set("walkable", walkableButton);
    brushButtons.set("door", doorButton);
    brushButtons.set("erase-door", eraseDoorButton);

    brushRow.append(wallButton, walkableButton, doorButton, eraseDoorButton);

    const toolsRow = makeRow("Tools");
    const saveLevelButton = makeButton("Save Level (Ctrl+S)", () => {
      saveLevelModelNow();
    });
    const saveGameButton = makeButton("Save Game (K)", () => {
      if (mode !== "GAME") {
        statusMessage = "Switch to GAME mode to save a game.";
        syncHud();
        return;
      }

      saveGameNow();
    });
    const loadGameButton = makeButton("Load Game (L)", () => {
      if (mode !== "GAME") {
        statusMessage = "Switch to GAME mode to load a game save.";
        syncHud();
        return;
      }

      loadGameNow();
    });
    toolsRow.append(saveLevelButton, saveGameButton, loadGameButton);

    const stats = document.createElement("div");
    stats.dataset.testid = "editor-game-ecs-stats";
    stats.style.fontSize = "12px";
    stats.style.lineHeight = "1.4";
    stats.style.color = "#c8deee";
    rightPanel.appendChild(stats);

    const status = document.createElement("div");
    status.dataset.testid = "editor-game-ecs-status";
    status.style.fontSize = "12px";
    status.style.lineHeight = "1.35";
    status.style.color = "#e3f3ff";
    rightPanel.appendChild(status);

    const hints = document.createElement("div");
    hints.style.fontSize = "12px";
    hints.style.lineHeight = "1.35";
    hints.style.opacity = "0.93";
    hints.textContent =
      "EDITOR: paint with LMB drag, Ctrl+S saves LevelModel. GAME: click doors to toggle, K saves game, L loads game. Camera: Q/E rotate, wheel zoom, trackpad pan, MMB or Space+drag pan.";
    rightPanel.appendChild(hints);

    let levelModel = createDefaultLevelModel();
    const savedLevelModelJson = localStorage.getItem(LEVEL_MODEL_STORAGE_KEY);
    if (savedLevelModelJson) {
      try {
        const parsed = parseLevelModel(JSON.parse(savedLevelModelJson));
        if (parsed) {
          levelModel = parsed;
          statusMessage = "Loaded LevelModel from localStorage.";
        }
      } catch {
        // Keep default model if stored value is invalid JSON.
      }
    }

    const raycaster = new THREE.Raycaster();
    const pointerNdc = new THREE.Vector2();
    const groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
    const worldPoint = new THREE.Vector3();

    const cameraTarget = new THREE.Vector3(0, 0, 0);
    let yawIndex = 0;
    let yawCurrent = CAMERA_BASE_YAW;
    let zoomTarget = 1.2;
    let zoomCurrent = zoomTarget;

    const panRight = new THREE.Vector3();
    const panForward = new THREE.Vector3();
    const panDelta = new THREE.Vector3();
    const inputRight = new THREE.Vector3();
    const inputForward = new THREE.Vector3();

    let dragState: DragState | null = null;
    let spacePressed = false;
    let raf = 0;

    let gameRuntime: GameRuntime | null = null;

    function clearGroup(group: THREE.Group): void {
      for (let i = group.children.length - 1; i >= 0; i -= 1) {
        group.remove(group.children[i]);
      }
    }

    function updateGridGeometry(): void {
      const nextGeometry = createGridGeometry(levelModel.width, levelModel.height, 0.01);
      gridLines.geometry = nextGeometry;
      minorGridGeometry.dispose();
      minorGridGeometry = nextGeometry;
    }

    function rebuildBaseLevelMeshes(): void {
      clearGroup(floorGroup);
      clearGroup(wallGroup);

      const doorCells = new Set(levelModel.placements.map((placement) => cellKey(placement.x, placement.y)));

      for (let y = 0; y < levelModel.height; y += 1) {
        for (let x = 0; x < levelModel.width; x += 1) {
          const floorTile = new THREE.Mesh(floorGeometry, floorMaterial);
          floorTile.position.set(toWorldX(levelModel, x), 0.03, toWorldZ(levelModel, y));
          floorGroup.add(floorTile);

          if (getTileAt(levelModel, x, y) !== TILE_WALL || doorCells.has(cellKey(x, y))) {
            continue;
          }

          const wall = new THREE.Group();
          const wallCore = new THREE.Mesh(wallCoreGeometry, wallMaterial);
          wallCore.position.y = 0.82;
          wall.add(wallCore);

          const wallCap = new THREE.Mesh(wallCapGeometry, wallCapMaterial);
          wallCap.position.y = 1.68;
          wall.add(wallCap);

          wall.position.set(toWorldX(levelModel, x), 0, toWorldZ(levelModel, y));
          wallGroup.add(wall);
        }
      }
    }

    function rebuildEditorDoorMeshes(): void {
      clearGroup(editorDoorGroup);

      for (const placement of levelModel.placements) {
        if (placement.kind !== "door") {
          continue;
        }

        const doorVisual = createDoorVisual(doorGeometries, doorMaterials);
        setDoorVisualOpen(doorVisual, placement.data?.open === true);

        doorVisual.root.position.set(
          toWorldX(levelModel, placement.x),
          0,
          toWorldZ(levelModel, placement.y)
        );
        doorVisual.root.rotation.y = ((placement.rot ?? 0) % 4) * (Math.PI * 0.5);

        editorDoorGroup.add(doorVisual.root);
      }
    }

    function updateHover(world: THREE.Vector3 | null): void {
      if (mode !== "EDITOR" || !world) {
        hoverMesh.visible = false;
        return;
      }

      const cell = worldToCell(levelModel, world.x, world.z);
      if (!cell) {
        hoverMesh.visible = false;
        return;
      }

      hoverMesh.visible = true;
      hoverMesh.position.set(toWorldX(levelModel, cell.x), 0.03, toWorldZ(levelModel, cell.y));

      if (editorBrush === "wall") {
        hoverMaterial.color.setHex(0x8fc6f5);
      } else if (editorBrush === "walkable") {
        hoverMaterial.color.setHex(0x86cf97);
      } else if (editorBrush === "door") {
        hoverMaterial.color.setHex(0xd8ac79);
      } else {
        hoverMaterial.color.setHex(0xe08484);
      }
    }

    function syncHud(): void {
      modeButtons.forEach((button, buttonMode) => {
        setButtonActive(button, mode === buttonMode);
      });

      brushButtons.forEach((button, brush) => {
        setButtonActive(button, mode === "EDITOR" && editorBrush === brush);
      });

      const doorCount = levelModel.placements.length;
      const wallCount = levelModel.tiles.filter((tile) => tile === TILE_WALL).length;
      const viewStep = ((yawIndex % 4) + 4) % 4;

      const playerTransform = gameRuntime ? findPlayerTransform(gameRuntime.world) : null;
      const playerText = playerTransform
        ? `Player=(${playerTransform.x.toFixed(2)}, ${playerTransform.y.toFixed(2)})`
        : "Player=<none>";

      stats.textContent = [
        `Mode: ${mode}`,
        `Grid: ${levelModel.width}x${levelModel.height}`,
        `Tiles wall/walkable: ${wallCount}/${levelModel.tiles.length - wallCount}`,
        `Doors: ${doorCount}`,
        `Door rot brush: ${(editorDoorRot % 4 + 4) % 4}`,
        `View: ${viewStep}/4`,
        mode === "GAME" ? playerText : ""
      ]
        .filter(Boolean)
        .join("  •  ");

      status.textContent = statusMessage;
    }

    function updateCameraProjection(): void {
      const aspect = viewportWidth / viewportHeight;
      const halfHeight = ORTHO_HEIGHT * 0.5;

      camera.left = -halfHeight * aspect;
      camera.right = halfHeight * aspect;
      camera.top = halfHeight;
      camera.bottom = -halfHeight;
      camera.updateProjectionMatrix();
    }

    function applyPanByPixels(deltaX: number, deltaY: number): void {
      const worldUnitsPerPixel = ORTHO_HEIGHT / zoomCurrent / viewportHeight;

      panRight.set(1, 0, 0).applyQuaternion(camera.quaternion);
      panRight.y = 0;
      panRight.normalize();

      panForward.set(0, 0, -1).applyQuaternion(camera.quaternion);
      panForward.y = 0;
      panForward.normalize();

      panDelta.set(0, 0, 0);
      panDelta.addScaledVector(panRight, -deltaX * worldUnitsPerPixel);
      panDelta.addScaledVector(panForward, deltaY * worldUnitsPerPixel);
      cameraTarget.add(panDelta);
    }

    function setCameraPose(): void {
      const yawTarget = CAMERA_BASE_YAW + yawIndex * (Math.PI * 0.5);
      const delta = Math.atan2(Math.sin(yawTarget - yawCurrent), Math.cos(yawTarget - yawCurrent));
      yawCurrent += delta * 0.22;
      zoomCurrent = THREE.MathUtils.lerp(zoomCurrent, zoomTarget, 0.18);

      const horizontal = Math.cos(CAMERA_PITCH);
      const dir = new THREE.Vector3(
        Math.sin(yawCurrent) * horizontal,
        Math.sin(CAMERA_PITCH),
        Math.cos(yawCurrent) * horizontal
      );

      camera.position.copy(cameraTarget).addScaledVector(dir, CAMERA_DISTANCE);
      camera.lookAt(cameraTarget);
      camera.zoom = zoomCurrent;
      camera.updateProjectionMatrix();
    }

    // Player movement is view-relative: W/Up moves toward the top of the screen
    // regardless of 90-degree camera rotation.
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

    function worldAtClient(clientX: number, clientY: number): THREE.Vector3 | null {
      const rect = renderer.domElement.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) {
        return null;
      }

      pointerNdc.x = ((clientX - rect.left) / rect.width) * 2 - 1;
      pointerNdc.y = -((clientY - rect.top) / rect.height) * 2 + 1;
      raycaster.setFromCamera(pointerNdc, camera);

      const hit = raycaster.ray.intersectPlane(groundPlane, worldPoint);
      return hit ? hit.clone() : null;
    }

    function applyEditorBrushAtCell(cellX: number, cellY: number): void {
      if (!inBounds(levelModel, cellX, cellY)) {
        return;
      }

      let changed = false;

      if (editorBrush === "wall") {
        changed = setTileAt(levelModel, cellX, cellY, TILE_WALL);
      } else if (editorBrush === "walkable") {
        changed = setTileAt(levelModel, cellX, cellY, TILE_WALKABLE);
      } else if (editorBrush === "door") {
        setTileAt(levelModel, cellX, cellY, TILE_WALL);

        const existing = findDoorPlacementAt(levelModel, cellX, cellY);
        const data: DoorPlacementData = {
          open: existing?.data?.open ?? false,
          locked: existing?.data?.locked
        };

        const placement: Placement = {
          id: existing?.id ?? nextPlacementId(levelModel),
          kind: "door",
          x: cellX,
          y: cellY,
          rot: ((editorDoorRot % 4) + 4) % 4,
          data
        };

        addDoorPlacement(levelModel, placement);
        changed = true;
      } else if (editorBrush === "erase-door") {
        changed = removeDoorPlacementAt(levelModel, cellX, cellY);
      }

      if (!changed) {
        return;
      }

      rebuildBaseLevelMeshes();
      rebuildEditorDoorMeshes();
      statusMessage = `Edited cell (${cellX}, ${cellY}) using ${editorBrush}.`;
      syncHud();
    }

    function paintStroke(start: THREE.Vector3 | null, end: THREE.Vector3): void {
      if (!start) {
        const cell = worldToCell(levelModel, end.x, end.z);
        if (cell) {
          applyEditorBrushAtCell(cell.x, cell.y);
        }
        return;
      }

      const distance = start.distanceTo(end);
      const steps = Math.max(1, Math.ceil(distance / 0.2));
      const seen = new Set<string>();
      const point = new THREE.Vector3();

      for (let i = 0; i <= steps; i += 1) {
        point.lerpVectors(start, end, i / steps);
        const cell = worldToCell(levelModel, point.x, point.z);
        if (!cell) {
          continue;
        }

        const key = cellKey(cell.x, cell.y);
        if (seen.has(key)) {
          continue;
        }

        seen.add(key);
        applyEditorBrushAtCell(cell.x, cell.y);
      }
    }

    function rebuildGameplayDoorMeshes(runtime: GameRuntime): void {
      clearGroup(gameDoorGroup);
      runtime.doorVisuals.clear();

      for (const [placementId, eid] of runtime.doorByPlacementId.entries()) {
        const door = runtime.doors.get(eid);
        if (!door) {
          continue;
        }

        const visual = createDoorVisual(doorGeometries, doorMaterials);
        visual.root.position.set(toWorldX(levelModel, door.cellX), 0, toWorldZ(levelModel, door.cellY));
        visual.root.rotation.y = door.rot * (Math.PI * 0.5);
        setDoorVisualOpen(visual, door.open);

        runtime.doorVisuals.set(placementId, visual);
        gameDoorGroup.add(visual.root);
      }
    }

    function disposeGameRuntime(): void {
      if (!gameRuntime) {
        return;
      }

      gameRuntime.keyboard.dispose(window);
      gameRuntime = null;
      clearGroup(gameDoorGroup);
      playerMesh.visible = false;
    }

    function createGameRuntime(options?: {
      player?: { x: number; y: number };
      doorOverrides?: Map<string, DoorOverride>;
    }): GameRuntime {
      const baked = bakeTileLevel(levelModel);

      const world = new World({
        level: baked.levelResource,
        resolveLevel: () => baked.levelResource
      });

      const keyboard = new KeyboardTracker(window);
      const systems = {
        inputSystem: createInputSystem(keyboard),
        movementSystem: createMovementSystem(),
        eventSystem: createEventSystem()
      };

      const playerEid = world.createEntity();
      const playerStart = options?.player ?? PLAYER_SPAWN;
      world.transforms.add(playerEid, { x: playerStart.x, y: playerStart.y });
      world.velocities.add(playerEid, { vx: 0, vy: 0 });
      world.playerTags.add(playerEid, true);
      world.persistents.add(playerEid, { kind: "player" });

      const doors = new DataStore<DoorComponent>();
      const doorByPlacementId = new Map<string, EID>();
      const placementIdByCell = new Map<string, string>();
      const doorVisuals = new Map<string, DoorVisual>();
      const interactionQueue: Array<{ cellX: number; cellY: number }> = [];

      for (const placement of baked.placements) {
        if (placement.kind !== "door") {
          continue;
        }

        const override = options?.doorOverrides?.get(placement.id);
        const open = override ? override.open : placement.data?.open === true;
        const locked = override?.locked ?? placement.data?.locked;

        const eid = world.createEntity();
        const rot = ((placement.rot ?? 0) % 4 + 4) % 4;

        doors.add(eid, {
          placementId: placement.id,
          cellX: placement.x,
          cellY: placement.y,
          rot,
          open,
          locked
        });

        world.transforms.add(eid, { x: placement.x + 0.5, y: placement.y + 0.5 });
        world.persistents.add(eid, { kind: "door" });

        doorByPlacementId.set(placement.id, eid);
        placementIdByCell.set(cellKey(placement.x, placement.y), placement.id);
        baked.levelResource.setBlocked(placement.x, placement.y, !open);
      }

      return {
        world,
        levelResource: baked.levelResource,
        keyboard,
        systems,
        playerEid,
        doors,
        doorByPlacementId,
        placementIdByCell,
        doorVisuals,
        interactionQueue
      };
    }

    function enterEditor(): void {
      disposeGameRuntime();
      mode = "EDITOR";
      editorDoorGroup.visible = true;
      gameDoorGroup.visible = false;
      hoverMesh.visible = true;
      statusMessage = "Switched to EDITOR.";
      syncHud();
    }

    function enterGame(options?: {
      player?: { x: number; y: number };
      doorOverrides?: Map<string, DoorOverride>;
      status?: string;
    }): void {
      disposeGameRuntime();

      const runtime = createGameRuntime({
        player: options?.player,
        doorOverrides: options?.doorOverrides
      });

      gameRuntime = runtime;
      rebuildGameplayDoorMeshes(runtime);

      mode = "GAME";
      editorDoorGroup.visible = false;
      gameDoorGroup.visible = true;
      hoverMesh.visible = false;
      playerMesh.visible = true;

      const playerTransform = runtime.world.transforms.get(runtime.playerEid);
      if (playerTransform) {
        playerMesh.position.set(toWorldCoordX(levelModel, playerTransform.x), 0, toWorldCoordZ(levelModel, playerTransform.y));
      }

      statusMessage = options?.status ?? "Baked LevelModel and entered GAME mode.";
      syncHud();
    }

    function saveLevelModelNow(): void {
      localStorage.setItem(LEVEL_MODEL_STORAGE_KEY, serializeLevelModel(levelModel));
      statusMessage = `Saved LevelModel to localStorage key: ${LEVEL_MODEL_STORAGE_KEY}`;
      console.log("[editor-game-ecs] level model saved", {
        key: LEVEL_MODEL_STORAGE_KEY,
        width: levelModel.width,
        height: levelModel.height,
        placements: levelModel.placements.length
      });
      syncHud();
    }

    function saveGameNow(): void {
      if (!gameRuntime) {
        return;
      }

      const player = findPlayerTransform(gameRuntime.world);
      if (!player) {
        statusMessage = "Save failed: player transform missing.";
        syncHud();
        return;
      }

      const doors: GameSaveDoor[] = [];
      for (const [placementId, eid] of gameRuntime.doorByPlacementId.entries()) {
        const door = gameRuntime.doors.get(eid);
        if (!door) {
          continue;
        }

        doors.push({
          placementId,
          open: door.open,
          locked: door.locked
        });
      }

      const payload: GameSave = {
        schemaVersion: GAME_SAVE_SCHEMA_VERSION,
        levelModel: cloneLevelModel(levelModel),
        player,
        doors
      };

      localStorage.setItem(GAME_SAVE_STORAGE_KEY, JSON.stringify(payload));
      statusMessage = `Saved game to localStorage key: ${GAME_SAVE_STORAGE_KEY}`;
      console.log("[editor-game-ecs] game save success", {
        key: GAME_SAVE_STORAGE_KEY,
        player,
        doors: doors.length
      });
      syncHud();
    }

    function loadGameNow(): void {
      const raw = localStorage.getItem(GAME_SAVE_STORAGE_KEY);
      if (!raw) {
        statusMessage = "No game save found in localStorage.";
        syncHud();
        return;
      }

      let parsedSave: GameSave | null = null;
      try {
        parsedSave = parseGameSave(JSON.parse(raw));
      } catch {
        parsedSave = null;
      }

      if (!parsedSave) {
        statusMessage = "Game save load failed: schema/validation error.";
        syncHud();
        return;
      }

      levelModel = cloneLevelModel(parsedSave.levelModel);
      updateGridGeometry();
      rebuildBaseLevelMeshes();
      rebuildEditorDoorMeshes();
      saveLevelModelNow();

      const overrides = new Map<string, DoorOverride>();
      for (const entry of parsedSave.doors) {
        overrides.set(entry.placementId, {
          open: entry.open,
          locked: entry.locked
        });
      }

      enterGame({
        player: parsedSave.player,
        doorOverrides: overrides,
        status: "Loaded game save and restored player + door states by placementId."
      });

      console.log("[editor-game-ecs] game load success", {
        player: parsedSave.player,
        doors: parsedSave.doors.length
      });
    }

    function queueDoorInteraction(cellX: number, cellY: number): void {
      if (!gameRuntime) {
        return;
      }

      gameRuntime.interactionQueue.push({ cellX, cellY });
    }

    function runDoorSystem(runtime: GameRuntime): void {
      if (runtime.interactionQueue.length === 0) {
        return;
      }

      const queue = runtime.interactionQueue.splice(0, runtime.interactionQueue.length);

      for (const request of queue) {
        const placementId = runtime.placementIdByCell.get(cellKey(request.cellX, request.cellY));
        if (!placementId) {
          continue;
        }

        const doorEid = runtime.doorByPlacementId.get(placementId);
        if (doorEid === undefined) {
          continue;
        }

        const door = runtime.doors.get(doorEid);
        if (!door) {
          continue;
        }

        if (door.locked) {
          statusMessage = `Door ${door.placementId} is locked.`;
          continue;
        }

        door.open = !door.open;
        runtime.levelResource.setBlocked(door.cellX, door.cellY, !door.open);

        const visual = runtime.doorVisuals.get(door.placementId);
        if (visual) {
          setDoorVisualOpen(visual, door.open);
        }

        statusMessage = `Door ${door.placementId} -> ${door.open ? "open" : "closed"}`;
      }
    }

    function runGameFrame(runtime: GameRuntime, dt: number): void {
      const world = runtime.world;
      world.time.dt = dt;
      world.time.t += dt;
      world.time.frame += 1;

      runtime.systems.inputSystem(world);
      runCameraRelativePlayerInputSystem(world);
      runDoorSystem(runtime);
      runtime.systems.movementSystem(world);
      runtime.systems.eventSystem(world);

      const player = world.transforms.get(runtime.playerEid);
      if (player) {
        playerMesh.position.set(toWorldCoordX(levelModel, player.x), 0, toWorldCoordZ(levelModel, player.y));
      }
    }

    function syncSize(): void {
      const rect = mount.getBoundingClientRect();
      viewportWidth = Math.max(1, Math.floor(rect.width));
      viewportHeight = Math.max(1, Math.floor(rect.height));

      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
      renderer.setSize(viewportWidth, viewportHeight, true);
      updateCameraProjection();
    }

    function updateCursor(): void {
      if (dragState?.mode === "pan") {
        renderer.domElement.style.cursor = "grabbing";
        return;
      }

      if (spacePressed) {
        renderer.domElement.style.cursor = "grab";
        return;
      }

      if (mode === "EDITOR") {
        renderer.domElement.style.cursor = "crosshair";
      } else {
        renderer.domElement.style.cursor = "pointer";
      }
    }

    function handlePointerDown(event: PointerEvent): void {
      if (event.button !== 0 && event.button !== 1) {
        return;
      }

      renderer.domElement.focus({ preventScroll: true });
      renderer.domElement.setPointerCapture(event.pointerId);

      const shouldPan = event.button === 1 || spacePressed;
      const world = worldAtClient(event.clientX, event.clientY);

      if (shouldPan) {
        dragState = {
          pointerId: event.pointerId,
          mode: "pan",
          lastClientX: event.clientX,
          lastClientY: event.clientY,
          lastWorld: world,
          moved: false
        };
        updateCursor();
        event.preventDefault();
        return;
      }

      if (mode === "EDITOR") {
        if (world) {
          paintStroke(null, world);
        }

        dragState = {
          pointerId: event.pointerId,
          mode: "paint",
          lastClientX: event.clientX,
          lastClientY: event.clientY,
          lastWorld: world,
          moved: false
        };
      } else {
        dragState = {
          pointerId: event.pointerId,
          mode: "game-click",
          lastClientX: event.clientX,
          lastClientY: event.clientY,
          lastWorld: world,
          moved: false
        };
      }

      updateCursor();
      event.preventDefault();
    }

    function handlePointerMove(event: PointerEvent): void {
      const world = worldAtClient(event.clientX, event.clientY);
      updateHover(world);

      if (!dragState || dragState.pointerId !== event.pointerId) {
        return;
      }

      const dx = event.clientX - dragState.lastClientX;
      const dy = event.clientY - dragState.lastClientY;

      if (Math.abs(dx) > 2 || Math.abs(dy) > 2) {
        dragState.moved = true;
      }

      if (dragState.mode === "pan") {
        applyPanByPixels(dx, dy);
        dragState.lastClientX = event.clientX;
        dragState.lastClientY = event.clientY;
        event.preventDefault();
        return;
      }

      if (dragState.mode === "paint" && mode === "EDITOR" && world) {
        paintStroke(dragState.lastWorld, world);
        dragState.lastWorld = world;
      }

      dragState.lastClientX = event.clientX;
      dragState.lastClientY = event.clientY;
      event.preventDefault();
    }

    function handlePointerUp(event: PointerEvent): void {
      if (!dragState || dragState.pointerId !== event.pointerId) {
        return;
      }

      if (dragState.mode === "game-click" && mode === "GAME" && !dragState.moved) {
        const world = worldAtClient(event.clientX, event.clientY);
        if (world) {
          const cell = worldToCell(levelModel, world.x, world.z);
          if (cell) {
            queueDoorInteraction(cell.x, cell.y);
          }
        }
      }

      dragState = null;
      updateCursor();
      event.preventDefault();
    }

    function handlePointerCancel(event: PointerEvent): void {
      if (!dragState || dragState.pointerId !== event.pointerId) {
        return;
      }

      dragState = null;
      updateCursor();
      event.preventDefault();
    }

    function isLikelyTrackpad(event: WheelEvent): boolean {
      if (event.deltaMode !== WheelEvent.DOM_DELTA_PIXEL) {
        return false;
      }

      if (Math.abs(event.deltaX) > 0.01) {
        return true;
      }

      return Math.abs(event.deltaY) < 24;
    }

    function handleWheel(event: WheelEvent): void {
      const scale = event.deltaMode === WheelEvent.DOM_DELTA_LINE ? 16 : 1;
      const trackpad = isLikelyTrackpad(event);
      const zoomIntent = event.ctrlKey || event.metaKey || !trackpad;

      if (zoomIntent) {
        const delta = event.deltaY * scale;
        zoomTarget = THREE.MathUtils.clamp(zoomTarget * Math.exp(-delta * 0.0015), ZOOM_MIN, ZOOM_MAX);
      } else {
        const panX = (event.deltaX + (event.shiftKey ? event.deltaY : 0)) * scale;
        const panY = event.deltaY * scale;
        applyPanByPixels(panX, panY);
      }

      event.preventDefault();
    }

    function handleKeyDown(event: KeyboardEvent): void {
      if (event.code === "Space") {
        if (!spacePressed) {
          spacePressed = true;
          updateCursor();
        }
        event.preventDefault();
        return;
      }

      if (event.code === "F5") {
        event.preventDefault();
        enterGame();
        return;
      }

      if (event.code === "Escape") {
        event.preventDefault();
        enterEditor();
        return;
      }

      if (event.code === "KeyQ" && !event.repeat) {
        yawIndex -= 1;
        event.preventDefault();
        syncHud();
        return;
      }

      if (event.code === "KeyE" && !event.repeat) {
        yawIndex += 1;
        event.preventDefault();
        syncHud();
        return;
      }

      if (mode === "GAME" && !event.repeat) {
        if ((event.ctrlKey || event.metaKey) && event.code === "KeyS") {
          event.preventDefault();
          saveGameNow();
          return;
        }

        if (event.code === "KeyK") {
          event.preventDefault();
          saveGameNow();
          return;
        }

        if (event.code === "KeyL") {
          event.preventDefault();
          loadGameNow();
          return;
        }
      }

      if (mode !== "EDITOR") {
        return;
      }

      if ((event.ctrlKey || event.metaKey) && event.code === "KeyS") {
        event.preventDefault();
        saveLevelModelNow();
        return;
      }

      if (event.repeat) {
        return;
      }

      if (event.code === "Digit1") {
        editorBrush = "wall";
        syncHud();
        event.preventDefault();
      } else if (event.code === "Digit2") {
        editorBrush = "walkable";
        syncHud();
        event.preventDefault();
      } else if (event.code === "Digit3") {
        editorBrush = "door";
        syncHud();
        event.preventDefault();
      } else if (event.code === "Digit4") {
        editorBrush = "erase-door";
        syncHud();
        event.preventDefault();
      } else if (event.code === "KeyR") {
        editorDoorRot += 1;
        statusMessage = `Door placement rotation set to ${(editorDoorRot % 4 + 4) % 4}`;
        syncHud();
        event.preventDefault();
      }
    }

    function handleKeyUp(event: KeyboardEvent): void {
      if (event.code === "Space") {
        spacePressed = false;
        updateCursor();
        event.preventDefault();
      }
    }

    const resizeObserver = new ResizeObserver(() => {
      syncSize();
    });
    resizeObserver.observe(mount);

    renderer.domElement.addEventListener("pointerdown", handlePointerDown);
    renderer.domElement.addEventListener("pointermove", handlePointerMove);
    renderer.domElement.addEventListener("pointerup", handlePointerUp);
    renderer.domElement.addEventListener("pointercancel", handlePointerCancel);
    renderer.domElement.addEventListener("wheel", handleWheel, { passive: false });
    renderer.domElement.addEventListener("contextmenu", (event) => event.preventDefault());

    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("keyup", handleKeyUp);

    updateGridGeometry();
    rebuildBaseLevelMeshes();
    rebuildEditorDoorMeshes();
    updateCameraProjection();
    syncHud();
    updateCursor();

    let last = performance.now();

    const render = (now: number): void => {
      const dt = Math.min(0.1, Math.max(0, (now - last) / 1000));
      last = now;

      if (mode === "GAME" && gameRuntime) {
        runGameFrame(gameRuntime, dt);
      }

      setCameraPose();
      renderer.render(scene, camera);
      syncHud();

      raf = requestAnimationFrame(render);
    };

    raf = requestAnimationFrame(render);

    return () => {
      cancelAnimationFrame(raf);

      disposeGameRuntime();
      resizeObserver.disconnect();

      renderer.domElement.removeEventListener("pointerdown", handlePointerDown);
      renderer.domElement.removeEventListener("pointermove", handlePointerMove);
      renderer.domElement.removeEventListener("pointerup", handlePointerUp);
      renderer.domElement.removeEventListener("pointercancel", handlePointerCancel);
      renderer.domElement.removeEventListener("wheel", handleWheel);

      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("keyup", handleKeyUp);

      floorGeometry.dispose();
      wallCoreGeometry.dispose();
      wallCapGeometry.dispose();
      playerBodyGeometry.dispose();
      playerHeadGeometry.dispose();
      doorGeometries.leftJamb.dispose();
      doorGeometries.rightJamb.dispose();
      doorGeometries.header.dispose();
      doorGeometries.threshold.dispose();
      doorGeometries.leaf.dispose();
      doorGeometries.handle.dispose();
      hoverMesh.geometry.dispose();

      minorGridGeometry.dispose();
      minorGridMaterial.dispose();

      floorMaterial.dispose();
      wallMaterial.dispose();
      wallCapMaterial.dispose();
      doorMaterials.frame.dispose();
      doorMaterials.leaf.dispose();
      doorMaterials.handle.dispose();
      playerBodyMaterial.dispose();
      playerHeadMaterial.dispose();
      hoverMaterial.dispose();

      renderer.dispose();

      if (hud.parentElement) {
        hud.parentElement.removeChild(hud);
      }

      if (renderer.domElement.parentElement) {
        renderer.domElement.parentElement.removeChild(renderer.domElement);
      }

      mount.style.position = "";
    };
  }
};

export default experiment;
