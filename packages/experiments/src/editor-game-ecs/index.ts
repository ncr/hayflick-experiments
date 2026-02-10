/**
 * Per-frame flow for this combined editor + game experiment:
 * 1) EDITOR mode mutates a grid editor state (ground overrides + edge structure segments).
 * 2) F5 bakes editor state into ECS LevelResource + collider descriptors.
 * 3) GAME mode runs systems: Input -> PlayerIntent -> PhysicsEnsure -> SyncIn -> Step -> SyncOut -> Door -> Event.
 * 4) Door interactions are queued from clicks, then DoorSystem toggles logical blocking and physics colliders.
 * 5) K/L in GAME save/load full game state (editor state + player + door states by placementId).
 * 6) ESC returns to EDITOR without mutating editor auth state from runtime-only door toggles.
 */

import * as THREE from "three";
import {
  bakeLevelForEcs,
  createPromotedEditorControls,
  createEcsLevelResourceFromBake,
  createEditorStructureMeshKit,
  createEditorHud,
  LEVEL_EDITOR_WORLD_UNIT,
  levelBuilderDoorPlacementIdFromNodes,
  type PromotedEditorBrush,
  type PromotedEditorDefaultGround,
  type PromotedEditorRectToolMode,
  type PromotedEditorToolMode,
  LEVEL_BUILDER_STRUCTURE_KIND as STRUCTURE_KIND,
  isLevelBuilderDoorState,
  isLevelBuilderStructureKind,
  setDoorVisualOpen,
  type LevelBuilderDoorState,
  type LevelBuilderColliderDesc,
  type LevelBuilderGroundBase,
  type LevelBuilderGroundOverride,
  type LevelBuilderStructureSegment,
  type EditorDoorVisual,
  type MutableGridLevelResource
} from "@common/level-editor";
import {
  DataStore,
  KeyboardTracker,
  World,
  createEventSystem,
  createInputSystem,
  type EID
} from "@common/gameplay";
import { PixelPerfectIsoView } from "@common/render";
import {
  createPhysicsResource,
  initRapier,
  physicsEnsureSystem,
  physicsStepSystem,
  physicsSyncInSystem,
  physicsSyncOutSystem,
  type PhysicsBodyRef,
  type PhysicsColliderRef,
  type PhysicsResource
} from "@common/physics-rapier";
import type { ExperimentModule } from "../runtime/types";

function makeGradientMap(bands: number): THREE.DataTexture {
  const steps = Math.max(2, bands);
  const data = new Uint8Array(steps * 4);

  for (let i = 0; i < steps; i += 1) {
    const t = i / (steps - 1);
    const value = Math.round((0.18 + t * 0.82) * 255);
    const offset = i * 4;
    data[offset] = value;
    data[offset + 1] = value;
    data[offset + 2] = value;
    data[offset + 3] = 255;
  }

  const gradient = new THREE.DataTexture(data, steps, 1, THREE.RGBAFormat);
  gradient.minFilter = THREE.NearestFilter;
  gradient.magFilter = THREE.NearestFilter;
  gradient.generateMipmaps = false;
  gradient.needsUpdate = true;
  return gradient;
}

function applyRetroDither(
  material: THREE.MeshToonMaterial,
  bands: number,
  strength: number,
  specularStrength: number,
  specularShininess: number,
  specularBands: number,
  specularDitherStrength: number
): void {
  material.dithering = false;
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uToonDitherBands = { value: Math.max(2.0, bands) };
    shader.uniforms.uToonDitherStrength = { value: strength };
    shader.uniforms.uToonDitherPixelSize = { value: 4.0 };
    shader.uniforms.uSpecularStrength = { value: specularStrength };
    shader.uniforms.uSpecularShininess = { value: specularShininess };
    shader.uniforms.uSpecularBands = { value: Math.max(2.0, specularBands) };
    shader.uniforms.uSpecularDitherStrength = { value: specularDitherStrength };

    shader.fragmentShader = shader.fragmentShader.replace(
      "#include <gradientmap_pars_fragment>",
      `
      #ifdef USE_GRADIENTMAP
      uniform sampler2D gradientMap;
      #endif

      uniform float uToonDitherBands;
      uniform float uToonDitherStrength;
      uniform float uToonDitherPixelSize;
      uniform float uSpecularStrength;
      uniform float uSpecularShininess;
      uniform float uSpecularBands;
      uniform float uSpecularDitherStrength;

      float toonBayer4x4(vec2 p) {
        vec2 q = mod(floor(p), 4.0);
        float x = q.x;
        float y = q.y;
        if (y < 1.0) {
          if (x < 1.0) return 0.0;
          if (x < 2.0) return 8.0;
          if (x < 3.0) return 2.0;
          return 10.0;
        }
        if (y < 2.0) {
          if (x < 1.0) return 12.0;
          if (x < 2.0) return 4.0;
          if (x < 3.0) return 14.0;
          return 6.0;
        }
        if (y < 3.0) {
          if (x < 1.0) return 3.0;
          if (x < 2.0) return 11.0;
          if (x < 3.0) return 1.0;
          return 9.0;
        }
        if (x < 1.0) return 15.0;
        if (x < 2.0) return 7.0;
        if (x < 3.0) return 13.0;
        return 5.0;
      }

      vec3 getGradientIrradiance(vec3 normal, vec3 lightDirection) {
        float dotNL = clamp(dot(normal, lightDirection) * 0.5 + 0.5, 0.0, 1.0);
        float levels = max(2.0, uToonDitherBands);
        vec2 ditherCell = floor(gl_FragCoord.xy / max(1.0, uToonDitherPixelSize));
        float bayer = (toonBayer4x4(ditherCell) + 0.5) / 16.0 - 0.5;
        float dithered = clamp(dotNL + bayer * uToonDitherStrength, 0.0, 1.0);
        float quantized = floor(dithered * (levels - 1.0) + 0.5) / (levels - 1.0);

        #ifdef USE_GRADIENTMAP
          return vec3(texture2D(gradientMap, vec2(quantized, 0.0)).r);
        #else
          return vec3(quantized);
        #endif
      }
      `
    );

    shader.fragmentShader = shader.fragmentShader.replace(
      "#include <lights_toon_pars_fragment>",
      `
      varying vec3 vViewPosition;

      struct ToonMaterial {
        vec3 diffuseColor;
      };

      void RE_Direct_Toon( const in IncidentLight directLight, const in vec3 geometryPosition, const in vec3 geometryNormal, const in vec3 geometryViewDir, const in vec3 geometryClearcoatNormal, const in ToonMaterial material, inout ReflectedLight reflectedLight ) {
        vec3 irradiance = getGradientIrradiance( geometryNormal, directLight.direction ) * directLight.color;
        reflectedLight.directDiffuse += irradiance * BRDF_Lambert( material.diffuseColor );

        float ndl = max( dot( geometryNormal, directLight.direction ), 0.0 );
        vec3 halfDir = normalize( directLight.direction + geometryViewDir );
        float ndh = max( dot( geometryNormal, halfDir ), 0.0 );
        float specRaw = pow( ndh, max( 1.0, uSpecularShininess ) ) * ndl * uSpecularStrength;

        vec2 ditherCell = floor( gl_FragCoord.xy / max( 1.0, uToonDitherPixelSize ) );
        float bayer = ( toonBayer4x4( ditherCell ) + 0.5 ) / 16.0 - 0.5;
        float dithered = clamp( specRaw + bayer * uSpecularDitherStrength, 0.0, 1.0 );
        float levels = max( 2.0, uSpecularBands );
        float quantizedSpec = floor( dithered * ( levels - 1.0 ) + 0.5 ) / ( levels - 1.0 );

        vec3 specColor = mix( vec3( 1.0 ), material.diffuseColor, 0.2 );
        reflectedLight.directDiffuse += quantizedSpec * directLight.color * specColor;
      }

      void RE_IndirectDiffuse_Toon( const in vec3 irradiance, const in vec3 geometryPosition, const in vec3 geometryNormal, const in vec3 geometryViewDir, const in vec3 geometryClearcoatNormal, const in ToonMaterial material, inout ReflectedLight reflectedLight ) {
        reflectedLight.indirectDiffuse += irradiance * BRDF_Lambert( material.diffuseColor );
      }

      #define RE_Direct RE_Direct_Toon
      #define RE_IndirectDiffuse RE_IndirectDiffuse_Toon
      `
    );
  };
  material.customProgramCacheKey = () =>
    `retroDither_b${bands.toFixed(2)}_s${strength.toFixed(3)}_spec${specularStrength.toFixed(3)}_sh${specularShininess.toFixed(2)}_sb${specularBands.toFixed(2)}_sd${specularDitherStrength.toFixed(3)}`;
  material.needsUpdate = true;
}

type ToonMaterialSpec = {
  color: number;
  bands: number;
  ditherStrength: number;
  specularStrength: number;
  specularShininess: number;
  specularBands?: number;
  specularDitherStrength?: number;
  transparent?: boolean;
  opacity?: number;
};

function makeToonMaterial(spec: ToonMaterialSpec): {
  material: THREE.MeshToonMaterial;
  gradient: THREE.DataTexture;
} {
  const gradient = makeGradientMap(spec.bands);
  const material = new THREE.MeshToonMaterial({
    color: spec.color,
    gradientMap: gradient,
    transparent: spec.transparent ?? false,
    opacity: spec.opacity ?? 1,
    toneMapped: true
  });
  applyRetroDither(
    material,
    spec.bands,
    spec.ditherStrength,
    spec.specularStrength,
    spec.specularShininess,
    spec.specularBands ?? 4,
    spec.specularDitherStrength ?? 0.0
  );
  return { material, gradient };
}

type Mode = "EDITOR" | "GAME";

type ToolMode = "draw" | "erase";

type StructureBrush = "wall" | "window" | "door-closed" | "door-open";
type GroundPaintBrush = "floor" | "grass" | "road" | "sidewalk";
type EditorBrush = StructureBrush | GroundPaintBrush;
type RectToolMode = "none" | "grass-fill" | "building-footprint";

type GroundBase = LevelBuilderGroundBase;

type GroundCellOverride = {
  base: GroundBase;
  variant?: number;
};

type StructureSegmentData =
  | { kind: "wall" }
  | { kind: "window" }
  | { kind: "door"; state: LevelBuilderDoorState };

type DoorStructureSegment = Extract<StructureSegmentData, { kind: "door" }>;

type GridCell = {
  x: number;
  y: number;
};

type GridEdge = {
  ax: number;
  ay: number;
  bx: number;
  by: number;
};

