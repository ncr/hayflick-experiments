import type { StyleGuide } from "../../forge/StyleGuidePanel";
import type { PropPhysicsSettings } from "../../forge/types";
import type { BBox, PivotPreset, ScaleMode } from "../../forge/processing/dimensions";
import type {
  ForgeV2ColliderPresetFile,
  ForgeV2ColliderResultEntry,
  ForgeV2GenerationDraftProp,
  ForgeV2LifecycleStatus,
  ForgeV2PhysicsKindPresetFile,
  ForgeV2PropMeta,
  ForgeV2SimulationCheckResult
} from "../types";

// ---------------------------------------------------------------------------
// Stage-Status Model
// ---------------------------------------------------------------------------

export type StageId = "ref" | "mesh" | "pix" | "physics";

export type StageStatus = "EMPTY" | "VALID" | "OUTDATED" | "BUILDING" | "FAILED";

export interface StageState<TConfig = unknown, TArtifact = unknown> {
  config: TConfig;
  artifact: TArtifact | null;
  status: StageStatus;
  error: string | null;
  ownVersion: number;
  builtFromUpstreamVersion: number;
}

// Per-stage config types (serializable subsets)

export type RefConfig = {
  description: string;
  styleGuide: StyleGuide;
};

export type RefArtifact = {
  conceptImage: string;
  imageRevision: number;
};

export type MeshConfig = {
  faceLimit: number;
  pbr: boolean;
  textureResolution: number;
  scaleMode: ScaleMode | "depth";
  targetDimension: number;
  pivot: PivotPreset;
};

export type MeshArtifact = {
  rawGlb: ArrayBuffer;
  meshRevision: number;
  originalFaces: number;
  processedFaces: number;
  simplificationRatio: number;
  scale: number;
  pivotOffset: [number, number, number];
  bboxProcessed: { width: number; height: number; depth: number } | null;
};

export type PixConfig = {
  pixelCamera: {
    target: [number, number, number];
    yawTurns: number;
    zoomLevel: number;
  };
};

export type PixArtifact = {
  generationApprovedAt: string;
};

export type PhysicsConfig = {
  kindId: string;
  physicsSettings: PropPhysicsSettings;
  colliderPresetSelection: string[];
  selectedColliderPresetId: string | null;
};

export type PhysicsArtifact = {
  colliderResults: ForgeV2ColliderResultEntry[];
  simulationChecks: Record<string, ForgeV2SimulationCheckResult>;
  physicsApprovedAt: string;
};

// ---------------------------------------------------------------------------
// Saved prop list item (gallery display)
// ---------------------------------------------------------------------------

export type SavedPropListItem = {
  id: string;
  description: string;
  status: ForgeV2LifecycleStatus;
  conceptImage: string | null;
  generationApprovedAt?: string;
  physicsApprovedAt?: string;
};

// Gallery filter
export type GalleryFilter = "all" | "ref" | "mesh" | "physics";

// ---------------------------------------------------------------------------
// Top-level state
// ---------------------------------------------------------------------------

export interface ForgeStoreState {
  // Active prop
  selectedPropId: string | null;

  // Pipeline stages
  ref: StageState<RefConfig, RefArtifact>;
  mesh: StageState<MeshConfig, MeshArtifact>;
  pix: StageState<PixConfig, PixArtifact>;
  physics: StageState<PhysicsConfig, PhysicsArtifact>;

  // Active stage navigation
  activeStage: StageId;

  // Gallery
  galleryFilter: GalleryFilter;
  savedProps: SavedPropListItem[];
  savedLoading: boolean;

  // Batch (REF-only)
  batchMode: boolean;
  batchText: string;
  defaultFaceLimit: number;

  // Draft queue (generation drafts in progress)
  drafts: Map<string, ForgeV2GenerationDraftProp>;
  selectedDraftId: string | null;
  generationBusy: { images: boolean; meshes: boolean };

  // Presets (loaded on init)
  colliderPresets: ForgeV2ColliderPresetFile | null;
  physicsKindPresets: ForgeV2PhysicsKindPresetFile | null;

  // Physics view state
  physicsSelectedPropId: string | null;
  physicsMeta: ForgeV2PropMeta | null;
  physicsConceptImage: string | null;
  physicsBBox: BBox | null;
  physicsColliderResults: ForgeV2ColliderResultEntry[];
  physicsSelectedColliderPresetId: string | null;
  physicsSelectedKindId: string;
  physicsSettings: PropPhysicsSettings;
  physicsColliderBuildState: {
    running: boolean;
    progressText: string;
    statusText: string;
    error: string | null;
  };
  physicsSimStatusByScenario: Record<string, string>;

