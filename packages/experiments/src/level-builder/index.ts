import * as THREE from "three";
import {
  autoTileRotationRadians,
  createEditorStructureMeshKit,
  createPromotedEditorControls,
  createEditorHud,
  describeAutoTile,
  type AutoTileShape,
  type PromotedEditorBrush,
  type PromotedEditorDefaultGround,
  type PromotedEditorRectToolMode,
  type PromotedEditorToolMode
} from "@common/level-editor";
import { makeRenderer } from "@common/render";
import type { LevelResource } from "@common/gameplay";
import type { ExperimentModule } from "../runtime/types";
import {
  bakeLevelForEcs,
  createEcsLevelResourceFromBake,
  serializeBakedLevel,
  type LevelBuilderBake,
  type LevelBuilderDoorState,
  type LevelBuilderGroundBase,
  type LevelBuilderGroundOverride,
  type LevelBuilderStructureSegment
} from "./bake";

export {
  bakeLevelForEcs,
  createEcsLevelResourceFromBake,
  serializeBakedLevel,
  type LevelBuilderBake,
  type LevelBuilderDoorState,
  type LevelBuilderGroundBase,
  type LevelBuilderGroundOverride,
  type LevelBuilderStructureSegment
};

type StructureBrush = "wall" | "window" | "door-closed" | "door-open";
type GroundPaintBrush = "floor" | "grass" | "road" | "sidewalk";
type BrushType = StructureBrush | GroundPaintBrush;
type ToolMode = "draw" | "erase";
type RectToolMode = "none" | "grass-fill" | "building-footprint";

type GroundCellOverride = {
  base: LevelBuilderGroundBase;
  variant?: number;
};

type StructureSegmentData =
  | { kind: "wall" }
  | { kind: "window" }
  | { kind: "door"; state: LevelBuilderDoorState };

type GridEdge = {
  ax: number;
  az: number;
  bx: number;
  bz: number;
};

type GridCell = {
  x: number;
  z: number;
};

type DirectionVector = {
  dx: number;
  dz: number;
};

type DragState = {
  pointerId: number;
  mode: "paint" | "pan" | "rect";
  paintMode: ToolMode;
  brush: BrushType;
  lastClientX: number;
  lastClientY: number;
  lastWorldPoint: THREE.Vector3 | null;
  rectMode?: RectToolMode;
  rectStartCell?: GridCell;
  rectEndCell?: GridCell;
};

const GRID_TILES = 30;
const TILE_SIZE = 1;
const GRID_ORIGIN = -(GRID_TILES * TILE_SIZE) * 0.5;

const WALL_THICKNESS = 0.2;
const GROUND_TILE_HEIGHT = 0.05;
const GRASS_VARIANT_COUNT = 4;
const ROAD_WIDTH = 0.24;
const SIDEWALK_WIDTH = 0.34;
const DEFAULT_GRASS_VARIANT_SEED = 0x41c64e6d;

const ORTHO_HEIGHT = 28;
const CAMERA_DISTANCE = 34;
const CAMERA_PITCH = THREE.MathUtils.degToRad(35.26438968);
const CAMERA_BASE_YAW = THREE.MathUtils.degToRad(45);
const ZOOM_MIN = 0.45;
const ZOOM_MAX = 3.8;
const PAN_CLAMP = GRID_TILES * 0.8;

const BRUSH_COLORS: Record<BrushType, number> = {
  wall: 0xb9c6d2,
  window: 0x8bbfdc,
  "door-closed": 0xd09d68,
  "door-open": 0x95b882,
  floor: 0x7f95ab,
  grass: 0x5ca063,
  road: 0x4e545d,
  sidewalk: 0xb8b39f
};

const RECT_TOOL_COLORS: Record<Exclude<RectToolMode, "none">, number> = {
  "grass-fill": 0x5ca063,
  "building-footprint": 0xd4ba8a
};

function isGroundBrush(brush: BrushType): brush is GroundPaintBrush {
  return brush === "floor" || brush === "grass" || brush === "road" || brush === "sidewalk";
}

function structureFromBrush(brush: StructureBrush): StructureSegmentData {
  if (brush === "wall") {
    return { kind: "wall" };
  }

  if (brush === "window") {
    return { kind: "window" };
  }

  if (brush === "door-open") {
    return { kind: "door", state: "open" };
  }

  return { kind: "door", state: "closed" };
}

function structureEquals(a: StructureSegmentData | undefined, b: StructureSegmentData): boolean {
  if (!a || a.kind !== b.kind) {
    return false;
  }

  if (a.kind === "door" && b.kind === "door") {
    return a.state === b.state;
  }

  return true;
}

function nodeKey(x: number, z: number): string {
  return `${x},${z}`;
}

function cellKey(x: number, z: number): string {
  return `${x},${z}`;
}

function edgeKey(ax: number, az: number, bx: number, bz: number): string {
  if (ax < bx || (ax === bx && az <= bz)) {
    return `${ax},${az}|${bx},${bz}`;
  }
  return `${bx},${bz}|${ax},${az}`;
}

function parseEdge(key: string): GridEdge {
  const [a, b] = key.split("|");
  const [axStr, azStr] = a.split(",");
  const [bxStr, bzStr] = b.split(",");
  return {
    ax: Number(axStr),
    az: Number(azStr),
    bx: Number(bxStr),
    bz: Number(bzStr)
  };
}

function parseCellKey(key: string): GridCell {
  const [xStr, zStr] = key.split(",");
  return { x: Number(xStr), z: Number(zStr) };
}

function toWorldNodeX(x: number): number {
  return GRID_ORIGIN + x * TILE_SIZE;
}

function toWorldNodeZ(z: number): number {
  return GRID_ORIGIN + z * TILE_SIZE;
}

function toWorldCellX(x: number): number {
  return GRID_ORIGIN + x * TILE_SIZE + TILE_SIZE * 0.5;
}

function toWorldCellZ(z: number): number {
  return GRID_ORIGIN + z * TILE_SIZE + TILE_SIZE * 0.5;
}

function clampPanTarget(target: THREE.Vector3): void {
  target.x = THREE.MathUtils.clamp(target.x, -PAN_CLAMP, PAN_CLAMP);
  target.z = THREE.MathUtils.clamp(target.z, -PAN_CLAMP, PAN_CLAMP);
}

function dampAngle(current: number, target: number, factor: number): number {
  const delta = Math.atan2(Math.sin(target - current), Math.cos(target - current));
  return current + delta * factor;
}