type DragState = {
  pointerId: number;
  mode: "pan" | "paint" | "game-click" | "rect";
  lastClientX: number;
  lastClientY: number;
  lastWorldPoint: THREE.Vector3 | null;
  paintMode?: ToolMode;
  brush?: EditorBrush;
  moved: boolean;
  rectMode?: RectToolMode;
  rectStartCell?: { x: number; y: number };
  rectEndCell?: { x: number; y: number };
};

type DirectionVector = {
  dx: number;
  dy: number;
};

type DoorComponent = {
  placementId: string;
  edgeKey: string;
  cellX: number;
  cellY: number;
  linkedCells: Array<{ x: number; y: number }>;
  ax: number;
  ay: number;
  bx: number;
  by: number;
  rot: number;
  open: boolean;
  locked?: boolean;
};

type DoorOverride = {
  open: boolean;
  locked?: boolean;
};

type GameRuntime = {
  world: World;
  levelResource: MutableGridLevelResource;
  keyboard: KeyboardTracker;
  physics: PhysicsResource;
  physicsBodies: DataStore<PhysicsBodyRef>;
  physicsColliders: DataStore<PhysicsColliderRef>;
  systems: {
    inputSystem: ReturnType<typeof createInputSystem>;
    eventSystem: ReturnType<typeof createEventSystem>;
  };
  playerEid: EID;
  doors: DataStore<DoorComponent>;
  doorByPlacementId: Map<string, EID>;
  placementIdByEdge: Map<string, string>;
  doorColliderByPlacementId: Map<string, number>;
  doorVisuals: Map<string, EditorDoorVisual>;
  interactionQueue: string[];
};

type GameSaveDoor = {
  placementId: string;
  open: boolean;
  locked?: boolean;
};

type GameSave = {
  schemaVersion: number;
  terrain: {
    defaultGround: GroundBase;
    seed: number;
    overrides: Array<{
      x: number;
      y: number;
      base: GroundBase;
      variant?: number;
    }>;
  };
  structures: LevelBuilderStructureSegment[];
  player: {
    x: number;
    y: number;
  };
  doors: GameSaveDoor[];
};

type EditorSave = {
  schemaVersion: number;
  terrain: {
    defaultGround: GroundBase;
    seed: number;
    overrides: Array<{
      x: number;
      y: number;
      base: GroundBase;
      variant?: number;
    }>;
  };
  structures: LevelBuilderStructureSegment[];
};

const GRID_TILES = 30;
const TILE_SIZE = LEVEL_EDITOR_WORLD_UNIT;
const GRID_ORIGIN = -(GRID_TILES * TILE_SIZE) * 0.5;

const LEVEL_MODEL_STORAGE_KEY = "editor_game_ecs_level_model_v4";
const GAME_SAVE_STORAGE_KEY = "editor_game_ecs_game_save_v4";
const GAME_SAVE_SCHEMA_VERSION = 2;
const EDITOR_LEVEL_SCHEMA_VERSION = 4;

const CAMERA_PITCH = THREE.MathUtils.degToRad(30);
const CAMERA_BASE_YAW = THREE.MathUtils.degToRad(45);
const CAMERA_DISTANCE = 30 * TILE_SIZE;
const ORTHO_HEIGHT = 7.95495128834866 * TILE_SIZE;
const CAMERA_ZOOM_MIN = 1;
const CAMERA_ZOOM_MAX = 6;
const CAMERA_ZOOM_STEP = 1;
const ROTATION_ANIMATION_RATE = 18;
const ROTATION_ANIMATION_EPSILON = 1e-3;
const ZOOM_ANIMATION_RATE = 14;
const ZOOM_ANIMATION_BURST_RATE = 42;
const ZOOM_ANIMATION_EPSILON = 0.02;
const ZOOM_BURST_IDLE_MS = 90;
const FIXED_RENDER_HEIGHT = 360;
const BASE_PIXEL_ZOOM = 2;
const OUTPUT_OVERSCAN_LOW_PIXELS = 2;

const PLAYER_SPEED = 3.8;
const PLAYER_SPAWN = { x: 2.5, y: 2.5 };
const GRASS_VARIANT_COUNT = 4;
const DEFAULT_GRASS_VARIANT_SEED = 0x41c64e6d;

const BRUSH_COLORS: Record<EditorBrush, number> = {
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

function isGroundBrush(brush: EditorBrush): brush is GroundPaintBrush {
  return (
    brush === "floor" ||
    brush === "grass" ||
    brush === "road" ||
    brush === "sidewalk"
  );
}

function isStructureBrush(brush: EditorBrush): brush is StructureBrush {
  return (
    brush === "wall" ||
    brush === "window" ||
    brush === "door-closed" ||
    brush === "door-open"
  );
}

function structureFromBrush(brush: StructureBrush): StructureSegmentData {
  if (brush === "wall") {
    return { kind: STRUCTURE_KIND.WALL };
  }
  if (brush === "window") {
    return { kind: STRUCTURE_KIND.WINDOW };
  }
  return {
    kind: STRUCTURE_KIND.DOOR,
    state: brush === "door-open" ? "open" : "closed"
  };
}

function assertNever(value: never, label: string): never {
  throw new Error(`Unhandled ${label}: ${String(value)}`);
}

function isDoorStructureSegment(
  segment: StructureSegmentData
): segment is DoorStructureSegment {
  return segment.kind === STRUCTURE_KIND.DOOR;
}

function isSolidStructureSegment(segment: StructureSegmentData): boolean {
  return segment.kind !== STRUCTURE_KIND.DOOR;
}

function structureEquals(
  a: StructureSegmentData | undefined,
  b: StructureSegmentData
): boolean {
  if (!a || a.kind !== b.kind) {
    return false;
  }

  if (isDoorStructureSegment(a) && isDoorStructureSegment(b)) {
    return a.state === b.state;
  }
  return true;
}

function cellKey(x: number, y: number): string {
  return `${x},${y}`;
}

function edgeKey(ax: number, ay: number, bx: number, by: number): string {
  if (ax < bx || (ax === bx && ay <= by)) {
    return `${ax},${ay}|${bx},${by}`;
  }
  return `${bx},${by}|${ax},${ay}`;
}

function parseEdge(key: string): GridEdge {
  const [a, b] = key.split("|");
  const [axStr, ayStr] = a.split(",");
  const [bxStr, byStr] = b.split(",");
  return {
    ax: Number(axStr),
    ay: Number(ayStr),
    bx: Number(bxStr),
    by: Number(byStr)
  };
}

function edgePlacementId(edge: GridEdge): string {
  return levelBuilderDoorPlacementIdFromNodes(
    edge.ax,
    edge.ay,
    edge.bx,
    edge.by
  );
}

function isInGrid(cellX: number, cellY: number): boolean {
  return cellX >= 0 && cellY >= 0 && cellX < GRID_TILES && cellY < GRID_TILES;
}

function readRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  return value as Record<string, unknown>;
}

function readFiniteNumber(
  record: Record<string, unknown>,
  key: string
): number | null {
  const value = record[key];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return null;
  }
  return value;
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

function hashCell(seed: number, x: number, y: number): number {
  let h = seed | 0;
  h ^= Math.imul(x | 0, 0x9e3779b1);
  h = Math.imul(h, 0x85ebca6b);
  h ^= Math.imul(y | 0, 0xc2b2ae35);
  return hashInt32(h);
}

function hashRect(
  seed: number,
  ax: number,
  ay: number,
  bx: number,
  by: number
): number {
  let h = seed | 0;
  h ^= Math.imul(ax | 0, 0x165667b1);
  h ^= Math.imul(ay | 0, 0xd3a2646c);
  h ^= Math.imul(bx | 0, 0xfd7046c5);
  h ^= Math.imul(by | 0, 0xb55a4f09);
  return hashInt32(h);
}

function computeGrassVariant(seed: number, x: number, y: number): number {
  return hashCell(seed, x, y) % GRASS_VARIANT_COUNT;
}

function isGroundBase(value: unknown): value is GroundBase {
  return (
    value === "floor" ||
    value === "grass" ||
    value === "road" ||
    value === "sidewalk" ||
    value === "building"
  );
}

function normalizeGroundOverride(
  base: GroundBase,
  variant?: number
): GroundCellOverride {
  if (base === "grass") {
    return {
      base,
      variant:
        variant === undefined ? undefined : Math.max(0, Math.floor(variant))
    };
  }
  return { base };
}

function asInteger(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return null;
  }
  return Math.floor(value);
}

function parseStructureState(
  raw: unknown
): Map<string, StructureSegmentData> | null {
  if (!Array.isArray(raw)) {
    return null;
  }

  const segments = new Map<string, StructureSegmentData>();
  for (const entryRaw of raw) {
    const entry = readRecord(entryRaw);
    if (!entry) {
      return null;
    }

    const kind = entry.kind;
    const ax = asInteger(entry.ax);
    const ay = asInteger(entry.az);
    const bx = asInteger(entry.bx);
    const by = asInteger(entry.bz);
    if (
      ax === null ||
      ay === null ||
      bx === null ||
      by === null ||
      !isInGrid(Math.min(ax, bx), Math.min(ay, by)) ||
      !isInGrid(Math.max(ax, bx) - 1, Math.max(ay, by) - 1)
    ) {
      return null;
    }

    const horizontal = ay === by && Math.abs(ax - bx) === 1;
    const vertical = ax === bx && Math.abs(ay - by) === 1;
    if (!horizontal && !vertical) {
      return null;
    }

    const key = edgeKey(ax, ay, bx, by);
    if (!isLevelBuilderStructureKind(kind)) {
      return null;
    }

    switch (kind) {
      case STRUCTURE_KIND.WALL:
      case STRUCTURE_KIND.WINDOW:
        segments.set(key, { kind });
        break;
      case STRUCTURE_KIND.DOOR: {
        const doorState = entry.doorState;
        if (!isLevelBuilderDoorState(doorState)) {
          return null;
        }
        segments.set(key, { kind: STRUCTURE_KIND.DOOR, state: doorState });
        break;
      }
      default:
        return assertNever(kind, "serialized structure kind");
    }
  }

  return segments;
}

function serializeStructureState(
  structureSegments: Map<string, StructureSegmentData>
): LevelBuilderStructureSegment[] {
  const result: LevelBuilderStructureSegment[] = [];
  for (const [key, value] of structureSegments.entries()) {
    const edge = parseEdge(key);
    if (isDoorStructureSegment(value)) {
      result.push({
        kind: STRUCTURE_KIND.DOOR,
        doorState: value.state,
        ax: edge.ax,
        az: edge.ay,
        bx: edge.bx,
        bz: edge.by
      });
    } else {
      result.push({
        kind: value.kind,
        ax: edge.ax,
        az: edge.ay,
        bx: edge.bx,
        bz: edge.by
      });
    }
  }
  return result;
}

