import type { VhacdOptions } from "@common/collider-vhacd";
import type { ColliderParams } from "../forge/processing/colliders";
import type { ForgeColliderGenerationMetadata } from "../forge/processing/collider-vhacd";
import type {
  PropPhysicsSettings,
  PropPhysicsMaterial,
  PropPhysicsMobility
} from "../forge/types";
import type { PivotPreset, ScaleMode } from "../forge/processing/dimensions";

export type ForgeV2LifecycleStatus =
  | "draft"
  | "image-ready"
  | "mesh-ready"
  | "generation-approved"
  | "physics-approved";

export type ForgeV2BBoxJson = {
  width: number;
  height: number;
  depth: number;
};

export interface ForgeV2PropMeta {
  version: 1;
  id: string;
  description: string;
  createdAt: string;
  updatedAt: string;
  lifecycle: {
    status: ForgeV2LifecycleStatus;
    generationApprovedAt?: string;
    physicsApprovedAt?: string;
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
      bboxRaw?: ForgeV2BBoxJson;
      bboxProcessed?: ForgeV2BBoxJson;
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
    presets: ForgeV2ColliderResultEntry[];
  };
  physics?: {
    kind: string;
    overrides: Partial<PropPhysicsSettings>;
    resolved: PropPhysicsSettings;
    simulationChecks?: Record<string, ForgeV2SimulationCheckResult>;
  };
}

export interface ForgeV2ColliderResultEntry {
  presetId: string;
  presetName: string;
  enabled: boolean;
  file: string;
  collider: ColliderParams;
  generation: ForgeColliderGenerationMetadata;
}

export interface ForgeV2ColliderPreset {
  id: string;
  name: string;
  options: VhacdOptions;
  enabledByDefault?: boolean;
}

export interface ForgeV2ColliderPresetFile {
  version: 1;
  defaultPresetId: string;
  updatedAt: string;
  presets: ForgeV2ColliderPreset[];
}

export interface ForgeV2PhysicsKindPreset {
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

export interface ForgeV2PhysicsKindPresetFile {
  version: 1;
  defaultKindId: string;
  updatedAt: string;
  kinds: ForgeV2PhysicsKindPreset[];
}

export interface ForgeV2SimulationCheckResult {
  scenario: "floorDrop" | "slope30Drop" | "edgeDrop";
  durationSeconds: number;
  maxLinearSpeed: number;
  maxAngularSpeed: number;
  settled: boolean;
}

export interface ForgeV2GenerationDraftProp {
  tempId: string;
  idSlug: string;
  description: string;
  status:
    | "draft"
    | "generating-image"
    | "image-ready"
    | "generating-mesh"
    | "mesh-ready"
    | "approved-generation"
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
  bboxProcessed: ForgeV2BBoxJson | null;
  pixelCamera: {
    target: [number, number, number];
    yawTurns: number;
    zoomLevel: number;
  };
  generationApprovedAt?: string;
}

export interface ForgeV2PhysicsEditorState {
  propId: string;
  colliderPresetSelection: string[];
  selectedColliderPresetId: string | null;
  kindId: string;
  physics: PropPhysicsSettings;
}