function createGridGeometry(step: number, y: number): THREE.BufferGeometry {
  const positions: number[] = [];
  const worldSpan = GRID_TILES * TILE_SIZE;
  const start = GRID_ORIGIN;
  const end = start + worldSpan;

  for (let i = 0; i <= GRID_TILES; i += step) {
    const offset = i * TILE_SIZE;
    const x = start + offset;
    const z = start + offset;

    positions.push(x, y, start, x, y, end);
    positions.push(start, y, z, end, y, z);
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  return geometry;
}

function hashInt32(value: number): number {
  let v = value | 0;
  v ^= v >>> 16;
  v = Math.imul(v, 0x7feb352d);
  v ^= v >>> 15;
  v = Math.imul(v, 0x846ca68b);
  v ^= v >>> 16;
  return v >>> 0;
}

function hashCell(seed: number, x: number, z: number): number {
  let h = seed | 0;
  h ^= Math.imul(x | 0, 0x9e3779b1);
  h = Math.imul(h, 0x85ebca6b);
  h ^= Math.imul(z | 0, 0xc2b2ae35);
  return hashInt32(h);
}

function hashRect(seed: number, ax: number, az: number, bx: number, bz: number): number {
  let h = seed | 0;
  h ^= Math.imul(ax | 0, 0x165667b1);
  h ^= Math.imul(az | 0, 0xd3a2646c);
  h ^= Math.imul(bx | 0, 0xfd7046c5);
  h ^= Math.imul(bz | 0, 0xb55a4f09);
  return hashInt32(h);
}

function computeGrassVariant(seed: number, x: number, z: number): number {
  return hashCell(seed, x, z) % GRASS_VARIANT_COUNT;
}

function createPathTexture(colorHex: number, width: number, shape: AutoTileShape): THREE.CanvasTexture {
  const size = 128;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;

  const context = canvas.getContext("2d");
  if (!context) {
    throw new Error("Failed to create path texture context.");
  }

  context.clearRect(0, 0, size, size);
  context.fillStyle = "#00000000";
  context.fillRect(0, 0, size, size);

  const color = `#${colorHex.toString(16).padStart(6, "0")}`;
  const center = size * 0.5;
  const arm = Math.max(6, Math.floor(size * width * 0.5));

  const drawArm = (north: boolean, east: boolean, south: boolean, west: boolean): void => {
    context.fillStyle = color;
    context.fillRect(center - arm, center - arm, arm * 2, arm * 2);

    if (north) {
      context.fillRect(center - arm, 0, arm * 2, center - arm);
    }
    if (east) {
      context.fillRect(center + arm, center - arm, size - (center + arm), arm * 2);
    }
    if (south) {
      context.fillRect(center - arm, center + arm, arm * 2, size - (center + arm));
    }
    if (west) {
      context.fillRect(0, center - arm, center - arm, arm * 2);
    }
  };

  if (shape === "isolated") {
    drawArm(false, false, false, false);
  } else if (shape === "end") {
    drawArm(true, false, false, false);
  } else if (shape === "straight") {
    drawArm(true, false, true, false);
  } else if (shape === "corner") {
    drawArm(true, true, false, false);
  } else if (shape === "tee") {
    drawArm(true, true, false, true);
  } else {
    drawArm(true, true, true, true);
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.generateMipmaps = false;
  texture.needsUpdate = true;
  return texture;
}

const experiment: ExperimentModule = {
  id: "level-builder",
  title: "Level Builder",
  tags: ["threejs", "editor", "isometric", "level-design", "tools"],
  init: ({ mount, width, height, dpr }) => {
    mount.style.position = "relative";

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x0c1822);

    const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 200);

    let viewportWidth = Math.max(1, width);
    let viewportHeight = Math.max(1, height);

    const renderer = makeRenderer(viewportWidth, viewportHeight, dpr);
    renderer.setPixelRatio(dpr);
    renderer.setSize(viewportWidth, viewportHeight, true);
    renderer.domElement.style.touchAction = "none";
    renderer.domElement.style.outline = "none";
    renderer.domElement.tabIndex = 0;
    mount.appendChild(renderer.domElement);

    const hemiLight = new THREE.HemisphereLight(0xd6e6ff, 0x2c3643, 0.94);
    scene.add(hemiLight);

    const keyLight = new THREE.DirectionalLight(0xfff2dc, 1.18);
    keyLight.position.set(18, 24, 12);
    scene.add(keyLight);

    const fillLight = new THREE.DirectionalLight(0xc4e2ff, 0.45);
    fillLight.position.set(-10, 14, -9);
    scene.add(fillLight);

    const floorBaseGeometry = new THREE.PlaneGeometry(GRID_TILES * TILE_SIZE, GRID_TILES * TILE_SIZE);
    const floorBaseMaterial = new THREE.MeshStandardMaterial({
      color: 0x172430,
      roughness: 0.95,
      metalness: 0.02
    });
    const floorBase = new THREE.Mesh(floorBaseGeometry, floorBaseMaterial);
    floorBase.rotation.x = -Math.PI * 0.5;
    scene.add(floorBase);

    const minorGridGeometry = createGridGeometry(1, 0.001);
    const majorGridGeometry = createGridGeometry(5, 0.002);
    const minorGrid = new THREE.LineSegments(
      minorGridGeometry,
      new THREE.LineBasicMaterial({ color: 0x375069, transparent: true, opacity: 0.42 })
    );
    const majorGrid = new THREE.LineSegments(
      majorGridGeometry,
      new THREE.LineBasicMaterial({ color: 0x5d7f9d, transparent: true, opacity: 0.7 })
    );
    scene.add(minorGrid);
    scene.add(majorGrid);

    const groundGroup = new THREE.Group();
    const structuresGroup = new THREE.Group();
    const jointsGroup = new THREE.Group();
    scene.add(groundGroup);
    scene.add(structuresGroup);
    scene.add(jointsGroup);

    const groundFloorMaterial = new THREE.MeshStandardMaterial({
      color: 0x788ea3,
      roughness: 0.84,
      metalness: 0.05
    });
    const grassVariantMaterials: THREE.MeshStandardMaterial[] = [
      new THREE.MeshStandardMaterial({ color: 0x5b9862, roughness: 0.94, metalness: 0.0 }),
      new THREE.MeshStandardMaterial({ color: 0x679f6b, roughness: 0.92, metalness: 0.0 }),
      new THREE.MeshStandardMaterial({ color: 0x4e8d58, roughness: 0.95, metalness: 0.0 }),
      new THREE.MeshStandardMaterial({ color: 0x76ab6c, roughness: 0.9, metalness: 0.0 })
    ];
    const groundBuildingMaterial = new THREE.MeshStandardMaterial({
      color: 0xcab58e,
      roughness: 0.74,
      metalness: 0.03
    });
    const groundRoadSubgradeMaterial = new THREE.MeshStandardMaterial({
      color: 0x6a7480,
      roughness: 0.82,
      metalness: 0.03
    });
    const groundSidewalkSubgradeMaterial = new THREE.MeshStandardMaterial({
      color: 0xb4b0a1,
      roughness: 0.78,
      metalness: 0.04
    });

    const autoTileShapes: AutoTileShape[] = ["isolated", "end", "straight", "corner", "tee", "cross"];
    const autoTileTextures = new Map<string, THREE.CanvasTexture>();
    const autoTileMaterials = new Map<string, THREE.MeshStandardMaterial>();
    for (const shape of autoTileShapes) {
      const roadTexture = createPathTexture(0x434a53, ROAD_WIDTH, shape);
      autoTileTextures.set(`road:${shape}`, roadTexture);
      autoTileMaterials.set(
        `road:${shape}`,
        new THREE.MeshStandardMaterial({
          color: 0xffffff,
          map: roadTexture,
          alphaMap: roadTexture,
          transparent: true,
          roughness: 0.63,
          metalness: 0.06,
          depthWrite: false
        })
      );

      const sidewalkTexture = createPathTexture(0xd2c8b1, SIDEWALK_WIDTH, shape);
      autoTileTextures.set(`sidewalk:${shape}`, sidewalkTexture);
      autoTileMaterials.set(
        `sidewalk:${shape}`,
        new THREE.MeshStandardMaterial({
          color: 0xffffff,
          map: sidewalkTexture,
          alphaMap: sidewalkTexture,
          transparent: true,
          roughness: 0.86,
          metalness: 0.01,
          depthWrite: false
        })
      );
    }

    const structureMeshKit = createEditorStructureMeshKit();

    const hoverMaterial = new THREE.MeshBasicMaterial({
      color: BRUSH_COLORS.wall,
      transparent: true,
      opacity: 0.62,
      depthWrite: false
    });
    const rectPreviewMaterial = new THREE.MeshBasicMaterial({
      color: RECT_TOOL_COLORS["grass-fill"],
      transparent: true,
      opacity: 0.26,
      depthWrite: false
    });

    const groundTileGeometry = new THREE.BoxGeometry(TILE_SIZE, GROUND_TILE_HEIGHT, TILE_SIZE);
    const autoTileOverlayGeometry = new THREE.PlaneGeometry(TILE_SIZE, TILE_SIZE);
    autoTileOverlayGeometry.rotateX(-Math.PI * 0.5);

    const edgeHoverGeometry = new THREE.BoxGeometry(TILE_SIZE, 0.05, WALL_THICKNESS);
    const cellHoverGeometry = new THREE.BoxGeometry(TILE_SIZE, 0.04, TILE_SIZE);
    const rectPreviewGeometry = new THREE.BoxGeometry(TILE_SIZE, 0.03, TILE_SIZE);

    const edgeHoverMesh = new THREE.Mesh(edgeHoverGeometry, hoverMaterial);
    edgeHoverMesh.visible = false;
    edgeHoverMesh.position.y = 0.03;

    const cellHoverMesh = new THREE.Mesh(cellHoverGeometry, hoverMaterial);
    cellHoverMesh.visible = false;
    cellHoverMesh.position.y = 0.03;

    const rectPreviewMesh = new THREE.Mesh(rectPreviewGeometry, rectPreviewMaterial);
    rectPreviewMesh.visible = false;
    rectPreviewMesh.position.y = 0.035;

    scene.add(edgeHoverMesh);
    scene.add(cellHoverMesh);
    scene.add(rectPreviewMesh);

    const structureSegments = new Map<string, StructureSegmentData>();
    const groundOverrides = new Map<string, GroundCellOverride>();

    let activeBrush: BrushType = "wall";
    let activeTool: ToolMode = "draw";
    let activeRectTool: RectToolMode = "none";
    let defaultGroundBase: LevelBuilderGroundBase = "floor";
    let userSeed = 1337;
    let spacePressed = false;
    let dragState: DragState | null = null;

    let yawIndex = 0;
    let yawCurrent = CAMERA_BASE_YAW;
    let zoomTarget = 1.15;
    let zoomCurrent = zoomTarget;
    const cameraTarget = new THREE.Vector3(0, 0, 0);

    let intersectionCount = 0;
    let needsRebuild = true;
    let raf = 0;

    let lastBake: LevelBuilderBake | null = null;
    let lastBakedResource: LevelResource | null = null;
    let bakeStatusMessage = "Not baked yet.";

    const raycaster = new THREE.Raycaster();
    const pointerNdc = new THREE.Vector2();
    const groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);

    const panRight = new THREE.Vector3();
    const panForward = new THREE.Vector3();
    const panWorld = new THREE.Vector3();

    const strokePoint = new THREE.Vector3();
    const nextWorldPoint = new THREE.Vector3();
    const tempMatrix = new THREE.Matrix4();
    const tempQuaternion = new THREE.Quaternion();
    const tempPosition = new THREE.Vector3();
    const tempScale = new THREE.Vector3(1, 1, 1);
    const upAxis = new THREE.Vector3(0, 1, 0);

    const hud = createEditorHud({
      mount,
      title: "Level Builder",
      description:
        "Isometric room + terrain editor: seeded grass rect fill, autotiled road/sidewalk paint, building footprint rects, and ECS bake-ready export.",
      hints:
        "LMB drag: paint  •  Shift+drag: grass fill rect  •  G: grass rect  •  9: footprint rect  •  7/8: road/sidewalk  •  B: bake",
      focusTarget: renderer.domElement,
      leftPanelWidth: "min(390px, 56vw)",
      rightPanelMinWidth: "260px",
      statsTestId: "level-builder-stats",
      statusTestId: "level-builder-status"
    });

    const setButtonActive = hud.setButtonActive;
    const stats = hud.stats;
    const bakeStatus = hud.status;

    function getCurrentBrushAndMode(): { brush: BrushType; mode: ToolMode } {
      if (dragState && dragState.mode === "paint") {
        return { brush: dragState.brush, mode: dragState.paintMode };
      }
      return { brush: activeBrush, mode: activeTool };
    }

    function areGroundOverridesEqual(a: GroundCellOverride, b: GroundCellOverride): boolean {
      return a.base === b.base && a.variant === b.variant;
    }

    function normalizeGroundOverride(base: LevelBuilderGroundBase, variant?: number): GroundCellOverride {
      if (base === "grass") {
        return {
          base,
          variant: variant === undefined ? undefined : Math.max(0, Math.floor(variant))
        };
      }

      return { base };
    }

    function getDefaultGroundAtCell(x: number, z: number): GroundCellOverride {
      if (defaultGroundBase === "grass") {
        return {
          base: "grass",
          variant: computeGrassVariant(userSeed ^ DEFAULT_GRASS_VARIANT_SEED, x, z)
        };
      }

      return { base: defaultGroundBase };
    }

    function getGroundOverrideAtCell(x: number, z: number): GroundCellOverride {
      const direct = groundOverrides.get(cellKey(x, z));
      if (direct) {
        return direct;
      }

      return getDefaultGroundAtCell(x, z);
    }

    function setGroundOverrideAtCell(x: number, z: number, override: GroundCellOverride): void {
      const key = cellKey(x, z);

      const normalized = normalizeGroundOverride(override.base, override.variant);
      const defaults = getDefaultGroundAtCell(x, z);
      if (normalized.base === defaults.base && normalized.variant === defaults.variant) {
        groundOverrides.delete(key);
      } else {
        groundOverrides.set(key, normalized);
      }
    }

    function getRoadMaskAtCell(x: number, z: number, base: "road" | "sidewalk"): number {
      let mask = 0;

      if (z > 0 && getGroundOverrideAtCell(x, z - 1).base === base) {
        mask |= 1;
      }
      if (x < GRID_TILES - 1 && getGroundOverrideAtCell(x + 1, z).base === base) {
        mask |= 2;
      }
      if (z < GRID_TILES - 1 && getGroundOverrideAtCell(x, z + 1).base === base) {
        mask |= 4;
      }
      if (x > 0 && getGroundOverrideAtCell(x - 1, z).base === base) {
        mask |= 8;
      }

      return mask;
    }

    function getRectBounds(a: GridCell, b: GridCell): { minX: number; maxX: number; minZ: number; maxZ: number } {
      return {
        minX: Math.min(a.x, b.x),
        maxX: Math.max(a.x, b.x),
        minZ: Math.min(a.z, b.z),
        maxZ: Math.max(a.z, b.z)
      };
    }

    function updateRectPreview(start: GridCell, end: GridCell, mode: RectToolMode): void {
      const bounds = getRectBounds(start, end);
      rectPreviewMesh.visible = mode !== "none";
      if (mode === "none") {
        return;
      }

      const width = bounds.maxX - bounds.minX + 1;
      const height = bounds.maxZ - bounds.minZ + 1;
      rectPreviewMesh.scale.set(width, 1, height);
      rectPreviewMesh.position.set(
        toWorldCellX(bounds.minX + (width - 1) * 0.5),
        0.035,
        toWorldCellZ(bounds.minZ + (height - 1) * 0.5)
      );
      rectPreviewMaterial.color.setHex(RECT_TOOL_COLORS[mode]);
    }

    function hideRectPreview(): void {
      rectPreviewMesh.visible = false;
    }

    function applyGrassRectFill(start: GridCell, end: GridCell): void {
      const bounds = getRectBounds(start, end);
      const seededRect = hashRect(userSeed, bounds.minX, bounds.minZ, bounds.maxX, bounds.maxZ);
      for (let z = bounds.minZ; z <= bounds.maxZ; z += 1) {
        for (let x = bounds.minX; x <= bounds.maxX; x += 1) {
          const variant = computeGrassVariant(seededRect, x, z);
          setGroundOverrideAtCell(x, z, { base: "grass", variant });
        }
      }
    }

    function applyBuildingFootprintRect(start: GridCell, end: GridCell): void {
      const bounds = getRectBounds(start, end);
      for (let z = bounds.minZ; z <= bounds.maxZ; z += 1) {
        for (let x = bounds.minX; x <= bounds.maxX; x += 1) {
          setGroundOverrideAtCell(x, z, { base: "building" });
        }
      }
    }

    function runRectTool(mode: RectToolMode, start: GridCell, end: GridCell): void {
      if (mode === "grass-fill") {
        applyGrassRectFill(start, end);
        bakeStatusMessage = `Filled grass rect (${start.x},${start.z}) -> (${end.x},${end.z}) with seed ${userSeed}.`;
      } else if (mode === "building-footprint") {
        applyBuildingFootprintRect(start, end);
        bakeStatusMessage = `Painted building footprint rect (${start.x},${start.z}) -> (${end.x},${end.z}).`;
      }

      needsRebuild = true;
      syncHud();
    }

    function clearGroup(group: THREE.Group): void {
      for (let i = group.children.length - 1; i >= 0; i -= 1) {
        group.remove(group.children[i]);
      }
    }

    function createGroundInstances(material: THREE.Material, count: number): THREE.InstancedMesh {
      const mesh = new THREE.InstancedMesh(groundTileGeometry, material, Math.max(1, count));
      mesh.count = count;
      return mesh;
    }

    function createWallSegment(): THREE.Object3D {
      return structureMeshKit.createWallSegment();
    }

    function createWindowSegment(): THREE.Object3D {
      return structureMeshKit.createWindowSegment();
    }

    function createDoorSegment(state: LevelBuilderDoorState): THREE.Object3D {
      return structureMeshKit.createDoorSegment(state);
    }

    function createStructureSegment(segment: StructureSegmentData): THREE.Object3D {
      if (segment.kind === "wall") {
        return createWallSegment();
      }

      if (segment.kind === "window") {
        return createWindowSegment();
      }

      return createDoorSegment(segment.state);
    }

    function createJoinPost(degree: number): THREE.Object3D {
      return structureMeshKit.createJoinPost(degree);
    }

    function registerDirection(map: Map<string, DirectionVector[]>, x: number, z: number, dx: number, dz: number): void {
      const key = nodeKey(x, z);
      const directions = map.get(key) ?? [];
      if (!directions.some((entry) => entry.dx === dx && entry.dz === dz)) {
        directions.push({ dx, dz });
      }
      map.set(key, directions);
    }

    function rebuildGroundTiles(): void {
      clearGroup(groundGroup);

      const grassCounts = new Array<number>(GRASS_VARIANT_COUNT).fill(0);
      let floorCount = 0;
      let roadCount = 0;
      let sidewalkCount = 0;
      let buildingCount = 0;

      for (let z = 0; z < GRID_TILES; z += 1) {
        for (let x = 0; x < GRID_TILES; x += 1) {
          const ground = getGroundOverrideAtCell(x, z);
          if (ground.base === "grass") {
            const variant = ground.variant ?? computeGrassVariant(userSeed ^ DEFAULT_GRASS_VARIANT_SEED, x, z);
            grassCounts[Math.max(0, variant % GRASS_VARIANT_COUNT)] += 1;
          } else if (ground.base === "road") {
            roadCount += 1;
          } else if (ground.base === "sidewalk") {
            sidewalkCount += 1;
          } else if (ground.base === "building") {
            buildingCount += 1;
          } else {
            floorCount += 1;
          }
        }
      }

      const floorInstances = createGroundInstances(groundFloorMaterial, floorCount);
      const roadInstances = createGroundInstances(groundRoadSubgradeMaterial, roadCount);
      const sidewalkInstances = createGroundInstances(groundSidewalkSubgradeMaterial, sidewalkCount);
      const buildingInstances = createGroundInstances(groundBuildingMaterial, buildingCount);
      const grassVariantInstances = grassVariantMaterials.map((material, index) =>
        createGroundInstances(material, grassCounts[index] ?? 0)
      );

      const autoTileBuckets = new Map<string, THREE.Matrix4[]>();

      let floorIndex = 0;
      let roadIndex = 0;
      let sidewalkIndex = 0;
      let buildingIndex = 0;
      const grassIndexes = new Array<number>(GRASS_VARIANT_COUNT).fill(0);

      for (let z = 0; z < GRID_TILES; z += 1) {
        for (let x = 0; x < GRID_TILES; x += 1) {
          const worldX = toWorldCellX(x);
          const worldZ = toWorldCellZ(z);
          const ground = getGroundOverrideAtCell(x, z);

          tempMatrix.makeTranslation(worldX, GROUND_TILE_HEIGHT * 0.5, worldZ);

          if (ground.base === "grass") {
            const variant = Math.max(
              0,
              (ground.variant ?? computeGrassVariant(userSeed ^ DEFAULT_GRASS_VARIANT_SEED, x, z)) % GRASS_VARIANT_COUNT
            );
            grassVariantInstances[variant].setMatrixAt(grassIndexes[variant], tempMatrix);
            grassIndexes[variant] += 1;
          } else if (ground.base === "road") {
            roadInstances.setMatrixAt(roadIndex, tempMatrix);
            roadIndex += 1;

            const tile = describeAutoTile(getRoadMaskAtCell(x, z, "road"));
            const key = `road:${tile.shape}:${tile.rotation}`;
            const matrices = autoTileBuckets.get(key) ?? [];

            tempQuaternion.setFromAxisAngle(upAxis, autoTileRotationRadians(tile.rotation));
            tempPosition.set(worldX, GROUND_TILE_HEIGHT + 0.012, worldZ);
            tempMatrix.compose(tempPosition, tempQuaternion, tempScale);
            matrices.push(tempMatrix.clone());
            autoTileBuckets.set(key, matrices);
          } else if (ground.base === "sidewalk") {
            sidewalkInstances.setMatrixAt(sidewalkIndex, tempMatrix);
            sidewalkIndex += 1;

            const tile = describeAutoTile(getRoadMaskAtCell(x, z, "sidewalk"));
            const key = `sidewalk:${tile.shape}:${tile.rotation}`;
            const matrices = autoTileBuckets.get(key) ?? [];

            tempQuaternion.setFromAxisAngle(upAxis, autoTileRotationRadians(tile.rotation));
            tempPosition.set(worldX, GROUND_TILE_HEIGHT + 0.016, worldZ);
            tempMatrix.compose(tempPosition, tempQuaternion, tempScale);
            matrices.push(tempMatrix.clone());
            autoTileBuckets.set(key, matrices);
          } else if (ground.base === "building") {
            buildingInstances.setMatrixAt(buildingIndex, tempMatrix);
            buildingIndex += 1;
          } else {
            floorInstances.setMatrixAt(floorIndex, tempMatrix);
            floorIndex += 1;
          }
        }
      }

      floorInstances.instanceMatrix.needsUpdate = true;
      roadInstances.instanceMatrix.needsUpdate = true;
      sidewalkInstances.instanceMatrix.needsUpdate = true;
      buildingInstances.instanceMatrix.needsUpdate = true;
      for (const instance of grassVariantInstances) {
        instance.instanceMatrix.needsUpdate = true;
      }

      groundGroup.add(floorInstances);
      groundGroup.add(roadInstances);
      groundGroup.add(sidewalkInstances);
      groundGroup.add(buildingInstances);
      for (const instance of grassVariantInstances) {
        groundGroup.add(instance);
      }

      autoTileBuckets.forEach((matrices, key) => {
        if (matrices.length === 0) {
          return;
        }

        const [base, shape] = key.split(":");
        const material = autoTileMaterials.get(`${base}:${shape}`);
        if (!material) {
          return;
        }

        const mesh = new THREE.InstancedMesh(autoTileOverlayGeometry, material, matrices.length);
        mesh.count = matrices.length;
        for (let index = 0; index < matrices.length; index += 1) {
          mesh.setMatrixAt(index, matrices[index]);
        }
        mesh.instanceMatrix.needsUpdate = true;
        groundGroup.add(mesh);
      });
    }

    function rebuildStructures(): void {
      clearGroup(structuresGroup);
      clearGroup(jointsGroup);

      const adjacency = new Map<string, DirectionVector[]>();
      intersectionCount = 0;

      structureSegments.forEach((segmentData, segmentKey) => {
        const edge = parseEdge(segmentKey);
        const module = createStructureSegment(segmentData);

        const xA = toWorldNodeX(edge.ax);
        const zA = toWorldNodeZ(edge.az);
        const xB = toWorldNodeX(edge.bx);
        const zB = toWorldNodeZ(edge.bz);

        module.position.set((xA + xB) * 0.5, 0, (zA + zB) * 0.5);
        if (edge.az !== edge.bz) {
          module.rotation.y = Math.PI * 0.5;
        }

        structuresGroup.add(module);

        registerDirection(adjacency, edge.ax, edge.az, edge.bx - edge.ax, edge.bz - edge.az);
        registerDirection(adjacency, edge.bx, edge.bz, edge.ax - edge.bx, edge.az - edge.bz);
      });

      adjacency.forEach((directions, key) => {
        if (directions.length < 2) {
          return;
        }

        const { x, z } = parseCellKey(key);
        const post = createJoinPost(directions.length);
        post.position.x = toWorldNodeX(x);
        post.position.z = toWorldNodeZ(z);
        jointsGroup.add(post);

        intersectionCount += 1;
      });
    }

    function computeStructureCounts(): {
      wall: number;
      window: number;
      doorClosed: number;
      doorOpen: number;
    } {
      let wall = 0;
      let windowCount = 0;
      let doorClosed = 0;
      let doorOpen = 0;

      for (const segment of structureSegments.values()) {
        if (segment.kind === "wall") {
          wall += 1;
        } else if (segment.kind === "window") {
          windowCount += 1;
        } else if (segment.state === "closed") {
          doorClosed += 1;
        } else {
          doorOpen += 1;
        }
      }

      return { wall, window: windowCount, doorClosed, doorOpen };
    }

    function computeGroundCounts(): Record<LevelBuilderGroundBase, number> {
      const counts: Record<LevelBuilderGroundBase, number> = {
        floor: 0,
        grass: 0,
        road: 0,
        sidewalk: 0,
        building: 0
      };

      for (let z = 0; z < GRID_TILES; z += 1) {
        for (let x = 0; x < GRID_TILES; x += 1) {
          const base = getGroundOverrideAtCell(x, z).base;
          counts[base] += 1;
        }
      }

      return counts;
    }

    function createBakePayload(): LevelBuilderBake {
      const structures: LevelBuilderStructureSegment[] = [];
      for (const [segmentKey, segmentData] of structureSegments.entries()) {
        const edge = parseEdge(segmentKey);

        if (segmentData.kind === "door") {
          structures.push({
            kind: "door",
            doorState: segmentData.state,
            ax: edge.ax,
            az: edge.az,
            bx: edge.bx,
            bz: edge.bz
          });
        } else {
          structures.push({
            kind: segmentData.kind,
            ax: edge.ax,
            az: edge.az,
            bx: edge.bx,
            bz: edge.bz
          });
        }
      }

      const ground: LevelBuilderGroundOverride[] = [];
      for (const [key, override] of groundOverrides.entries()) {
        const cell = parseCellKey(key);
        ground.push({
          x: cell.x,
          z: cell.z,
          base: override.base,
          variant: override.variant
        });
      }

      return bakeLevelForEcs({
        level: {
          id: "level-builder-draft",
          version: 1
        },
        grid: {
          tiles: GRID_TILES,
          tileSize: TILE_SIZE,
          origin: GRID_ORIGIN
        },
        terrain: {
          defaultGround: defaultGroundBase,
          overrides: ground
        },
        structures
      });
    }

    function runBakePreview(): void {
      const baked = createBakePayload();
      const resource = createEcsLevelResourceFromBake(baked);

      lastBake = baked;
      lastBakedResource = resource;
      bakeStatusMessage = `Baked ${baked.structures.length} segments, blocked ${baked.blockedCells.length} cells.`;

      console.log("[level-builder] Baked payload", baked);
      console.log("[level-builder] Baked payload JSON", serializeBakedLevel(baked));
      console.log("[level-builder] ECS LevelResource probes", {
        blockedAt0_0: resource.isBlocked(0, 0),
        blockedAt6_0: resource.isBlocked(6, 0),
        blockedAt2_0: resource.isBlocked(2, 0)
      });

      syncHud();
    }

    const promotedControls = createPromotedEditorControls({
      hud,
      initialSeed: userSeed,
      onTool(mode: PromotedEditorToolMode): void {
        activeTool = mode;
        syncHud();
      },
      onBrush(brush: PromotedEditorBrush): void {
        activeBrush = brush as BrushType;
        if (brush === "grass" || brush === "road" || brush === "sidewalk") {
          activeRectTool = "none";
        }
        syncHud();
      },
      onRectTool(mode: PromotedEditorRectToolMode): void {
        activeRectTool = mode as RectToolMode;
        if (mode === "none") {
          hideRectPreview();
        }
        syncHud();
      },
      onDefaultGround(base: PromotedEditorDefaultGround): void {
        defaultGroundBase = base;
        needsRebuild = true;
        bakeStatusMessage = `Default ground set to ${base}.`;
        syncHud();
      },
      onSeed(seed: number): void {
        userSeed = seed;
        needsRebuild = true;
        bakeStatusMessage = `Seed updated to ${userSeed}.`;
        syncHud();
      },
      onRotate(deltaQuarterTurns: -1 | 1): void {
        yawIndex += deltaQuarterTurns;
        syncHud();
      },
      onResetView(): void {
        yawIndex = 0;
        zoomTarget = 1.15;
        cameraTarget.set(0, 0, 0);
        syncHud();
      },
      onClearStructures(): void {
        structureSegments.clear();
        needsRebuild = true;
        bakeStatusMessage = "Geometry cleared.";
        syncHud();
      },
      onClearGround(): void {
        groundOverrides.clear();
        needsRebuild = true;
        bakeStatusMessage = "Terrain overrides cleared.";
        syncHud();
      },
      onBake(): void {
        runBakePreview();
      },
      onExit(): void {
        bakeStatusMessage =
          "EXIT is only available in the Editor + Game (ECS) experiment.";
        syncHud();
      }
    });

    const toolButtons = promotedControls.toolButtons as Map<ToolMode, HTMLButtonElement>;
    const brushButtons = promotedControls.brushButtons as Map<BrushType, HTMLButtonElement>;
    const rectToolButtons = promotedControls.rectToolButtons as Map<Exclude<RectToolMode, "none">, HTMLButtonElement>;
    const defaultGroundButtons = promotedControls.defaultGroundButtons as Map<"floor" | "grass", HTMLButtonElement>;
    const rectOffButton = promotedControls.rectOffButton;

    function syncHud(): void {
      toolButtons.forEach((button, mode) => {
        setButtonActive(button, activeTool === mode);
      });

      brushButtons.forEach((button, brush) => {
        setButtonActive(button, activeBrush === brush);
      });

       rectToolButtons.forEach((button, mode) => {
         setButtonActive(button, activeRectTool === mode);
       });
       setButtonActive(rectOffButton, activeRectTool === "none");

       defaultGroundButtons.forEach((button, base) => {
         setButtonActive(button, defaultGroundBase === base);
       });

      const viewStep = (yawIndex % 4 + 4) % 4;
      const counts = computeStructureCounts();
      const groundCounts = computeGroundCounts();
      stats.textContent = [
        `Walls: ${counts.wall}`,
        `Windows: ${counts.window}`,
        `Doors(C/O): ${counts.doorClosed}/${counts.doorOpen}`,
        `Junctions: ${intersectionCount}`,
        `Ground(F/G/R/S/B): ${groundCounts.floor}/${groundCounts.grass}/${groundCounts.road}/${groundCounts.sidewalk}/${groundCounts.building}`,
        `Overrides: ${groundOverrides.size}`,
        `Default: ${defaultGroundBase}`,
        `Rect: ${activeRectTool}`,
        `Seed: ${userSeed}`,
        `View: ${viewStep}/4`
      ].join("  •  ");

      const blocked = lastBake?.blockedCells.length ?? 0;
      const probe = lastBakedResource ? `  Probe(6,0): ${lastBakedResource.isBlocked(6, 0) ? "blocked" : "open"}` : "";
      bakeStatus.textContent = `Bake: ${bakeStatusMessage}${lastBake ? `  (blocked cells: ${blocked})` : ""}${probe}`;

      const { brush, mode } = getCurrentBrushAndMode();
      if (activeRectTool !== "none") {
        hoverMaterial.color.setHex(RECT_TOOL_COLORS[activeRectTool]);
      } else {
        hoverMaterial.color.setHex(mode === "erase" ? 0xff7e7e : BRUSH_COLORS[brush]);
      }
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

      panWorld.set(0, 0, 0);
      panWorld.addScaledVector(panRight, -deltaX * worldUnitsPerPixel);
      panWorld.addScaledVector(panForward, deltaY * worldUnitsPerPixel);
      cameraTarget.add(panWorld);
      clampPanTarget(cameraTarget);
    }

    function setCameraPose(): void {
      const yawTarget = CAMERA_BASE_YAW + yawIndex * (Math.PI * 0.5);
      yawCurrent = dampAngle(yawCurrent, yawTarget, 0.22);
      zoomCurrent = THREE.MathUtils.lerp(zoomCurrent, zoomTarget, 0.18);

      const horizontal = Math.cos(CAMERA_PITCH);
      const direction = new THREE.Vector3(
        Math.sin(yawCurrent) * horizontal,
        Math.sin(CAMERA_PITCH),
        Math.cos(yawCurrent) * horizontal
      );

      camera.position.copy(cameraTarget).addScaledVector(direction, CAMERA_DISTANCE);
      camera.lookAt(cameraTarget);
      camera.zoom = zoomCurrent;
      camera.updateProjectionMatrix();
    }

    function getWorldAtClient(clientX: number, clientY: number): THREE.Vector3 | null {
      const rect = renderer.domElement.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) {
        return null;
      }

      pointerNdc.x = ((clientX - rect.left) / rect.width) * 2 - 1;
      pointerNdc.y = -((clientY - rect.top) / rect.height) * 2 + 1;

      raycaster.setFromCamera(pointerNdc, camera);
      const hit = raycaster.ray.intersectPlane(groundPlane, nextWorldPoint);
      if (!hit) {
        return null;
      }
      return hit.clone();
    }

    function pickCellFromWorld(world: THREE.Vector3): GridCell | null {
      const localX = (world.x - GRID_ORIGIN) / TILE_SIZE;
      const localZ = (world.z - GRID_ORIGIN) / TILE_SIZE;

      if (localX < 0 || localX >= GRID_TILES || localZ < 0 || localZ >= GRID_TILES) {
        return null;
      }

      return {
        x: Math.floor(localX),
        z: Math.floor(localZ)
      };
    }

    function pickEdgeFromWorld(world: THREE.Vector3): GridEdge | null {
      const localX = (world.x - GRID_ORIGIN) / TILE_SIZE;
      const localZ = (world.z - GRID_ORIGIN) / TILE_SIZE;

      if (localX < -0.001 || localX > GRID_TILES + 0.001 || localZ < -0.001 || localZ > GRID_TILES + 0.001) {
        return null;
      }

      const clampedX = THREE.MathUtils.clamp(localX, 0, GRID_TILES);
      const clampedZ = THREE.MathUtils.clamp(localZ, 0, GRID_TILES);

      const safeCellX = THREE.MathUtils.clamp(Math.floor(localX), 0, GRID_TILES - 1);
      const safeCellZ = THREE.MathUtils.clamp(Math.floor(localZ), 0, GRID_TILES - 1);

      const lineX = THREE.MathUtils.clamp(Math.round(clampedX), 0, GRID_TILES);
      const lineZ = THREE.MathUtils.clamp(Math.round(clampedZ), 0, GRID_TILES);

      const distanceToVertical = Math.abs(clampedX - lineX);
      const distanceToHorizontal = Math.abs(clampedZ - lineZ);

      if (distanceToVertical <= distanceToHorizontal) {
        return {
          ax: lineX,
          az: safeCellZ,
          bx: lineX,
          bz: safeCellZ + 1
        };
      }

      return {
        ax: safeCellX,
        az: lineZ,
        bx: safeCellX + 1,
        bz: lineZ
      };
    }

    function applyGroundTool(cell: GridCell, mode: ToolMode, brush: GroundPaintBrush): void {
      const key = cellKey(cell.x, cell.z);
      if (mode === "erase") {
        if (groundOverrides.delete(key)) {
          needsRebuild = true;
        }
        return;
      }

      const variant = brush === "grass" ? computeGrassVariant(userSeed ^ 0x9e3779b9, cell.x, cell.z) : undefined;
      const next = normalizeGroundOverride(brush, variant);
      const before = getGroundOverrideAtCell(cell.x, cell.z);

      if (!areGroundOverridesEqual(before, next)) {
        setGroundOverrideAtCell(cell.x, cell.z, next);
        needsRebuild = true;
      }
    }

    function applyStructureTool(edge: GridEdge, mode: ToolMode, brush: StructureBrush): void {
      const key = edgeKey(edge.ax, edge.az, edge.bx, edge.bz);

      if (mode === "erase") {
        if (structureSegments.delete(key)) {
          needsRebuild = true;
        }
        return;
      }

      const next = structureFromBrush(brush);
      const before = structureSegments.get(key);
      if (!structureEquals(before, next)) {
        structureSegments.set(key, next);
        needsRebuild = true;
      }
    }

    function applyBrushAtWorldPoint(world: THREE.Vector3, mode: ToolMode, brush: BrushType): void {
      if (isGroundBrush(brush)) {
        const cell = pickCellFromWorld(world);
        if (!cell) {
          return;
        }
        applyGroundTool(cell, mode, brush);
        return;
      }

      const edge = pickEdgeFromWorld(world);
      if (!edge) {
        return;
      }
      applyStructureTool(edge, mode, brush);
    }

    function strokeBetween(start: THREE.Vector3, end: THREE.Vector3, mode: ToolMode, brush: BrushType): void {
      const distance = start.distanceTo(end);
      const steps = Math.max(1, Math.ceil(distance / 0.2));
      for (let i = 1; i <= steps; i += 1) {
        strokePoint.lerpVectors(start, end, i / steps);
        applyBrushAtWorldPoint(strokePoint, mode, brush);
      }
    }

    function resolveRectModeForPointer(event: PointerEvent): RectToolMode {
      if (activeRectTool !== "none") {
        return activeRectTool;
      }

      if (event.shiftKey) {
        return "grass-fill";
      }

      return "none";
    }

    function hideHover(): void {
      edgeHoverMesh.visible = false;
      cellHoverMesh.visible = false;
    }

    function updateHoverFromWorld(world: THREE.Vector3 | null): void {
      if (!world) {
        hideHover();
        return;
      }

      const rectMode = dragState?.mode === "rect" ? dragState.rectMode ?? "none" : activeRectTool;
      if (rectMode !== "none") {
        const cell = pickCellFromWorld(world);
        if (!cell) {
          hideHover();
          return;
        }

        cellHoverMesh.visible = true;
        edgeHoverMesh.visible = false;
        cellHoverMesh.position.set(toWorldCellX(cell.x), 0.03, toWorldCellZ(cell.z));
        hoverMaterial.color.setHex(RECT_TOOL_COLORS[rectMode]);
        return;
      }

      const { brush } = getCurrentBrushAndMode();

      if (isGroundBrush(brush)) {
        const cell = pickCellFromWorld(world);
        if (!cell) {
          hideHover();
          return;
        }

        cellHoverMesh.visible = true;
        edgeHoverMesh.visible = false;
        cellHoverMesh.position.set(toWorldCellX(cell.x), 0.03, toWorldCellZ(cell.z));
        return;
      }

      const edge = pickEdgeFromWorld(world);
      if (!edge) {
        hideHover();
        return;
      }

      edgeHoverMesh.visible = true;
      cellHoverMesh.visible = false;

      const xA = toWorldNodeX(edge.ax);
      const zA = toWorldNodeZ(edge.az);
      const xB = toWorldNodeX(edge.bx);
      const zB = toWorldNodeZ(edge.bz);

      edgeHoverMesh.position.set((xA + xB) * 0.5, 0.03, (zA + zB) * 0.5);
      edgeHoverMesh.rotation.y = edge.az !== edge.bz ? Math.PI * 0.5 : 0;
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

      if (activeRectTool !== "none" || dragState?.mode === "rect") {
        renderer.domElement.style.cursor = "crosshair";
        return;
      }

      const { mode } = getCurrentBrushAndMode();
      renderer.domElement.style.cursor = mode === "erase" ? "not-allowed" : "crosshair";
    }

    function handlePointerDown(event: PointerEvent): void {
      if (event.button !== 0 && event.button !== 1 && event.button !== 2) {
        return;
      }

      renderer.domElement.focus({ preventScroll: true });
      renderer.domElement.setPointerCapture(event.pointerId);

      const startWorld = getWorldAtClient(event.clientX, event.clientY);
      const shouldPan = event.button === 1 || spacePressed;
      const paintMode: ToolMode = event.button === 2 ? "erase" : activeTool;
      const rectMode = event.button === 0 ? resolveRectModeForPointer(event) : "none";

      if (shouldPan) {
        dragState = {
          pointerId: event.pointerId,
          mode: "pan",
          paintMode,
          brush: activeBrush,
          lastClientX: event.clientX,
          lastClientY: event.clientY,
          lastWorldPoint: startWorld
        };
        updateCursor();
        event.preventDefault();
        return;
      }

      if (rectMode !== "none") {
        const startCell = startWorld ? pickCellFromWorld(startWorld) : null;
        if (!startCell) {
          event.preventDefault();
          return;
        }

        dragState = {
          pointerId: event.pointerId,
          mode: "rect",
          paintMode,
          brush: activeBrush,
          rectMode,
          rectStartCell: startCell,
          rectEndCell: startCell,
          lastClientX: event.clientX,
          lastClientY: event.clientY,
          lastWorldPoint: startWorld
        };
        updateRectPreview(startCell, startCell, rectMode);
        updateCursor();
        syncHud();
        event.preventDefault();
        return;
      }

      if (startWorld) {
        applyBrushAtWorldPoint(startWorld, paintMode, activeBrush);
      }

      dragState = {
        pointerId: event.pointerId,
        mode: "paint",
        paintMode,
        brush: activeBrush,
        lastClientX: event.clientX,
        lastClientY: event.clientY,
        lastWorldPoint: startWorld
      };

      updateCursor();
      syncHud();
      event.preventDefault();
    }

    function handlePointerMove(event: PointerEvent): void {
      if (dragState && event.pointerId === dragState.pointerId) {
        if (dragState.mode === "pan") {
          const deltaX = event.clientX - dragState.lastClientX;
          const deltaY = event.clientY - dragState.lastClientY;
          applyPanByPixels(deltaX, deltaY);

          dragState.lastClientX = event.clientX;
          dragState.lastClientY = event.clientY;

          updateHoverFromWorld(getWorldAtClient(event.clientX, event.clientY));
          event.preventDefault();
          return;
        }

        if (dragState.mode === "rect") {
          const world = getWorldAtClient(event.clientX, event.clientY);
          const cell = world ? pickCellFromWorld(world) : null;
          if (cell && dragState.rectStartCell) {
            dragState.rectEndCell = cell;
            updateRectPreview(dragState.rectStartCell, cell, dragState.rectMode ?? "none");
          }
          updateHoverFromWorld(world);
          event.preventDefault();
          return;
        }

        const world = getWorldAtClient(event.clientX, event.clientY);
        if (world) {
          if (dragState.lastWorldPoint) {
            strokeBetween(dragState.lastWorldPoint, world, dragState.paintMode, dragState.brush);
          } else {
            applyBrushAtWorldPoint(world, dragState.paintMode, dragState.brush);
          }
          dragState.lastWorldPoint = world;
        }

        updateHoverFromWorld(world);
        event.preventDefault();
        return;
      }

      updateHoverFromWorld(getWorldAtClient(event.clientX, event.clientY));
    }

    function finishPointer(pointerId: number): void {
      if (dragState && dragState.pointerId === pointerId) {
        if (
          dragState.mode === "rect" &&
          dragState.rectMode &&
          dragState.rectMode !== "none" &&
          dragState.rectStartCell &&
          dragState.rectEndCell
        ) {
          runRectTool(dragState.rectMode, dragState.rectStartCell, dragState.rectEndCell);
          hideRectPreview();
        }

        dragState = null;
      }
      hideRectPreview();
      updateCursor();
      syncHud();
    }

    function handlePointerUp(event: PointerEvent): void {
      finishPointer(event.pointerId);
    }

    function handlePointerCancel(event: PointerEvent): void {
      if (dragState && dragState.pointerId === event.pointerId) {
        dragState = null;
      }
      hideRectPreview();
      updateCursor();
      syncHud();
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

    function handleContextMenu(event: MouseEvent): void {
      event.preventDefault();
    }

    function handleKeyDown(event: KeyboardEvent): void {
      if (event.code === "Space") {
        spacePressed = true;
        updateCursor();
        event.preventDefault();
        return;
      }

      if (event.repeat) {
        return;
      }

      if (event.code === "KeyQ") {
        yawIndex -= 1;
        syncHud();
        event.preventDefault();
      } else if (event.code === "KeyE") {
        yawIndex += 1;
        syncHud();
        event.preventDefault();
      } else if (event.code === "Digit1") {
        activeBrush = "wall";
        activeRectTool = "none";
        syncHud();
        event.preventDefault();
      } else if (event.code === "Digit2") {
        activeBrush = "window";
        activeRectTool = "none";
        syncHud();
        event.preventDefault();
      } else if (event.code === "Digit3") {
        activeBrush = "door-closed";
        activeRectTool = "none";
        syncHud();
        event.preventDefault();
      } else if (event.code === "Digit4") {
        activeBrush = "floor";
        activeRectTool = "none";
        syncHud();
        event.preventDefault();
      } else if (event.code === "Digit5") {
        activeBrush = "grass";
        activeRectTool = "none";
        syncHud();
        event.preventDefault();
      } else if (event.code === "Digit6") {
        activeBrush = "door-open";
        activeRectTool = "none";
        syncHud();
        event.preventDefault();
      } else if (event.code === "Digit7") {
        activeBrush = "road";
        activeRectTool = "none";
        syncHud();
        event.preventDefault();
      } else if (event.code === "Digit8") {
        activeBrush = "sidewalk";
        activeRectTool = "none";
        syncHud();
        event.preventDefault();
      } else if (event.code === "Digit9") {
        activeRectTool = "building-footprint";
        syncHud();
        event.preventDefault();
      } else if (event.code === "KeyG") {
        activeRectTool = "grass-fill";
        syncHud();
        event.preventDefault();
      } else if (event.code === "KeyD") {
        activeTool = "draw";
        syncHud();
        event.preventDefault();
      } else if (event.code === "KeyX") {
        activeTool = "erase";
        syncHud();
        event.preventDefault();
      } else if (event.code === "KeyC") {
        structureSegments.clear();
        needsRebuild = true;
        bakeStatusMessage = "Geometry cleared.";
        syncHud();
        event.preventDefault();
      } else if (event.code === "KeyV") {
        groundOverrides.clear();
        needsRebuild = true;
        bakeStatusMessage = "Terrain overrides cleared.";
        syncHud();
        event.preventDefault();
      } else if (event.code === "KeyB") {
        runBakePreview();
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

    function syncSize(): void {
      const rect = mount.getBoundingClientRect();
      viewportWidth = Math.max(1, Math.floor(rect.width));
      viewportHeight = Math.max(1, Math.floor(rect.height));

      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
      renderer.setSize(viewportWidth, viewportHeight, true);
      updateCameraProjection();
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
    renderer.domElement.addEventListener("contextmenu", handleContextMenu);
    renderer.domElement.addEventListener("keydown", handleKeyDown);
    renderer.domElement.addEventListener("keyup", handleKeyUp);

    updateCameraProjection();
    syncHud();
    updateCursor();

    const render = () => {
      if (needsRebuild) {
        rebuildGroundTiles();
        rebuildStructures();
        needsRebuild = false;
        syncHud();
      }

      setCameraPose();
      renderer.render(scene, camera);
      raf = requestAnimationFrame(render);
    };

    render();

    return () => {
      cancelAnimationFrame(raf);
      resizeObserver.disconnect();

      renderer.domElement.removeEventListener("pointerdown", handlePointerDown);
      renderer.domElement.removeEventListener("pointermove", handlePointerMove);
      renderer.domElement.removeEventListener("pointerup", handlePointerUp);
      renderer.domElement.removeEventListener("pointercancel", handlePointerCancel);
      renderer.domElement.removeEventListener("wheel", handleWheel);
      renderer.domElement.removeEventListener("contextmenu", handleContextMenu);
      renderer.domElement.removeEventListener("keydown", handleKeyDown);
      renderer.domElement.removeEventListener("keyup", handleKeyUp);

      hud.destroy();

      clearGroup(groundGroup);
      clearGroup(structuresGroup);
      clearGroup(jointsGroup);

      const geometries: THREE.BufferGeometry[] = [
        groundTileGeometry,
        edgeHoverGeometry,
        cellHoverGeometry,
        rectPreviewGeometry,
        autoTileOverlayGeometry,
        floorBaseGeometry,
        minorGridGeometry,
        majorGridGeometry
      ];

      for (const geometry of geometries) {
        geometry.dispose();
      }

      structureMeshKit.dispose();

      const materials: THREE.Material[] = [
        floorBaseMaterial,
        minorGrid.material as THREE.Material,
        majorGrid.material as THREE.Material,
        groundFloorMaterial,
        ...grassVariantMaterials,
        groundBuildingMaterial,
        groundRoadSubgradeMaterial,
        groundSidewalkSubgradeMaterial,
        hoverMaterial,
        rectPreviewMaterial,
        ...autoTileMaterials.values()
      ];

      for (const material of materials) {
        material.dispose();
      }

      for (const texture of autoTileTextures.values()) {
        texture.dispose();
      }

      renderer.dispose();
      renderer.domElement.remove();
      mount.style.position = "";
    };
  }
};

export default experiment;