function parseTerrainState(raw: unknown): {
  defaultGround: GroundBase;
  seed: number;
  overrides: Map<string, GroundCellOverride>;
} | null {
  const record = readRecord(raw);
  if (!record) {
    return null;
  }

  const defaultGroundRaw = record.defaultGround;
  const seedRaw = record.seed;
  const overridesRaw = record.overrides;

  if (
    !isGroundBase(defaultGroundRaw) ||
    typeof seedRaw !== "number" ||
    !Array.isArray(overridesRaw)
  ) {
    return null;
  }

  const overrides = new Map<string, GroundCellOverride>();
  for (const entryRaw of overridesRaw) {
    const entry = readRecord(entryRaw);
    if (!entry) {
      return null;
    }

    const x = readFiniteNumber(entry, "x");
    const y = readFiniteNumber(entry, "y");
    const base = entry.base;
    const variant = entry.variant;

    if (x === null || y === null || !isGroundBase(base)) {
      return null;
    }
    if (
      variant !== undefined &&
      (typeof variant !== "number" || !Number.isFinite(variant))
    ) {
      return null;
    }

    overrides.set(
      cellKey(Math.floor(x), Math.floor(y)),
      normalizeGroundOverride(base, variant as number | undefined)
    );
  }

  return {
    defaultGround: defaultGroundRaw,
    seed: Math.floor(seedRaw),
    overrides
  };
}

function parseStoredEditorState(raw: unknown): {
  defaultGround: GroundBase;
  seed: number;
  overrides: Map<string, GroundCellOverride>;
  structures: Map<string, StructureSegmentData>;
} | null {
  const record = readRecord(raw);
  if (!record) {
    return null;
  }

  const schemaVersion = readFiniteNumber(record, "schemaVersion");
  if (schemaVersion !== EDITOR_LEVEL_SCHEMA_VERSION) {
    return null;
  }

  const terrain = parseTerrainState(record.terrain);
  const structures = parseStructureState(record.structures);
  if (!terrain || !structures) {
    return null;
  }

  return {
    defaultGround: terrain.defaultGround,
    seed: terrain.seed,
    overrides: terrain.overrides,
    structures
  };
}

function serializeTerrainState(
  defaultGround: GroundBase,
  seed: number,
  overrides: Map<string, GroundCellOverride>
): {
  defaultGround: GroundBase;
  seed: number;
  overrides: Array<{
    x: number;
    y: number;
    base: GroundBase;
    variant?: number;
  }>;
} {
  return {
    defaultGround,
    seed,
    overrides: [...overrides.entries()].map(([key, value]) => {
      const [xStr, yStr] = key.split(",");
      return {
        x: Number(xStr),
        y: Number(yStr),
        base: value.base,
        variant: value.variant
      };
    })
  };
}

function createGridGeometry(
  width: number,
  height: number,
  y: number
): THREE.BufferGeometry {
  const lines: number[] = [];
  const originX = GRID_ORIGIN;
  const originY = GRID_ORIGIN;

  for (let x = 0; x <= width; x += 1) {
    const worldX = originX + x * TILE_SIZE;
    lines.push(worldX, y, originY, worldX, y, originY + height * TILE_SIZE);
  }

  for (let yCell = 0; yCell <= height; yCell += 1) {
    const worldY = originY + yCell * TILE_SIZE;
    lines.push(originX, y, worldY, originX + width * TILE_SIZE, y, worldY);
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(lines, 3));
  return geometry;
}

function toWorldX(cellX: number): number {
  return GRID_ORIGIN + cellX * TILE_SIZE + TILE_SIZE * 0.5;
}

function toWorldZ(cellY: number): number {
  return GRID_ORIGIN + cellY * TILE_SIZE + TILE_SIZE * 0.5;
}

function toWorldCoordX(x: number): number {
  return GRID_ORIGIN + x * TILE_SIZE;
}

function toWorldCoordZ(y: number): number {
  return GRID_ORIGIN + y * TILE_SIZE;
}

function toWorldNodeX(nodeX: number): number {
  return GRID_ORIGIN + nodeX * TILE_SIZE;
}

function toWorldNodeZ(nodeY: number): number {
  return GRID_ORIGIN + nodeY * TILE_SIZE;
}

function worldToCell(worldX: number, worldZ: number): GridCell | null {
  const localX = (worldX - GRID_ORIGIN) / TILE_SIZE;
  const localY = (worldZ - GRID_ORIGIN) / TILE_SIZE;
  if (
    localX < 0 ||
    localX >= GRID_TILES ||
    localY < 0 ||
    localY >= GRID_TILES
  ) {
    return null;
  }
  return {
    x: Math.floor(localX),
    y: Math.floor(localY)
  };
}

function pickEdgeFromWorld(world: THREE.Vector3): GridEdge | null {
  const localX = (world.x - GRID_ORIGIN) / TILE_SIZE;
  const localY = (world.z - GRID_ORIGIN) / TILE_SIZE;
  if (
    localX < -0.001 ||
    localX > GRID_TILES + 0.001 ||
    localY < -0.001 ||
    localY > GRID_TILES + 0.001
  ) {
    return null;
  }

  const clampedX = THREE.MathUtils.clamp(localX, 0, GRID_TILES);
  const clampedY = THREE.MathUtils.clamp(localY, 0, GRID_TILES);

  const safeCellX = THREE.MathUtils.clamp(
    Math.floor(localX),
    0,
    GRID_TILES - 1
  );
  const safeCellY = THREE.MathUtils.clamp(
    Math.floor(localY),
    0,
    GRID_TILES - 1
  );

  const lineX = THREE.MathUtils.clamp(Math.round(clampedX), 0, GRID_TILES);
  const lineY = THREE.MathUtils.clamp(Math.round(clampedY), 0, GRID_TILES);

  const distanceToVertical = Math.abs(clampedX - lineX);
  const distanceToHorizontal = Math.abs(clampedY - lineY);
  if (distanceToVertical <= distanceToHorizontal) {
    return {
      ax: lineX,
      ay: safeCellY,
      bx: lineX,
      by: safeCellY + 1
    };
  }

  return {
    ax: safeCellX,
    ay: lineY,
    bx: safeCellX + 1,
    by: lineY
  };
}

function addRoomWalls(
  structureSegments: Map<string, StructureSegmentData>,
  minX: number,
  minY: number,
  maxX: number,
  maxY: number
): void {
  for (let x = minX; x <= maxX; x += 1) {
    structureSegments.set(edgeKey(x, minY, x + 1, minY), { kind: "wall" });
    structureSegments.set(edgeKey(x, maxY + 1, x + 1, maxY + 1), {
      kind: "wall"
    });
  }
  for (let y = minY; y <= maxY; y += 1) {
    structureSegments.set(edgeKey(minX, y, minX, y + 1), { kind: "wall" });
    structureSegments.set(edgeKey(maxX + 1, y, maxX + 1, y + 1), {
      kind: "wall"
    });
  }
}

function createMockupStructureSegments(): Map<string, StructureSegmentData> {
  const structureSegments = new Map<string, StructureSegmentData>();

  // Two neighboring rooms with a shared wall.
  addRoomWalls(structureSegments, 6, 7, 9, 10);
  addRoomWalls(structureSegments, 10, 7, 13, 10);

  // Door between rooms (shared wall) and one door to the outside.
  structureSegments.set(edgeKey(10, 8, 10, 9), {
    kind: STRUCTURE_KIND.DOOR,
    state: "closed"
  });
  structureSegments.set(edgeKey(7, 7, 8, 7), {
    kind: STRUCTURE_KIND.DOOR,
    state: "closed"
  });

  return structureSegments;
}

