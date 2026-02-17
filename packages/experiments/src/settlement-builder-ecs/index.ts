/**
 * Per-frame flow for this combined editor + game experiment:
 * 1) EDITOR mode mutates a grid editor state (ground overrides + edge structure segments).
 * 2) F5 bakes editor state into ECS LevelResource + collider descriptors.
 * 3) GAME mode runs systems: Input -> PlayerIntent -> Door -> Rapier3D Step -> Sync -> Event.
 * 4) Door interactions are queued from clicks, then DoorSystem toggles logical blocking and physics colliders.
 * 5) Props are instantiated as ECS entities and mapped to 3D physics bodies/colliders.
 * 6) K/L in GAME save/load full game state (editor state + player + door states by placementId).
 * 7) ESC returns to EDITOR without mutating editor auth state from runtime-only door toggles.
 */

import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import RAPIER3D from "@dimforge/rapier3d-compat";
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
  createPhysics3dResource,
  type Physics3dBodyRef,
  type Physics3dColliderRef,
  type Physics3dResource
} from "./game-physics-3d";
import type { ExperimentModule } from "../runtime/types";
import { createHistoryController } from "./history";
import {
  listSavedPropDefinitions,
  loadSavedPropBinary,
  makePropPlacementId,
  type SavedPropDefinition
} from "./prop-library";
import {
  getAvailablePropColliderModes as getAvailablePropColliderModesForDefinition,
  isPropColliderModeSupported as isPropColliderModeSupportedForDefinition,
  resolveEffectivePropColliderMode,
  resolvePropColliderResolution
} from "./prop-collider-resolver";
import {
  clonePropPhysicsProfile,
  inferPropPhysicsProfile,
  normalizePropPhysicsProfile,
  withPropPhysicsMobility
} from "./prop-physics-profile";
import {
  summarizePropAssetValidation,
  validateSavedPropDefinition,
  type PropAssetValidationIssue
} from "./prop-asset-validation";
import {
  bodyTranslationFromRootPose,
  quaternionDelta,
  rootPoseFromBodyPose,
  yawQuaternionForQuarterTurns
} from "./prop-physics-math";
import {
  collisionGroups,
  PHYSICS_LAYER,
  PHYSICS_MASK
} from "./physics-settings";
import {
  buildEditorSaveV1,
  parseEditorSaveV1,
  parseGameSaveV1,
  SETTLEMENT_EDITOR_STORAGE_KEY,
  SETTLEMENT_GAME_STORAGE_KEY,
  SETTLEMENT_GAME_SCHEMA_VERSION,
  type SettlementGameSaveV1,
  type SettlementPropColliderMode,
  type SettlementPropPhysicsMobility,
  type SettlementPropPhysicsProfile,
  type SettlementPropPlacement
} from "./schema";

let rapier3dInitPromise: Promise<void> | null = null;

function initRapier3d(): Promise<void> {
  if (!rapier3dInitPromise) {
    rapier3dInitPromise = RAPIER3D.init();
  }
  return rapier3dInitPromise;
}

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
type BuildCatalogMode = "brush" | "prop";
type BuildCatalogTab = "structures" | "terrain" | "props";

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

type PropPlacementTarget = {
  cellX: number;
  cellY: number;
  worldX: number;
  worldZ: number;
  supportKind: "floor" | "prop";
  supportY: number;
  supportPlacementId: string | null;
  pointerWorldX: number;
  pointerWorldY: number;
  pointerWorldZ: number;
  rayDirectionX: number;
  rayDirectionY: number;
  rayDirectionZ: number;
};

type DroppedPlacement = {
  worldX: number;
  worldZ: number;
  elevation: number;
};

type ResolvedGhostPlacement = DroppedPlacement & {
  anchorWorldX: number;
  anchorWorldY: number;
  anchorWorldZ: number;
  landingY: number;
  isClear: boolean;
  slidTowardCamera: boolean;
};

type PropRuntimeRotation = {
  x: number;
  y: number;
  z: number;
  w: number;
};

type EditorPropPhysicsBody = {
  placementId: string;
  sourcePropId: string;
  rotQuarterTurns: 0 | 1 | 2 | 3;
  colliderMode: SettlementPropColliderMode;
  profile: SettlementPropPhysicsProfile;
  body: RAPIER3D.RigidBody;
  localRootOffset: { x: number; y: number; z: number };
  usesComplexCollider: boolean;
  activationTimeMs: number;
  active: boolean;
};

type EditorPropRebuildReason =
  | "missing-placement"
  | "source-changed"
  | "rotation-changed"
  | "collider-mode-changed"
  | "profile-changed";

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

type PropComponent = {
  placementId: string;
  sourcePropId: string;
  localRootOffset: { x: number; y: number; z: number };
};

type GameRuntime = {
  world: World;
  levelResource: MutableGridLevelResource;
  keyboard: KeyboardTracker;
  physics: Physics3dResource;
  physicsBodies: DataStore<Physics3dBodyRef>;
  physicsColliders: DataStore<Physics3dColliderRef>;
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
  props: DataStore<PropComponent>;
  propByPlacementId: Map<string, EID>;
  propRootByPlacementId: Map<string, THREE.Group>;
  interactionQueue: string[];
};

type GameSaveDoor = {
  placementId: string;
  open: boolean;
  locked?: boolean;
};

type EditorSnapshot = {
  defaultGroundBase: GroundBase;
  userSeed: number;
  groundOverrides: Map<string, GroundCellOverride>;
  structureSegments: Map<string, StructureSegmentData>;
  propPlacements: Map<string, SettlementPropPlacement>;
  propColliderModes: Map<string, SettlementPropColliderMode>;
  propPhysicsProfiles: Map<string, SettlementPropPhysicsProfile>;
  propRotationQuarterTurns: 0 | 1 | 2 | 3;
};

const GRID_TILES = 30;
const TILE_SIZE = LEVEL_EDITOR_WORLD_UNIT;
const GRID_ORIGIN = -(GRID_TILES * TILE_SIZE) * 0.5;

const LEVEL_MODEL_STORAGE_KEY = SETTLEMENT_EDITOR_STORAGE_KEY;
const GAME_SAVE_STORAGE_KEY = SETTLEMENT_GAME_STORAGE_KEY;

const CAMERA_PITCH = THREE.MathUtils.degToRad(30);
const CAMERA_BASE_YAW = THREE.MathUtils.degToRad(45);
const CAMERA_DISTANCE = 30 * TILE_SIZE;
const ORTHO_HEIGHT = 3.97747564417433 * TILE_SIZE;
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
const BASE_PIXEL_ZOOM = 1;
const OUTPUT_OVERSCAN_LOW_PIXELS = 2;

const PLAYER_SPEED = 3.8;
const PLAYER_SPAWN = { x: 2.5, y: 2.5 };
const GAME_PHYSICS_PLAYER_RADIUS = 0.24 * TILE_SIZE;
const GAME_PHYSICS_PLAYER_HALF_HEIGHT = 0.26 * TILE_SIZE;
const GAME_PHYSICS_PLAYER_CENTER_Y =
  GAME_PHYSICS_PLAYER_RADIUS + GAME_PHYSICS_PLAYER_HALF_HEIGHT;
const GAME_PHYSICS_COLLIDER_HEIGHT = 2.8 * TILE_SIZE;
const GAME_PHYSICS_FLOOR_HALF_HEIGHT = 0.05;
const GRASS_VARIANT_COUNT = 4;
const DEFAULT_GRASS_VARIANT_SEED = 0x41c64e6d;
const DROP_PREVIEW_MAX_LINEAR_SPEED = 8;
const DROP_PREVIEW_MAX_ANGULAR_SPEED = 18;
const PROP_SURFACE_CLEARANCE = 0.004;
const PROP_PLACEMENT_SLIDE_STEP = 0.03;
const PROP_PLACEMENT_SLIDE_MAX_DISTANCE = 1.1 * TILE_SIZE;
const PROP_PLACEMENT_MARKER_Y_OFFSET = 0.01;

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

function clonePropRuntimeState(
  runtimeState: SettlementPropPlacement["runtimeState"]
): SettlementPropPlacement["runtimeState"] {
  if (!runtimeState) {
    return undefined;
  }
  return {
    rotation: {
      x: runtimeState.rotation.x,
      y: runtimeState.rotation.y,
      z: runtimeState.rotation.z,
      w: runtimeState.rotation.w
    },
    linearVelocity: {
      x: runtimeState.linearVelocity.x,
      y: runtimeState.linearVelocity.y,
      z: runtimeState.linearVelocity.z
    },
    angularVelocity: {
      x: runtimeState.angularVelocity.x,
      y: runtimeState.angularVelocity.y,
      z: runtimeState.angularVelocity.z
    },
    sleeping: runtimeState.sleeping
  };
}