  // Status strip
  statusMessage: string;
  statusError: string | null;

  // Style guide
  styleGuide: StyleGuide;
}

// ---------------------------------------------------------------------------
// Default stage state factory
// ---------------------------------------------------------------------------

function emptyStage<C, A>(config: C): StageState<C, A> {
  return {
    config,
    artifact: null,
    status: "EMPTY",
    error: null,
    ownVersion: 0,
    builtFromUpstreamVersion: 0,
  };
}

// ---------------------------------------------------------------------------
// Cascade logic
// ---------------------------------------------------------------------------

const STAGE_ORDER: StageId[] = ["ref", "mesh", "pix", "physics"];

function cascadeDownstream(state: ForgeStoreState): ForgeStoreState {
  let next = state;
  for (let i = 1; i < STAGE_ORDER.length; i++) {
    const upstreamId = STAGE_ORDER[i - 1];
    const stageId = STAGE_ORDER[i];
    // physics depends on mesh, not pix
    const effectiveUpstream = stageId === "physics" ? "mesh" : upstreamId;
    const upstream = next[effectiveUpstream] as StageState;
    const current = next[stageId] as StageState;
    if (
      current.status === "VALID" &&
      current.builtFromUpstreamVersion < upstream.ownVersion
    ) {
      next = {
        ...next,
        [stageId]: { ...current, status: "OUTDATED" },
      };
    }
  }
  return next;
}

// ---------------------------------------------------------------------------
// Lifecycle → stage status mapping (for loading saved props)
// ---------------------------------------------------------------------------

export function lifecycleToStageStatuses(
  status: ForgeV2LifecycleStatus
): Record<StageId, StageStatus> {
  switch (status) {
    case "draft":
      return { ref: "EMPTY", mesh: "EMPTY", pix: "EMPTY", physics: "EMPTY" };
    case "image-ready":
      return { ref: "VALID", mesh: "EMPTY", pix: "EMPTY", physics: "EMPTY" };
    case "mesh-ready":
      return { ref: "VALID", mesh: "VALID", pix: "EMPTY", physics: "EMPTY" };
    case "generation-approved":
      return { ref: "VALID", mesh: "VALID", pix: "VALID", physics: "EMPTY" };
    case "physics-approved":
      return { ref: "VALID", mesh: "VALID", pix: "VALID", physics: "VALID" };
  }
}

