import type { PixelViewportViewState } from "../shared/viewport-state";
import type { StyleGuide } from "../shared/StyleGuidePanel";
import type { ForgeScaleMode } from "./MeshProcessor";
import type {
  ForgeColliderResultEntry,
  ForgeGenerationDraftProp,
  ForgePhysicsEditorState,
  ForgePropMeta,
} from "../types";
import { buildComposedPrompt } from "../io/forge-helpers";

const DEFAULT_FACE_LIMIT = 5_000;

export function canLoadPhysicsForLifecycle(status: ForgePropMeta["lifecycle"]["status"]): boolean {
  return status === "mesh-ready" || status === "physics-ready";
}

export function draftFromSavedProp(input: {
  meta: ForgePropMeta;
  conceptImage: string | null;
  rawGlb: ArrayBuffer | null;
}): ForgeGenerationDraftProp {
  const { meta, conceptImage, rawGlb } = input;
  const scaleModeRaw = meta.processing.transform.targetDimension.method;
  const scaleMode: ForgeScaleMode =
    scaleModeRaw === "width" ||
    scaleModeRaw === "height" ||
    scaleModeRaw === "max" ||
    scaleModeRaw === "manual" ||
    scaleModeRaw === "depth"
      ? scaleModeRaw
      : "max";

  return {
    tempId: `saved-${meta.id}`,
    idSlug: meta.id,
    description: meta.description,
    status: rawGlb && conceptImage ? "mesh-ready" : conceptImage ? "image-ready" : "draft",
    conceptImage,
    rawGlb,
    imageError: null,
    meshError: null,
    imageRevision: Math.max(0, meta.generation.image.revision),
    meshRevision: Math.max(0, meta.generation.mesh.revision),
    meshProgress: rawGlb ? 100 : 0,
    meshProgressLabel: rawGlb ? "Imported" : "idle",
    faceLimit: Math.max(1000, meta.generation.mesh.faceLimit || DEFAULT_FACE_LIMIT),
    pbr: meta.generation.mesh.pbr !== false,
    textureResolution: meta.processing.mesh.textureResolution ?? 0,
    scaleMode,
    targetDimension: meta.processing.transform.targetDimension.value ?? 1,
    scale: meta.processing.transform.scale?.[0] ?? 1,
    pivot: meta.processing.transform.provisionalPivot.preset,
    pivotOffset: meta.processing.transform.provisionalPivot.offset,
    originalFaces: meta.processing.mesh.originalFaces ?? 0,
    processedFaces: meta.processing.mesh.processedFaces ?? 0,
    simplificationRatio: meta.processing.mesh.simplificationRatio ?? 1,
    bboxProcessed: meta.processing.mesh.bboxProcessed ?? null,
    pixelCamera: {
      target: meta.pixelPreview.cameraSyncState.target,
      yawTurns: meta.pixelPreview.cameraSyncState.yawTurns,
      zoomLevel: meta.pixelPreview.cameraSyncState.zoomLevel,
    },
  };
}

export function applyDraftReferenceToMeta(
  base: ForgePropMeta,
  draft: ForgeGenerationDraftProp,
  styleGuide: StyleGuide,
  composedPrompt: string
): ForgePropMeta {
  return {
    ...base,
    description: draft.description,
    lifecycle: {
      status: draft.conceptImage ? "image-ready" : "draft",
    },
    styleGuide: {
      name: styleGuide.name,
      prompt: styleGuide.prompt,
      negativePrompt: styleGuide.negativePrompt,
      imageSize: styleGuide.imageSize,
    },
    generation: {
      ...base.generation,
      image: {
        ...base.generation.image,
        prompt: composedPrompt,
        size: styleGuide.imageSize || "1024x1024",
        revision: draft.imageRevision,
        generatedAt: draft.imageRevision > 0 ? new Date().toISOString() : undefined,
      },
    },
  };
}