function clonePropPlacement(
  placement: SettlementPropPlacement
): SettlementPropPlacement {
  return {
    placementId: placement.placementId,
    sourcePropId: placement.sourcePropId,
    cellX: placement.cellX,
    cellY: placement.cellY,
    offsetX: placement.offsetX,
    offsetZ: placement.offsetZ,
    rotQuarterTurns: placement.rotQuarterTurns,
    elevation: placement.elevation,
    collider2d: placement.collider2d
      ? {
          width: placement.collider2d.width,
          depth: placement.collider2d.depth
        }
      : null,
    runtimeState: clonePropRuntimeState(placement.runtimeState)
  };
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

function parseStoredEditorState(raw: unknown): {
  defaultGround: GroundBase;
  seed: number;
  overrides: Map<string, GroundCellOverride>;
  structures: Map<string, StructureSegmentData>;
  props: Map<string, SettlementPropPlacement>;
  propColliderModes: Map<string, SettlementPropColliderMode>;
  propPhysicsProfiles: Map<string, SettlementPropPhysicsProfile>;
} | null {
  const parsed = parseEditorSaveV1(raw, GRID_TILES);
  if (!parsed) {
    return null;
  }

  return {
    defaultGround: parsed.defaultGround,
    seed: parsed.seed,
    overrides: parsed.overrides,
    structures: parsed.structures,
    props: parsed.props,
    propColliderModes: parsed.propColliderModes,
    propPhysicsProfiles: parsed.propPhysicsProfiles
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

function toWorldDistance(value: number): number {
  return value * TILE_SIZE;
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

function parseGameSave(raw: unknown): SettlementGameSaveV1 | null {
  return parseGameSaveV1(raw, GRID_TILES);
}

const experiment: ExperimentModule = {
  id: "settlement-builder-ecs",
  title: "Settlement Builder (FO4-inspired)",
  tags: ["threejs", "editor", "ecs", "base-building", "level-bake", "save-load"],
  init: async ({ mount, width, height }) => {
    mount.style.position = "relative";

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x0b1117);

    let viewportWidth = Math.max(1, width);
    let viewportHeight = Math.max(1, height);

    const hemiLight = new THREE.HemisphereLight(0xf2f8ff, 0x2d3f52, 1.45);
    scene.add(hemiLight);

    const keyLight = new THREE.DirectionalLight(0xfff3df, 1.7);
    keyLight.position.set(16, 22, 12);
    scene.add(keyLight);

    const fillLight = new THREE.DirectionalLight(0xb8d0ff, 0.95);
    fillLight.position.set(-12, 14, -10);
    scene.add(fillLight);

    const rimLight = new THREE.DirectionalLight(0xffd8a8, 0.6);
    rimLight.position.set(-18, 10, 20);
    scene.add(rimLight);

    const bounceLight = new THREE.PointLight(0xb3d3ff, 0.75, 180, 2);
    bounceLight.position.set(0, 8, 0);
    scene.add(bounceLight);

    const floorGroup = new THREE.Group();
    const wallGroup = new THREE.Group();
    const editorDoorGroup = new THREE.Group();
    const gameDoorGroup = new THREE.Group();
    const editorPropGroup = new THREE.Group();
    const gamePropGroup = new THREE.Group();
    const gameplayGroup = new THREE.Group();

    scene.add(floorGroup);
    scene.add(wallGroup);
    scene.add(editorDoorGroup);
    scene.add(gameDoorGroup);
    scene.add(editorPropGroup);
    scene.add(gamePropGroup);
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
    renderer.toneMappingExposure = 1.35;
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

    const propPlaceholderGeometry = new THREE.BoxGeometry(1, 1, 1);
    const propPlaceholderMaterial = makeToon({
      color: 0x99b4c9,
      bands: 4,
      ditherStrength: 0.0,
      specularStrength: 0.15,
      specularShininess: 24
    });
    const propGhostMaterial = new THREE.MeshBasicMaterial({
      color: 0x8dd7ff,
      transparent: true,
      opacity: 0.45,
      depthWrite: false
    });
    const propGhostRoot = new THREE.Group();
    propGhostRoot.visible = false;
    scene.add(propGhostRoot);
    const propPlacementAnchorMaterial = new THREE.MeshBasicMaterial({
      color: 0xc2eeff,
      transparent: true,
      opacity: 0.72,
      depthWrite: false,
      depthTest: false,
      side: THREE.DoubleSide
    });
    const propPlacementAnchorMesh = new THREE.Mesh(
      new THREE.RingGeometry(0.06 * TILE_SIZE, 0.12 * TILE_SIZE, 20),
      propPlacementAnchorMaterial
    );
    propPlacementAnchorMesh.rotation.x = -Math.PI * 0.5;
    propPlacementAnchorMesh.visible = false;
    propPlacementAnchorMesh.renderOrder = 25;
    scene.add(propPlacementAnchorMesh);
    const propPlacementLandingMaterial = new THREE.MeshBasicMaterial({
      color: 0x6fd0ff,
      transparent: true,
      opacity: 0.26,
      depthWrite: false,
      depthTest: true,
      side: THREE.DoubleSide
    });
    const propPlacementLandingMesh = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1),
      propPlacementLandingMaterial
    );
    propPlacementLandingMesh.rotation.x = -Math.PI * 0.5;
    propPlacementLandingMesh.visible = false;
    propPlacementLandingMesh.renderOrder = 20;
    scene.add(propPlacementLandingMesh);
    const propPlacementDepthLineMaterial = new THREE.LineBasicMaterial({
      color: 0x86d8ff,
      transparent: true,
      opacity: 0.7,
      depthWrite: false
    });
    const propPlacementDepthLineGeometry = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(),
      new THREE.Vector3()
    ]);
    const propPlacementDepthLine = new THREE.Line(
      propPlacementDepthLineGeometry,
      propPlacementDepthLineMaterial
    );
    propPlacementDepthLine.visible = false;
    propPlacementDepthLine.renderOrder = 24;
    scene.add(propPlacementDepthLine);
    const propPlacementOffsetLineMaterial = new THREE.LineBasicMaterial({
      color: 0xffd88d,
      transparent: true,
      opacity: 0.8,
      depthWrite: false
    });
    const propPlacementOffsetLineGeometry = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(),
      new THREE.Vector3()
    ]);
    const propPlacementOffsetLine = new THREE.Line(
      propPlacementOffsetLineGeometry,
      propPlacementOffsetLineMaterial
    );
    propPlacementOffsetLine.visible = false;
    propPlacementOffsetLine.renderOrder = 24;
    scene.add(propPlacementOffsetLine);

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
      title: "Settlement Builder (FO4-inspired)",
      description:
        "Build a settlement in EDITOR with snap placement and saved Forge props, then enter GAME to validate traversal and doors.",
      hints:
        "EDITOR: Build/Scrap with click placement, R rotates pending prop, Ctrl+Z/Y undo/redo. GAME: WASD move, click doors, K save, L load.",
      focusTarget: renderer.domElement,
      leftPanelWidth: "min(430px, 58vw)",
      rightPanelMinWidth: "300px",
      statsTestId: "settlement-builder-ecs-stats",
      statusTestId: "settlement-builder-ecs-status"
    });

    const setButtonActive = hud.setButtonActive;
    const stats = hud.stats;
    const status = hud.status;
    const hints = hud.hints;

    let mode: Mode = "EDITOR";
    let activeTool: ToolMode = "draw";
    let editorBrush: EditorBrush = "wall";
    let activeBuildCatalog: BuildCatalogMode = "brush";
    let activeCatalogTab: BuildCatalogTab = "structures";
    let selectedPropId: string | null = null;
    let propRotationQuarterTurns: 0 | 1 | 2 | 3 = 0;
    let propPlacementSnapToGrid = true;
    let activeRectTool: RectToolMode = "none";
    let defaultGroundBase: GroundBase = "grass";
    let userSeed = 1337;
    let statusMessage = "Ready.";
    let lastPointerClientX = Number.NaN;
    let lastPointerClientY = Number.NaN;

    const editorHintsText =
      "Build flow: choose Structures/Terrain/Props  •  LMB place, RMB scrap  •  D/X build-scrap  •  R rotate prop  •  N snap on/off  •  Ctrl+Z/Y undo-redo  •  Ctrl+S save  •  B bake  •  F5 game mode";
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
        clearSelectedPropSelection();
        editorBrush = brush as EditorBrush;
        activeCatalogTab = isGroundBrush(editorBrush) ? "terrain" : "structures";
        if (brush === "grass" || brush === "road" || brush === "sidewalk") {
          activeRectTool = "none";
        }
        syncHud();
      },
      onRectTool(modeValue: PromotedEditorRectToolMode): void {
        if (!isGroundBrush(editorBrush)) {
          editorBrush = "floor";
        }
        clearSelectedPropSelection();
        activeBuildCatalog = "brush";
        activeCatalogTab = "terrain";
        activeRectTool = modeValue as RectToolMode;
        if (modeValue === "none") {
          hideRectPreview();
        }
        syncHud();
      },
      onDefaultGround(base: PromotedEditorDefaultGround): void {
        runEditorMutation(`Default ground set to ${base}.`, () => {
          if (defaultGroundBase === base) {
            return false;
          }
          defaultGroundBase = base;
          return true;
        });
      },
      onSeed(seed: number): void {
        runEditorMutation(`Seed updated to ${seed}.`, () => {
          if (userSeed === seed) {
            return false;
          }
          userSeed = seed;
          return true;
        });
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
        runEditorMutation("Structures cleared.", () => {
          if (structureSegments.size === 0) {
            return false;
          }
          structureSegments.clear();
          return true;
        });
      },
      onClearGround(): void {
        runEditorMutation("Terrain overrides cleared.", () => {
          if (groundOverrides.size === 0) {
            return false;
          }
          groundOverrides.clear();
          return true;
        });
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
    const controlRows = promotedControls.rows;
    const modeRowContainer = controlRows.mode.parentElement as HTMLDivElement | null;
    const toolRowContainer = controlRows.tool.parentElement as HTMLDivElement | null;
    const brushRowContainer = controlRows.brush.parentElement as HTMLDivElement | null;
    const rectRowContainer = controlRows.rect.parentElement as HTMLDivElement | null;
    const terrainRowContainer = controlRows.terrain.parentElement as HTMLDivElement | null;

    const catalogRow = hud.createRow("Build Catalog");
    const catalogRowContainer = catalogRow.parentElement as HTMLDivElement | null;
    if (
      catalogRowContainer &&
      toolRowContainer &&
      toolRowContainer.parentElement
    ) {
      toolRowContainer.parentElement.insertBefore(
        catalogRowContainer,
        toolRowContainer.nextSibling
      );
    }

    const catalogStructuresButton = hud.createButton("Structures", () => {
      setBuildCatalogTab("structures");
    });
    const catalogTerrainButton = hud.createButton("Terrain", () => {
      setBuildCatalogTab("terrain");
    });
    const catalogPropsButton = hud.createButton("Props", () => {
      setBuildCatalogTab("props");
    });
    const buildCatalogButtons = new Map<BuildCatalogTab, HTMLButtonElement>([
      ["structures", catalogStructuresButton],
      ["terrain", catalogTerrainButton],
      ["props", catalogPropsButton]
    ]);
    catalogRow.style.display = "grid";
    catalogRow.style.gridTemplateColumns = "repeat(3, minmax(0, 1fr))";
    catalogRow.style.gap = "7px";
    buildCatalogButtons.forEach((button) => {
      button.style.width = "100%";
      button.style.justifyContent = "center";
    });
    catalogRow.append(
      catalogStructuresButton,
      catalogTerrainButton,
      catalogPropsButton
    );

    function setBuildCatalogTab(nextTab: BuildCatalogTab): void {
      activeCatalogTab = nextTab;
      if (nextTab === "props") {
        activeBuildCatalog = "prop";
        activeTool = "draw";
      } else {
        clearSelectedPropSelection();
        activeBuildCatalog = "brush";
        if (nextTab === "structures" && isGroundBrush(editorBrush)) {
          editorBrush = "wall";
        }
        if (nextTab === "terrain" && !isGroundBrush(editorBrush)) {
          editorBrush = "floor";
        }
        activeCatalogTab = nextTab;
      }
      syncHud();
    }

    if (modeRowContainer) {
      modeRowContainer.style.borderColor = "rgba(255, 193, 96, 0.42)";
      modeRowContainer.style.background =
        "linear-gradient(160deg, rgba(53, 42, 24, 0.52), rgba(24, 21, 15, 0.64))";
    }
    if (toolRowContainer) {
      toolRowContainer.style.borderColor = "rgba(120, 183, 224, 0.42)";
      toolRowContainer.style.background =
        "linear-gradient(160deg, rgba(21, 43, 59, 0.5), rgba(18, 28, 38, 0.64))";
    }
    if (catalogRowContainer) {
      catalogRowContainer.style.borderColor = "rgba(165, 187, 203, 0.4)";
      catalogRowContainer.style.background =
        "linear-gradient(160deg, rgba(39, 47, 56, 0.56), rgba(20, 26, 32, 0.7))";
    }
    if (brushRowContainer) {
      brushRowContainer.style.borderColor = "rgba(134, 171, 196, 0.38)";
    }
    if (rectRowContainer) {
      rectRowContainer.style.borderColor = "rgba(130, 174, 143, 0.38)";
      rectRowContainer.style.background =
        "linear-gradient(165deg, rgba(27, 47, 34, 0.48), rgba(16, 30, 21, 0.62))";
    }
    if (terrainRowContainer) {
      terrainRowContainer.style.borderColor = "rgba(181, 173, 130, 0.38)";
      terrainRowContainer.style.background =
        "linear-gradient(165deg, rgba(58, 52, 32, 0.44), rgba(28, 24, 18, 0.62))";
    }

    const propLibraryRow = hud.createRow("Asset Browser");
    const propLibraryRowContainer = propLibraryRow.parentElement as HTMLDivElement | null;
    if (propLibraryRowContainer) {
      propLibraryRowContainer.style.background =
        "linear-gradient(155deg, rgba(24, 44, 58, 0.62), rgba(15, 24, 34, 0.76))";
      propLibraryRowContainer.style.borderColor = "rgba(117, 179, 223, 0.4)";
    }
    propLibraryRow.style.display = "flex";
    propLibraryRow.style.flexDirection = "column";
    propLibraryRow.style.alignItems = "stretch";
    propLibraryRow.style.gap = "9px";
    propLibraryRow.style.width = "100%";

    const propSearchInput = document.createElement("input");
    propSearchInput.type = "search";
    propSearchInput.placeholder = "Search saved props...";
    propSearchInput.style.border = "1px solid rgba(142, 181, 208, 0.68)";
    propSearchInput.style.background = "rgba(10, 16, 22, 0.88)";
    propSearchInput.style.color = "#eef8ff";
    propSearchInput.style.borderRadius = "9px";
    propSearchInput.style.padding = "7px 10px";
    propSearchInput.style.fontSize = "12px";
    propSearchInput.style.fontWeight = "600";
    propSearchInput.style.width = "100%";

    const propSelectionLabel = document.createElement("div");
    propSelectionLabel.style.fontSize = "11px";
    propSelectionLabel.style.color = "rgba(223, 239, 250, 0.94)";
    propSelectionLabel.style.lineHeight = "1.35";
    propSelectionLabel.style.padding = "6px 8px";
    propSelectionLabel.style.borderRadius = "8px";
    propSelectionLabel.style.border = "1px solid rgba(141, 181, 206, 0.34)";
    propSelectionLabel.style.background = "rgba(12, 20, 28, 0.76)";
    propSelectionLabel.textContent = "No prop selected.";

    const propInspectorRow = document.createElement("div");
    propInspectorRow.style.display = "flex";
    propInspectorRow.style.flexWrap = "wrap";
    propInspectorRow.style.gap = "6px";

    const propRotationBadge = document.createElement("span");
    propRotationBadge.style.display = "inline-flex";
    propRotationBadge.style.alignItems = "center";
    propRotationBadge.style.padding = "3px 8px";
    propRotationBadge.style.borderRadius = "999px";
    propRotationBadge.style.fontSize = "10px";
    propRotationBadge.style.letterSpacing = "0.08em";
    propRotationBadge.style.textTransform = "uppercase";
    propRotationBadge.style.background = "rgba(16, 24, 30, 0.86)";
    propRotationBadge.style.border = "1px solid rgba(148, 173, 190, 0.5)";
    propRotationBadge.style.color = "rgba(223, 237, 247, 0.96)";

    const propSnapBadge = document.createElement("span");
    propSnapBadge.style.display = "inline-flex";
    propSnapBadge.style.alignItems = "center";
    propSnapBadge.style.padding = "3px 8px";
    propSnapBadge.style.borderRadius = "999px";
    propSnapBadge.style.fontSize = "10px";
    propSnapBadge.style.letterSpacing = "0.08em";
    propSnapBadge.style.textTransform = "uppercase";
    propSnapBadge.style.background = "rgba(16, 24, 30, 0.86)";
    propSnapBadge.style.border = "1px solid rgba(148, 173, 190, 0.5)";
    propSnapBadge.style.color = "rgba(223, 237, 247, 0.96)";
    const propColliderBadge = document.createElement("span");
    propColliderBadge.style.display = "inline-flex";
    propColliderBadge.style.alignItems = "center";
    propColliderBadge.style.padding = "3px 8px";
    propColliderBadge.style.borderRadius = "999px";
    propColliderBadge.style.fontSize = "10px";
    propColliderBadge.style.letterSpacing = "0.08em";
    propColliderBadge.style.textTransform = "uppercase";
    propColliderBadge.style.background = "rgba(16, 24, 30, 0.86)";
    propColliderBadge.style.border = "1px solid rgba(148, 173, 190, 0.5)";
    propColliderBadge.style.color = "rgba(223, 237, 247, 0.96)";
    const propPhysicsBadge = document.createElement("span");
    propPhysicsBadge.style.display = "inline-flex";
    propPhysicsBadge.style.alignItems = "center";
    propPhysicsBadge.style.padding = "3px 8px";
    propPhysicsBadge.style.borderRadius = "999px";
    propPhysicsBadge.style.fontSize = "10px";
    propPhysicsBadge.style.letterSpacing = "0.08em";
    propPhysicsBadge.style.textTransform = "uppercase";
    propPhysicsBadge.style.background = "rgba(16, 24, 30, 0.86)";
    propPhysicsBadge.style.border = "1px solid rgba(148, 173, 190, 0.5)";
    propPhysicsBadge.style.color = "rgba(223, 237, 247, 0.96)";
    propInspectorRow.append(
      propRotationBadge,
      propSnapBadge,
      propColliderBadge,
      propPhysicsBadge
    );

    const propColliderModeRow = document.createElement("div");
    propColliderModeRow.style.display = "flex";
    propColliderModeRow.style.flexWrap = "wrap";
    propColliderModeRow.style.gap = "7px";
    const propColliderBoxButton = hud.createButton("Collider: Box", () => {
      setSelectedPropColliderMode("box");
    });
    const propColliderHullButton = hud.createButton("Collider: Convex Hull", () => {
      setSelectedPropColliderMode("convex-hull");
    });
    const propColliderCompoundButton = hud.createButton("Collider: Compound", () => {
      setSelectedPropColliderMode("compound-boxes");
    });
    propColliderModeRow.append(
      propColliderBoxButton,
      propColliderHullButton,
      propColliderCompoundButton
    );
    propColliderBoxButton.style.flex = "1 1 120px";
    propColliderHullButton.style.flex = "1 1 140px";
    propColliderCompoundButton.style.flex = "1 1 140px";

    const propPhysicsModeRow = document.createElement("div");
    propPhysicsModeRow.style.display = "flex";
    propPhysicsModeRow.style.flexWrap = "wrap";
    propPhysicsModeRow.style.gap = "7px";
    const propPhysicsDynamicButton = hud.createButton("Physics: Loose", () => {
      setSelectedPropPhysicsMobility("dynamic");
    });
    const propPhysicsFixedButton = hud.createButton("Physics: Support", () => {
      setSelectedPropPhysicsMobility("fixed");
    });
    propPhysicsDynamicButton.style.flex = "1 1 150px";
    propPhysicsFixedButton.style.flex = "1 1 150px";
    propPhysicsModeRow.append(propPhysicsDynamicButton, propPhysicsFixedButton);

    const propActionRow = document.createElement("div");
    propActionRow.style.display = "flex";
    propActionRow.style.flexWrap = "wrap";
    propActionRow.style.gap = "7px";

    const propSnapToggleButton = hud.createButton("Snap: ON (N)", () => {
      togglePropPlacementSnap();
    });
    const propRotateButton = hud.createButton("Rotate (R)", () => {
      rotatePendingProp();
    });
    const propRefreshButton = hud.createButton("Refresh", () => {
      void refreshSavedProps();
    });
    const propClearButton = hud.createButton("No Prop", () => {
      clearSelectedPropSelection();
      statusMessage = "Prop selection cleared.";
      syncHud();
    });
    propActionRow.append(
      propSnapToggleButton,
      propRotateButton,
      propRefreshButton,
      propClearButton
    );
    [propSnapToggleButton, propRotateButton, propRefreshButton, propClearButton].forEach(
      (button) => {
        button.style.flex = "1 1 120px";
      }
    );

    const propCardGrid = document.createElement("div");
    propCardGrid.style.display = "grid";
    propCardGrid.style.gridTemplateColumns = "repeat(auto-fill, minmax(118px, 1fr))";
    propCardGrid.style.gap = "9px";
    propCardGrid.style.maxHeight = "280px";
    propCardGrid.style.overflowY = "auto";
    propCardGrid.style.padding = "2px";

    const propEmptyState = document.createElement("div");
    propEmptyState.style.fontSize = "11px";
    propEmptyState.style.color = "rgba(209, 228, 242, 0.88)";
    propEmptyState.style.padding = "6px 2px";

    propLibraryRow.append(
      propSearchInput,
      propSelectionLabel,
      propInspectorRow,
      propColliderModeRow,
      propPhysicsModeRow,
      propActionRow,
      propCardGrid,
      propEmptyState
    );

    const propCardById = new Map<string, HTMLButtonElement>();
    let propSearchQuery = "";
    const structureBrushes: EditorBrush[] = [
      "wall",
      "window",
      "door-closed",
      "door-open"
    ];
    const terrainBrushes: EditorBrush[] = ["floor", "grass", "road", "sidewalk"];

    const drawModeButton = toolButtons.get("draw");
    if (drawModeButton) {
      drawModeButton.textContent = "Build (D)";
    }
    const eraseModeButton = toolButtons.get("erase");
    if (eraseModeButton) {
      eraseModeButton.textContent = "Scrap (X)";
    }

    const dataRow = hud.createRow("Data");
    const exportJsonButton = hud.createButton("Export JSON", () => {
      exportEditorJson();
    });
    const importJsonButton = hud.createButton("Import JSON", () => {
      importJsonInput.click();
    });
    const clearAllButton = hud.createButton("Clear All", () => {
      runEditorMutation("Cleared all level content.", () => clearAllEditorContent());
    });
    exportJsonButton.style.borderColor = "rgba(210, 174, 102, 0.82)";
    exportJsonButton.style.background =
      "linear-gradient(180deg, rgba(94, 71, 34, 0.88), rgba(52, 41, 24, 0.92))";
    importJsonButton.style.borderColor = "rgba(160, 193, 214, 0.78)";
    clearAllButton.style.borderColor = "rgba(226, 132, 116, 0.86)";
    clearAllButton.style.background =
      "linear-gradient(180deg, rgba(112, 42, 34, 0.9), rgba(66, 24, 20, 0.94))";
    const importJsonInput = document.createElement("input");
    importJsonInput.type = "file";
    importJsonInput.accept = "application/json,.json";
    importJsonInput.style.display = "none";
    importJsonInput.addEventListener("change", () => {
      const file = importJsonInput.files?.[0];
      if (!file) {
        return;
      }
      void importEditorJson(file);
      importJsonInput.value = "";
    });
    dataRow.append(exportJsonButton, importJsonButton, clearAllButton);
    const dataRowContainer = dataRow.parentElement as HTMLDivElement | null;
    if (dataRowContainer) {
      dataRowContainer.style.borderColor = "rgba(201, 168, 112, 0.4)";
      dataRowContainer.style.background =
        "linear-gradient(165deg, rgba(54, 43, 27, 0.46), rgba(27, 23, 17, 0.64))";
    }
    hud.leftPanel.appendChild(importJsonInput);

    const gameControlsRow = document.createElement("div");
    gameControlsRow.style.display = "none";
    gameControlsRow.style.flexDirection = "column";
    gameControlsRow.style.gap = "8px";
    gameControlsRow.style.marginBottom = "6px";
    gameControlsRow.style.padding = "9px 10px";
    gameControlsRow.style.borderRadius = "10px";
    gameControlsRow.style.background =
      "linear-gradient(160deg, rgba(24, 46, 62, 0.54), rgba(14, 22, 31, 0.68))";
    gameControlsRow.style.border = "1px solid rgba(123, 182, 221, 0.38)";

    const gameControlsLabel = document.createElement("div");
    gameControlsLabel.textContent = "Game Controls";
    gameControlsLabel.style.fontSize = "12px";
    gameControlsLabel.style.opacity = "0.95";
    gameControlsLabel.style.letterSpacing = "0.08em";
    gameControlsLabel.style.fontWeight = "700";
    gameControlsLabel.style.textTransform = "uppercase";
    gameControlsRow.appendChild(gameControlsLabel);

    const gameControlsButtons = document.createElement("div");
    gameControlsButtons.style.display = "flex";
    gameControlsButtons.style.flexWrap = "wrap";
    gameControlsButtons.style.gap = "7px";
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

    const gltfLoader = new GLTFLoader();
    const savedPropDefinitionsById = new Map<string, SavedPropDefinition>();
    const propAssetValidationIssuesById = new Map<string, PropAssetValidationIssue[]>();
    const propTemplateById = new Map<string, THREE.Object3D | null>();
    const propConvexVerticesById = new Map<string, Float32Array>();
    const editorPropRootByPlacementId = new Map<string, THREE.Group>();
    const propRuntimeRotationByPlacementId = new Map<string, PropRuntimeRotation>();
    const editorPropPhysicsByPlacementId = new Map<string, EditorPropPhysicsBody>();
    const pendingEditorPropActivationAtMsByPlacementId = new Map<string, number>();
    const editorPropRebuildCounts = new Map<EditorPropRebuildReason, number>();
    const propTemplateRequestById = new Map<string, Promise<void>>();
    let runtimePhysicsLastSubsteps = 0;

    let structureSegments = createMockupStructureSegments();
    let groundOverrides = createMockupTerrainOverrides(userSeed);
    let propPlacements = new Map<string, SettlementPropPlacement>();
    let propColliderModes = new Map<string, SettlementPropColliderMode>();
    let propPhysicsProfiles = new Map<string, SettlementPropPhysicsProfile>();
    const savedLevelModelJson = localStorage.getItem(LEVEL_MODEL_STORAGE_KEY);
    if (savedLevelModelJson) {
      try {
        const parsed = parseStoredEditorState(JSON.parse(savedLevelModelJson));
        if (parsed) {
          structureSegments = parsed.structures;
          groundOverrides = parsed.overrides;
          propPlacements = parsed.props;
          propColliderModes = parsed.propColliderModes;
          propPhysicsProfiles = new Map(parsed.propPhysicsProfiles);
          defaultGroundBase = parsed.defaultGround;
          userSeed = parsed.seed;
          seedInput.value = String(userSeed);
          statusMessage = "Loaded editor state from localStorage.";
        }
      } catch {
        // Keep defaults if stored value is invalid JSON.
      }
    }
    hydrateRuntimeStateFromPlacements();
    for (const placement of propPlacements.values()) {
      ensurePropTemplate(placement.sourcePropId);
    }
    void refreshSavedProps();

    const inputRight = new THREE.Vector3();
    const inputForward = new THREE.Vector3();
    const worldPoint = new THREE.Vector3();
    const snappedPlayerWorld = new THREE.Vector3();
    const propPlacementRayDirection = new THREE.Vector3();
    const propPlacementRayToCameraDirection = new THREE.Vector3();
    const propSurfaceRaycaster = new THREE.Raycaster();
    const propPointerNdc = new THREE.Vector2();
    const propFloorPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
    const propFloorHit = new THREE.Vector3();
    const propPlacementHintLineStart = new THREE.Vector3();
    const propPlacementHintLineEnd = new THREE.Vector3();
    const propScratchBounds = new THREE.Box3();
    const propScratchCenter = new THREE.Vector3();

    let dragState: DragState | null = null;
    let raf = 0;

    let gameRuntime: GameRuntime | null = null;
    let preservedEditorReturnPlayer: { x: number; y: number } | null = null;
    let autosaveTimer = 0;
    let propDropEnabled = true;
    let ghostPropTemplateId: string | null = null;
    let ghostDropCacheKey = "";
    let ghostDropElevation = 0;
    let ghostDropWorldX = 0;
    let ghostDropWorldZ = 0;
    let ghostDropLandingY = 0;
    let ghostAnchorWorldX = 0;
    let ghostAnchorWorldY = 0;
    let ghostAnchorWorldZ = 0;
    let ghostDropIsClear = true;
    let ghostDropSlidTowardCamera = false;
    let propDropRevision = 0;
    let editorPropPhysicsWorld: RAPIER3D.World | null = null;
    let editorPropPhysicsLastAutosaveMs = 0;
    let editorPropPhysicsLastHoverRefreshMs = 0;
    const ghostMaterials = new Set<THREE.Material>();

    const history = createHistoryController<EditorSnapshot>({
      maxEntries: 100,
      clone(value) {
        return {
          defaultGroundBase: value.defaultGroundBase,
          userSeed: value.userSeed,
          groundOverrides: new Map(
            [...value.groundOverrides.entries()].map(([key, ground]) => [
              key,
              { base: ground.base, variant: ground.variant }
            ])
          ),
          structureSegments: new Map(
            [...value.structureSegments.entries()].map(([key, segment]) => [
              key,
              segment.kind === STRUCTURE_KIND.DOOR
                ? { kind: STRUCTURE_KIND.DOOR, state: segment.state }
                : { kind: segment.kind }
            ])
          ),
          propPlacements: new Map(
            [...value.propPlacements.entries()].map(([key, placement]) => [
              key,
              clonePropPlacement(placement)
            ])
          ),
          propColliderModes: new Map(value.propColliderModes),
          propPhysicsProfiles: new Map(
            [...value.propPhysicsProfiles.entries()].map(([key, profile]) => [
              key,
              clonePropPhysicsProfile(profile)
            ])
          ),
          propRotationQuarterTurns: value.propRotationQuarterTurns
        };
      }
    });

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

    function captureEditorSnapshot(): EditorSnapshot {
      return {
        defaultGroundBase,
        userSeed,
        groundOverrides: new Map(
          [...groundOverrides.entries()].map(([key, value]) => [
            key,
            { base: value.base, variant: value.variant }
          ])
        ),
        structureSegments: new Map(
          [...structureSegments.entries()].map(([key, segment]) => [
            key,
            segment.kind === STRUCTURE_KIND.DOOR
              ? { kind: STRUCTURE_KIND.DOOR, state: segment.state }
              : { kind: segment.kind }
          ])
        ),
        propPlacements: new Map(
          [...propPlacements.entries()].map(([key, placement]) => [
            key,
            clonePropPlacement(placement)
          ])
        ),
        propColliderModes: new Map(propColliderModes),
        propPhysicsProfiles: new Map(
          [...propPhysicsProfiles.entries()].map(([key, profile]) => [
            key,
            clonePropPhysicsProfile(profile)
          ])
        ),
        propRotationQuarterTurns
      };
    }

    function hydrateRuntimeStateFromPlacements(): void {
      propRuntimeRotationByPlacementId.clear();
      for (const placement of propPlacements.values()) {
        const runtimeState = placement.runtimeState;
        if (!runtimeState) {
          continue;
        }
        propRuntimeRotationByPlacementId.set(placement.placementId, {
          x: runtimeState.rotation.x,
          y: runtimeState.rotation.y,
          z: runtimeState.rotation.z,
          w: runtimeState.rotation.w
        });
      }
    }

    function applyEditorSnapshot(snapshot: EditorSnapshot): void {
      defaultGroundBase = snapshot.defaultGroundBase;
      userSeed = snapshot.userSeed;
      groundOverrides = new Map(snapshot.groundOverrides);
      structureSegments = new Map(snapshot.structureSegments);
      propPlacements = new Map(snapshot.propPlacements);
      disposeEditorPropPhysics();
      hydrateRuntimeStateFromPlacements();
      propColliderModes = new Map(snapshot.propColliderModes);
      propPhysicsProfiles = new Map(snapshot.propPhysicsProfiles);
      propRotationQuarterTurns = snapshot.propRotationQuarterTurns;
      propDropRevision += 1;
      ghostDropCacheKey = "";
      seedInput.value = String(userSeed);
      rebuildBaseLevelMeshes();
      rebuildEditorStructureMeshes();
      rebuildEditorPropMeshes();
      if (gameRuntime) {
        rebuildGamePropMeshes();
      }
      scheduleEditorAutosave();
      syncHud();
    }

    function saveEditorNow(): void {
      const payload = buildEditorSaveV1({
        defaultGround: defaultGroundBase,
        seed: userSeed,
        overrides: groundOverrides,
        structures: structureSegments,
        props: propPlacements,
        propColliderModes,
        propPhysicsProfiles
      });
      localStorage.setItem(LEVEL_MODEL_STORAGE_KEY, JSON.stringify(payload));
    }

    function exportEditorJson(): void {
      const payload = buildEditorSaveV1({
        defaultGround: defaultGroundBase,
        seed: userSeed,
        overrides: groundOverrides,
        structures: structureSegments,
        props: propPlacements,
        propColliderModes,
        propPhysicsProfiles
      });
      const blob = new Blob([JSON.stringify(payload, null, 2)], {
        type: "application/json"
      });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = "settlement-editor-save.json";
      anchor.click();
      URL.revokeObjectURL(url);
      statusMessage = "Exported editor JSON.";
      syncHud();
    }

    async function importEditorJson(file: File): Promise<void> {
      let parsed: unknown;
      try {
        parsed = JSON.parse(await file.text());
      } catch {
        statusMessage = "Import failed: invalid JSON.";
        syncHud();
        return;
      }

      const editor = parseEditorSaveV1(parsed, GRID_TILES);
      if (!editor) {
        statusMessage = "Import failed: schema/validation error.";
        syncHud();
        return;
      }

      const previous = captureEditorSnapshot();
      defaultGroundBase = editor.defaultGround;
      userSeed = editor.seed;
      seedInput.value = String(userSeed);
      groundOverrides = editor.overrides;
      structureSegments = editor.structures;
      propPlacements = editor.props;
      disposeEditorPropPhysics();
      hydrateRuntimeStateFromPlacements();
      propColliderModes = editor.propColliderModes;
      propPhysicsProfiles = new Map(editor.propPhysicsProfiles);
      propRotationQuarterTurns = 0;
      propDropRevision += 1;
      ghostDropCacheKey = "";
      for (const placement of propPlacements.values()) {
        ensurePropTemplate(placement.sourcePropId);
      }
      history.push(previous);
      propDropRevision += 1;
      ghostDropCacheKey = "";
      rebuildBaseLevelMeshes();
      rebuildEditorStructureMeshes();
      rebuildEditorPropMeshes();
      if (gameRuntime) {
        rebuildGamePropMeshes();
      }
      scheduleEditorAutosave();
      statusMessage = `Imported editor JSON from ${file.name}.`;
      syncHud();
    }

    function scheduleEditorAutosave(): void {
      if (autosaveTimer > 0) {
        window.clearTimeout(autosaveTimer);
      }
      autosaveTimer = window.setTimeout(() => {
        autosaveTimer = 0;
        saveEditorNow();
      }, 220);
    }

    function runEditorMutation(statusText: string, mutate: () => boolean): boolean {
      const previous = captureEditorSnapshot();
      const changed = mutate();
      if (!changed) {
        return false;
      }
      history.push(previous);
      propDropRevision += 1;
      ghostDropCacheKey = "";
      rebuildBaseLevelMeshes();
      rebuildEditorStructureMeshes();
      rebuildEditorPropMeshes();
      if (gameRuntime) {
        rebuildGamePropMeshes();
      }
      scheduleEditorAutosave();
      statusMessage = statusText;
      syncHud();
      return true;
    }

    function clearAllEditorContent(): boolean {
      const hasAnyContent =
        structureSegments.size > 0 ||
        groundOverrides.size > 0 ||
        propPlacements.size > 0 ||
        propColliderModes.size > 0 ||
        propPhysicsProfiles.size > 0;
      if (!hasAnyContent) {
        return false;
      }

      structureSegments.clear();
      groundOverrides.clear();
      propPlacements.clear();
      propColliderModes.clear();
      propPhysicsProfiles.clear();
      propRuntimeRotationByPlacementId.clear();
      pendingEditorPropActivationAtMsByPlacementId.clear();
      editorPropRebuildCounts.clear();
      disposeEditorPropPhysics();
      return true;
    }

    function isSamePropCell(placement: SettlementPropPlacement, x: number, y: number): boolean {
      return placement.cellX === x && placement.cellY === y;
    }

    function getPropPlacementWorldX(placement: SettlementPropPlacement): number {
      return toWorldX(placement.cellX) + placement.offsetX;
    }

    function getPropPlacementWorldZ(placement: SettlementPropPlacement): number {
      return toWorldZ(placement.cellY) + placement.offsetZ;
    }

    function toGameplayCoordX(worldX: number): number {
      return (worldX - GRID_ORIGIN) / TILE_SIZE;
    }

    function toGameplayCoordY(worldZ: number): number {
      return (worldZ - GRID_ORIGIN) / TILE_SIZE;
    }

    function setPropPointerRayFromClient(clientX: number, clientY: number): boolean {
      const rect = renderer.domElement.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) {
        return false;
      }

      const normalizedX = (clientX - rect.left) / rect.width;
      const normalizedY = (clientY - rect.top) / rect.height;
      propPointerNdc.set(
        normalizedX * 2 - 1,
        -(normalizedY * 2 - 1)
      );
      propSurfaceRaycaster.setFromCamera(propPointerNdc, camera);
      return true;
    }

    type PlacementSupportCandidate = {
      kind: "floor" | "prop";
      t: number;
      pointX: number;
      pointY: number;
      pointZ: number;
      supportY: number;
      supportPlacementId: string | null;
    };

    function selectBestPlacementSupportOnRay(
      ray: THREE.Ray
    ): PlacementSupportCandidate | null {
      if (Math.abs(ray.direction.y) <= 0.000001) {
        return null;
      }

      let best: PlacementSupportCandidate | null = null;
      const setIfCloser = (candidate: PlacementSupportCandidate): void => {
        if (candidate.t <= 0) {
          return;
        }
        if (!best || candidate.t < best.t) {
          best = candidate;
        }
      };

      const floorHit = ray.intersectPlane(propFloorPlane, propFloorHit);
      if (floorHit && worldToCell(floorHit.x, floorHit.z)) {
        const floorT = (0 - ray.origin.y) / ray.direction.y;
        setIfCloser({
          kind: "floor",
          t: floorT,
          pointX: floorHit.x,
          pointY: 0,
          pointZ: floorHit.z,
          supportY: 0,
          supportPlacementId: null
        });
      }

      const footprintEpsilon = 0.0006;
      for (const placement of propPlacements.values()) {
        const dims = resolvePropDimensions(
          placement.sourcePropId,
          placement.rotQuarterTurns
        );
        const supportY = placement.elevation + dims.height;
        const t = (supportY - ray.origin.y) / ray.direction.y;
        if (t <= 0) {
          continue;
        }
        const hitX = ray.origin.x + ray.direction.x * t;
        const hitZ = ray.origin.z + ray.direction.z * t;
        if (!worldToCell(hitX, hitZ)) {
          continue;
        }

        const centerX = getPropPlacementWorldX(placement);
        const centerZ = getPropPlacementWorldZ(placement);
        const halfWidth = dims.width * 0.5 + footprintEpsilon;
        const halfDepth = dims.depth * 0.5 + footprintEpsilon;
        if (Math.abs(hitX - centerX) > halfWidth) {
          continue;
        }
        if (Math.abs(hitZ - centerZ) > halfDepth) {
          continue;
        }

        setIfCloser({
          kind: "prop",
          t,
          pointX: hitX,
          pointY: supportY,
          pointZ: hitZ,
          supportY,
          supportPlacementId: placement.placementId
        });
      }

      return best;
    }

    function resolvePropPlacementTargetFromClient(
      clientX: number,
      clientY: number
    ): PropPlacementTarget | null {
      if (!setPropPointerRayFromClient(clientX, clientY)) {
        return null;
      }

      const ray = propSurfaceRaycaster.ray;
      const support = selectBestPlacementSupportOnRay(ray);
      if (!support) {
        return null;
      }

      const pointerCell = worldToCell(support.pointX, support.pointZ);
      if (!pointerCell) {
        return null;
      }

      let worldX = support.pointX;
      let worldZ = support.pointZ;
      if (support.kind === "floor") {
        if (propPlacementSnapToGrid) {
          worldX = toWorldX(pointerCell.x);
          worldZ = toWorldZ(pointerCell.y);
        }
      }

      const placementCell = worldToCell(worldX, worldZ) ?? pointerCell;

      return {
        cellX: placementCell.x,
        cellY: placementCell.y,
        worldX,
        worldZ,
        supportKind: support.kind,
        supportY: support.supportY,
        supportPlacementId: support.supportPlacementId,
        pointerWorldX: support.pointX,
        pointerWorldY: support.pointY,
        pointerWorldZ: support.pointZ,
        rayDirectionX: ray.direction.x,
        rayDirectionY: ray.direction.y,
        rayDirectionZ: ray.direction.z
      };
    }

    function getPropPlacementsAtCell(cellX: number, cellY: number): SettlementPropPlacement[] {
      const matches: SettlementPropPlacement[] = [];
      for (const placement of propPlacements.values()) {
        if (isSamePropCell(placement, cellX, cellY)) {
          matches.push(placement);
        }
      }
      matches.sort((a, b) => a.elevation - b.elevation);
      return matches;
    }

    function findTopPropPlacementAtCell(
      cellX: number,
      cellY: number
    ): SettlementPropPlacement | null {
      const matches = getPropPlacementsAtCell(cellX, cellY);
      if (matches.length === 0) {
        return null;
      }
      return matches[matches.length - 1] ?? null;
    }

    function resolvePropDimensions(
      propId: string,
      rotQuarterTurns: 0 | 1 | 2 | 3
    ): { width: number; depth: number; height: number; collider2d: { width: number; depth: number } | null } {
      const definition = savedPropDefinitionsById.get(propId);
      const fallbackWidth = 0.72;
      const fallbackDepth = 0.72;
      const fallbackHeight = 0.9;

      let width =
        definition && definition.bbox.width > 0
          ? definition.bbox.width
          : definition?.collider2d?.width ?? fallbackWidth;
      let depth =
        definition && definition.bbox.depth > 0
          ? definition.bbox.depth
          : definition?.collider2d?.depth ?? fallbackDepth;
      const height =
        definition && definition.bbox.height > 0
          ? definition.bbox.height
          : fallbackHeight;

      width = Math.max(0.2, width);
      depth = Math.max(0.2, depth);
      const normalizedHeight = Math.max(0.2, height);

      if (rotQuarterTurns % 2 === 1) {
        [width, depth] = [depth, width];
      }

      return {
        width,
        depth,
        height: normalizedHeight,
        collider2d: definition?.collider2d
          ? {
              width: definition.collider2d.width,
              depth: definition.collider2d.depth
            }
          : null
      };
    }

    function resolveColliderForProp(
      propId: string,
      rotQuarterTurns: 0 | 1 | 2 | 3
    ): { width: number; depth: number } | null {
      const dimensions = resolvePropDimensions(propId, rotQuarterTurns);
      return dimensions.collider2d;
    }

    function getSavedPropDefinition(sourcePropId: string): SavedPropDefinition | undefined {
      return savedPropDefinitionsById.get(sourcePropId);
    }

    function getPropAssetValidationIssueCount(sourcePropId: string): number {
      return propAssetValidationIssuesById.get(sourcePropId)?.length ?? 0;
    }

    function getAvailablePropColliderModes(
      sourcePropId: string
    ): SettlementPropColliderMode[] {
      return getAvailablePropColliderModesForDefinition(
        getSavedPropDefinition(sourcePropId)
      );
    }

    function isPropColliderModeSupported(
      sourcePropId: string,
      mode: SettlementPropColliderMode
    ): boolean {
      return isPropColliderModeSupportedForDefinition(
        getSavedPropDefinition(sourcePropId),
        mode
      );
    }

    function disposeGhostMaterials(): void {
      ghostMaterials.forEach((material) => material.dispose());
      ghostMaterials.clear();
    }

    function clearPropGhostVisual(): void {
      clearGroup(propGhostRoot);
      disposeGhostMaterials();
      ghostPropTemplateId = null;
      propGhostRoot.visible = false;
      hidePropPlacementIndicators();
    }

    function hidePropPlacementIndicators(): void {
      propPlacementAnchorMesh.visible = false;
      propPlacementLandingMesh.visible = false;
      propPlacementDepthLine.visible = false;
      propPlacementOffsetLine.visible = false;
    }

    function cloneGhostMaterial(material: THREE.Material): THREE.Material {
      const cloned = material.clone();
      cloned.transparent = true;
      if ("opacity" in cloned && typeof cloned.opacity === "number") {
        cloned.opacity = Math.min(0.55, Math.max(0.2, cloned.opacity * 0.55));
      }
      cloned.depthWrite = false;
      cloned.needsUpdate = true;
      ghostMaterials.add(cloned);
      return cloned;
    }

    function makeTransparentGhostObject(source: THREE.Object3D): THREE.Object3D {
      const ghost = source.clone(true);
      ghost.traverse((node) => {
        if (!(node instanceof THREE.Mesh)) {
          return;
        }
        if (Array.isArray(node.material)) {
          node.material = node.material.map((material) =>
            cloneGhostMaterial(material)
          );
          return;
        }
        node.material = cloneGhostMaterial(node.material);
      });
      return ghost;
    }

    function refreshPropGhostVisual(): void {
      clearPropGhostVisual();
      if (!selectedPropId) {
        return;
      }

      const dimensions = resolvePropDimensions(selectedPropId, propRotationQuarterTurns);
      const template = propTemplateById.get(selectedPropId);
      if (template) {
        propGhostRoot.add(makeTransparentGhostObject(template));
      } else {
        const placeholder = new THREE.Mesh(propPlaceholderGeometry, propGhostMaterial);
        placeholder.scale.set(dimensions.width, dimensions.height, dimensions.depth);
        placeholder.position.y = dimensions.height * 0.5;
        propGhostRoot.add(placeholder);
      }

      ghostPropTemplateId = selectedPropId;
    }

    function updateSnapToggleLabel(): void {
      propSnapToggleButton.textContent = propPlacementSnapToGrid
        ? "Snap: ON (N)"
        : "Snap: OFF (N)";
      setButtonActive(propSnapToggleButton, propPlacementSnapToGrid);
    }

    function formatPropDimension(value: number): string {
      if (!Number.isFinite(value) || value <= 0) {
        return "--";
      }
      return `${value.toFixed(2)}m`;
    }

    function getPropPhysicsProfile(sourcePropId: string): SettlementPropPhysicsProfile {
      const explicit = propPhysicsProfiles.get(sourcePropId);
      if (explicit) {
        return normalizePropPhysicsProfile(explicit);
      }
      return inferPropPhysicsProfile(savedPropDefinitionsById.get(sourcePropId));
    }

    function setPropPhysicsMobility(
      sourcePropId: string,
      mobility: SettlementPropPhysicsMobility
    ): boolean {
      const normalizedMobility = mobility === "fixed" ? "fixed" : "dynamic";
      const current = getPropPhysicsProfile(sourcePropId);
      if (
        current.mobility === normalizedMobility &&
        propPhysicsProfiles.has(sourcePropId)
      ) {
        return false;
      }

      const next = withPropPhysicsMobility(current, normalizedMobility);
      propPhysicsProfiles.set(sourcePropId, next);

      const nowMs = performance.now();
      for (const placement of propPlacements.values()) {
        if (placement.sourcePropId !== sourcePropId) {
          continue;
        }
        const currentRotation = resolvePlacementRuntimeRotation(placement);
        if (normalizedMobility === "fixed") {
          placement.runtimeState = {
            rotation: {
              x: currentRotation.x,
              y: currentRotation.y,
              z: currentRotation.z,
              w: currentRotation.w
            },
            linearVelocity: { x: 0, y: 0, z: 0 },
            angularVelocity: { x: 0, y: 0, z: 0 },
            sleeping: true
          };
          pendingEditorPropActivationAtMsByPlacementId.delete(placement.placementId);
        } else {
          placement.runtimeState = {
            rotation: {
              x: currentRotation.x,
              y: currentRotation.y,
              z: currentRotation.z,
              w: currentRotation.w
            },
            linearVelocity: { x: 0, y: 0, z: 0 },
            angularVelocity: { x: 0, y: 0, z: 0 },
            sleeping: false
          };
          const delayMs = Math.max(1, next.activationDelayMs);
          pendingEditorPropActivationAtMsByPlacementId.set(
            placement.placementId,
            nowMs + delayMs
          );
        }
        removeEditorPropPhysicsBody(placement.placementId);
      }

      updatePropSelectOptions();
      propDropRevision += 1;
      ghostDropCacheKey = "";
      refreshHoverFromLastPointer();
      return true;
    }

    function getPropColliderMode(sourcePropId: string): SettlementPropColliderMode {
      return resolveEffectivePropColliderMode(
        getSavedPropDefinition(sourcePropId),
        propColliderModes.get(sourcePropId)
      );
    }

    function setPropColliderMode(
      sourcePropId: string,
      mode: SettlementPropColliderMode
    ): boolean {
      if (!isPropColliderModeSupported(sourcePropId, mode)) {
        return false;
      }

      const current = getPropColliderMode(sourcePropId);
      if (current === mode) {
        if (!propColliderModes.has(sourcePropId)) {
          return false;
        }
      }

      const fallback = resolveEffectivePropColliderMode(
        getSavedPropDefinition(sourcePropId),
        null
      );
      if (mode === fallback) {
        if (!propColliderModes.has(sourcePropId)) {
          return false;
        }
        propColliderModes.delete(sourcePropId);
      } else {
        propColliderModes.set(sourcePropId, mode);
      }

      for (const placement of propPlacements.values()) {
        if (placement.sourcePropId !== sourcePropId) {
          continue;
        }
        removeEditorPropPhysicsBody(placement.placementId);
      }

      propConvexVerticesById.delete(sourcePropId);
      updatePropSelectOptions();
      propDropRevision += 1;
      ghostDropCacheKey = "";
      refreshHoverFromLastPointer();
      return true;
    }

    function colliderModeLabel(mode: SettlementPropColliderMode): string {
      switch (mode) {
        case "box":
          return "box";
        case "convex-hull":
          return "convex hull";
        case "compound-boxes":
          return "compound boxes";
        default:
          return mode;
      }
    }

    function setSelectedPropColliderMode(mode: SettlementPropColliderMode): void {
      if (!selectedPropId) {
        return;
      }
      const propId = selectedPropId;
      if (!isPropColliderModeSupported(propId, mode)) {
        statusMessage = `${propId} does not provide ${colliderModeLabel(mode)} collider data.`;
        syncHud();
        return;
      }
      const modeLabel = colliderModeLabel(mode);
      runEditorMutation(
        `Set ${propId} to ${modeLabel} mode.`,
        () => setPropColliderMode(propId, mode)
      );
    }

    function setSelectedPropPhysicsMobility(
      mobility: SettlementPropPhysicsMobility
    ): void {
      if (!selectedPropId) {
        return;
      }
      const propId = selectedPropId;
      const modeLabel = mobility === "fixed" ? "support (fixed)" : "loose (dynamic)";
      runEditorMutation(
        `Set ${propId} physics to ${modeLabel}.`,
        () => setPropPhysicsMobility(propId, mobility)
      );
    }

    function setSelectedProp(nextId: string | null, statusText?: string): void {
      const normalized =
        nextId && savedPropDefinitionsById.has(nextId) ? nextId : null;
      selectedPropId = normalized;
      if (normalized) {
        activeBuildCatalog = "prop";
        activeCatalogTab = "props";
      } else if (activeCatalogTab === "props") {
        activeBuildCatalog = "prop";
      } else {
        activeBuildCatalog = "brush";
        activeCatalogTab = isGroundBrush(editorBrush) ? "terrain" : "structures";
      }
      ghostDropCacheKey = "";
      if (normalized) {
        ensurePropTemplate(normalized);
        refreshPropGhostVisual();
      } else {
        clearPropGhostVisual();
      }
      refreshHoverFromLastPointer();
      updatePropSelectOptions();
      if (statusText) {
        statusMessage = statusText;
      }
    }

    function rotatePendingProp(): void {
      propRotationQuarterTurns =
        (((propRotationQuarterTurns + 1) % 4) + 4) % 4 as 0 | 1 | 2 | 3;
      if (selectedPropId && activeBuildCatalog === "prop") {
        refreshPropGhostVisual();
      }
      ghostDropCacheKey = "";
      refreshHoverFromLastPointer();
      statusMessage = `Prop rotation ${propRotationQuarterTurns * 90}°`;
      syncHud();
    }

    function togglePropPlacementSnap(): void {
      propPlacementSnapToGrid = !propPlacementSnapToGrid;
      ghostDropCacheKey = "";
      refreshHoverFromLastPointer();
      statusMessage = `Prop snap ${propPlacementSnapToGrid ? "enabled" : "disabled"}.`;
      syncHud();
    }

    function updatePropSelectOptions(): void {
      const entries = [...savedPropDefinitionsById.values()].sort((a, b) =>
        a.description.localeCompare(b.description)
      );
      const query = propSearchQuery.trim().toLowerCase();
      const filtered =
        query.length === 0
          ? entries
          : entries.filter((entry) => {
              const idMatch = entry.id.toLowerCase().includes(query);
              const nameMatch = entry.description.toLowerCase().includes(query);
              return idMatch || nameMatch;
            });

      propCardGrid.innerHTML = "";
      propCardById.clear();

      for (const entry of filtered) {
        const card = document.createElement("button");
        card.type = "button";
        card.title = entry.description;
        card.style.display = "flex";
        card.style.flexDirection = "column";
        card.style.alignItems = "stretch";
        card.style.gap = "7px";
        card.style.padding = "7px";
        card.style.borderRadius = "10px";
        card.style.border = "1px solid rgba(132, 166, 189, 0.46)";
        card.style.background =
          "linear-gradient(180deg, rgba(21, 36, 48, 0.88), rgba(14, 24, 33, 0.92))";
        card.style.cursor = "pointer";
        card.style.textAlign = "left";
        card.style.boxShadow =
          "0 4px 10px rgba(0, 0, 0, 0.32), inset 0 1px 0 rgba(255, 255, 255, 0.08)";

        const thumb = document.createElement("div");
        thumb.style.position = "relative";
        thumb.style.width = "100%";
        thumb.style.aspectRatio = "1 / 1";
        thumb.style.borderRadius = "8px";
        thumb.style.overflow = "hidden";
        thumb.style.background =
          "radial-gradient(circle at 20% 18%, rgba(125, 186, 230, 0.36), rgba(9, 16, 23, 0.98))";
        thumb.style.border = "1px solid rgba(146, 186, 214, 0.34)";

        const image = document.createElement("img");
        image.src = `/api/fs/read?path=${encodeURIComponent(entry.conceptImagePath)}`;
        image.alt = entry.description;
        image.loading = "lazy";
        image.decoding = "async";
        image.style.width = "100%";
        image.style.height = "100%";
        image.style.objectFit = "cover";
        image.style.display = "block";
        image.addEventListener("error", () => {
          if (image.parentElement === thumb) {
            thumb.removeChild(image);
          }
          const fallback = document.createElement("div");
          fallback.style.display = "grid";
          fallback.style.placeItems = "center";
          fallback.style.width = "100%";
          fallback.style.height = "100%";
          fallback.style.color = "rgba(216, 232, 244, 0.82)";
          fallback.style.fontSize = "11px";
          fallback.style.padding = "6px";
          fallback.style.textAlign = "center";
          fallback.textContent = entry.description;
          thumb.appendChild(fallback);
        });
        thumb.appendChild(image);

        const loading = propTemplateRequestById.has(entry.id);
        if (loading) {
          const badge = document.createElement("span");
          badge.textContent = "loading";
          badge.style.position = "absolute";
          badge.style.right = "4px";
          badge.style.bottom = "4px";
          badge.style.fontSize = "10px";
          badge.style.padding = "1px 5px";
          badge.style.borderRadius = "999px";
          badge.style.background = "rgba(11, 17, 23, 0.78)";
          badge.style.border = "1px solid rgba(152, 190, 217, 0.42)";
          badge.style.color = "#cfe4f4";
          thumb.appendChild(badge);
        }

        const label = document.createElement("div");
        label.style.fontSize = "11px";
        label.style.fontWeight = "700";
        label.style.letterSpacing = "0.02em";
        label.style.lineHeight = "1.3";
        label.style.color = "#ebf7ff";
        label.textContent = entry.description;

        const dims = document.createElement("div");
        dims.style.fontSize = "10px";
        dims.style.lineHeight = "1.2";
        dims.style.color = "rgba(190, 220, 242, 0.88)";
        const profile = getPropPhysicsProfile(entry.id);
        const validationIssueCount = getPropAssetValidationIssueCount(entry.id);
        const mobilityLabel =
          profile.mobility === "fixed" ? "support physics" : "loose physics";
        dims.textContent = `${formatPropDimension(entry.bbox.width)} × ${formatPropDimension(entry.bbox.depth)} × ${formatPropDimension(entry.bbox.height)} • ${mobilityLabel}${validationIssueCount > 0 ? ` • meta warn:${validationIssueCount}` : ""}`;

        card.append(thumb, label, dims);
        card.addEventListener("click", () => {
          setSelectedProp(entry.id, `Selected prop: ${entry.description}`);
          syncHud();
        });

        propCardById.set(entry.id, card);
        propCardGrid.appendChild(card);
      }

      const hasSavedProps = entries.length > 0;
      if (!hasSavedProps) {
        propEmptyState.textContent = "No saved props found in Forge.";
      } else if (filtered.length === 0) {
        propEmptyState.textContent = "No props match your search.";
      } else {
        propEmptyState.textContent = "";
      }

      if (selectedPropId && !savedPropDefinitionsById.has(selectedPropId)) {
        setSelectedProp(null);
      }

      for (const [id, card] of propCardById.entries()) {
        const active = id === selectedPropId && activeBuildCatalog === "prop";
        card.style.borderColor = active
          ? "rgba(171, 220, 252, 0.98)"
          : "rgba(132, 166, 189, 0.46)";
        card.style.background = active
          ? "linear-gradient(180deg, rgba(61, 117, 161, 0.94), rgba(22, 50, 73, 0.97))"
          : "linear-gradient(180deg, rgba(21, 36, 48, 0.88), rgba(14, 24, 33, 0.92))";
        card.style.boxShadow = active
          ? "0 0 0 1px rgba(170, 218, 250, 0.36), 0 10px 20px rgba(9, 18, 25, 0.45)"
          : "0 4px 10px rgba(0, 0, 0, 0.32), inset 0 1px 0 rgba(255, 255, 255, 0.08)";
      }

      if (selectedPropId && savedPropDefinitionsById.has(selectedPropId)) {
        const selected = savedPropDefinitionsById.get(selectedPropId);
        const profile = getPropPhysicsProfile(selectedPropId);
        const validationIssueCount = getPropAssetValidationIssueCount(selectedPropId);
        const mobilityLabel =
          profile.mobility === "fixed" ? "support physics" : "loose physics";
        propSelectionLabel.textContent = selected
          ? `Selected: ${selected.description} • ${mobilityLabel}${validationIssueCount > 0 ? ` • meta warn:${validationIssueCount}` : ""}`
          : `Selected: ${selectedPropId}`;
      } else {
        propSelectionLabel.textContent = "No prop selected.";
      }
    }

    propSearchInput.addEventListener("input", () => {
      propSearchQuery = propSearchInput.value;
      updatePropSelectOptions();
    });

    type PropTemplateNormalization = {
      centerX: number;
      centerZ: number;
      minY: number;
    };

    async function parseGltfBinary(binary: ArrayBuffer): Promise<THREE.Object3D | null> {
      return new Promise<THREE.Object3D | null>((resolve) => {
        gltfLoader.parse(
          binary,
          "",
          (gltf) => {
            const root = gltf.scene;
            if (!root) {
              resolve(null);
              return;
            }
            root.updateMatrixWorld(true);
            resolve(root);
          },
          () => resolve(null)
        );
      });
    }

    function readPropTemplateNormalization(
      template: THREE.Object3D
    ): PropTemplateNormalization | null {
      template.updateMatrixWorld(true);
      propScratchBounds.setFromObject(template);
      if (propScratchBounds.isEmpty()) {
        return null;
      }
      propScratchBounds.getCenter(propScratchCenter);
      return {
        centerX: propScratchCenter.x,
        centerZ: propScratchCenter.z,
        minY: propScratchBounds.min.y
      };
    }

    function applyPropTemplateNormalization(
      template: THREE.Object3D,
      normalization: PropTemplateNormalization
    ): void {
      template.position.x -= normalization.centerX;
      template.position.z -= normalization.centerZ;
      template.position.y -= normalization.minY;
      template.updateMatrixWorld(true);
    }

    function normalizePropTemplate(
      template: THREE.Object3D,
      normalization: PropTemplateNormalization | null = null
    ): PropTemplateNormalization | null {
      const resolved = normalization ?? readPropTemplateNormalization(template);
      if (!resolved) {
        return normalization;
      }
      applyPropTemplateNormalization(template, resolved);
      return resolved;
    }

    function clampDropBodyVelocity(body: RAPIER3D.RigidBody): void {
      const linear = body.linvel();
      const linearSpeed = Math.hypot(linear.x, linear.y, linear.z);
      if (linearSpeed > DROP_PREVIEW_MAX_LINEAR_SPEED && linearSpeed > 0) {
        const scale = DROP_PREVIEW_MAX_LINEAR_SPEED / linearSpeed;
        body.setLinvel(
          {
            x: linear.x * scale,
            y: linear.y * scale,
            z: linear.z * scale
          },
          true
        );
      }

      const angular = body.angvel();
      const angularSpeed = Math.hypot(angular.x, angular.y, angular.z);
      if (angularSpeed > DROP_PREVIEW_MAX_ANGULAR_SPEED && angularSpeed > 0) {
        const scale = DROP_PREVIEW_MAX_ANGULAR_SPEED / angularSpeed;
        body.setAngvel(
          {
            x: angular.x * scale,
            y: angular.y * scale,
            z: angular.z * scale
          },
          true
        );
      }
    }

    function ensurePropTemplate(propId: string): void {
      if (propTemplateById.has(propId)) {
        return;
      }
      if (propTemplateRequestById.has(propId)) {
        return;
      }

      const request = (async () => {
        const binary = await loadSavedPropBinary(propId);
        if (!binary) {
          propTemplateById.set(propId, null);
          propConvexVerticesById.delete(propId);
          return;
        }
        const parsed = await parseGltfBinary(binary);
        if (!parsed) {
          propTemplateById.set(propId, null);
          propConvexVerticesById.delete(propId);
          return;
        }
        normalizePropTemplate(parsed);
        propTemplateById.set(propId, parsed);
        propConvexVerticesById.delete(propId);
        propDropRevision += 1;
        ghostDropCacheKey = "";
      })()
        .catch(() => {
          propTemplateById.set(propId, null);
          propConvexVerticesById.delete(propId);
        })
        .finally(() => {
          propTemplateRequestById.delete(propId);
          for (const placement of propPlacements.values()) {
            if (placement.sourcePropId === propId) {
              removeEditorPropPhysicsBody(placement.placementId);
            }
          }
          updatePropSelectOptions();
          rebuildEditorPropMeshes();
          if (gameRuntime) {
            rebuildGamePropMeshes();
          }
          if (selectedPropId === propId && activeBuildCatalog === "prop") {
            refreshPropGhostVisual();
            refreshHoverFromLastPointer();
          }
        });

      propTemplateRequestById.set(propId, request);
    }

    async function refreshSavedProps(): Promise<void> {
      const definitions = await listSavedPropDefinitions();
      savedPropDefinitionsById.clear();
      propAssetValidationIssuesById.clear();
      propConvexVerticesById.clear();
      for (const definition of definitions) {
        savedPropDefinitionsById.set(definition.id, definition);
        const validationIssues = validateSavedPropDefinition(definition);
        if (validationIssues.length > 0) {
          propAssetValidationIssuesById.set(definition.id, validationIssues);
        }
        ensurePropTemplate(definition.id);
      }
      const validationSummary = summarizePropAssetValidation(
        propAssetValidationIssuesById
      );
      if (validationSummary.totalIssues > 0) {
        console.warn(
          `[settlement-builder-ecs] Prop asset validation: ${validationSummary.propsWithIssues} props with issues (${validationSummary.warningCount} warnings, ${validationSummary.errorCount} errors).`
        );
        let logged = 0;
        for (const [propId, issues] of propAssetValidationIssuesById.entries()) {
          if (logged >= 12) {
            break;
          }
          console.warn(
            `[settlement-builder-ecs] ${propId}: ${issues
              .map((issue) => `${issue.severity}:${issue.code}`)
              .join(", ")}`
          );
          logged += 1;
        }
      }
      updatePropSelectOptions();
      statusMessage =
        validationSummary.totalIssues > 0
          ? `Loaded ${definitions.length} saved props (${validationSummary.propsWithIssues} with metadata warnings/errors).`
          : `Loaded ${definitions.length} saved props.`;
      syncHud();
    }

    function createPropPlaceholder(
      dimensions: { width: number; depth: number; height: number }
    ): THREE.Mesh {
      const mesh = new THREE.Mesh(propPlaceholderGeometry, propPlaceholderMaterial);
      mesh.scale.set(dimensions.width, dimensions.height, dimensions.depth);
      mesh.position.y = dimensions.height * 0.5;
      return mesh;
    }

    function computePointerRayDirectionFromTarget(
      target: PropPlacementTarget
    ): THREE.Vector3 | null {
      propPlacementRayDirection.set(
        target.rayDirectionX,
        target.rayDirectionY,
        target.rayDirectionZ
      );
      if (propPlacementRayDirection.lengthSq() <= 0.0000001) {
        return null;
      }
      return propPlacementRayDirection.normalize();
    }

    function supportContainsWorldPoint(
      target: PropPlacementTarget,
      worldX: number,
      worldZ: number
    ): boolean {
      if (target.supportKind === "floor") {
        return worldToCell(worldX, worldZ) !== null;
      }
      if (!target.supportPlacementId) {
        return false;
      }
      const supportPlacement = propPlacements.get(target.supportPlacementId);
      if (!supportPlacement) {
        return false;
      }
      const supportDims = resolvePropDimensions(
        supportPlacement.sourcePropId,
        supportPlacement.rotQuarterTurns
      );
      const supportCenterX = getPropPlacementWorldX(supportPlacement);
      const supportCenterZ = getPropPlacementWorldZ(supportPlacement);
      const halfWidth = supportDims.width * 0.5 + 0.0015;
      const halfDepth = supportDims.depth * 0.5 + 0.0015;
      return (
        Math.abs(worldX - supportCenterX) <= halfWidth &&
        Math.abs(worldZ - supportCenterZ) <= halfDepth
      );
    }

    function placementWouldIntersectExistingProps(
      sourcePropId: string,
      rotQuarterTurns: 0 | 1 | 2 | 3,
      worldX: number,
      worldZ: number,
      elevation: number,
      ignorePlacementId: string | null = null
    ): boolean {
      const targetDims = resolvePropDimensions(sourcePropId, rotQuarterTurns);
      const targetMinX = worldX - targetDims.width * 0.5;
      const targetMaxX = worldX + targetDims.width * 0.5;
      const targetMinY = elevation;
      const targetMaxY = elevation + targetDims.height;
      const targetMinZ = worldZ - targetDims.depth * 0.5;
      const targetMaxZ = worldZ + targetDims.depth * 0.5;
      const epsilon = 0.0015;

      for (const placement of propPlacements.values()) {
        if (ignorePlacementId && placement.placementId === ignorePlacementId) {
          continue;
        }
        const placedDims = resolvePropDimensions(
          placement.sourcePropId,
          placement.rotQuarterTurns
        );
        const placedWorldX = getPropPlacementWorldX(placement);
        const placedWorldZ = getPropPlacementWorldZ(placement);
        const placedMinX = placedWorldX - placedDims.width * 0.5;
        const placedMaxX = placedWorldX + placedDims.width * 0.5;
        const placedMinY = placement.elevation;
        const placedMaxY = placement.elevation + placedDims.height;
        const placedMinZ = placedWorldZ - placedDims.depth * 0.5;
        const placedMaxZ = placedWorldZ + placedDims.depth * 0.5;

        const overlapsX =
          targetMinX < placedMaxX - epsilon && targetMaxX > placedMinX + epsilon;
        if (!overlapsX) {
          continue;
        }
        const overlapsY =
          targetMinY < placedMaxY - epsilon && targetMaxY > placedMinY + epsilon;
        if (!overlapsY) {
          continue;
        }
        const overlapsZ =
          targetMinZ < placedMaxZ - epsilon && targetMaxZ > placedMinZ + epsilon;
        if (!overlapsZ) {
          continue;
        }
        return true;
      }

      return false;
    }

    function slidePlacementTowardCameraUntilClear(options: {
      sourcePropId: string;
      rotQuarterTurns: 0 | 1 | 2 | 3;
      rayDirection: THREE.Vector3;
      worldX: number;
      worldZ: number;
      elevation: number;
      target: PropPlacementTarget;
      ignorePlacementId?: string | null;
    }): DroppedPlacement & { isClear: boolean; slidTowardCamera: boolean } {
      const initialCollision = placementWouldIntersectExistingProps(
        options.sourcePropId,
        options.rotQuarterTurns,
        options.worldX,
        options.worldZ,
        options.elevation,
        options.ignorePlacementId ?? null
      );
      if (!initialCollision) {
        return {
          worldX: options.worldX,
          worldZ: options.worldZ,
          elevation: options.elevation,
          isClear: true,
          slidTowardCamera: false
        };
      }

      propPlacementRayToCameraDirection.set(
        -options.rayDirection.x,
        0,
        -options.rayDirection.z
      );
      if (propPlacementRayToCameraDirection.lengthSq() <= 0.0000001) {
        return {
          worldX: options.worldX,
          worldZ: options.worldZ,
          elevation: options.elevation,
          isClear: false,
          slidTowardCamera: false
        };
      }
      propPlacementRayToCameraDirection.normalize();

      for (
        let distance = PROP_PLACEMENT_SLIDE_STEP;
        distance <= PROP_PLACEMENT_SLIDE_MAX_DISTANCE;
        distance += PROP_PLACEMENT_SLIDE_STEP
      ) {
        const trialWorldX =
          options.worldX + propPlacementRayToCameraDirection.x * distance;
        const trialWorldZ =
          options.worldZ + propPlacementRayToCameraDirection.z * distance;
        const trialElevation = options.elevation;
        if (!supportContainsWorldPoint(options.target, trialWorldX, trialWorldZ)) {
          break;
        }
        if (
          !placementWouldIntersectExistingProps(
            options.sourcePropId,
            options.rotQuarterTurns,
            trialWorldX,
            trialWorldZ,
            trialElevation,
            options.ignorePlacementId ?? null
          )
        ) {
          return {
            worldX: trialWorldX,
            worldZ: trialWorldZ,
            elevation: trialElevation,
            isClear: true,
            slidTowardCamera: true
          };
        }
      }

      return {
        worldX: options.worldX,
        worldZ: options.worldZ,
        elevation: options.elevation,
        isClear: false,
        slidTowardCamera: false
      };
    }

    function resolveGhostPlacementFromTarget(
      sourcePropId: string,
      target: PropPlacementTarget,
      rotQuarterTurns: 0 | 1 | 2 | 3
    ): ResolvedGhostPlacement {
      if (!supportContainsWorldPoint(target, target.worldX, target.worldZ)) {
        return {
          worldX: target.worldX,
          worldZ: target.worldZ,
          elevation: target.supportKind === "prop" ? target.supportY : 0,
          anchorWorldX: target.pointerWorldX,
          anchorWorldY: target.pointerWorldY,
          anchorWorldZ: target.pointerWorldZ,
          landingY: target.supportY,
          isClear: false,
          slidTowardCamera: false
        };
      }

      const rayDirection = computePointerRayDirectionFromTarget(target);
      const ignorePlacementId =
        target.supportKind === "prop" ? target.supportPlacementId : null;
      const basePlacement: DroppedPlacement = {
        worldX: target.worldX,
        worldZ: target.worldZ,
        elevation:
          target.supportKind === "prop"
            ? Math.max(0, target.supportY + PROP_SURFACE_CLEARANCE)
            : 0
      };
      const allowSlide =
        target.supportKind === "prop" || !propPlacementSnapToGrid;
      const resolved = rayDirection
        ? !allowSlide
          ? {
              worldX: basePlacement.worldX,
              worldZ: basePlacement.worldZ,
              elevation: basePlacement.elevation,
              isClear: !placementWouldIntersectExistingProps(
                sourcePropId,
                rotQuarterTurns,
                basePlacement.worldX,
                basePlacement.worldZ,
                basePlacement.elevation,
                ignorePlacementId
              ),
              slidTowardCamera: false
            }
          : slidePlacementTowardCameraUntilClear({
              sourcePropId,
              rotQuarterTurns,
              rayDirection,
              worldX: basePlacement.worldX,
              worldZ: basePlacement.worldZ,
              elevation: basePlacement.elevation,
              target,
              ignorePlacementId
            })
        : {
            worldX: basePlacement.worldX,
            worldZ: basePlacement.worldZ,
            elevation: basePlacement.elevation,
            isClear: !placementWouldIntersectExistingProps(
              sourcePropId,
              rotQuarterTurns,
              basePlacement.worldX,
              basePlacement.worldZ,
              basePlacement.elevation,
              ignorePlacementId
            ),
            slidTowardCamera: false
          };

      return {
        worldX: resolved.worldX,
        worldZ: resolved.worldZ,
        elevation: resolved.elevation,
        anchorWorldX: target.pointerWorldX,
        anchorWorldY: target.pointerWorldY,
        anchorWorldZ: target.pointerWorldZ,
        landingY: target.supportY,
        isClear: resolved.isClear,
        slidTowardCamera: resolved.slidTowardCamera
      };
    }

    function applyPlacementWorldPose(
      placement: SettlementPropPlacement,
      worldX: number,
      worldZ: number,
      elevation: number
    ): void {
      const cell = worldToCell(worldX, worldZ);
      if (cell) {
        placement.cellX = cell.x;
        placement.cellY = cell.y;
      }
      placement.offsetX = worldX - toWorldX(placement.cellX);
      placement.offsetZ = worldZ - toWorldZ(placement.cellY);
      placement.elevation = Math.max(0, elevation);
    }

    function propPhysicsProfileEquals(
      a: SettlementPropPhysicsProfile,
      b: SettlementPropPhysicsProfile
    ): boolean {
      return (
        a.mobility === b.mobility &&
        Math.abs(a.mass - b.mass) <= 0.00001 &&
        Math.abs(a.friction - b.friction) <= 0.00001 &&
        Math.abs(a.restitution - b.restitution) <= 0.00001 &&
        Math.abs(a.linearDamping - b.linearDamping) <= 0.00001 &&
        Math.abs(a.angularDamping - b.angularDamping) <= 0.00001 &&
        a.activationDelayMs === b.activationDelayMs
      );
    }

    function updatePlacementRuntimeStateFromBody(
      placement: SettlementPropPlacement,
      body: RAPIER3D.RigidBody,
      rotation: { x: number; y: number; z: number; w: number },
      sleeping: boolean
    ): void {
      const linearVelocity = body.linvel();
      const angularVelocity = body.angvel();
      placement.runtimeState = {
        rotation: {
          x: rotation.x,
          y: rotation.y,
          z: rotation.z,
          w: rotation.w
        },
        linearVelocity: {
          x: linearVelocity.x,
          y: linearVelocity.y,
          z: linearVelocity.z
        },
        angularVelocity: {
          x: angularVelocity.x,
          y: angularVelocity.y,
          z: angularVelocity.z
        },
        sleeping
      };
    }

    function configureDynamicDropBody(
      body: RAPIER3D.RigidBody,
      usesComplexCollider: boolean,
      profile: SettlementPropPhysicsProfile
    ): void {
      body.setAdditionalSolverIterations(usesComplexCollider ? 2 : 0);
      body.setLinearDamping(profile.linearDamping);
      body.setAngularDamping(profile.angularDamping);
      body.enableCcd(true);
    }

    function disposeEditorPropPhysics(): void {
      editorPropPhysicsByPlacementId.clear();
      pendingEditorPropActivationAtMsByPlacementId.clear();
      if (!editorPropPhysicsWorld) {
        return;
      }
      editorPropPhysicsWorld.free();
      editorPropPhysicsWorld = null;
    }

    function ensureEditorPropPhysicsWorld(): RAPIER3D.World {
      if (editorPropPhysicsWorld) {
        return editorPropPhysicsWorld;
      }

      const world = new RAPIER3D.World({ x: 0, y: -9.81, z: 0 });
      world.integrationParameters.dt = 1 / 60;
      world.integrationParameters.maxCcdSubsteps = 4;
      world.integrationParameters.numSolverIterations = 8;
      world.integrationParameters.numInternalPgsIterations = 2;
      world.integrationParameters.normalizedAllowedLinearError = 0.0005;

      const floorHalfSpan = GRID_TILES * TILE_SIZE * 0.5 + TILE_SIZE;
      const floorBody = world.createRigidBody(
        RAPIER3D.RigidBodyDesc.fixed().setTranslation(0, -0.05, 0)
      );
      world.createCollider(
        RAPIER3D.ColliderDesc.cuboid(floorHalfSpan, 0.05, floorHalfSpan)
          .setFriction(0.92)
          .setRestitution(0)
          .setCollisionGroups(
            collisionGroups(PHYSICS_LAYER.WORLD_STATIC, PHYSICS_MASK.WORLD_STATIC)
          ),
        floorBody
      );

      editorPropPhysicsWorld = world;
      return world;
    }

    function removeEditorPropPhysicsBody(placementId: string): void {
      const state = editorPropPhysicsByPlacementId.get(placementId);
      if (!state) {
        pendingEditorPropActivationAtMsByPlacementId.delete(placementId);
        return;
      }
      const world = ensureEditorPropPhysicsWorld();
      world.removeRigidBody(state.body);
      editorPropPhysicsByPlacementId.delete(placementId);
      pendingEditorPropActivationAtMsByPlacementId.delete(placementId);
    }

    function noteEditorPropRebuild(reason: EditorPropRebuildReason): void {
      editorPropRebuildCounts.set(
        reason,
        (editorPropRebuildCounts.get(reason) ?? 0) + 1
      );
    }

    function createEditorPropPhysicsBody(
      placement: SettlementPropPlacement,
      activationTimeMs: number,
      nowMs: number
    ): EditorPropPhysicsBody | null {
      if (!propDropEnabled) {
        return null;
      }

      const world = ensureEditorPropPhysicsWorld();
      const worldX = getPropPlacementWorldX(placement);
      const worldZ = getPropPlacementWorldZ(placement);
      const rotation = resolvePlacementRuntimeRotation(placement);
      const profile = getPropPhysicsProfile(placement.sourcePropId);
      const dimensions = resolvePropDimensions(
        placement.sourcePropId,
        placement.rotQuarterTurns
      );
      const halfWidth = dimensions.width * 0.5;
      const halfDepth = dimensions.depth * 0.5;
      const halfHeight = dimensions.height * 0.5;
      const colliderResolution = resolvePropColliderResolution({
        sourcePropId: placement.sourcePropId,
        definition: getSavedPropDefinition(placement.sourcePropId),
        explicitMode: propColliderModes.get(placement.sourcePropId),
        dimensions,
        convexVerticesByPropId: propConvexVerticesById
      });
      const propCollisionGroups =
        profile.mobility === "fixed"
          ? collisionGroups(PHYSICS_LAYER.PROP_SUPPORT, PHYSICS_MASK.PROP_SUPPORT)
          : collisionGroups(PHYSICS_LAYER.PROP_LOOSE, PHYSICS_MASK.PROP_LOOSE);

      let usesComplexCollider = colliderResolution.usesComplexCollider;
      const shouldBeDynamic = profile.mobility === "dynamic";
      let localRootOffset = colliderResolution.localRootOffset;
      const bodyStart = bodyTranslationFromRootPose(
        worldX,
        placement.elevation,
        worldZ,
        localRootOffset,
        rotation
      );
      const shouldActivateNow = shouldBeDynamic && activationTimeMs <= nowMs;

      const bodyDesc = shouldActivateNow
        ? RAPIER3D.RigidBodyDesc.dynamic()
            .setTranslation(bodyStart.x, bodyStart.y, bodyStart.z)
            .setRotation(rotation)
            .setAdditionalSolverIterations(usesComplexCollider ? 2 : 0)
        : RAPIER3D.RigidBodyDesc.fixed()
            .setTranslation(bodyStart.x, bodyStart.y, bodyStart.z)
            .setRotation(rotation);

      const body = world.createRigidBody(bodyDesc);
      let colliderCreated = false;
      switch (colliderResolution.shape) {
        case "compound-boxes": {
          const partCount = Math.max(1, colliderResolution.parts.length);
          const partMass = profile.mass / partCount;
          for (const part of colliderResolution.parts) {
            world.createCollider(
              RAPIER3D.ColliderDesc.cuboid(
                part.halfExtents.x,
                part.halfExtents.y,
                part.halfExtents.z
              )
                .setTranslation(
                  part.translation.x,
                  part.translation.y,
                  part.translation.z
                )
                .setFriction(profile.friction)
                .setRestitution(profile.restitution)
                .setMass(partMass)
                .setCollisionGroups(propCollisionGroups),
              body
            );
          }
          colliderCreated = true;
          break;
        }
        case "convex-hull": {
          try {
            const hullDesc = RAPIER3D.ColliderDesc.convexHull(colliderResolution.vertices);
            if (hullDesc) {
              world.createCollider(
                hullDesc
                  .setFriction(profile.friction)
                  .setRestitution(profile.restitution)
                  .setMass(profile.mass)
                  .setCollisionGroups(propCollisionGroups),
                body
              );
              colliderCreated = true;
            }
          } catch {
            colliderCreated = false;
          }
          break;
        }
        case "box": {
          world.createCollider(
            RAPIER3D.ColliderDesc.cuboid(
              colliderResolution.halfExtents.x,
              colliderResolution.halfExtents.y,
              colliderResolution.halfExtents.z
            )
              .setFriction(profile.friction)
              .setRestitution(profile.restitution)
              .setMass(profile.mass)
              .setCollisionGroups(propCollisionGroups),
            body
          );
          colliderCreated = true;
          break;
        }
        default:
          assertNever(colliderResolution, "prop collider resolution");
      }

      if (!colliderCreated) {
        usesComplexCollider = false;
        localRootOffset = { x: 0, y: -halfHeight, z: 0 };
        const fallbackStart = bodyTranslationFromRootPose(
          worldX,
          placement.elevation,
          worldZ,
          localRootOffset,
          rotation
        );
        body.setTranslation(fallbackStart, true);
        world.createCollider(
          RAPIER3D.ColliderDesc.cuboid(halfWidth, halfHeight, halfDepth)
            .setFriction(profile.friction)
            .setRestitution(profile.restitution)
            .setMass(profile.mass)
            .setCollisionGroups(propCollisionGroups),
          body
        );
      }

      if (shouldActivateNow) {
        configureDynamicDropBody(body, usesComplexCollider, profile);
        if (placement.runtimeState) {
          body.setLinvel(placement.runtimeState.linearVelocity, true);
          body.setAngvel(placement.runtimeState.angularVelocity, true);
          if (placement.runtimeState.sleeping) {
            body.sleep();
          } else {
            body.wakeUp();
          }
        } else {
          body.setLinvel({ x: 0, y: 0, z: 0 }, true);
          body.setAngvel({ x: 0, y: 0, z: 0 }, true);
        }
      } else {
        body.setLinvel({ x: 0, y: 0, z: 0 }, true);
        body.setAngvel({ x: 0, y: 0, z: 0 }, true);
      }

      return {
        placementId: placement.placementId,
        sourcePropId: placement.sourcePropId,
        rotQuarterTurns: placement.rotQuarterTurns,
        colliderMode: colliderResolution.mode,
        profile: clonePropPhysicsProfile(profile),
        body,
        localRootOffset,
        usesComplexCollider,
        activationTimeMs,
        active: shouldActivateNow
      };
    }

    function queueEditorPropDropActivation(placementId: string): void {
      if (!propDropEnabled) {
        return;
      }
      const placement = propPlacements.get(placementId);
      if (!placement) {
        return;
      }
      const profile = getPropPhysicsProfile(placement.sourcePropId);
      if (profile.mobility !== "dynamic") {
        pendingEditorPropActivationAtMsByPlacementId.delete(placementId);
        return;
      }
      const rotation = resolvePlacementRuntimeRotation(placement);
      placement.runtimeState = {
        rotation: {
          x: rotation.x,
          y: rotation.y,
          z: rotation.z,
          w: rotation.w
        },
        linearVelocity: { x: 0, y: 0, z: 0 },
        angularVelocity: { x: 0, y: 0, z: 0 },
        sleeping: false
      };

      const activationTimeMs = performance.now() + Math.max(1, profile.activationDelayMs);
      pendingEditorPropActivationAtMsByPlacementId.set(placementId, activationTimeMs);
      const state = editorPropPhysicsByPlacementId.get(placementId);
      if (!state) {
        return;
      }
      state.profile = clonePropPhysicsProfile(profile);
      state.activationTimeMs = activationTimeMs;
      state.active = false;
      state.body.setBodyType(RAPIER3D.RigidBodyType.Fixed, true);
      state.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
      state.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
    }

    function syncEditorPropPhysicsBodies(nowMs: number): void {
      if (!propDropEnabled) {
        return;
      }

      for (const [placementId, state] of editorPropPhysicsByPlacementId.entries()) {
        const placement = propPlacements.get(placementId);
        if (!placement) {
          noteEditorPropRebuild("missing-placement");
          removeEditorPropPhysicsBody(placementId);
          continue;
        }
        const desiredProfile = getPropPhysicsProfile(placement.sourcePropId);
        const desiredColliderMode = getPropColliderMode(placement.sourcePropId);
        const rebuildReason =
          state.sourcePropId !== placement.sourcePropId
            ? "source-changed"
            : state.rotQuarterTurns !== placement.rotQuarterTurns
              ? "rotation-changed"
              : state.colliderMode !== desiredColliderMode
                ? "collider-mode-changed"
                : !propPhysicsProfileEquals(state.profile, desiredProfile)
                  ? "profile-changed"
                  : null;
        if (rebuildReason !== null) {
          noteEditorPropRebuild(rebuildReason);
          removeEditorPropPhysicsBody(placementId);
          continue;
        }

        if (state.active) {
          continue;
        }

        const desiredRotation = resolvePlacementRuntimeRotation(placement);
        const currentTranslation = state.body.translation();
        const currentRotation = state.body.rotation();
        const currentRootPose = rootPoseFromBodyPose(
          currentTranslation,
          state.localRootOffset,
          currentRotation
        );
        const desiredWorldX = getPropPlacementWorldX(placement);
        const desiredWorldZ = getPropPlacementWorldZ(placement);
        const desiredWorldY = placement.elevation;
        const rotationDiff = quaternionDelta(desiredRotation, currentRotation);
        if (
          Math.hypot(
            currentRootPose.worldX - desiredWorldX,
            currentRootPose.worldZ - desiredWorldZ
          ) > 0.006 ||
          Math.abs(currentRootPose.worldY - desiredWorldY) > 0.006 ||
          rotationDiff > 0.003
        ) {
          const desiredBodyPose = bodyTranslationFromRootPose(
            desiredWorldX,
            desiredWorldY,
            desiredWorldZ,
            state.localRootOffset,
            desiredRotation
          );
          state.body.setTranslation(desiredBodyPose, true);
          state.body.setRotation(desiredRotation, true);
          state.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
          state.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
        }
      }

      for (const placement of propPlacements.values()) {
        if (editorPropPhysicsByPlacementId.has(placement.placementId)) {
          continue;
        }
        const activationTimeMs =
          pendingEditorPropActivationAtMsByPlacementId.get(placement.placementId) ??
          nowMs;
        const state = createEditorPropPhysicsBody(placement, activationTimeMs, nowMs);
        if (!state) {
          continue;
        }
        editorPropPhysicsByPlacementId.set(placement.placementId, state);
        pendingEditorPropActivationAtMsByPlacementId.delete(placement.placementId);
      }
    }

    function stepEditorPropPhysics(nowMs: number): void {
      if (mode !== "EDITOR" || !propDropEnabled) {
        return;
      }

      syncEditorPropPhysicsBodies(nowMs);
      if (!editorPropPhysicsWorld || editorPropPhysicsByPlacementId.size === 0) {
        return;
      }

      for (const state of editorPropPhysicsByPlacementId.values()) {
        if (
          state.profile.mobility !== "dynamic" ||
          state.active ||
          nowMs < state.activationTimeMs
        ) {
          continue;
        }

        const placement = propPlacements.get(state.placementId);
        state.body.setBodyType(RAPIER3D.RigidBodyType.Dynamic, true);
        configureDynamicDropBody(state.body, state.usesComplexCollider, state.profile);
        if (placement?.runtimeState) {
          state.body.setLinvel(placement.runtimeState.linearVelocity, true);
          state.body.setAngvel(placement.runtimeState.angularVelocity, true);
          if (placement.runtimeState.sleeping) {
            state.body.sleep();
          } else {
            state.body.wakeUp();
          }
        } else {
          state.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
          state.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
        }
        state.active = true;
      }

      editorPropPhysicsWorld.step();

      let movedAny = false;
      for (const [placementId, state] of editorPropPhysicsByPlacementId.entries()) {
        const placement = propPlacements.get(placementId);
        if (!placement) {
          continue;
        }
        if (state.active) {
          clampDropBodyVelocity(state.body);
        }

        const translation = state.body.translation();
        const rotation = state.body.rotation();
        const rootPose = rootPoseFromBodyPose(
          translation,
          state.localRootOffset,
          rotation
        );
        const nextElevation = Math.max(0, rootPose.worldY);
        const previousWorldX = getPropPlacementWorldX(placement);
        const previousWorldZ = getPropPlacementWorldZ(placement);
        const previousElevation = placement.elevation;
        const previousRotation =
          propRuntimeRotationByPlacementId.get(placement.placementId) ??
          yawQuaternionForQuarterTurns(placement.rotQuarterTurns);
        const previousSleeping = placement.runtimeState?.sleeping;

        applyPlacementWorldPose(
          placement,
          rootPose.worldX,
          rootPose.worldZ,
          nextElevation
        );
        propRuntimeRotationByPlacementId.set(placementId, {
          x: rotation.x,
          y: rotation.y,
          z: rotation.z,
          w: rotation.w
        });

        const root = editorPropRootByPlacementId.get(placementId);
        if (root) {
          root.position.set(rootPose.worldX, nextElevation, rootPose.worldZ);
          root.quaternion.set(rotation.x, rotation.y, rotation.z, rotation.w);
        }

        updatePlacementRuntimeStateFromBody(
          placement,
          state.body,
          rotation,
          state.profile.mobility === "fixed" ? true : state.body.isSleeping()
        );

        if (
          Math.hypot(rootPose.worldX - previousWorldX, rootPose.worldZ - previousWorldZ) >
            0.0008 ||
          Math.abs(nextElevation - previousElevation) > 0.0008 ||
          quaternionDelta(previousRotation, rotation) > 0.0004 ||
          previousSleeping !== placement.runtimeState?.sleeping
        ) {
          movedAny = true;
        }
      }

      if (!movedAny) {
        return;
      }
      ghostDropCacheKey = "";
      if (nowMs - editorPropPhysicsLastHoverRefreshMs > 90) {
        refreshHoverFromLastPointer();
        editorPropPhysicsLastHoverRefreshMs = nowMs;
      }
      if (nowMs - editorPropPhysicsLastAutosaveMs > 700) {
        scheduleEditorAutosave();
        editorPropPhysicsLastAutosaveMs = nowMs;
      }
    }

    function resolvePlacementRuntimeRotation(
      placement: SettlementPropPlacement
    ): { x: number; y: number; z: number; w: number } {
      if (placement.runtimeState) {
        return placement.runtimeState.rotation;
      }
      return (
        propRuntimeRotationByPlacementId.get(placement.placementId) ??
        yawQuaternionForQuarterTurns(placement.rotQuarterTurns)
      );
    }

    function createPropInstance(placement: SettlementPropPlacement): THREE.Object3D {
      const root = new THREE.Group();
      root.position.set(
        getPropPlacementWorldX(placement),
        placement.elevation,
        getPropPlacementWorldZ(placement)
      );
      const runtimeRotation = resolvePlacementRuntimeRotation(placement);
      root.quaternion.set(
        runtimeRotation.x,
        runtimeRotation.y,
        runtimeRotation.z,
        runtimeRotation.w
      );

      const template = propTemplateById.get(placement.sourcePropId);
      if (template) {
        root.add(template.clone(true));
      } else {
        const dimensions = resolvePropDimensions(
          placement.sourcePropId,
          placement.rotQuarterTurns
        );
        root.add(createPropPlaceholder(dimensions));
      }

      return root;
    }

    function rebuildPropMeshes(
      target: THREE.Group,
      rootByPlacementId?: Map<string, THREE.Group>
    ): void {
      clearGroup(target);
      rootByPlacementId?.clear();
      for (const placement of propPlacements.values()) {
        if (!propTemplateById.has(placement.sourcePropId)) {
          ensurePropTemplate(placement.sourcePropId);
        }
        const root = createPropInstance(placement) as THREE.Group;
        rootByPlacementId?.set(placement.placementId, root);
        target.add(root);
      }
      for (const placementId of propRuntimeRotationByPlacementId.keys()) {
        if (!propPlacements.has(placementId)) {
          propRuntimeRotationByPlacementId.delete(placementId);
        }
      }
    }

    function rebuildEditorPropMeshes(): void {
      rebuildPropMeshes(editorPropGroup, editorPropRootByPlacementId);
    }

    function rebuildRuntimePropMeshes(runtime: GameRuntime): void {
      clearGroup(gamePropGroup);
      runtime.propRootByPlacementId.clear();

      for (const [placementId, eid] of runtime.propByPlacementId.entries()) {
        const prop = runtime.props.get(eid);
        if (!prop) {
          continue;
        }

        const placement = propPlacements.get(placementId);
        if (!placement) {
          continue;
        }

        if (!propTemplateById.has(prop.sourcePropId)) {
          ensurePropTemplate(prop.sourcePropId);
        }
        const root = createPropInstance(placement) as THREE.Group;
        runtime.propRootByPlacementId.set(placementId, root);
        gamePropGroup.add(root);
      }
    }

    function rebuildGamePropMeshes(): void {
      if (!gameRuntime) {
        clearGroup(gamePropGroup);
        return;
      }
      rebuildRuntimePropMeshes(gameRuntime);
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
      propGhostRoot.visible = false;
      hidePropPlacementIndicators();
      if (mode !== "EDITOR") {
        hoverMesh.visible = false;
        return;
      }

      if (activeBuildCatalog === "prop" && activeTool === "draw" && selectedPropId) {
        const hasPointerClient =
          Number.isFinite(lastPointerClientX) && Number.isFinite(lastPointerClientY);
        const target = hasPointerClient
          ? resolvePropPlacementTargetFromClient(lastPointerClientX, lastPointerClientY)
          : null;
        if (!target) {
          hoverMesh.visible = false;
          propGhostRoot.visible = false;
          return;
        }

        if (ghostPropTemplateId !== selectedPropId) {
          refreshPropGhostVisual();
        }

        const dropWorldX = target.worldX;
        const dropWorldZ = target.worldZ;
        const cacheKey = `${selectedPropId}:${propRotationQuarterTurns}:${target.supportKind}:${target.supportPlacementId ?? "-"}:${target.cellX},${target.cellY}:${dropWorldX.toFixed(3)},${target.supportY.toFixed(3)},${dropWorldZ.toFixed(3)}:${target.pointerWorldX.toFixed(3)},${target.pointerWorldY.toFixed(3)},${target.pointerWorldZ.toFixed(3)}:${target.rayDirectionX.toFixed(5)},${target.rayDirectionY.toFixed(5)},${target.rayDirectionZ.toFixed(5)}:${propPlacementSnapToGrid ? "snap" : "free"}:${propDropRevision}`;
        if (cacheKey !== ghostDropCacheKey) {
          ghostDropCacheKey = cacheKey;
          const dropped = resolveGhostPlacementFromTarget(
            selectedPropId,
            target,
            propRotationQuarterTurns
          );
          ghostDropElevation = dropped.elevation;
          ghostDropWorldX = dropped.worldX;
          ghostDropWorldZ = dropped.worldZ;
          ghostDropLandingY = dropped.landingY;
          ghostAnchorWorldX = dropped.anchorWorldX;
          ghostAnchorWorldY = dropped.anchorWorldY;
          ghostAnchorWorldZ = dropped.anchorWorldZ;
          ghostDropIsClear = dropped.isClear;
          ghostDropSlidTowardCamera = dropped.slidTowardCamera;
        }

        propGhostRoot.visible = true;
        propGhostRoot.position.set(
          ghostDropWorldX,
          ghostDropElevation,
          ghostDropWorldZ
        );
        propGhostRoot.rotation.y = propRotationQuarterTurns * (Math.PI * 0.5);
        propPlacementAnchorMesh.visible = true;
        propPlacementAnchorMesh.position.set(
          ghostAnchorWorldX,
          ghostAnchorWorldY + PROP_PLACEMENT_MARKER_Y_OFFSET,
          ghostAnchorWorldZ
        );
        propPlacementLandingMesh.visible = true;
        propPlacementLandingMesh.position.set(
          ghostDropWorldX,
          ghostDropLandingY + PROP_PLACEMENT_MARKER_Y_OFFSET,
          ghostDropWorldZ
        );
        const ghostDims = resolvePropDimensions(
          selectedPropId,
          propRotationQuarterTurns
        );
        propPlacementLandingMesh.scale.set(ghostDims.width, ghostDims.depth, 1);
        const depthDelta = Math.abs(ghostDropElevation - ghostDropLandingY);
        if (depthDelta > 0.0008) {
          propPlacementDepthLine.visible = true;
          propPlacementHintLineStart.set(
            ghostDropWorldX,
            ghostDropElevation,
            ghostDropWorldZ
          );
          propPlacementHintLineEnd.set(
            ghostDropWorldX,
            ghostDropLandingY + PROP_PLACEMENT_MARKER_Y_OFFSET,
            ghostDropWorldZ
          );
          propPlacementDepthLineGeometry.setFromPoints([
            propPlacementHintLineStart,
            propPlacementHintLineEnd
          ]);
        } else {
          propPlacementDepthLine.visible = false;
        }

        const offsetDeltaX = ghostDropWorldX - ghostAnchorWorldX;
        const offsetDeltaZ = ghostDropWorldZ - ghostAnchorWorldZ;
        const offsetDistance = Math.hypot(offsetDeltaX, offsetDeltaZ);
        if (offsetDistance > 0.0075) {
          propPlacementOffsetLine.visible = true;
          propPlacementHintLineStart.set(
            ghostAnchorWorldX,
            ghostDropLandingY + PROP_PLACEMENT_MARKER_Y_OFFSET,
            ghostAnchorWorldZ
          );
          propPlacementHintLineEnd.set(
            ghostDropWorldX,
            ghostDropLandingY + PROP_PLACEMENT_MARKER_Y_OFFSET,
            ghostDropWorldZ
          );
          propPlacementOffsetLineGeometry.setFromPoints([
            propPlacementHintLineStart,
            propPlacementHintLineEnd
          ]);
        } else {
          propPlacementOffsetLine.visible = false;
        }
        if (!ghostDropIsClear) {
          propPlacementLandingMaterial.color.setHex(0xff6767);
          propPlacementLandingMaterial.opacity = 0.34;
          propPlacementAnchorMaterial.color.setHex(0xffaaaa);
          propPlacementDepthLineMaterial.color.setHex(0xff8e8e);
          propPlacementOffsetLineMaterial.color.setHex(0xff8e8e);
        } else if (ghostDropSlidTowardCamera) {
          propPlacementLandingMaterial.color.setHex(0xffd88d);
          propPlacementLandingMaterial.opacity = 0.3;
          propPlacementAnchorMaterial.color.setHex(0xfff0c2);
          propPlacementDepthLineMaterial.color.setHex(0xffd6a8);
          propPlacementOffsetLineMaterial.color.setHex(0xffd88d);
        } else {
          propPlacementLandingMaterial.color.setHex(0x6fd0ff);
          propPlacementLandingMaterial.opacity = 0.26;
          propPlacementAnchorMaterial.color.setHex(0xc2eeff);
          propPlacementDepthLineMaterial.color.setHex(0x86d8ff);
          propPlacementOffsetLineMaterial.color.setHex(0x8ed6ff);
        }
        hoverMesh.visible = false;
        return;
      }

      if (!world) {
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
      const structureCatalogActive = isEditorMode && activeCatalogTab === "structures";
      const terrainCatalogActive = isEditorMode && activeCatalogTab === "terrain";
      const propCatalogActive = isEditorMode && activeCatalogTab === "props";

      buildCatalogButtons.forEach((button, tab) => {
        setButtonActive(button, isEditorMode && activeCatalogTab === tab);
      });

      if (brushRowContainer) {
        brushRowContainer.style.display =
          structureCatalogActive || terrainCatalogActive ? "flex" : "none";
      }
      if (rectRowContainer) {
        rectRowContainer.style.display = terrainCatalogActive ? "flex" : "none";
      }
      if (terrainRowContainer) {
        terrainRowContainer.style.display = terrainCatalogActive ? "flex" : "none";
      }
      if (propLibraryRowContainer) {
        propLibraryRowContainer.style.display = propCatalogActive ? "flex" : "none";
      }

      toolButtons.forEach((button, tool) => {
        setButtonActive(button, isEditorMode && activeTool === tool);
      });
      brushButtons.forEach((button, brush) => {
        const inStructureSet = structureBrushes.includes(brush);
        const inTerrainSet = terrainBrushes.includes(brush);
        const visible =
          (structureCatalogActive && inStructureSet) ||
          (terrainCatalogActive && inTerrainSet);
        button.style.display = visible ? "" : "none";
        button.disabled = !isEditorMode || !visible;
        setButtonActive(
          button,
          visible &&
            activeBuildCatalog === "brush" &&
            activeTool === "draw" &&
            editorBrush === brush
        );
      });
      rectToolButtons.forEach((button, rectMode) => {
        button.disabled = !terrainCatalogActive;
        setButtonActive(button, terrainCatalogActive && activeRectTool === rectMode);
      });
      rectOffButton.disabled = !terrainCatalogActive;
      setButtonActive(rectOffButton, terrainCatalogActive && activeRectTool === "none");
      defaultGroundButtons.forEach((button, base) => {
        button.disabled = !terrainCatalogActive;
        setButtonActive(button, terrainCatalogActive && defaultGroundBase === base);
      });
      updateSnapToggleLabel();
      propSearchInput.disabled = !propCatalogActive;
      propRotateButton.disabled = !propCatalogActive || !selectedPropId;
      propRefreshButton.disabled = !propCatalogActive;
      propClearButton.disabled = !propCatalogActive;
      propSnapToggleButton.disabled = !propCatalogActive;
      const hasSelectedProp = selectedPropId !== null;
      const selectedProfile =
        selectedPropId !== null ? getPropPhysicsProfile(selectedPropId) : null;
      const selectedColliderMode =
        selectedPropId !== null ? getPropColliderMode(selectedPropId) : null;
      const availableColliderModes =
        selectedPropId !== null ? getAvailablePropColliderModes(selectedPropId) : [];
      propColliderBoxButton.disabled =
        !propCatalogActive ||
        !hasSelectedProp ||
        !availableColliderModes.includes("box");
      propColliderHullButton.disabled =
        !propCatalogActive ||
        !hasSelectedProp ||
        !availableColliderModes.includes("convex-hull");
      propColliderCompoundButton.disabled =
        !propCatalogActive ||
        !hasSelectedProp ||
        !availableColliderModes.includes("compound-boxes");
      setButtonActive(
        propColliderBoxButton,
        propCatalogActive && selectedColliderMode === "box"
      );
      setButtonActive(
        propColliderHullButton,
        propCatalogActive && selectedColliderMode === "convex-hull"
      );
      setButtonActive(
        propColliderCompoundButton,
        propCatalogActive && selectedColliderMode === "compound-boxes"
      );
      propPhysicsDynamicButton.disabled = !propCatalogActive || !hasSelectedProp;
      propPhysicsFixedButton.disabled = !propCatalogActive || !hasSelectedProp;
      setButtonActive(
        propPhysicsDynamicButton,
        propCatalogActive &&
          selectedProfile !== null &&
          selectedProfile.mobility === "dynamic"
      );
      setButtonActive(
        propPhysicsFixedButton,
        propCatalogActive &&
          selectedProfile !== null &&
          selectedProfile.mobility === "fixed"
      );
      propCardGrid.style.pointerEvents = propCatalogActive ? "auto" : "none";
      propCardGrid.style.opacity = propCatalogActive ? "1" : "0.54";
      propSelectionLabel.style.opacity = propCatalogActive ? "1" : "0.7";
      propRotationBadge.textContent = `Rot ${propRotationQuarterTurns * 90}°`;
      propSnapBadge.textContent = propPlacementSnapToGrid ? "Snap Grid" : "Snap Free";
      propSnapBadge.style.borderColor = propPlacementSnapToGrid
        ? "rgba(162, 202, 231, 0.64)"
        : "rgba(245, 191, 120, 0.68)";
      propSnapBadge.style.color = propPlacementSnapToGrid
        ? "rgba(225, 244, 255, 0.96)"
        : "rgba(255, 230, 197, 0.97)";
      propColliderBadge.textContent = hasSelectedProp
        ? selectedColliderMode === "box"
          ? "Collider Box"
          : selectedColliderMode === "convex-hull"
            ? "Collider Hull"
            : "Collider Compound"
        : "Collider --";
      propColliderBadge.style.borderColor = "rgba(148, 173, 190, 0.5)";
      propColliderBadge.style.color = "rgba(223, 237, 247, 0.96)";
      propPhysicsBadge.textContent =
        selectedProfile === null
          ? "Physics --"
          : selectedProfile.mobility === "fixed"
            ? "Physics Support"
            : "Physics Loose";
      propPhysicsBadge.style.borderColor =
        selectedProfile === null
          ? "rgba(148, 173, 190, 0.5)"
          : selectedProfile.mobility === "fixed"
            ? "rgba(245, 191, 120, 0.68)"
            : "rgba(162, 202, 231, 0.64)";
      propPhysicsBadge.style.color =
        selectedProfile === null
          ? "rgba(223, 237, 247, 0.96)"
          : selectedProfile.mobility === "fixed"
            ? "rgba(255, 230, 197, 0.97)"
            : "rgba(225, 244, 255, 0.96)";

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
        const propMetaIssueProps = propAssetValidationIssuesById.size;
        let propMetaIssueTotal = 0;
        for (const issues of propAssetValidationIssuesById.values()) {
          propMetaIssueTotal += issues.length;
        }
        let editorDynamicBodies = 0;
        let editorDynamicSleeping = 0;
        for (const state of editorPropPhysicsByPlacementId.values()) {
          if (state.profile.mobility !== "dynamic") {
            continue;
          }
          editorDynamicBodies += 1;
          if (state.body.isSleeping()) {
            editorDynamicSleeping += 1;
          }
        }
        const rebuildMissing = editorPropRebuildCounts.get("missing-placement") ?? 0;
        const rebuildSource = editorPropRebuildCounts.get("source-changed") ?? 0;
        const rebuildRotation = editorPropRebuildCounts.get("rotation-changed") ?? 0;
        const rebuildCollider = editorPropRebuildCounts.get("collider-mode-changed") ?? 0;
        const rebuildProfile = editorPropRebuildCounts.get("profile-changed") ?? 0;

        stats.textContent = [
          "Mode: EDITOR",
          `Grid: ${GRID_TILES}x${GRID_TILES}`,
          `Tool: ${activeTool === "draw" ? "Build" : "Scrap"}`,
          `Catalog: ${
            activeBuildCatalog === "prop"
              ? `Prop(${selectedPropId ?? "none"})`
              : `Brush(${editorBrush})`
          }`,
          `Prop Rot: ${propRotationQuarterTurns * 90}°`,
          `Prop Snap: ${propPlacementSnapToGrid ? "ON" : "OFF"}`,
          `Walls/Windows/Doors: ${wallCount}/${windowCount}/${doorCount}`,
          `Props: ${propPlacements.size}`,
          `Prop Meta Issues(props/issues): ${propMetaIssueProps}/${propMetaIssueTotal}`,
          `Editor Phys(Bodies/Dyn/Sleep/Pending): ${editorPropPhysicsByPlacementId.size}/${editorDynamicBodies}/${editorDynamicSleeping}/${pendingEditorPropActivationAtMsByPlacementId.size}`,
          `Rebuilds(M/S/R/C/P): ${rebuildMissing}/${rebuildSource}/${rebuildRotation}/${rebuildCollider}/${rebuildProfile}`,
          `Ground(F/G/R/S/B): ${groundCounts.floor}/${groundCounts.grass}/${groundCounts.road}/${groundCounts.sidewalk}/${groundCounts.building}`,
          `Overrides: ${groundOverrides.size}`,
          `Default: ${defaultGroundBase}`,
          `Rect: ${activeRectTool}`,
          `Seed: ${userSeed}`,
          `Undo/Redo: ${history.canUndo() ? "Y" : "N"}/${history.canRedo() ? "Y" : "N"}`,
          `View: ${viewStep}/4`,
          `Zoom: ${zoomCurrent.toFixed(2)}x`
        ].join("  •  ");
        hints.textContent = editorHintsText;
      } else {
        let openDoors = 0;
        let closedDoors = 0;
        let dynamicProps = 0;
        let sleepingDynamicProps = 0;
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
          for (const [placementId, eid] of gameRuntime.propByPlacementId.entries()) {
            const placement = propPlacements.get(placementId);
            if (!placement) {
              continue;
            }
            const profile = getPropPhysicsProfile(placement.sourcePropId);
            if (profile.mobility !== "dynamic") {
              continue;
            }
            dynamicProps += 1;
            if (gameRuntime.physics.isEntitySleeping(eid)) {
              sleepingDynamicProps += 1;
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
          `Props: ${propPlacements.size}`,
          `Physics(Dyn/Sleep/Substeps): ${dynamicProps}/${sleepingDynamicProps}/${runtimePhysicsLastSubsteps}`,
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

    function nextPropPlacementId(sourcePropId: string, cellX: number, cellY: number): string {
      let index = 1;
      while (true) {
        const candidate = makePropPlacementId(sourcePropId, cellX, cellY, index);
        if (!propPlacements.has(candidate)) {
          return candidate;
        }
        index += 1;
      }
    }

    function applyPropPlacementTool(target: PropPlacementTarget): boolean {
      if (!selectedPropId) {
        return false;
      }
      const collider2d = resolveColliderForProp(
        selectedPropId,
        propRotationQuarterTurns
      );
      const resolvedPlacement = resolveGhostPlacementFromTarget(
        selectedPropId,
        target,
        propRotationQuarterTurns
      );
      if (!resolvedPlacement.isClear) {
        statusMessage = "Blocked: no clear prop placement along the pointer ray.";
        syncHud();
        return false;
      }
      const placementWorldX = resolvedPlacement.worldX;
      const placementWorldZ = resolvedPlacement.worldZ;
      const settledCell = worldToCell(placementWorldX, placementWorldZ);
      const placementCellX = settledCell?.x ?? target.cellX;
      const placementCellY = settledCell?.y ?? target.cellY;
      const placementsAtCell = getPropPlacementsAtCell(placementCellX, placementCellY);
      const elevation = resolvedPlacement.elevation;
      const duplicateDistanceThreshold = propPlacementSnapToGrid ? 0.02 : 0.08;
      const duplicateDistanceSq = duplicateDistanceThreshold * duplicateDistanceThreshold;
      if (
        placementsAtCell.some(
          (placement) => {
            if (
              placement.sourcePropId !== selectedPropId ||
              placement.rotQuarterTurns !== propRotationQuarterTurns ||
              Math.abs(placement.elevation - elevation) >= 0.01
            ) {
              return false;
            }
            const dx = getPropPlacementWorldX(placement) - placementWorldX;
            const dz = getPropPlacementWorldZ(placement) - placementWorldZ;
            return dx * dx + dz * dz <= duplicateDistanceSq;
          }
        )
      ) {
        return false;
      }

      const placementId = nextPropPlacementId(
        selectedPropId,
        placementCellX,
        placementCellY
      );
      const initialRotation = yawQuaternionForQuarterTurns(propRotationQuarterTurns);
      const placementProfile = getPropPhysicsProfile(selectedPropId);
      propPlacements.set(placementId, {
        placementId,
        sourcePropId: selectedPropId,
        cellX: placementCellX,
        cellY: placementCellY,
        offsetX: placementWorldX - toWorldX(placementCellX),
        offsetZ: placementWorldZ - toWorldZ(placementCellY),
        rotQuarterTurns: propRotationQuarterTurns,
        elevation,
        collider2d,
        runtimeState: {
          rotation: {
            x: initialRotation.x,
            y: initialRotation.y,
            z: initialRotation.z,
            w: initialRotation.w
          },
          linearVelocity: { x: 0, y: 0, z: 0 },
          angularVelocity: { x: 0, y: 0, z: 0 },
          sleeping: placementProfile.mobility === "fixed"
        }
      });
      propRuntimeRotationByPlacementId.set(placementId, initialRotation);
      queueEditorPropDropActivation(placementId);
      return true;
    }

    function applyEditorActionAtWorld(world: THREE.Vector3 | null): boolean {
      if (activeTool === "erase") {
        if (!world) {
          return false;
        }
        const cell = worldToCell(world.x, world.z);
        const edge = pickEdgeFromWorld(world);
        if (cell) {
          const existingProp = findTopPropPlacementAtCell(cell.x, cell.y);
          if (existingProp) {
            return propPlacements.delete(existingProp.placementId);
          }
        }
        if (edge) {
          if (structureSegments.delete(edgeKey(edge.ax, edge.ay, edge.bx, edge.by))) {
            return true;
          }
        }
        if (cell) {
          return groundOverrides.delete(cellKey(cell.x, cell.y));
        }
        return false;
      }

      if (activeBuildCatalog === "prop") {
        if (!selectedPropId) {
          return false;
        }
        if (!Number.isFinite(lastPointerClientX) || !Number.isFinite(lastPointerClientY)) {
          return false;
        }
        const target = resolvePropPlacementTargetFromClient(
          lastPointerClientX,
          lastPointerClientY
        );
        if (!target) {
          return false;
        }
        return applyPropPlacementTool(target);
      }

      if (!world) {
        return false;
      }
      const cell = worldToCell(world.x, world.z);
      if (isGroundBrush(editorBrush)) {
        if (!cell) {
          return false;
        }
        return applyGroundTool(cell.x, cell.y, activeTool, editorBrush);
      }

      const edge = pickEdgeFromWorld(world);
      if (!edge || !isStructureBrush(editorBrush)) {
        return false;
      }
      return applyStructureTool(edge, activeTool, editorBrush);
    }

    function applyEditorActionWithHistory(world: THREE.Vector3 | null): void {
      const contextLabel =
        activeTool === "erase"
          ? "Scrapped selection."
          : activeBuildCatalog === "prop" && selectedPropId
            ? `Placed prop ${selectedPropId}.`
            : `Placed ${editorBrush}.`;

      runEditorMutation(contextLabel, () => applyEditorActionAtWorld(world));
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

    function updateHoverFromClient(
      clientX: number,
      clientY: number
    ): THREE.Vector3 | null {
      lastPointerClientX = clientX;
      lastPointerClientY = clientY;
      const world = worldAtClient(clientX, clientY);
      updateHover(world);
      return world;
    }

    function refreshHoverFromLastPointer(): void {
      if (!Number.isFinite(lastPointerClientX) || !Number.isFinite(lastPointerClientY)) {
        return;
      }
      updateHover(worldAtClient(lastPointerClientX, lastPointerClientY));
    }

    function syncPlayerMeshPosition(transform: { x: number; y: number }): void {
      snappedPlayerWorld.set(
        toWorldCoordX(transform.x),
        0,
        toWorldCoordZ(transform.y)
      );
      if (view.snapWorldPointOnGround(snappedPlayerWorld, snappedPlayerWorld)) {
        playerMesh.position.copy(snappedPlayerWorld);
        return;
      }
      playerMesh.position.set(
        toWorldCoordX(transform.x),
        0,
        toWorldCoordZ(transform.y)
      );
    }

    function disposeGameRuntime(): void {
      if (!gameRuntime) {
        return;
      }

      gameRuntime.keyboard.dispose(window);
      gameRuntime.physics.dispose();
      gameRuntime = null;
      runtimePhysicsLastSubsteps = 0;
      clearGroup(gameDoorGroup);
      clearGroup(gamePropGroup);
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
          id: "settlement-builder-ecs-level",
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
      console.log("[settlement-builder-ecs] baked preview", baked);
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

    function createRuntimeSolidColliders(
      physics: Physics3dResource,
      baked: ReturnType<typeof createBakePayload>
    ): void {
      const floorHalfSpan = GRID_TILES * TILE_SIZE * 0.5 + TILE_SIZE;
      physics.createStaticCuboidCollider({
        translation: { x: 0, y: -GAME_PHYSICS_FLOOR_HALF_HEIGHT, z: 0 },
        halfExtents: {
          x: floorHalfSpan,
          y: GAME_PHYSICS_FLOOR_HALF_HEIGHT,
          z: floorHalfSpan
        },
        friction: 0.94,
        restitution: 0,
        collisionGroups: collisionGroups(
          PHYSICS_LAYER.WORLD_STATIC,
          PHYSICS_MASK.WORLD_STATIC
        )
      });

      const colliderHalfHeight = GAME_PHYSICS_COLLIDER_HEIGHT * 0.5;
      for (const collider of baked.colliderDescs) {
        if (collider.kind !== "rect") {
          continue;
        }
        physics.createStaticCuboidCollider({
          translation: {
            x: toWorldCoordX(collider.x),
            y: colliderHalfHeight,
            z: toWorldCoordZ(collider.y)
          },
          halfExtents: {
            x: toWorldDistance(collider.w) * 0.5,
            y: colliderHalfHeight,
            z: toWorldDistance(collider.h) * 0.5
          },
          friction: 0.9,
          restitution: 0,
          collisionGroups: collisionGroups(
            PHYSICS_LAYER.WORLD_STATIC,
            PHYSICS_MASK.WORLD_STATIC
          )
        });
      }
    }

    function createRuntimePropPhysicsBody(options: {
      physics: Physics3dResource;
      physicsBodies: DataStore<Physics3dBodyRef>;
      physicsColliders: DataStore<Physics3dColliderRef>;
      eid: EID;
      placement: SettlementPropPlacement;
      runtimeRotation: { x: number; y: number; z: number; w: number };
      profile: SettlementPropPhysicsProfile;
      propCollisionGroups: number;
    }): { localRootOffset: { x: number; y: number; z: number } } {
      const placement = options.placement;
      const worldX = getPropPlacementWorldX(placement);
      const worldZ = getPropPlacementWorldZ(placement);
      const runtimeRotation = options.runtimeRotation;
      const profile = options.profile;
      const physics = options.physics;
      const physicsBodies = options.physicsBodies;
      const physicsColliders = options.physicsColliders;
      const eid = options.eid;
      const propCollisionGroups = options.propCollisionGroups;

      const dimensions = resolvePropDimensions(
        placement.sourcePropId,
        placement.rotQuarterTurns
      );
      const halfHeight = dimensions.height * 0.5;
      const fallbackHalfExtents = {
        x: dimensions.width * 0.5,
        y: halfHeight,
        z: dimensions.depth * 0.5
      };
      const colliderResolution = resolvePropColliderResolution({
        sourcePropId: placement.sourcePropId,
        definition: getSavedPropDefinition(placement.sourcePropId),
        explicitMode: propColliderModes.get(placement.sourcePropId),
        dimensions,
        convexVerticesByPropId: propConvexVerticesById
      });
      let localRootOffset = colliderResolution.localRootOffset;
      const bodyTranslation = bodyTranslationFromRootPose(
        worldX,
        placement.elevation,
        worldZ,
        localRootOffset,
        runtimeRotation
      );

      let createdBody = false;
      switch (colliderResolution.shape) {
        case "compound-boxes": {
          const created =
            profile.mobility === "dynamic"
              ? physics.createDynamicCompoundCuboidEntity(eid, {
                  translation: bodyTranslation,
                  rotation: runtimeRotation,
                  parts: colliderResolution.parts,
                  mass: profile.mass,
                  friction: profile.friction,
                  restitution: profile.restitution,
                  linearDamping: profile.linearDamping,
                  angularDamping: profile.angularDamping,
                  ccd: true,
                  collisionGroups: propCollisionGroups
                })
              : physics.createFixedCompoundCuboidEntity(eid, {
                  translation: bodyTranslation,
                  rotation: runtimeRotation,
                  parts: colliderResolution.parts,
                  friction: profile.friction,
                  restitution: profile.restitution,
                  collisionGroups: propCollisionGroups
                });
          physicsBodies.add(eid, { bodyHandle: created.bodyHandle });
          physicsColliders.add(eid, {
            colliderHandle: created.colliderHandle
          });
          createdBody = true;
          break;
        }
        case "convex-hull": {
          const created =
            profile.mobility === "dynamic"
              ? physics.createDynamicConvexHullEntity(eid, {
                  translation: bodyTranslation,
                  rotation: runtimeRotation,
                  vertices: colliderResolution.vertices,
                  mass: profile.mass,
                  friction: profile.friction,
                  restitution: profile.restitution,
                  linearDamping: profile.linearDamping,
                  angularDamping: profile.angularDamping,
                  ccd: true,
                  collisionGroups: propCollisionGroups
                })
              : physics.createFixedConvexHullEntity(eid, {
                  translation: bodyTranslation,
                  rotation: runtimeRotation,
                  vertices: colliderResolution.vertices,
                  friction: profile.friction,
                  restitution: profile.restitution,
                  collisionGroups: propCollisionGroups
                });
          if (created) {
            physicsBodies.add(eid, { bodyHandle: created.bodyHandle });
            physicsColliders.add(eid, {
              colliderHandle: created.colliderHandle
            });
            createdBody = true;
          }
          break;
        }
        case "box": {
          const created =
            profile.mobility === "dynamic"
              ? physics.createDynamicCuboidEntity(eid, {
                  translation: bodyTranslation,
                  rotation: runtimeRotation,
                  halfExtents: colliderResolution.halfExtents,
                  mass: profile.mass,
                  friction: profile.friction,
                  restitution: profile.restitution,
                  linearDamping: profile.linearDamping,
                  angularDamping: profile.angularDamping,
                  ccd: true,
                  collisionGroups: propCollisionGroups
                })
              : physics.createFixedCuboidEntity(eid, {
                  translation: bodyTranslation,
                  rotation: runtimeRotation,
                  halfExtents: colliderResolution.halfExtents,
                  friction: profile.friction,
                  restitution: profile.restitution,
                  collisionGroups: propCollisionGroups
                });
          physicsBodies.add(eid, { bodyHandle: created.bodyHandle });
          physicsColliders.add(eid, {
            colliderHandle: created.colliderHandle
          });
          createdBody = true;
          break;
        }
        default:
          assertNever(colliderResolution, "prop collider resolution");
      }

      if (!createdBody) {
        localRootOffset = { x: 0, y: -halfHeight, z: 0 };
        const fallbackBodyTranslation = bodyTranslationFromRootPose(
          worldX,
          placement.elevation,
          worldZ,
          localRootOffset,
          runtimeRotation
        );
        const created =
          profile.mobility === "dynamic"
            ? physics.createDynamicCuboidEntity(eid, {
                translation: fallbackBodyTranslation,
                rotation: runtimeRotation,
                halfExtents: fallbackHalfExtents,
                mass: profile.mass,
                friction: profile.friction,
                restitution: profile.restitution,
                linearDamping: profile.linearDamping,
                angularDamping: profile.angularDamping,
                ccd: true,
                collisionGroups: propCollisionGroups
              })
            : physics.createFixedCuboidEntity(eid, {
                translation: fallbackBodyTranslation,
                rotation: runtimeRotation,
                halfExtents: fallbackHalfExtents,
                friction: profile.friction,
                restitution: profile.restitution,
                collisionGroups: propCollisionGroups
              });
        physicsBodies.add(eid, { bodyHandle: created.bodyHandle });
        physicsColliders.add(eid, {
          colliderHandle: created.colliderHandle
        });
      }

      if (profile.mobility === "dynamic" && placement.runtimeState) {
        physics.setEntityLinearVelocity(eid, placement.runtimeState.linearVelocity, true);
        physics.setEntityAngularVelocity(eid, placement.runtimeState.angularVelocity, true);
        if (placement.runtimeState.sleeping) {
          physics.sleepEntity(eid);
        } else {
          physics.wakeEntity(eid);
        }
      }

      return { localRootOffset };
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
      const physics = createPhysics3dResource({
        gravity: { x: 0, y: -9.81, z: 0 },
        fixedDt: 1 / 60,
        maxSubsteps: 10,
        characterOffset: 0.02
      });
      const physicsBodies = new DataStore<Physics3dBodyRef>();
      const physicsColliders = new DataStore<Physics3dColliderRef>();
      createRuntimeSolidColliders(physics, baked);

      const doorColliderDescriptors = doorColliderMap(baked.colliderDescs);
      const doorColliderByPlacementId = new Map<string, number>();

      const playerEid = world.createEntity();
      const playerStart = options?.player ?? PLAYER_SPAWN;
      world.transforms.add(playerEid, { x: playerStart.x, y: playerStart.y });
      world.velocities.add(playerEid, { vx: 0, vy: 0 });
      world.playerTags.add(playerEid, true);
      world.persistents.add(playerEid, { kind: "player" });
      const playerBody = physics.ensureKinematicCharacterCapsule(
        playerEid,
        {
          x: toWorldCoordX(playerStart.x),
          y: GAME_PHYSICS_PLAYER_CENTER_Y,
          z: toWorldCoordZ(playerStart.y)
        },
        {
          radius: GAME_PHYSICS_PLAYER_RADIUS,
          halfHeight: GAME_PHYSICS_PLAYER_HALF_HEIGHT
        },
        {
          collisionGroups: collisionGroups(PHYSICS_LAYER.PLAYER, PHYSICS_MASK.PLAYER),
          friction: 0.5
        }
      );
      physicsBodies.add(playerEid, { bodyHandle: playerBody.bodyHandle });
      physicsColliders.add(playerEid, { colliderHandle: playerBody.colliderHandle });

      const doors = new DataStore<DoorComponent>();
      const doorByPlacementId = new Map<string, EID>();
      const placementIdByEdge = new Map<string, string>();
      const doorVisuals = new Map<string, EditorDoorVisual>();
      const props = new DataStore<PropComponent>();
      const propByPlacementId = new Map<string, EID>();
      const propRootByPlacementId = new Map<string, THREE.Group>();
      const interactionQueue: string[] = [];
      const doorColliderHalfHeight = GAME_PHYSICS_COLLIDER_HEIGHT * 0.5;

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

        const doorCollider = doorColliderDescriptors.get(placementId);
        if (doorCollider) {
          const created = physics.createFixedCuboidEntity(eid, {
            translation: {
              x: toWorldCoordX(doorCollider.x),
              y: doorColliderHalfHeight,
              z: toWorldCoordZ(doorCollider.y)
            },
            halfExtents: {
              x: toWorldDistance(doorCollider.w) * 0.5,
              y: doorColliderHalfHeight,
              z: toWorldDistance(doorCollider.h) * 0.5
            },
            friction: 0.9,
            restitution: 0,
            collisionGroups: collisionGroups(
              PHYSICS_LAYER.STRUCTURE_DOOR,
              PHYSICS_MASK.STRUCTURE_DOOR
            )
          });
          physicsBodies.add(eid, { bodyHandle: created.bodyHandle });
          physicsColliders.add(eid, {
            colliderHandle: created.colliderHandle
          });
          doorColliderByPlacementId.set(placementId, created.colliderHandle);
        }
      }

      for (const placement of propPlacements.values()) {
        const eid = world.createEntity();
        const worldX = getPropPlacementWorldX(placement);
        const worldZ = getPropPlacementWorldZ(placement);
        const runtimeRotation = resolvePlacementRuntimeRotation(placement);
        let localRootOffset = { x: 0, y: 0, z: 0 };
        const profile = getPropPhysicsProfile(placement.sourcePropId);
        const propCollisionGroups =
          profile.mobility === "fixed"
            ? collisionGroups(PHYSICS_LAYER.PROP_SUPPORT, PHYSICS_MASK.PROP_SUPPORT)
            : collisionGroups(PHYSICS_LAYER.PROP_LOOSE, PHYSICS_MASK.PROP_LOOSE);

        world.transforms.add(eid, {
          x: toGameplayCoordX(worldX),
          y: toGameplayCoordY(worldZ)
        });
        world.persistents.add(eid, { kind: "prop" });
        propByPlacementId.set(placement.placementId, eid);

        localRootOffset = createRuntimePropPhysicsBody({
          physics,
          physicsBodies,
          physicsColliders,
          eid,
          placement,
          runtimeRotation,
          profile,
          propCollisionGroups
        }).localRootOffset;

        props.add(eid, {
          placementId: placement.placementId,
          sourcePropId: placement.sourcePropId,
          localRootOffset
        });
      }

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
        props,
        propByPlacementId,
        propRootByPlacementId,
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

    function syncRuntimePlayerFromPhysics(runtime: GameRuntime): void {
      const translation = runtime.physics.getEntityTranslation(runtime.playerEid);
      if (!translation) {
        return;
      }
      const transform = runtime.world.transforms.get(runtime.playerEid);
      if (!transform) {
        return;
      }
      transform.x = toGameplayCoordX(translation.x);
      transform.y = toGameplayCoordY(translation.z);
    }

    function syncRuntimePropTransforms(runtime: GameRuntime): void {
      for (const [placementId, eid] of runtime.propByPlacementId.entries()) {
        const prop = runtime.props.get(eid);
        if (!prop) {
          continue;
        }
        const placement = propPlacements.get(placementId);
        if (!placement) {
          continue;
        }

        const translation = runtime.physics.getEntityTranslation(eid);
        const rotation = runtime.physics.getEntityRotation(eid);
        if (!translation || !rotation) {
          continue;
        }

        const rootPose = rootPoseFromBodyPose(
          translation,
          prop.localRootOffset,
          rotation
        );
        const rootY = Math.max(0, rootPose.worldY);
        applyPlacementWorldPose(placement, rootPose.worldX, rootPose.worldZ, rootY);
        propRuntimeRotationByPlacementId.set(placement.placementId, {
          x: rotation.x,
          y: rotation.y,
          z: rotation.z,
          w: rotation.w
        });

        const linearVelocity =
          runtime.physics.getEntityLinearVelocity(eid) ?? { x: 0, y: 0, z: 0 };
        const angularVelocity =
          runtime.physics.getEntityAngularVelocity(eid) ?? { x: 0, y: 0, z: 0 };
        const profile = getPropPhysicsProfile(placement.sourcePropId);
        placement.runtimeState = {
          rotation: {
            x: rotation.x,
            y: rotation.y,
            z: rotation.z,
            w: rotation.w
          },
          linearVelocity: {
            x: linearVelocity.x,
            y: linearVelocity.y,
            z: linearVelocity.z
          },
          angularVelocity: {
            x: angularVelocity.x,
            y: angularVelocity.y,
            z: angularVelocity.z
          },
          sleeping:
            profile.mobility === "fixed"
              ? true
              : runtime.physics.isEntitySleeping(eid)
        };

        const transform = runtime.world.transforms.get(eid);
        if (transform) {
          transform.x = toGameplayCoordX(rootPose.worldX);
          transform.y = toGameplayCoordY(rootPose.worldZ);
        }

        const root = runtime.propRootByPlacementId.get(placementId);
        if (root) {
          root.position.set(rootPose.worldX, rootY, rootPose.worldZ);
          root.quaternion.set(rotation.x, rotation.y, rotation.z, rotation.w);
        }
      }
    }

    function enterEditor(): void {
      if (gameRuntime) {
        const player = findPlayerTransform(gameRuntime.world);
        if (player) {
          preservedEditorReturnPlayer = { x: player.x, y: player.y };
        }
      }
      disposeGameRuntime();
      mode = "EDITOR";
      editorDoorGroup.visible = true;
      editorPropGroup.visible = true;
      gameDoorGroup.visible = false;
      gamePropGroup.visible = false;
      hoverMesh.visible = true;
      propGhostRoot.visible = false;
      hidePropPlacementIndicators();
      hideRectPreview();
      runtimePhysicsLastSubsteps = 0;
      statusMessage = "Switched to EDITOR.";
      syncHud();
    }

    let enterGameRequestId = 0;

    async function enterGame(options?: {
      player?: { x: number; y: number };
      doorOverrides?: Map<string, DoorOverride>;
      status?: string;
    }): Promise<void> {
      disposeEditorPropPhysics();
      const requestId = enterGameRequestId + 1;
      enterGameRequestId = requestId;

      await initRapier3d();
      if (requestId !== enterGameRequestId) {
        return;
      }

      disposeGameRuntime();

      const runtime = createGameRuntime({
        player: options?.player ?? preservedEditorReturnPlayer ?? undefined,
        doorOverrides: options?.doorOverrides
      });
      if (requestId !== enterGameRequestId) {
        runtime.keyboard.dispose(window);
        runtime.physics.dispose();
        return;
      }

      gameRuntime = runtime;
      runtimePhysicsLastSubsteps = 0;
      rebuildGameplayDoorMeshes(runtime);
      rebuildGamePropMeshes();
      syncRuntimePlayerFromPhysics(runtime);
      syncRuntimePropTransforms(runtime);

      mode = "GAME";
      editorDoorGroup.visible = false;
      editorPropGroup.visible = false;
      gameDoorGroup.visible = true;
      gamePropGroup.visible = true;
      hoverMesh.visible = false;
      propGhostRoot.visible = false;
      hidePropPlacementIndicators();
      hideRectPreview();
      playerMesh.visible = true;

      const playerTransform = runtime.world.transforms.get(runtime.playerEid);
      if (playerTransform) {
        syncPlayerMeshPosition(playerTransform);
      }

      statusMessage =
        options?.status ?? "Baked editor state and entered GAME mode.";
      preservedEditorReturnPlayer = null;
      syncHud();
    }

    function saveLevelModelNow(): void {
      saveEditorNow();
      statusMessage = `Saved editor state to localStorage key: ${LEVEL_MODEL_STORAGE_KEY}`;
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

      const payload: SettlementGameSaveV1 = {
        schemaVersion: SETTLEMENT_GAME_SCHEMA_VERSION,
        editor: buildEditorSaveV1({
          defaultGround: defaultGroundBase,
          seed: userSeed,
          overrides: groundOverrides,
          structures: structureSegments,
          props: propPlacements,
          propColliderModes,
          propPhysicsProfiles
        }),
        player,
        doors
      };

      localStorage.setItem(GAME_SAVE_STORAGE_KEY, JSON.stringify(payload));
      statusMessage = `Saved game to localStorage key: ${GAME_SAVE_STORAGE_KEY}`;
      syncHud();
    }

    function loadGameNow(): void {
      const raw = localStorage.getItem(GAME_SAVE_STORAGE_KEY);
      if (!raw) {
        statusMessage = "No game save found in localStorage.";
        syncHud();
        return;
      }

      let parsedSave: SettlementGameSaveV1 | null = null;
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

      const parsedEditor = parseEditorSaveV1(parsedSave.editor, GRID_TILES);
      if (!parsedEditor) {
        statusMessage = "Game save load failed: invalid editor payload.";
        syncHud();
        return;
      }

      defaultGroundBase = parsedEditor.defaultGround;
      userSeed = parsedEditor.seed;
      seedInput.value = String(userSeed);
      groundOverrides = parsedEditor.overrides;
      structureSegments = parsedEditor.structures;
      propPlacements = parsedEditor.props;
      disposeEditorPropPhysics();
      hydrateRuntimeStateFromPlacements();
      propColliderModes = parsedEditor.propColliderModes;
      propPhysicsProfiles = new Map(parsedEditor.propPhysicsProfiles);
      propRotationQuarterTurns = 0;
      propDropRevision += 1;
      ghostDropCacheKey = "";
      history.clear();

      for (const placement of propPlacements.values()) {
        ensurePropTemplate(placement.sourcePropId);
      }

      updateGridGeometry();
      rebuildBaseLevelMeshes();
      rebuildEditorStructureMeshes();
      rebuildEditorPropMeshes();
      saveEditorNow();

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
      const playerVelocity = world.velocities.get(runtime.playerEid);
      if (playerVelocity) {
        runtime.physics.setCharacterDesiredVelocity(runtime.playerEid, {
          vx: playerVelocity.vx * TILE_SIZE,
          vz: playerVelocity.vy * TILE_SIZE
        });
      } else {
        runtime.physics.setCharacterDesiredVelocity(runtime.playerEid, {
          vx: 0,
          vz: 0
        });
      }

      runDoorSystem(runtime);
      runtimePhysicsLastSubsteps = runtime.physics.step(dt);
      syncRuntimePlayerFromPhysics(runtime);
      syncRuntimePropTransforms(runtime);
      runtime.systems.eventSystem(world);

      const player = world.transforms.get(runtime.playerEid);
      if (player) {
        syncPlayerMeshPosition(player);
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

    function clearSelectedPropSelection(): void {
      if (!selectedPropId && activeBuildCatalog === "brush") {
        return;
      }
      setSelectedProp(null);
      activeBuildCatalog = "brush";
      activeCatalogTab = isGroundBrush(editorBrush) ? "terrain" : "structures";
    }

    function isTextInputActive(): boolean {
      const active = document.activeElement;
      if (!(active instanceof HTMLElement)) {
        return false;
      }
      if (active.isContentEditable) {
        return true;
      }
      if (active instanceof HTMLTextAreaElement) {
        return !active.readOnly && !active.disabled;
      }
      if (active instanceof HTMLInputElement) {
        if (active.readOnly || active.disabled) {
          return false;
        }
        const nonTextTypes = new Set([
          "button",
          "checkbox",
          "color",
          "file",
          "hidden",
          "image",
          "radio",
          "range",
          "reset",
          "submit"
        ]);
        return !nonTextTypes.has(active.type.toLowerCase());
      }
      return active instanceof HTMLSelectElement;
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
      if (mode === "EDITOR") {
        updateHoverFromClient(event.clientX, event.clientY);
      }

      const world = worldAtClient(event.clientX, event.clientY);
      const paintMode: ToolMode = event.button === 2 ? "erase" : activeTool;
      const rectMode =
        event.button === 0 ? resolveRectModeForPointer(event) : "none";

      if (mode === "EDITOR") {
        if (event.button === 2) {
          clearSelectedPropSelection();
          statusMessage = "Cancelled pending prop placement.";
          syncHud();
          event.preventDefault();
          return;
        }

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

        applyEditorActionWithHistory(world);

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
      const world = updateHoverFromClient(event.clientX, event.clientY);

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
        const rectMode = dragState.rectMode;
        const rectStartCell = dragState.rectStartCell;
        const rectEndCell = dragState.rectEndCell;
        runEditorMutation(
          `Applied ${rectMode} rect (${rectStartCell.x},${rectStartCell.y}) -> (${rectEndCell.x},${rectEndCell.y}).`,
          () => {
            runRectTool(rectMode, rectStartCell, rectEndCell);
            return true;
          }
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

      if (
        mode === "EDITOR" &&
        isTextInputActive() &&
        !event.ctrlKey &&
        !event.metaKey
      ) {
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

      if ((event.ctrlKey || event.metaKey) && event.code === "KeyZ") {
        event.preventDefault();
        const previous = history.undo(captureEditorSnapshot());
        if (previous) {
          applyEditorSnapshot(previous);
          statusMessage = "Undo.";
          syncHud();
        }
        return;
      }

      if (
        (event.ctrlKey || event.metaKey) &&
        (event.code === "KeyY" || (event.shiftKey && event.code === "KeyZ"))
      ) {
        event.preventDefault();
        const next = history.redo(captureEditorSnapshot());
        if (next) {
          applyEditorSnapshot(next);
          statusMessage = "Redo.";
          syncHud();
        }
        return;
      }

      if (event.repeat) {
        return;
      }

      if (event.code === "Digit1") {
        editorBrush = "wall";
        clearSelectedPropSelection();
        activeTool = "draw";
        activeRectTool = "none";
        syncHud();
        event.preventDefault();
      } else if (event.code === "Digit2") {
        editorBrush = "window";
        clearSelectedPropSelection();
        activeTool = "draw";
        activeRectTool = "none";
        syncHud();
        event.preventDefault();
      } else if (event.code === "Digit3") {
        editorBrush = "door-closed";
        clearSelectedPropSelection();
        activeTool = "draw";
        activeRectTool = "none";
        syncHud();
        event.preventDefault();
      } else if (event.code === "Digit4") {
        editorBrush = "floor";
        clearSelectedPropSelection();
        activeTool = "draw";
        activeRectTool = "none";
        syncHud();
        event.preventDefault();
      } else if (event.code === "Digit5") {
        editorBrush = "grass";
        clearSelectedPropSelection();
        activeTool = "draw";
        activeRectTool = "none";
        syncHud();
        event.preventDefault();
      } else if (event.code === "Digit6") {
        editorBrush = "door-open";
        clearSelectedPropSelection();
        activeTool = "draw";
        activeRectTool = "none";
        syncHud();
        event.preventDefault();
      } else if (event.code === "Digit7") {
        editorBrush = "road";
        clearSelectedPropSelection();
        activeTool = "draw";
        activeRectTool = "none";
        syncHud();
        event.preventDefault();
      } else if (event.code === "Digit8") {
        editorBrush = "sidewalk";
        clearSelectedPropSelection();
        activeTool = "draw";
        activeRectTool = "none";
        syncHud();
        event.preventDefault();
      } else if (event.code === "Digit9") {
        if (!isGroundBrush(editorBrush)) {
          editorBrush = "floor";
        }
        clearSelectedPropSelection();
        activeBuildCatalog = "brush";
        activeCatalogTab = "terrain";
        activeRectTool = "building-footprint";
        syncHud();
        event.preventDefault();
      } else if (event.code === "KeyG") {
        if (!isGroundBrush(editorBrush)) {
          editorBrush = "floor";
        }
        clearSelectedPropSelection();
        activeBuildCatalog = "brush";
        activeCatalogTab = "terrain";
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
      } else if (event.code === "KeyR") {
        rotatePendingProp();
        event.preventDefault();
      } else if (event.code === "KeyN") {
        togglePropPlacementSnap();
        event.preventDefault();
      }
    }

    try {
      await initRapier3d();
    } catch {
      propDropEnabled = false;
      statusMessage = "Rapier 3D failed to initialize; prop drop falls back to ground-level placement.";
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
    rebuildEditorPropMeshes();

    enterEditor();
    syncHud();
    updateCursor();

    let last = performance.now();

    const render = (now: number): void => {
      const dt = Math.min(0.1, Math.max(0, (now - last) / 1000));
      last = now;

      if (mode === "GAME" && gameRuntime) {
        runGameFrame(gameRuntime, dt);
      } else if (mode === "EDITOR") {
        stepEditorPropPhysics(now);
      }

      view.frame(now, dt);
      syncHud();

      raf = requestAnimationFrame(render);
    };

    raf = requestAnimationFrame(render);

    return () => {
      cancelAnimationFrame(raf);
      disposeEditorPropPhysics();
      propRuntimeRotationByPlacementId.clear();

      if (autosaveTimer > 0) {
        window.clearTimeout(autosaveTimer);
        autosaveTimer = 0;
      }
      saveEditorNow();

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
      propPlacementAnchorMesh.geometry.dispose();
      propPlacementLandingMesh.geometry.dispose();
      propPlacementDepthLineGeometry.dispose();
      propPlacementOffsetLineGeometry.dispose();
      propPlaceholderGeometry.dispose();

      minorGridGeometry.dispose();
      minorGridMaterial.dispose();

      floorMaterial.dispose();
      grassVariantMaterials.forEach((material) => material.dispose());
      roadMaterial.dispose();
      sidewalkMaterial.dispose();
      buildingGroundMaterial.dispose();
      playerBodyMaterial.dispose();
      playerHeadMaterial.dispose();
      clearPropGhostVisual();
      propPlaceholderMaterial.dispose();
      propGhostMaterial.dispose();
      propPlacementAnchorMaterial.dispose();
      propPlacementLandingMaterial.dispose();
      propPlacementDepthLineMaterial.dispose();
      propPlacementOffsetLineMaterial.dispose();
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