// Stage status → lifecycle reverse mapping (for saving)
export function stageStatusesToLifecycle(
  stages: Record<StageId, StageStatus>
): ForgeV2LifecycleStatus {
  if (stages.physics === "VALID") return "physics-approved";
  if (stages.pix === "VALID") return "generation-approved";
  if (stages.mesh === "VALID") return "mesh-ready";
  if (stages.ref === "VALID") return "image-ready";
  return "draft";
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

export type ForgeAction =
  // Navigation
  | { type: "SET_ACTIVE_STAGE"; stage: StageId }
  // Gallery
  | { type: "SET_GALLERY_FILTER"; filter: GalleryFilter }
  | { type: "SET_SAVED_PROPS"; props: SavedPropListItem[] }
  | { type: "SET_SAVED_LOADING"; loading: boolean }
  | { type: "SELECT_PROP"; propId: string | null }
  // Batch
  | { type: "SET_BATCH_MODE"; on: boolean }
  | { type: "SET_BATCH_TEXT"; text: string }
  | { type: "SET_DEFAULT_FACE_LIMIT"; limit: number }
  // Drafts
  | { type: "ADD_DRAFTS"; drafts: ForgeV2GenerationDraftProp[] }
  | { type: "UPDATE_DRAFT"; id: string; patch: Partial<ForgeV2GenerationDraftProp> }
  | { type: "SELECT_DRAFT"; id: string | null }
  | { type: "SET_GENERATION_BUSY"; patch: Partial<{ images: boolean; meshes: boolean }> }
  // Stage state updates
  | { type: "SET_STAGE_STATUS"; stage: StageId; status: StageStatus; error?: string | null }
  | { type: "SET_STAGE_ARTIFACT"; stage: StageId; artifact: unknown }
  | { type: "SET_STAGE_CONFIG"; stage: StageId; config: unknown }
  | { type: "INCREMENT_STAGE_VERSION"; stage: StageId }
  // Presets
  | { type: "SET_COLLIDER_PRESETS"; presets: ForgeV2ColliderPresetFile }
  | { type: "SET_PHYSICS_KIND_PRESETS"; presets: ForgeV2PhysicsKindPresetFile }
  // Physics
  | { type: "SET_PHYSICS_PROP"; propId: string; meta: ForgeV2PropMeta; conceptImage: string | null }
  | { type: "SET_PHYSICS_BBOX"; bbox: BBox | null }
  | { type: "SET_PHYSICS_COLLIDER_RESULTS"; results: ForgeV2ColliderResultEntry[] }
  | { type: "SET_PHYSICS_SELECTED_COLLIDER"; presetId: string | null }
  | { type: "SET_PHYSICS_KIND"; kindId: string }
  | { type: "SET_PHYSICS_SETTINGS"; settings: PropPhysicsSettings }
  | { type: "SET_PHYSICS_BUILD_STATE"; state: ForgeStoreState["physicsColliderBuildState"] }
  | { type: "SET_PHYSICS_SIM_STATUS"; scenario: string; text: string }
  | { type: "CLEAR_PHYSICS_PROP" }
  // Status strip
  | { type: "SET_STATUS_MESSAGE"; message: string }
  | { type: "SET_STATUS_ERROR"; error: string | null }
  // Style guide
  | { type: "SET_STYLE_GUIDE"; guide: StyleGuide }
  // Drafts management
  | { type: "CLEAR_DRAFTS" }
  // Load prop into pipeline (maps persisted meta to stage states)
  | { type: "LOAD_PROP_INTO_PIPELINE"; meta: ForgeV2PropMeta; conceptImage: string | null };

// ---------------------------------------------------------------------------
// Initial state factory
// ---------------------------------------------------------------------------

import { DEFAULT_FORGE_PHYSICS_SETTINGS } from "../../forge/processing/physics";

const DEFAULT_FACE_LIMIT = 5_000;

export function createInitialState(): ForgeStoreState {
  return {
    selectedPropId: null,
    ref: emptyStage<RefConfig, RefArtifact>({
      description: "",
      styleGuide: { name: "", prompt: "", negativePrompt: "", imageSize: "1024x1024", referenceImages: [] },
    }),
    mesh: emptyStage<MeshConfig, MeshArtifact>({
      faceLimit: DEFAULT_FACE_LIMIT,
      pbr: true,
      textureResolution: 0,
      scaleMode: "max",
      targetDimension: 1,
      pivot: "bottom-center",
    }),
    pix: emptyStage<PixConfig, PixArtifact>({
      pixelCamera: { target: [0, 0, 0], yawTurns: 0, zoomLevel: 1 },
    }),
    physics: emptyStage<PhysicsConfig, PhysicsArtifact>({
      kindId: "wood",
      physicsSettings: { ...DEFAULT_FORGE_PHYSICS_SETTINGS },
      colliderPresetSelection: [],
      selectedColliderPresetId: null,
    }),
    activeStage: "ref",
    galleryFilter: "all",
    savedProps: [],
    savedLoading: false,
    batchMode: false,
    batchText: "",
    defaultFaceLimit: DEFAULT_FACE_LIMIT,
    drafts: new Map(),
    selectedDraftId: null,
    generationBusy: { images: false, meshes: false },
    colliderPresets: null,
    physicsKindPresets: null,
    physicsSelectedPropId: null,
    physicsMeta: null,
    physicsConceptImage: null,
    physicsBBox: null,
    physicsColliderResults: [],
    physicsSelectedColliderPresetId: null,
    physicsSelectedKindId: "wood",
    physicsSettings: { ...DEFAULT_FORGE_PHYSICS_SETTINGS },
    physicsColliderBuildState: {
      running: false,
      progressText: "idle",
      statusText: "Select a prop to begin.",
      error: null,
    },
    physicsSimStatusByScenario: {
      floorDrop: "Compute a collider to start auto-replay.",
      slope30Drop: "Compute a collider to start auto-replay.",
      edgeDrop: "Compute a collider to start auto-replay.",
    },
    statusMessage: "",
    statusError: null,
    styleGuide: { name: "", prompt: "", negativePrompt: "", imageSize: "1024x1024", referenceImages: [] },
  };
}

// ---------------------------------------------------------------------------
// Reducer
// ---------------------------------------------------------------------------

export function forgeReducer(state: ForgeStoreState, action: ForgeAction): ForgeStoreState {
  let next = state;

  switch (action.type) {
    // Navigation
    case "SET_ACTIVE_STAGE":
      next = { ...state, activeStage: action.stage };
      break;

    // Gallery
    case "SET_GALLERY_FILTER":
      next = { ...state, galleryFilter: action.filter };
      break;
    case "SET_SAVED_PROPS":
      next = { ...state, savedProps: action.props };
      break;
    case "SET_SAVED_LOADING":
      next = { ...state, savedLoading: action.loading };
      break;
    case "SELECT_PROP":
      next = { ...state, selectedPropId: action.propId };
      break;

    // Batch
    case "SET_BATCH_MODE":
      next = { ...state, batchMode: action.on };
      break;
    case "SET_BATCH_TEXT":
      next = { ...state, batchText: action.text };
      break;
    case "SET_DEFAULT_FACE_LIMIT":
      next = { ...state, defaultFaceLimit: action.limit };
      break;

    // Drafts
    case "ADD_DRAFTS": {
      const drafts = new Map(state.drafts);
      for (const d of action.drafts) {
        drafts.set(d.tempId, d);
      }
      next = {
        ...state,
        drafts,
        selectedDraftId: state.selectedDraftId ?? action.drafts[0]?.tempId ?? null,
      };
      break;
    }
    case "UPDATE_DRAFT": {
      const item = state.drafts.get(action.id);
      if (!item) break;
      const drafts = new Map(state.drafts);
      drafts.set(action.id, { ...item, ...action.patch });
      next = { ...state, drafts };
      break;
    }
    case "SELECT_DRAFT":
      next = { ...state, selectedDraftId: action.id };
      break;
    case "SET_GENERATION_BUSY":
      next = { ...state, generationBusy: { ...state.generationBusy, ...action.patch } };
      break;

    // Stage state
    case "SET_STAGE_STATUS": {
      const stage = state[action.stage] as StageState;
      next = {
        ...state,
        [action.stage]: {
          ...stage,
          status: action.status,
          error: action.error ?? (action.status === "FAILED" ? stage.error : null),
        },
      };
      break;
    }
    case "SET_STAGE_ARTIFACT": {
      const stage = state[action.stage] as StageState;
      next = {
        ...state,
        [action.stage]: { ...stage, artifact: action.artifact },
      };
      break;
    }
    case "SET_STAGE_CONFIG": {
      const stage = state[action.stage] as StageState;
      next = {
        ...state,
        [action.stage]: { ...stage, config: action.config },
      };
      break;
    }
    case "INCREMENT_STAGE_VERSION": {
      const stage = state[action.stage] as StageState;
      next = {
        ...state,
        [action.stage]: { ...stage, ownVersion: stage.ownVersion + 1 },
      };
      // Cascade downstream
      next = cascadeDownstream(next);
      break;
    }

    // Presets
    case "SET_COLLIDER_PRESETS":
      next = { ...state, colliderPresets: action.presets };
      break;
    case "SET_PHYSICS_KIND_PRESETS":
      next = { ...state, physicsKindPresets: action.presets };
      break;

    // Physics
    case "SET_PHYSICS_PROP":
      next = {
        ...state,
        physicsSelectedPropId: action.propId,
        physicsMeta: action.meta,
        physicsConceptImage: action.conceptImage,
        physicsColliderResults: action.meta.colliders?.presets ?? [],
        physicsSelectedColliderPresetId:
          action.meta.colliders?.selectedPresetId ??
          action.meta.colliders?.presets[0]?.presetId ?? null,
      };
      break;
    case "SET_PHYSICS_BBOX":
      next = { ...state, physicsBBox: action.bbox };
      break;
    case "SET_PHYSICS_COLLIDER_RESULTS":
      next = { ...state, physicsColliderResults: action.results };
      break;
    case "SET_PHYSICS_SELECTED_COLLIDER":
      next = { ...state, physicsSelectedColliderPresetId: action.presetId };
      break;
    case "SET_PHYSICS_KIND":
      next = { ...state, physicsSelectedKindId: action.kindId };
      break;
    case "SET_PHYSICS_SETTINGS":
      next = { ...state, physicsSettings: action.settings };
      break;
    case "SET_PHYSICS_BUILD_STATE":
      next = { ...state, physicsColliderBuildState: action.state };
      break;
    case "SET_PHYSICS_SIM_STATUS":
      next = {
        ...state,
        physicsSimStatusByScenario: {
          ...state.physicsSimStatusByScenario,
          [action.scenario]: action.text,
        },
      };
      break;
    case "CLEAR_PHYSICS_PROP":
      next = {
        ...state,
        physicsSelectedPropId: null,
        physicsMeta: null,
        physicsConceptImage: null,
        physicsBBox: null,
        physicsColliderResults: [],
        physicsSelectedColliderPresetId: null,
      };
      break;

    // Status strip
    case "SET_STATUS_MESSAGE":
      next = { ...state, statusMessage: action.message };
      break;
    case "SET_STATUS_ERROR":
      next = { ...state, statusError: action.error };
      break;

    // Style guide
    case "SET_STYLE_GUIDE":
      next = { ...state, styleGuide: action.guide };
      break;

    // Drafts management
    case "CLEAR_DRAFTS":
      next = { ...state, drafts: new Map(), selectedDraftId: null };
      break;

    // Load prop into pipeline
    case "LOAD_PROP_INTO_PIPELINE": {
      const { meta, conceptImage } = action;
      const statuses = lifecycleToStageStatuses(meta.lifecycle.status);
      const ver = 1; // freshly loaded = version 1

      next = {
        ...state,
        selectedPropId: meta.id,
        ref: {
          config: {
            description: meta.description,
            styleGuide: {
              name: meta.styleGuide.name,
              prompt: meta.styleGuide.prompt,
              negativePrompt: meta.styleGuide.negativePrompt,
              imageSize: meta.styleGuide.imageSize,
              referenceImages: [],
            },
          },
          artifact: conceptImage
            ? { conceptImage, imageRevision: meta.generation.image.revision }
            : null,
          status: statuses.ref,
          error: null,
          ownVersion: ver,
          builtFromUpstreamVersion: 0,
        },
        mesh: {
          config: {
            faceLimit: meta.generation.mesh.faceLimit,
            pbr: meta.generation.mesh.pbr,
            textureResolution: meta.processing.mesh.textureResolution,
            scaleMode: meta.processing.transform.targetDimension.method as MeshConfig["scaleMode"],
            targetDimension: meta.processing.transform.targetDimension.value,
            pivot: meta.processing.transform.provisionalPivot.preset,
          },
          artifact: statuses.mesh !== "EMPTY"
            ? {
                rawGlb: null as unknown as ArrayBuffer, // will be populated by async load
                meshRevision: meta.generation.mesh.revision,
                originalFaces: meta.processing.mesh.originalFaces,
                processedFaces: meta.processing.mesh.processedFaces,
                simplificationRatio: meta.processing.mesh.simplificationRatio,
                scale: meta.processing.transform.scale[0],
                pivotOffset: meta.processing.transform.provisionalPivot.offset,
                bboxProcessed: meta.processing.mesh.bboxProcessed ?? null,
              }
            : null,
          status: statuses.mesh,
          error: null,
          ownVersion: ver,
          builtFromUpstreamVersion: ver,
        },
        pix: {
          config: {
            pixelCamera: {
              target: meta.pixelPreview.cameraSyncState.target,
              yawTurns: meta.pixelPreview.cameraSyncState.yawTurns,
              zoomLevel: meta.pixelPreview.cameraSyncState.zoomLevel,
            },
          },
          artifact: statuses.pix !== "EMPTY"
            ? { generationApprovedAt: meta.lifecycle.generationApprovedAt ?? "" }
            : null,
          status: statuses.pix,
          error: null,
          ownVersion: ver,
          builtFromUpstreamVersion: ver,
        },
        physics: {
          config: {
            kindId: meta.physics?.kind ?? "wood",
            physicsSettings: meta.physics?.resolved ?? { ...DEFAULT_FORGE_PHYSICS_SETTINGS },
            colliderPresetSelection: [],
            selectedColliderPresetId: meta.colliders?.selectedPresetId ?? null,
          },
          artifact: statuses.physics !== "EMPTY" && meta.physics
            ? {
                colliderResults: meta.colliders?.presets ?? [],
                simulationChecks: meta.physics.simulationChecks ?? {},
                physicsApprovedAt: meta.lifecycle.physicsApprovedAt ?? "",
              }
            : null,
          status: statuses.physics,
          error: null,
          ownVersion: ver,
          builtFromUpstreamVersion: ver,
        },
      };
      break;
    }
  }

  return next;
}