export function applyDraftMeshToMeta(
  base: ForgePropMeta,
  draft: ForgeGenerationDraftProp,
  pixelViewState: PixelViewportViewState
): ForgePropMeta {
  return {
    ...base,
    description: draft.description,
    lifecycle: {
      status: draft.rawGlb ? "mesh-ready" : draft.conceptImage ? "image-ready" : "draft",
    },
    generation: {
      ...base.generation,
      mesh: {
        ...base.generation.mesh,
        faceLimit: draft.faceLimit,
        pbr: draft.pbr,
        revision: draft.meshRevision,
        generatedAt: draft.meshRevision > 0 ? new Date().toISOString() : undefined,
      },
    },
    processing: {
      ...base.processing,
      mesh: {
        ...base.processing.mesh,
        originalFaces: draft.originalFaces,
        processedFaces: draft.processedFaces,
        simplificationRatio: draft.simplificationRatio,
        textureResolution: draft.textureResolution,
        bboxProcessed: draft.bboxProcessed ?? undefined,
      },
      transform: {
        ...base.processing.transform,
        scale: [draft.scale, draft.scale, draft.scale],
        targetDimension: {
          method: draft.scaleMode,
          value: draft.targetDimension,
        },
        provisionalPivot: {
          preset: draft.pivot,
          offset: draft.pivotOffset,
          basis: "mesh",
        },
        finalPivot: undefined,
      },
    },
    pixelPreview: {
      ...base.pixelPreview,
      cameraSyncState: {
        target: pixelViewState.target,
        yawTurns: pixelViewState.yawTurns,
        zoomLevel: Math.max(1, Math.round(pixelViewState.zoom)),
      },
    },
    colliders: undefined,
    physics: undefined,
  };
}

export function applyPhysicsToMeta(
  base: ForgePropMeta,
  input: {
    selectedPresetId: string;
    colliderResults: ForgeColliderResultEntry[];
    physics: ForgePropMeta["physics"];
    finalPivotOffset: [number, number, number];
  }
): ForgePropMeta {
  return {
    ...base,
    lifecycle: {
      status: "physics-ready",
    },
    colliders: {
      selectedPresetId: input.selectedPresetId,
      presets: input.colliderResults,
    },
    physics: input.physics,
    processing: {
      ...base.processing,
      transform: {
        ...base.processing.transform,
        finalPivot: {
          preset: "bottom-center",
          offset: input.finalPivotOffset,
          basis: "collider",
          colliderPresetId: input.selectedPresetId,
        },
      },
    },
  };
}

export function createPlaceholderMeta(input: {
  base: ForgePropMeta;
  styleGuide: StyleGuide;
  description: string;
}): ForgePropMeta {
  return {
    ...input.base,
    description: input.description,
    styleGuide: {
      name: input.styleGuide.name,
      prompt: input.styleGuide.prompt,
      negativePrompt: input.styleGuide.negativePrompt,
      imageSize: input.styleGuide.imageSize,
    },
    generation: {
      ...input.base.generation,
      image: {
        ...input.base.generation.image,
        prompt: buildComposedPrompt(input.styleGuide, input.description),
        size: input.styleGuide.imageSize || "1024x1024",
      },
    },
  };
}

export function buildInitialPhysicsEditorState(meta: ForgePropMeta): ForgePhysicsEditorState {
  return {
    propId: meta.id,
    colliderPresetSelection: [],
    selectedColliderPresetId: meta.colliders?.selectedPresetId ?? null,
    kindId: meta.physics?.kind ?? "wood",
    physics: meta.physics?.resolved ?? {
      mobility: "auto",
      material: "wood",
      massMode: "auto",
      massScale: 1,
      manualMass: 1.8,
      friction: 0.72,
      restitution: 0.04,
      linearDamping: 0.26,
      angularDamping: 0.36,
      activationDelayMs: 500,
    },
  };
}
