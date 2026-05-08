import type { VhacdOptions } from "@common/collider-vhacd";
import type { ColliderParams } from "./shared/processing/colliders";
import type { ForgeColliderGenerationMetadata } from "./shared/processing/collider-vhacd";
import type {
  PropPhysicsSettings,
  PropPhysicsMaterial,
  PropPhysicsMobility
} from "./shared/types";
import type { PivotPreset, ScaleMode } from "./shared/processing/dimensions";

export type ForgeLifecycleStatus =
  | "draft"
  | "image-ready"
  | "mesh-ready"
  | "physics-ready";

export type ForgeBBoxJson = {
  width: number;
  height: number;
  depth: number;
};

export interface ForgePropMeta {
  version: 1;
  id: string;
  description: string;
  createdAt: string;
  updatedAt: string;
  lifecycle: {
    status: ForgeLifecycleStatus;
  };
  styleGuide: {
    name: string;
    prompt: string;
    negativePrompt: string;
    imageSize: string;
  };
  generation: {
    image: {
      provider: "openai";
      model: string;
      prompt: string;
      size: string;
      generatedAt?: string;
      revision: number;
    };
    mesh: {
      provider: "tripo";
      faceLimit: number;
      pbr: boolean;
      tripoTaskId?: string;
      generatedAt?: string;
      revision: number;
    };
  };
  processing: {
    mesh: {
      originalFaces: number;
      processedFaces: number;
      simplificationRatio: number;
      textureResolution: number;
      bboxRaw?: ForgeBBoxJson;
      bboxProcessed?: ForgeBBoxJson;
    };
    transform: {
      unitScaleMetersPerUnit: number;
      targetDimension: {
        method: ScaleMode | "depth";
        value: number;
      };
      scale: [number, number, number];
      provisionalPivot: {
        preset: PivotPreset;
        offset: [number, number, number];
        basis: "mesh";
      };
      finalPivot?: {
        preset: PivotPreset;
        offset: [number, number, number];
        basis: "collider";
        colliderPresetId: string;
      };
    };
  };
  pixelPreview: {
    testEnvironmentVersion: 1;
    cameraSyncState: {
      target: [number, number, number];
      yawTurns: number;
      zoomLevel: number;
    };
    views: Array<{
      angle: "north" | "east" | "south" | "west";
      visible: boolean;
    }>;
  };
  colliders?: {
    selectedPresetId?: string;
    presets: ForgeColliderResultEntry[];
  };
  physics?: {
    kind: string;
    overrides: Partial<PropPhysicsSettings>;
    resolved: PropPhysicsSettings;
    simulationChecks?: Record<string, ForgeSimulationCheckResult>;
  };
}

export interface ForgeColliderResultEntry {
  presetId: string;
  presetName: string;
  enabled: boolean;
  file: string;
  collider: ColliderParams;
  generation: ForgeColliderGenerationMetadata;
}

export interface ForgeColliderPreset {
  id: string;
  name: string;
  options: VhacdOptions;
  enabledByDefault?: boolean;
}

export interface ForgeColliderPresetFile {
  version: 1;
  defaultPresetId: string;
  updatedAt: string;
  presets: ForgeColliderPreset[];
}

export interface ForgePhysicsKindPreset {
  id: string;
  name: string;
  mobility: PropPhysicsMobility;
  material: PropPhysicsMaterial;
  massMode: "auto" | "manual";
  massScale: number;
  manualMass: number;
  friction: number;
  restitution: number;
  linearDamping: number;
  angularDamping: number;
  activationDelayMs: number;
}

export interface ForgePhysicsKindPresetFile {
  version: 1;
  defaultKindId: string;
  updatedAt: string;
  kinds: ForgePhysicsKindPreset[];
}

export interface ForgeSimulationCheckResult {
  scenario: "floorDrop" | "slope30Drop" | "edgeDrop";
  durationSeconds: number;
  maxLinearSpeed: number;
  maxAngularSpeed: number;
  settled: boolean;
}

export interface ForgeGenerationDraftProp {
  tempId: string;
  idSlug: string;
  description: string;
  status:
    | "draft"
    | "generating-image"
    | "image-ready"
    | "generating-mesh"
    | "mesh-ready"
    | "error";
  conceptImage: string | null;
  rawGlb: ArrayBuffer | null;
  imageError: string | null;
  meshError: string | null;
  imageRevision: number;
  meshRevision: number;
  meshProgress: number;
  meshProgressLabel: string;
  faceLimit: number;
  pbr: boolean;
  textureResolution: number;
  scaleMode: ScaleMode | "depth";
  targetDimension: number;
  scale: number;
  pivot: PivotPreset;
  pivotOffset: [number, number, number];
  originalFaces: number;
  processedFaces: number;
  simplificationRatio: number;
  bboxProcessed: ForgeBBoxJson | null;
  pixelCamera: {
    target: [number, number, number];
    yawTurns: number;
    zoomLevel: number;
  };
}

export interface ForgePhysicsEditorState {
  propId: string;
  colliderPresetSelection: string[];
  selectedColliderPresetId: string | null;
  kindId: string;
  physics: PropPhysicsSettings;
}