function createMockupTerrainOverrides(
  seed: number
): Map<string, GroundCellOverride> {
  const overrides = new Map<string, GroundCellOverride>();

  const setCell = (
    x: number,
    y: number,
    base: GroundBase,
    variant?: number
  ): void => {
    if (!isInGrid(x, y)) {
      return;
    }

    overrides.set(cellKey(x, y), normalizeGroundOverride(base, variant));
  };

  const fillRect = (
    minX: number,
    minY: number,
    maxX: number,
    maxY: number,
    base: GroundBase
  ): void => {
    for (let y = minY; y <= maxY; y += 1) {
      for (let x = minX; x <= maxX; x += 1) {
        const variant =
          base === "grass"
            ? computeGrassVariant(seed ^ 0x9e3779b9, x, y)
            : undefined;
        setCell(x, y, base, variant);
      }
    }
  };

  // Room floors.
  fillRect(6, 7, 9, 10, "floor");
  fillRect(10, 7, 13, 10, "floor");

  // Exterior path leading to the outside door at edge (7,7)-(8,7).
  for (let y = 0; y <= 6; y += 1) {
    setCell(7, y, "sidewalk");
  }
  for (let x = 6; x <= 8; x += 1) {
    setCell(x, 4, "sidewalk");
  }

  return overrides;
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
  const structuresRaw = record.structures;
  const doorsRaw = record.doors;
  const terrainRaw = record.terrain;

  if (!playerRaw || !Array.isArray(doorsRaw)) {
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

  const terrain =
    terrainRaw === undefined ? undefined : parseTerrainState(terrainRaw);
  const structures = parseStructureState(structuresRaw);
  if (terrainRaw !== undefined && !terrain) {
    return null;
  }
  if (!terrain || !structures) {
    return null;
  }

  return {
    schemaVersion,
    terrain: {
      defaultGround: terrain.defaultGround,
      seed: terrain.seed,
      overrides: [...terrain.overrides.entries()].map(([key, value]) => {
        const [xStr, yStr] = key.split(",");
        return {
          x: Number(xStr),
          y: Number(yStr),
          base: value.base,
          variant: value.variant
        };
      })
    },
    structures: serializeStructureState(structures),
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
  init: async ({ mount, width, height }) => {
    mount.style.position = "relative";

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x0b1117);

    let viewportWidth = Math.max(1, width);
    let viewportHeight = Math.max(1, height);

    const hemiLight = new THREE.HemisphereLight(0xd6ecff, 0x15202b, 0.7);
    scene.add(hemiLight);

    const keyLight = new THREE.DirectionalLight(0xf5f1e8, 1.1);
    keyLight.position.set(16, 22, 12);
    scene.add(keyLight);

    const fillLight = new THREE.DirectionalLight(0xa9c7ff, 0.35);
    fillLight.position.set(-12, 14, -10);
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

    const view = new PixelPerfectIsoView({
      mount,
      width,
      height,
      scene,
      fixedRenderHeight: FIXED_RENDER_HEIGHT,
      baseOrthoHeight: ORTHO_HEIGHT,
      cameraDistance: CAMERA_DISTANCE,
      cameraPitch: CAMERA_PITCH,
      cameraYaw: CAMERA_BASE_YAW,
      basePixelZoom: BASE_PIXEL_ZOOM,
      zoomMin: CAMERA_ZOOM_MIN,
      zoomMax: CAMERA_ZOOM_MAX,
      zoomStep: CAMERA_ZOOM_STEP,
      zoomAnimationRate: ZOOM_ANIMATION_RATE,
      zoomAnimationBurstRate: ZOOM_ANIMATION_BURST_RATE,
      zoomAnimationEpsilon: ZOOM_ANIMATION_EPSILON,
      rotationAnimationRate: ROTATION_ANIMATION_RATE,
      rotationAnimationEpsilon: ROTATION_ANIMATION_EPSILON,
      zoomBurstIdleMs: ZOOM_BURST_IDLE_MS,
      outputOverscanLowPixels: OUTPUT_OVERSCAN_LOW_PIXELS,
      clearColor: 0x0b1117,
      clearAlpha: 1,
      mountBackground: "#0b1117",
      canvasBackground: "#0b1117"
    });
    const camera = view.camera;
    const renderer = view.renderer;
    renderer.domElement.style.touchAction = "none";
    renderer.domElement.style.outline = "none";
    renderer.domElement.tabIndex = 0;

    let minorGridGeometry = createGridGeometry(GRID_TILES, GRID_TILES, 0.01);
    const minorGridMaterial = new THREE.LineBasicMaterial({
      color: 0x42617c,
      transparent: true,
      opacity: 0.65
    });
    const gridLines = new THREE.LineSegments(
      minorGridGeometry,
      minorGridMaterial
    );
    scene.add(gridLines);

    const floorGeometry = new THREE.BoxGeometry(
      TILE_SIZE,
      0.06 * TILE_SIZE,
      TILE_SIZE
    );
    const structureMeshKit = createEditorStructureMeshKit();
    const playerBodyGeometry = new THREE.CylinderGeometry(
      0.25 * TILE_SIZE,
      0.25 * TILE_SIZE,
      1.0 * TILE_SIZE,
      14
    );
    const playerHeadGeometry = new THREE.SphereGeometry(0.2 * TILE_SIZE, 12, 10);
    const toonGradients: THREE.DataTexture[] = [];
    const makeToon = (spec: ToonMaterialSpec) => {
      const { material, gradient } = makeToonMaterial(spec);
      toonGradients.push(gradient);
      return material;
    };

    const floorMaterial = makeToon({
      color: 0xd7dee6,
      bands: 5,
      ditherStrength: 0.0,
      specularStrength: 0.3,
      specularShininess: 52
    });
    const grassVariantMaterials: THREE.MeshToonMaterial[] = [
      makeToon({
        color: 0x5b9862,
        bands: 4,
        ditherStrength: 0.0,
        specularStrength: 0.08,
        specularShininess: 18
      }),
      makeToon({
        color: 0x679f6b,
        bands: 4,
        ditherStrength: 0.0,
        specularStrength: 0.08,
        specularShininess: 18
      }),
      makeToon({
        color: 0x4e8d58,
        bands: 4,
        ditherStrength: 0.0,
        specularStrength: 0.08,
        specularShininess: 18
      }),
      makeToon({
        color: 0x76ab6c,
        bands: 4,
        ditherStrength: 0.0,
        specularStrength: 0.08,
        specularShininess: 18
      })
    ];
    const roadMaterial = makeToon({
      color: 0x5b6672,
      bands: 4,
      ditherStrength: 0.0,
      specularStrength: 0.12,
      specularShininess: 24
    });
    const sidewalkMaterial = makeToon({
      color: 0xc4c7c9,
      bands: 4,
      ditherStrength: 0.0,
      specularStrength: 0.18,
      specularShininess: 28
    });
    const buildingGroundMaterial = makeToon({
      color: 0xb7c0c9,
      bands: 4,
      ditherStrength: 0.0,
      specularStrength: 0.2,
      specularShininess: 26
    });

    const playerBodyMaterial = makeToon({
      color: 0x72b8f1,
      bands: 4,
      ditherStrength: 0.0,
      specularStrength: 0.26,
      specularShininess: 36
    });
    const playerHeadMaterial = makeToon({
      color: 0xf2f7ff,
      bands: 5,
      ditherStrength: 0.0,
      specularStrength: 0.35,
      specularShininess: 48
    });

    const hoverMaterial = new THREE.MeshBasicMaterial({
      color: 0x72b9ff,
      transparent: true,
      opacity: 0.38,
      depthWrite: false
    });
    const hoverMesh = new THREE.Mesh(
      new THREE.BoxGeometry(TILE_SIZE, 0.04 * TILE_SIZE, TILE_SIZE),
      hoverMaterial
    );
    hoverMesh.visible = false;
    hoverMesh.position.y = 0.03 * TILE_SIZE;
    scene.add(hoverMesh);

    const rectPreviewMaterial = new THREE.MeshBasicMaterial({
      color: RECT_TOOL_COLORS["grass-fill"],
      transparent: true,
      opacity: 0.26,
      depthWrite: false
    });
    const rectPreviewMesh = new THREE.Mesh(
      new THREE.BoxGeometry(TILE_SIZE, 0.03 * TILE_SIZE, TILE_SIZE),
      rectPreviewMaterial
    );
    rectPreviewMesh.visible = false;
    rectPreviewMesh.position.y = 0.035 * TILE_SIZE;
    scene.add(rectPreviewMesh);

    const playerMesh = new THREE.Group();
    const playerBody = new THREE.Mesh(playerBodyGeometry, playerBodyMaterial);
    playerBody.position.y = 0.5 * TILE_SIZE;
    playerMesh.add(playerBody);

    const playerHead = new THREE.Mesh(playerHeadGeometry, playerHeadMaterial);
    playerHead.position.y = 1.15 * TILE_SIZE;
    playerMesh.add(playerHead);

    gameplayGroup.add(playerMesh);
    playerMesh.visible = false;

    const hud = createEditorHud({
      mount,
      title: "Editor + Game (ECS)",
      description:
        "Build terrain + edge structures in EDITOR, bake to LevelResource, then run ECS gameplay in GAME mode.",
      hints:
        "EDITOR: paint with LMB drag, Ctrl+S saves editor state. GAME: click doors to toggle, K saves game, L loads game. Camera: Q/E rotate, wheel zoom, MMB drag pan.",
      focusTarget: renderer.domElement,
      leftPanelWidth: "min(430px, 58vw)",
      rightPanelMinWidth: "300px",
      statsTestId: "editor-game-ecs-stats",
      statusTestId: "editor-game-ecs-status"
    });

    const setButtonActive = hud.setButtonActive;
    const stats = hud.stats;
    const status = hud.status;
    const hints = hud.hints;

    let mode: Mode = "EDITOR";
    let activeTool: ToolMode = "draw";
    let editorBrush: EditorBrush = "wall";
    let activeRectTool: RectToolMode = "none";
    let defaultGroundBase: GroundBase = "grass";
    let userSeed = 1337;
    let statusMessage = "Ready.";

    const editorHintsText =
      "LMB drag: paint  •  Shift+drag: grass fill rect  •  G: grass rect  •  9: footprint rect  •  7/8: road/sidewalk  •  B: bake  •  EXIT (F5): game mode";
    const gameHintsText =
      "GAME: WASD/Arrows move, click doors to toggle, K save game, L load game, ESC editor. Camera: Q/E rotate, wheel zoom, MMB drag pan.";

    const promotedControls = createPromotedEditorControls({
      hud,
      initialSeed: userSeed,
      onTool(modeValue: PromotedEditorToolMode): void {
        activeTool = modeValue;
        syncHud();
      },
      onBrush(brush: PromotedEditorBrush): void {
        editorBrush = brush as EditorBrush;
        if (brush === "grass" || brush === "road" || brush === "sidewalk") {
          activeRectTool = "none";
        }
        syncHud();
      },
      onRectTool(modeValue: PromotedEditorRectToolMode): void {
        activeRectTool = modeValue as RectToolMode;
        if (modeValue === "none") {
          hideRectPreview();
        }
        syncHud();
      },
      onDefaultGround(base: PromotedEditorDefaultGround): void {
        defaultGroundBase = base;
        rebuildBaseLevelMeshes();
        statusMessage = `Default ground set to ${base}.`;
        syncHud();
      },
      onSeed(seed: number): void {
        userSeed = seed;
        rebuildBaseLevelMeshes();
        statusMessage = `Seed updated to ${userSeed}.`;
        syncHud();
      },
      onRotate(deltaQuarterTurns: -1 | 1): void {
        view.rotateQuarterTurns(deltaQuarterTurns);
        syncHud();
      },
      onResetView(): void {
        view.reset();
        syncHud();
      },
      onClearStructures(): void {
        structureSegments.clear();
        rebuildEditorStructureMeshes();
        statusMessage = "Structures cleared.";
        syncHud();
      },
      onClearGround(): void {
        groundOverrides.clear();
        rebuildBaseLevelMeshes();
        statusMessage = "Terrain overrides cleared.";
        syncHud();
      },
      onBake(): void {
        runBakePreview();
      },
      onExit(): void {
        void enterGame({
          status: "Exited EDITOR and entered GAME mode."
        });
      }
    });

    const toolButtons = promotedControls.toolButtons as Map<
      ToolMode,
      HTMLButtonElement
    >;
    const brushButtons = promotedControls.brushButtons as Map<
      EditorBrush,
      HTMLButtonElement
    >;
    const rectToolButtons = promotedControls.rectToolButtons as Map<
      Exclude<RectToolMode, "none">,
      HTMLButtonElement
    >;
    const defaultGroundButtons = promotedControls.defaultGroundButtons as Map<
      "floor" | "grass",
      HTMLButtonElement
    >;
    const rectOffButton = promotedControls.rectOffButton;
    const seedInput = promotedControls.seedInput;

    const gameControlsRow = document.createElement("div");
    gameControlsRow.style.display = "none";
    gameControlsRow.style.flexDirection = "column";
    gameControlsRow.style.gap = "6px";
    gameControlsRow.style.marginBottom = "6px";

    const gameControlsLabel = document.createElement("div");
    gameControlsLabel.textContent = "Game";
    gameControlsLabel.style.fontSize = "12px";
    gameControlsLabel.style.opacity = "0.82";
    gameControlsRow.appendChild(gameControlsLabel);

    const gameControlsButtons = document.createElement("div");
    gameControlsButtons.style.display = "flex";
    gameControlsButtons.style.flexWrap = "wrap";
    gameControlsButtons.style.gap = "6px";
    gameControlsRow.appendChild(gameControlsButtons);

    const gameEditorButton = hud.createButton("EDITOR (ESC)", () => {
      enterEditor();
    });
    const gameSaveButton = hud.createButton("Save Game (K)", () => {
      saveGameNow();
    });
    const gameLoadButton = hud.createButton("Load Game (L)", () => {
      loadGameNow();
    });
    gameControlsButtons.append(gameEditorButton, gameSaveButton, gameLoadButton);
    hud.rightPanel.insertBefore(gameControlsRow, stats);

    let structureSegments = createMockupStructureSegments();
    let groundOverrides = createMockupTerrainOverrides(userSeed);
    const savedLevelModelJson = localStorage.getItem(LEVEL_MODEL_STORAGE_KEY);
    if (savedLevelModelJson) {
      try {
        const parsed = parseStoredEditorState(JSON.parse(savedLevelModelJson));
        if (parsed) {
          structureSegments = parsed.structures;
          groundOverrides = parsed.overrides;
          defaultGroundBase = parsed.defaultGround;
          userSeed = parsed.seed;
          seedInput.value = String(userSeed);
          statusMessage = "Loaded editor state from localStorage.";
        }
      } catch {
        // Keep defaults if stored value is invalid JSON.
      }
    }

    const strokePoint = new THREE.Vector3();
    const inputRight = new THREE.Vector3();
    const inputForward = new THREE.Vector3();
    const worldPoint = new THREE.Vector3();

    let dragState: DragState | null = null;
    let raf = 0;

    let gameRuntime: GameRuntime | null = null;

    function getCurrentBrushAndMode(): { brush: EditorBrush; mode: ToolMode } {
      if (
        dragState &&
        dragState.mode === "paint" &&
        dragState.brush &&
        dragState.paintMode
      ) {
        return {
          brush: dragState.brush,
          mode: dragState.paintMode
        };
      }
      return {
        brush: editorBrush,
        mode: activeTool
      };
    }

    function clearGroup(group: THREE.Group): void {
      for (let i = group.children.length - 1; i >= 0; i -= 1) {
        group.remove(group.children[i]);
      }
    }

    function getDefaultGroundAtCell(x: number, y: number): GroundCellOverride {
      if (defaultGroundBase === "grass") {
        return {
          base: "grass",
          variant: computeGrassVariant(
            userSeed ^ DEFAULT_GRASS_VARIANT_SEED,
            x,
            y
          )
        };
      }
      return { base: defaultGroundBase };
    }

    function getGroundOverrideAtCell(x: number, y: number): GroundCellOverride {
      const direct = groundOverrides.get(cellKey(x, y));
      if (direct) {
        return direct;
      }
      return getDefaultGroundAtCell(x, y);
    }

    function setGroundOverrideAtCell(
      x: number,
      y: number,
      override: GroundCellOverride
    ): void {
      const key = cellKey(x, y);
      const normalized = normalizeGroundOverride(
        override.base,
        override.variant
      );
      const defaults = getDefaultGroundAtCell(x, y);
      if (
        normalized.base === defaults.base &&
        normalized.variant === defaults.variant
      ) {
        groundOverrides.delete(key);
      } else {
        groundOverrides.set(key, normalized);
      }
    }

    function getRectBounds(
      a: { x: number; y: number },
      b: { x: number; y: number }
    ): { minX: number; maxX: number; minY: number; maxY: number } {
      return {
        minX: Math.min(a.x, b.x),
        maxX: Math.max(a.x, b.x),
        minY: Math.min(a.y, b.y),
        maxY: Math.max(a.y, b.y)
      };
    }

    function updateRectPreview(
      start: { x: number; y: number },
      end: { x: number; y: number },
      mode: RectToolMode
    ): void {
      const bounds = getRectBounds(start, end);
      rectPreviewMesh.visible = mode !== "none";
      if (mode === "none") {
        return;
      }

      const widthCells = bounds.maxX - bounds.minX + 1;
      const heightCells = bounds.maxY - bounds.minY + 1;
      rectPreviewMesh.scale.set(widthCells, 1, heightCells);
      rectPreviewMesh.position.set(
        toWorldX(bounds.minX + (widthCells - 1) * 0.5),
        0.035 * TILE_SIZE,
        toWorldZ(bounds.minY + (heightCells - 1) * 0.5)
      );
      rectPreviewMaterial.color.setHex(RECT_TOOL_COLORS[mode]);
    }

    function hideRectPreview(): void {
      rectPreviewMesh.visible = false;
    }

    function runRectTool(
      mode: RectToolMode,
      start: { x: number; y: number },
      end: { x: number; y: number }
    ): void {
      const bounds = getRectBounds(start, end);

      if (mode === "grass-fill") {
        const seededRect = hashRect(
          userSeed,
          bounds.minX,
          bounds.minY,
          bounds.maxX,
          bounds.maxY
        );
        for (let y = bounds.minY; y <= bounds.maxY; y += 1) {
          for (let x = bounds.minX; x <= bounds.maxX; x += 1) {
            const variant = computeGrassVariant(seededRect, x, y);
            setGroundOverrideAtCell(x, y, { base: "grass", variant });
          }
        }
      } else if (mode === "building-footprint") {
        for (let y = bounds.minY; y <= bounds.maxY; y += 1) {
          for (let x = bounds.minX; x <= bounds.maxX; x += 1) {
            setGroundOverrideAtCell(x, y, { base: "building" });
          }
        }
      }

      rebuildBaseLevelMeshes();
      statusMessage = `Applied ${mode} rect (${start.x},${start.y}) -> (${end.x},${end.y}).`;
      syncHud();
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

    function updateGridGeometry(): void {
      const nextGeometry = createGridGeometry(GRID_TILES, GRID_TILES, 0.01);
      gridLines.geometry = nextGeometry;
      minorGridGeometry.dispose();
      minorGridGeometry = nextGeometry;
    }

    function rebuildBaseLevelMeshes(): void {
      clearGroup(floorGroup);
      for (let y = 0; y < GRID_TILES; y += 1) {
        for (let x = 0; x < GRID_TILES; x += 1) {
          const ground = getGroundOverrideAtCell(x, y);
          let terrainMaterial: THREE.Material = floorMaterial;
          if (ground.base === "grass") {
            const variant = Math.max(
              0,
              (ground.variant ??
                computeGrassVariant(
                  userSeed ^ DEFAULT_GRASS_VARIANT_SEED,
                  x,
                  y
                )) % GRASS_VARIANT_COUNT
            );
            terrainMaterial =
              grassVariantMaterials[variant] ?? grassVariantMaterials[0];
          } else if (ground.base === "road") {
            terrainMaterial = roadMaterial;
          } else if (ground.base === "sidewalk") {
            terrainMaterial = sidewalkMaterial;
          } else if (ground.base === "building") {
            terrainMaterial = buildingGroundMaterial;
          }

          const floorTile = new THREE.Mesh(floorGeometry, terrainMaterial);
          floorTile.position.set(toWorldX(x), 0.03 * TILE_SIZE, toWorldZ(y));
          floorGroup.add(floorTile);
        }
      }
    }

    function registerDirection(
      map: Map<string, DirectionVector[]>,
      x: number,
      y: number,
      dx: number,
      dy: number
    ): void {
      const key = cellKey(x, y);
      const list = map.get(key) ?? [];
      if (!list.some((entry) => entry.dx === dx && entry.dy === dy)) {
        list.push({ dx, dy });
      }
      map.set(key, list);
    }

    function createStructureMesh(
      segment: StructureSegmentData,
      options?: { trimStart?: boolean; trimEnd?: boolean; trimStartAmount?: number; trimEndAmount?: number }
    ): THREE.Object3D {
      if (isSolidStructureSegment(segment) && (options?.trimStart || options?.trimEnd)) {
        return new THREE.Group();
      }
      switch (segment.kind) {
        case STRUCTURE_KIND.WALL:
          return structureMeshKit.createWallSegment(options);
        case STRUCTURE_KIND.WINDOW:
          return structureMeshKit.createWindowSegment(options);
        case STRUCTURE_KIND.DOOR:
          return structureMeshKit.createDoorSegment(segment.state, options);
        default:
          return assertNever(segment, "structure segment");
      }
    }

    function orientedSegmentTrimOptions(
      edge: GridEdge,
      options: {
        trimStart: boolean;
        trimEnd: boolean;
        trimStartAmount?: number;
        trimEndAmount?: number;
      }
    ): {
      trimStart: boolean;
      trimEnd: boolean;
      trimStartAmount?: number;
      trimEndAmount?: number;
    } {
      if (edge.ay === edge.by) {
        return options;
      }
      return {
        trimStart: options.trimEnd,
        trimEnd: options.trimStart,
        trimStartAmount: options.trimEndAmount,
        trimEndAmount: options.trimStartAmount
      };
    }

    function directionMask(directions: DirectionVector[]): number {
      let mask = 0;
      for (const direction of directions) {
        if (direction.dy < 0) {
          mask |= 1;
        } else if (direction.dx > 0) {
          mask |= 2;
        } else if (direction.dy > 0) {
          mask |= 4;
        } else if (direction.dx < 0) {
          mask |= 8;
        }
      }
      return mask;
    }

    function rebuildEditorStructureMeshes(): void {
      clearGroup(wallGroup);
      clearGroup(editorDoorGroup);
      const adjacency = new Map<string, DirectionVector[]>();

      for (const [key, segment] of structureSegments.entries()) {
        if (!isSolidStructureSegment(segment)) {
          continue;
        }
        const edge = parseEdge(key);
        const dx = edge.bx - edge.ax;
        const dy = edge.by - edge.ay;
        registerDirection(adjacency, edge.ax, edge.ay, dx, dy);
        registerDirection(adjacency, edge.bx, edge.by, -dx, -dy);
      }

      const joinNodes = new Set<string>();
      adjacency.forEach((directions, key) => {
        if (directions.length < 2) {
          return;
        }
        const mask = directionMask(directions);
        if (mask === 5 || mask === 10) {
          return;
        }
        joinNodes.add(key);
      });

      for (const [key, segment] of structureSegments.entries()) {
        const edge = parseEdge(key);
        const trimStart = joinNodes.has(cellKey(edge.ax, edge.ay));
        const trimEnd = joinNodes.has(cellKey(edge.bx, edge.by));
        const mesh = createStructureMesh(
          segment,
          orientedSegmentTrimOptions(edge, {
            trimStart,
            trimEnd,
            trimStartAmount: trimStart ? TILE_SIZE : undefined,
            trimEndAmount: trimEnd ? TILE_SIZE : undefined
          })
        );
        mesh.position.set(
          (toWorldNodeX(edge.ax) + toWorldNodeX(edge.bx)) * 0.5,
          0,
          (toWorldNodeZ(edge.ay) + toWorldNodeZ(edge.by)) * 0.5
        );
        if (edge.ay !== edge.by) {
          mesh.rotation.y = Math.PI * 0.5;
        }

        if (isDoorStructureSegment(segment)) {
          editorDoorGroup.add(mesh);
        } else {
          wallGroup.add(mesh);
        }
      }

      adjacency.forEach((directions, key) => {
        if (directions.length < 2) {
          return;
        }
        const [xStr, yStr] = key.split(",");
        const x = Number(xStr);
        const y = Number(yStr);
        const post = structureMeshKit.createJoinPost(directionMask(directions));
        post.position.set(toWorldNodeX(x), 0, toWorldNodeZ(y));
        wallGroup.add(post);
      });
    }

    function updateHover(world: THREE.Vector3 | null): void {
      if (mode !== "EDITOR" || !world) {
        hoverMesh.visible = false;
        return;
      }

      const rectMode =
        dragState?.mode === "rect"
          ? (dragState.rectMode ?? "none")
          : activeRectTool;
      if (rectMode !== "none") {
        const cell = worldToCell(world.x, world.z);
        if (!cell) {
          hoverMesh.visible = false;
          return;
        }
        hoverMesh.visible = true;
        hoverMesh.scale.set(1, 1, 1);
        hoverMesh.rotation.y = 0;
        hoverMesh.position.set(toWorldX(cell.x), 0.03 * TILE_SIZE, toWorldZ(cell.y));
        hoverMaterial.color.setHex(RECT_TOOL_COLORS[rectMode]);
        return;
      }

      const { brush, mode: tool } = getCurrentBrushAndMode();
      hoverMaterial.color.setHex(
        tool === "erase" ? 0xff7e7e : BRUSH_COLORS[brush]
      );

      if (isGroundBrush(brush)) {
        const cell = worldToCell(world.x, world.z);
        if (!cell) {
          hoverMesh.visible = false;
          return;
        }
        hoverMesh.visible = true;
        hoverMesh.scale.set(1, 1, 1);
        hoverMesh.rotation.y = 0;
        hoverMesh.position.set(toWorldX(cell.x), 0.03 * TILE_SIZE, toWorldZ(cell.y));
        return;
      }

      const edge = pickEdgeFromWorld(world);
      if (!edge) {
        hoverMesh.visible = false;
        return;
      }

      hoverMesh.visible = true;
      hoverMesh.scale.set(1, 1, 0.2 * TILE_SIZE);
      hoverMesh.position.set(
        (toWorldNodeX(edge.ax) + toWorldNodeX(edge.bx)) * 0.5,
        0.03 * TILE_SIZE,
        (toWorldNodeZ(edge.ay) + toWorldNodeZ(edge.by)) * 0.5
      );
      hoverMesh.rotation.y = edge.ay !== edge.by ? Math.PI * 0.5 : 0;
    }

    function syncHud(): void {
      const isEditorMode = mode === "EDITOR";
      hud.leftPanel.style.display = isEditorMode ? "flex" : "none";
      gameControlsRow.style.display = isEditorMode ? "none" : "flex";

      toolButtons.forEach((button, tool) => {
        setButtonActive(button, isEditorMode && activeTool === tool);
      });
      brushButtons.forEach((button, brush) => {
        setButtonActive(button, isEditorMode && editorBrush === brush);
      });
      rectToolButtons.forEach((button, rectMode) => {
        setButtonActive(button, isEditorMode && activeRectTool === rectMode);
      });
      setButtonActive(rectOffButton, isEditorMode && activeRectTool === "none");
      defaultGroundButtons.forEach((button, base) => {
        setButtonActive(button, isEditorMode && defaultGroundBase === base);
      });

      const viewStep = ((view.getYawIndex() % 4) + 4) % 4;
      const zoomCurrent = view.getState().cameraZoomCurrent;

      if (isEditorMode) {
        let wallCount = 0;
        let windowCount = 0;
        let doorCount = 0;
        for (const segment of structureSegments.values()) {
          switch (segment.kind) {
            case STRUCTURE_KIND.WALL:
              wallCount += 1;
              break;
            case STRUCTURE_KIND.WINDOW:
              windowCount += 1;
              break;
            case STRUCTURE_KIND.DOOR:
              doorCount += 1;
              break;
            default:
              assertNever(segment, "structure segment");
          }
        }

        const groundCounts: Record<GroundBase, number> = {
          floor: 0,
          grass: 0,
          road: 0,
          sidewalk: 0,
          building: 0
        };
        for (let y = 0; y < GRID_TILES; y += 1) {
          for (let x = 0; x < GRID_TILES; x += 1) {
            groundCounts[getGroundOverrideAtCell(x, y).base] += 1;
          }
        }

        stats.textContent = [
          "Mode: EDITOR",
          `Grid: ${GRID_TILES}x${GRID_TILES}`,
          `Walls/Windows/Doors: ${wallCount}/${windowCount}/${doorCount}`,
          `Ground(F/G/R/S/B): ${groundCounts.floor}/${groundCounts.grass}/${groundCounts.road}/${groundCounts.sidewalk}/${groundCounts.building}`,
          `Overrides: ${groundOverrides.size}`,
          `Default: ${defaultGroundBase}`,
          `Rect: ${activeRectTool}`,
          `Seed: ${userSeed}`,
          `View: ${viewStep}/4`,
          `Zoom: ${zoomCurrent.toFixed(2)}x`
        ].join("  •  ");
        hints.textContent = editorHintsText;
      } else {
        let openDoors = 0;
        let closedDoors = 0;
        if (gameRuntime) {
          for (const doorEid of gameRuntime.doorByPlacementId.values()) {
            const door = gameRuntime.doors.get(doorEid);
            if (!door) {
              continue;
            }
            if (door.open) {
              openDoors += 1;
            } else {
              closedDoors += 1;
            }
          }
        }

        const playerTransform = gameRuntime
          ? findPlayerTransform(gameRuntime.world)
          : null;
        const playerText = playerTransform
          ? `Player=(${playerTransform.x.toFixed(2)}, ${playerTransform.y.toFixed(2)})`
          : "Player=<none>";

        stats.textContent = [
          "Mode: GAME",
          playerText,
          `Doors(O/C): ${openDoors}/${closedDoors}`,
          `View: ${viewStep}/4`,
          `Zoom: ${zoomCurrent.toFixed(2)}x`
        ].join("  •  ");
        hints.textContent = gameHintsText;
      }

      status.textContent = statusMessage;
    }

    function applyGroundTool(
      cellX: number,
      cellY: number,
      toolMode: ToolMode,
      brush: GroundPaintBrush
    ): boolean {
      if (!isInGrid(cellX, cellY)) {
        return false;
      }
      if (toolMode === "erase") {
        return groundOverrides.delete(cellKey(cellX, cellY));
      }
      const variant =
        brush === "grass"
          ? computeGrassVariant(userSeed ^ 0x9e3779b9, cellX, cellY)
          : undefined;
      const before = getGroundOverrideAtCell(cellX, cellY);
      const next = normalizeGroundOverride(brush, variant);
      if (before.base === next.base && before.variant === next.variant) {
        return false;
      }
      setGroundOverrideAtCell(cellX, cellY, next);
      return true;
    }

    function applyStructureTool(
      edge: GridEdge,
      toolMode: ToolMode,
      brush: StructureBrush
    ): boolean {
      const key = edgeKey(edge.ax, edge.ay, edge.bx, edge.by);
      if (toolMode === "erase") {
        return structureSegments.delete(key);
      }
      const next = structureFromBrush(brush);
      const before = structureSegments.get(key);
      if (structureEquals(before, next)) {
        return false;
      }
      structureSegments.set(key, next);
      return true;
    }

    function applyBrushAtWorld(
      world: THREE.Vector3,
      toolMode: ToolMode,
      brush: EditorBrush
    ): void {
      let changed = false;
      if (isGroundBrush(brush)) {
        const cell = worldToCell(world.x, world.z);
        if (!cell) {
          return;
        }
        changed = applyGroundTool(cell.x, cell.y, toolMode, brush);
      } else if (isStructureBrush(brush)) {
        const edge = pickEdgeFromWorld(world);
        if (!edge) {
          return;
        }
        changed = applyStructureTool(edge, toolMode, brush);
      }

      if (!changed) {
        return;
      }

      rebuildBaseLevelMeshes();
      rebuildEditorStructureMeshes();
      statusMessage = `Edited with ${toolMode}/${brush}.`;
      syncHud();
    }

    function paintStroke(
      start: THREE.Vector3 | null,
      end: THREE.Vector3,
      toolMode: ToolMode,
      brush: EditorBrush
    ): void {
      if (!start) {
        applyBrushAtWorld(end, toolMode, brush);
        return;
      }
      const distance = start.distanceTo(end);
      const steps = Math.max(1, Math.ceil(distance / 0.2));
      for (let i = 0; i <= steps; i += 1) {
        strokePoint.lerpVectors(start, end, i / steps);
        applyBrushAtWorld(strokePoint, toolMode, brush);
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

        const visual = structureMeshKit.createDoorVisual();
        visual.root.position.set(
          (toWorldNodeX(door.ax) + toWorldNodeX(door.bx)) * 0.5,
          0,
          (toWorldNodeZ(door.ay) + toWorldNodeZ(door.by)) * 0.5
        );
        visual.root.rotation.y = door.rot * (Math.PI * 0.5);
        setDoorVisualOpen(visual, door.open);

        runtime.doorVisuals.set(placementId, visual);
        gameDoorGroup.add(visual.root);
      }
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

    function worldAtClient(
      clientX: number,
      clientY: number
    ): THREE.Vector3 | null {
      if (!view.worldAtClient(clientX, clientY, worldPoint)) {
        return null;
      }
      return worldPoint.clone();
    }

    function disposeGameRuntime(): void {
      if (!gameRuntime) {
        return;
      }

      gameRuntime.keyboard.dispose(window);
      gameRuntime.physics.dispose();
      gameRuntime = null;
      clearGroup(gameDoorGroup);
      playerMesh.visible = false;
    }

    function toBakedStructures(): LevelBuilderStructureSegment[] {
      return serializeStructureState(structureSegments);
    }

    function createBakePayload(): ReturnType<typeof bakeLevelForEcs> {
      const terrain: LevelBuilderGroundOverride[] = [
        ...groundOverrides.entries()
      ].map(([key, value]) => {
        const [xStr, yStr] = key.split(",");
        return {
          x: Number(xStr),
          z: Number(yStr),
          base: value.base,
          variant: value.variant
        };
      });

      return bakeLevelForEcs({
        level: {
          id: "editor-game-ecs-level",
          version: 1
        },
        grid: {
          tiles: GRID_TILES,
          tileSize: TILE_SIZE,
          origin: GRID_ORIGIN
        },
        terrain: {
          defaultGround: defaultGroundBase,
          overrides: terrain
        },
        structures: toBakedStructures()
      });
    }

    function runBakePreview(): void {
      const baked = createBakePayload();
      statusMessage = `Baked preview: ${baked.structures.length} segments, blocked ${baked.blockedCells.length} cells, ${baked.colliderDescs.length} colliders.`;
      console.log("[editor-game-ecs] baked preview", baked);
      syncHud();
    }

    function linkedCellsForEdge(edge: GridEdge): Array<{ x: number; y: number }> {
      const cells: Array<{ x: number; y: number }> = [];

      if (edge.ax === edge.bx) {
        const y = Math.min(edge.ay, edge.by);
        const left = { x: edge.ax - 1, y };
        const right = { x: edge.ax, y };
        if (isInGrid(left.x, left.y)) {
          cells.push(left);
        }
        if (isInGrid(right.x, right.y)) {
          cells.push(right);
        }
      } else {
        const x = Math.min(edge.ax, edge.bx);
        const bottom = { x, y: edge.ay - 1 };
        const top = { x, y: edge.ay };
        if (isInGrid(bottom.x, bottom.y)) {
          cells.push(bottom);
        }
        if (isInGrid(top.x, top.y)) {
          cells.push(top);
        }
      }

      return cells;
    }

    function doorColliderMap(
      colliderDescs: LevelBuilderColliderDesc[]
    ): Map<string, LevelBuilderColliderDesc & { kind: "door" }> {
      const map = new Map<string, LevelBuilderColliderDesc & { kind: "door" }>();
      for (const desc of colliderDescs) {
        if (desc.kind !== "door") {
          continue;
        }
        map.set(desc.placementId, desc);
      }
      return map;
    }

    function applyDoorBlocking(runtime: GameRuntime, door: DoorComponent): void {
      for (const cell of door.linkedCells) {
        runtime.levelResource.setBlocked(cell.x, cell.y, !door.open);
      }

      const colliderHandle = runtime.doorColliderByPlacementId.get(
        door.placementId
      );
      if (colliderHandle !== undefined) {
        runtime.physics.setColliderEnabled(colliderHandle, !door.open);
      }
    }

    function createGameRuntime(options?: {
      player?: { x: number; y: number };
      doorOverrides?: Map<string, DoorOverride>;
    }): GameRuntime {
      const baked = createBakePayload();
      const levelResource = createEcsLevelResourceFromBake(baked) as MutableGridLevelResource;

      const world = new World({
        level: levelResource,
        resolveLevel: () => levelResource
      });

      const keyboard = new KeyboardTracker(window);
      const systems = {
        inputSystem: createInputSystem(keyboard),
        eventSystem: createEventSystem()
      };
      const physics = createPhysicsResource();
      const physicsBodies = new DataStore<PhysicsBodyRef>();
      const physicsColliders = new DataStore<PhysicsColliderRef>();

      for (const collider of baked.colliderDescs) {
        if (collider.kind !== "rect") {
          continue;
        }

        physics.ensureStaticColliderRect(collider.x, collider.y, collider.w, collider.h);
      }

      const doorColliderDescriptors = doorColliderMap(baked.colliderDescs);
      const doorColliderByPlacementId = new Map<string, number>();
      for (const [placementId, desc] of doorColliderDescriptors.entries()) {
        const handle = physics.ensureStaticColliderRect(
          desc.x,
          desc.y,
          desc.w,
          desc.h
        );
        doorColliderByPlacementId.set(placementId, handle);
      }

      const playerEid = world.createEntity();
      const playerStart = options?.player ?? PLAYER_SPAWN;
      world.transforms.add(playerEid, { x: playerStart.x, y: playerStart.y });
      world.velocities.add(playerEid, { vx: 0, vy: 0 });
      world.playerTags.add(playerEid, true);
      world.persistents.add(playerEid, { kind: "player" });

      const doors = new DataStore<DoorComponent>();
      const doorByPlacementId = new Map<string, EID>();
      const placementIdByEdge = new Map<string, string>();
      const doorVisuals = new Map<string, EditorDoorVisual>();
      const interactionQueue: string[] = [];

      for (const [key, segment] of structureSegments.entries()) {
        if (!isDoorStructureSegment(segment)) {
          continue;
        }

        const edge = parseEdge(key);
        const placementId = edgePlacementId(edge);
        const override = options?.doorOverrides?.get(placementId);
        const open = override ? override.open : segment.state === "open";
        const locked = override?.locked;
        const linkedCells = linkedCellsForEdge(edge);
        const primaryCell = linkedCells[0] ?? { x: 0, y: 0 };

        const eid = world.createEntity();
        const rot = edge.ay !== edge.by ? 1 : 0;
        doors.add(eid, {
          placementId,
          edgeKey: key,
          cellX: primaryCell.x,
          cellY: primaryCell.y,
          linkedCells,
          ax: edge.ax,
          ay: edge.ay,
          bx: edge.bx,
          by: edge.by,
          rot,
          open,
          locked
        });

        world.transforms.add(eid, {
          x: (edge.ax + edge.bx) * 0.5,
          y: (edge.ay + edge.by) * 0.5
        });
        world.persistents.add(eid, { kind: "door" });
        doorByPlacementId.set(placementId, eid);
        placementIdByEdge.set(key, placementId);

      }

      physicsEnsureSystem({
        world,
        physics,
        entities: world.queryTransformPlayer(),
        capsule: { radius: 0.25 },
        physicsBodies,
        physicsColliders
      });
      physics.setTranslation(playerEid, playerStart);

      const runtime: GameRuntime = {
        world,
        levelResource,
        keyboard,
        physics,
        physicsBodies,
        physicsColliders,
        systems,
        playerEid,
        doors,
        doorByPlacementId,
        placementIdByEdge,
        doorColliderByPlacementId,
        doorVisuals,
        interactionQueue
      };

      for (const eid of runtime.doorByPlacementId.values()) {
        const door = runtime.doors.get(eid);
        if (!door) {
          continue;
        }
        applyDoorBlocking(runtime, door);
      }

      return runtime;
    }

    function enterEditor(): void {
      disposeGameRuntime();
      mode = "EDITOR";
      editorDoorGroup.visible = true;
      gameDoorGroup.visible = false;
      hoverMesh.visible = true;
      hideRectPreview();
      statusMessage = "Switched to EDITOR.";
      syncHud();
    }

    let enterGameRequestId = 0;

    async function enterGame(options?: {
      player?: { x: number; y: number };
      doorOverrides?: Map<string, DoorOverride>;
      status?: string;
    }): Promise<void> {
      const requestId = enterGameRequestId + 1;
      enterGameRequestId = requestId;

      await initRapier();
      if (requestId !== enterGameRequestId) {
        return;
      }

      disposeGameRuntime();

      const runtime = createGameRuntime({
        player: options?.player,
        doorOverrides: options?.doorOverrides
      });
      if (requestId !== enterGameRequestId) {
        runtime.keyboard.dispose(window);
        runtime.physics.dispose();
        return;
      }

      gameRuntime = runtime;
      rebuildGameplayDoorMeshes(runtime);

      mode = "GAME";
      editorDoorGroup.visible = false;
      gameDoorGroup.visible = true;
      hoverMesh.visible = false;
      hideRectPreview();
      playerMesh.visible = true;

      const playerTransform = runtime.world.transforms.get(runtime.playerEid);
      if (playerTransform) {
        playerMesh.position.set(
          toWorldCoordX(playerTransform.x),
          0,
          toWorldCoordZ(playerTransform.y)
        );
      }

      statusMessage =
        options?.status ?? "Baked editor state and entered GAME mode.";
      syncHud();
    }

    function saveLevelModelNow(): void {
      const payload: EditorSave = {
        schemaVersion: EDITOR_LEVEL_SCHEMA_VERSION,
        terrain: serializeTerrainState(
          defaultGroundBase,
          userSeed,
          groundOverrides
        ),
        structures: toBakedStructures()
      };

      localStorage.setItem(LEVEL_MODEL_STORAGE_KEY, JSON.stringify(payload));
      statusMessage = `Saved editor state to localStorage key: ${LEVEL_MODEL_STORAGE_KEY}`;
      console.log("[editor-game-ecs] level model saved", {
        key: LEVEL_MODEL_STORAGE_KEY,
        structures: structureSegments.size,
        defaultGroundBase,
        groundOverrides: groundOverrides.size
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
      for (const [
        placementId,
        eid
      ] of gameRuntime.doorByPlacementId.entries()) {
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
        terrain: serializeTerrainState(
          defaultGroundBase,
          userSeed,
          groundOverrides
        ),
        structures: toBakedStructures(),
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

      defaultGroundBase = parsedSave.terrain.defaultGround;
      userSeed = parsedSave.terrain.seed;
      seedInput.value = String(userSeed);
      groundOverrides = new Map(
        parsedSave.terrain.overrides.map((entry) => [
          cellKey(Math.floor(entry.x), Math.floor(entry.y)),
          normalizeGroundOverride(entry.base, entry.variant)
        ])
      );

      const parsedStructures = parseStructureState(parsedSave.structures);
      if (!parsedStructures) {
        statusMessage = "Game save load failed: invalid structures.";
        syncHud();
        return;
      }
      structureSegments = parsedStructures;

      updateGridGeometry();
      rebuildBaseLevelMeshes();
      rebuildEditorStructureMeshes();
      saveLevelModelNow();

      const overrides = new Map<string, DoorOverride>();
      for (const entry of parsedSave.doors) {
        overrides.set(entry.placementId, {
          open: entry.open,
          locked: entry.locked
        });
      }

      void enterGame({
        player: parsedSave.player,
        doorOverrides: overrides,
        status:
          "Loaded game save and restored player + door states by placementId."
      });

      console.log("[editor-game-ecs] game load success", {
        player: parsedSave.player,
        doors: parsedSave.doors.length
      });
    }

    function queueDoorInteraction(edge: string): void {
      if (!gameRuntime) {
        return;
      }

      gameRuntime.interactionQueue.push(edge);
    }

    function runDoorSystem(runtime: GameRuntime): void {
      if (runtime.interactionQueue.length === 0) {
        return;
      }

      const queue = runtime.interactionQueue.splice(
        0,
        runtime.interactionQueue.length
      );

      for (const edge of queue) {
        const placementId = runtime.placementIdByEdge.get(edge);
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
        applyDoorBlocking(runtime, door);

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
      physicsEnsureSystem({
        world,
        physics: runtime.physics,
        entities: world.queryTransformPlayer(),
        capsule: { radius: 0.25 },
        physicsBodies: runtime.physicsBodies,
        physicsColliders: runtime.physicsColliders
      });
      physicsSyncInSystem({
        world,
        physics: runtime.physics,
        entities: world.queryTransformPlayer()
      });
      physicsStepSystem({
        physics: runtime.physics,
        dtFrame: dt
      });
      physicsSyncOutSystem({
        world,
        physics: runtime.physics,
        entities: world.queryTransformPlayer()
      });
      runDoorSystem(runtime);
      runtime.systems.eventSystem(world);

      const player = world.transforms.get(runtime.playerEid);
      if (player) {
        playerMesh.position.set(
          toWorldCoordX(player.x),
          0,
          toWorldCoordZ(player.y)
        );
      }
    }

    function syncSize(): void {
      const rect = mount.getBoundingClientRect();
      viewportWidth = Math.max(1, Math.floor(rect.width));
      viewportHeight = Math.max(1, Math.floor(rect.height));
      view.resize(viewportWidth, viewportHeight);
    }

    function updateCursor(): void {
      if (mode === "EDITOR") {
        if (activeRectTool !== "none" || dragState?.mode === "rect") {
          renderer.domElement.style.cursor = "crosshair";
          return;
        }

        const { mode: tool } = getCurrentBrushAndMode();
        renderer.domElement.style.cursor =
          tool === "erase" ? "not-allowed" : "crosshair";
        return;
      }

      renderer.domElement.style.cursor = "pointer";
    }

    function handlePointerDown(event: PointerEvent): void {
      if (event.button !== 0 && event.button !== 2) {
        return;
      }
      if (mode === "GAME" && event.button !== 0) {
        return;
      }

      renderer.domElement.focus({ preventScroll: true });
      renderer.domElement.setPointerCapture(event.pointerId);

      const world = worldAtClient(event.clientX, event.clientY);
      const paintMode: ToolMode = event.button === 2 ? "erase" : activeTool;
      const rectMode =
        event.button === 0 ? resolveRectModeForPointer(event) : "none";

      if (mode === "EDITOR") {
        if (rectMode !== "none") {
          const startCell = world ? worldToCell(world.x, world.z) : null;
          if (!startCell) {
            event.preventDefault();
            return;
          }

          dragState = {
            pointerId: event.pointerId,
            mode: "rect",
            paintMode,
            brush: editorBrush,
            lastClientX: event.clientX,
            lastClientY: event.clientY,
            lastWorldPoint: world,
            moved: false,
            rectMode,
            rectStartCell: startCell,
            rectEndCell: startCell
          };
          updateRectPreview(startCell, startCell, rectMode);
          updateCursor();
          syncHud();
          event.preventDefault();
          return;
        }

        if (world) {
          paintStroke(null, world, paintMode, editorBrush);
        }

        dragState = {
          pointerId: event.pointerId,
          mode: "paint",
          paintMode,
          brush: editorBrush,
          lastClientX: event.clientX,
          lastClientY: event.clientY,
          lastWorldPoint: world,
          moved: false
        };

        syncHud();
      } else {
        dragState = {
          pointerId: event.pointerId,
          mode: "game-click",
          lastClientX: event.clientX,
          lastClientY: event.clientY,
          lastWorldPoint: world,
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

      if (dragState.mode === "rect") {
        if (world && dragState.rectStartCell) {
          const cell = worldToCell(world.x, world.z);
          if (cell) {
            dragState.rectEndCell = cell;
            updateRectPreview(
              dragState.rectStartCell,
              cell,
              dragState.rectMode ?? "none"
            );
          }
        }

        dragState.lastClientX = event.clientX;
        dragState.lastClientY = event.clientY;
        event.preventDefault();
        return;
      }

      if (dragState.mode === "paint" && mode === "EDITOR" && world) {
        paintStroke(
          dragState.lastWorldPoint,
          world,
          dragState.paintMode ?? activeTool,
          dragState.brush ?? editorBrush
        );
        dragState.lastWorldPoint = world;
      }

      dragState.lastClientX = event.clientX;
      dragState.lastClientY = event.clientY;
      event.preventDefault();
    }

    function handlePointerUp(event: PointerEvent): void {
      if (!dragState || dragState.pointerId !== event.pointerId) {
        return;
      }

      if (
        dragState.mode === "game-click" &&
        mode === "GAME" &&
        !dragState.moved
      ) {
        const world = worldAtClient(event.clientX, event.clientY);
        if (world) {
          const edge = pickEdgeFromWorld(world);
          if (edge) {
            queueDoorInteraction(edgeKey(edge.ax, edge.ay, edge.bx, edge.by));
          }
        }
      }
      if (
        dragState.mode === "rect" &&
        dragState.rectMode &&
        dragState.rectMode !== "none" &&
        dragState.rectStartCell &&
        dragState.rectEndCell
      ) {
        runRectTool(
          dragState.rectMode,
          dragState.rectStartCell,
          dragState.rectEndCell
        );
      }

      dragState = null;
      hideRectPreview();
      updateCursor();
      syncHud();
      event.preventDefault();
    }

    function handlePointerCancel(event: PointerEvent): void {
      if (!dragState || dragState.pointerId !== event.pointerId) {
        return;
      }

      dragState = null;
      hideRectPreview();
      updateCursor();
      syncHud();
      event.preventDefault();
    }

    function handleKeyDown(event: KeyboardEvent): void {
      if (event.code === "F5") {
        event.preventDefault();
        void enterGame();
        return;
      }

      if (event.code === "Escape") {
        event.preventDefault();
        enterEditor();
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
        activeTool = "draw";
        activeRectTool = "none";
        syncHud();
        event.preventDefault();
      } else if (event.code === "Digit2") {
        editorBrush = "window";
        activeTool = "draw";
        activeRectTool = "none";
        syncHud();
        event.preventDefault();
      } else if (event.code === "Digit3") {
        editorBrush = "door-closed";
        activeTool = "draw";
        activeRectTool = "none";
        syncHud();
        event.preventDefault();
      } else if (event.code === "Digit4") {
        editorBrush = "floor";
        activeTool = "draw";
        activeRectTool = "none";
        syncHud();
        event.preventDefault();
      } else if (event.code === "Digit5") {
        editorBrush = "grass";
        activeTool = "draw";
        activeRectTool = "none";
        syncHud();
        event.preventDefault();
      } else if (event.code === "Digit6") {
        editorBrush = "door-open";
        activeTool = "draw";
        activeRectTool = "none";
        syncHud();
        event.preventDefault();
      } else if (event.code === "Digit7") {
        editorBrush = "road";
        activeTool = "draw";
        activeRectTool = "none";
        syncHud();
        event.preventDefault();
      } else if (event.code === "Digit8") {
        editorBrush = "sidewalk";
        activeTool = "draw";
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
      } else if (event.code === "KeyB") {
        runBakePreview();
        event.preventDefault();
      } else if (event.code === "KeyD") {
        activeTool = "draw";
        syncHud();
        event.preventDefault();
      } else if (event.code === "KeyX") {
        activeTool = "erase";
        syncHud();
        event.preventDefault();
      }
    }

    syncSize();

    renderer.domElement.addEventListener("pointerdown", handlePointerDown);
    renderer.domElement.addEventListener("pointermove", handlePointerMove);
    renderer.domElement.addEventListener("pointerup", handlePointerUp);
    renderer.domElement.addEventListener("pointercancel", handlePointerCancel);
    renderer.domElement.addEventListener("contextmenu", (event) =>
      event.preventDefault()
    );

    window.addEventListener("keydown", handleKeyDown);
    updateGridGeometry();
    rebuildBaseLevelMeshes();
    rebuildEditorStructureMeshes();

    await enterGame({
      status: "Started in GAME mode. Press ESC to switch to EDITOR."
    });

    syncHud();
    updateCursor();

    let last = performance.now();

    const render = (now: number): void => {
      const dt = Math.min(0.1, Math.max(0, (now - last) / 1000));
      last = now;

      if (mode === "GAME" && gameRuntime) {
        runGameFrame(gameRuntime, dt);
      }

      view.frame(now, dt);
      syncHud();

      raf = requestAnimationFrame(render);
    };

    raf = requestAnimationFrame(render);

    return () => {
      cancelAnimationFrame(raf);

      disposeGameRuntime();

      renderer.domElement.removeEventListener("pointerdown", handlePointerDown);
      renderer.domElement.removeEventListener("pointermove", handlePointerMove);
      renderer.domElement.removeEventListener("pointerup", handlePointerUp);
      renderer.domElement.removeEventListener(
        "pointercancel",
        handlePointerCancel
      );
      window.removeEventListener("keydown", handleKeyDown);

      floorGeometry.dispose();
      structureMeshKit.dispose();
      playerBodyGeometry.dispose();
      playerHeadGeometry.dispose();
      hoverMesh.geometry.dispose();
      rectPreviewMesh.geometry.dispose();

      minorGridGeometry.dispose();
      minorGridMaterial.dispose();

      floorMaterial.dispose();
      grassVariantMaterials.forEach((material) => material.dispose());
      roadMaterial.dispose();
      sidewalkMaterial.dispose();
      buildingGroundMaterial.dispose();
      playerBodyMaterial.dispose();
      playerHeadMaterial.dispose();
      toonGradients.forEach((gradient) => gradient.dispose());
      hoverMaterial.dispose();
      rectPreviewMaterial.dispose();

      view.dispose();

      hud.destroy();

      mount.style.position = "";
    };
  }
};

export default experiment;
