import { useCallback } from "react";
import { useForgeState, useForgeDispatch, useForgeRefs } from "../state/forge-context";
import { generateImage } from "../../forge/api/openai";
import { generateModel } from "../../forge/api/tripo";
import {
  type PivotPreset,
} from "../../forge/processing/dimensions";
import {
  buildColliderExportSceneFromParams,
  buildVhacdColliderForObject,
} from "../../forge/processing/collider-vhacd";
import { createColliderHelper } from "../../forge/processing/colliders";
import {
  normalizeForgePhysicsSettings,
} from "../../forge/processing/physics";
import {
  buildComposedPrompt,
  ensureSeedPresetFiles,
  exportObjectToGlb,
  listForgeV2PropIds,
  readColliderPresetFile,
  readForgeV2PropMeta,
  readPhysicsKindPresetFile,
  readPropRawConceptImage,
  readPropRawGlb,
  writeForgeV2PropMeta,
  writePropColliderGlb,
  writePropConceptImage,
  writePropProcessedModelGlb,
  writePropPrompt,
  writePropRawGlb,
  slugifyPropId,
  makePropBaseDir,
} from "../state/persistence";
import { createDefaultForgeV2Meta } from "../state/schema";
import {
  processMesh,
  normalizeTransforms,
  UNIT_SCALE_METERS_PER_UNIT,
  type ScaleModeV2,
} from "../model/MeshProcessor";
import type {
  ForgeV2ColliderResultEntry,
  ForgeV2GenerationDraftProp,
  ForgeV2PropMeta,
} from "../types";
import type { VhacdProgress } from "@common/collider-vhacd";
import { computeBBox, computePivotOffset } from "../../forge/processing/dimensions";

const DEFAULT_FACE_LIMIT = 5_000;

function formatVhacdProgress(progress: VhacdProgress): string {
  return `${progress.message} (${Math.round(progress.propProgress * 100)}%)`;
}

export function usePipelineActions() {
  const state = useForgeState();
  const dispatch = useForgeDispatch();
  const refs = useForgeRefs();

  const loadSavedPropIndex = useCallback(async () => {
    dispatch({ type: "SET_SAVED_LOADING", loading: true });
    try {
      const ids = await listForgeV2PropIds();
      const pairs = await Promise.all(
        ids.map(async (id) => {
          const [meta, conceptImage] = await Promise.all([
            readForgeV2PropMeta(id),
            readPropRawConceptImage(id),
          ]);
          return { meta, conceptImage };
        })
      );
      const items = pairs
        .filter((pair): pair is { meta: ForgeV2PropMeta; conceptImage: string | null } => pair.meta !== null)
        .map(({ meta, conceptImage }) => ({
          id: meta.id,
          description: meta.description,
          status: meta.lifecycle.status,
          conceptImage,
          generationApprovedAt: meta.lifecycle.generationApprovedAt,
          physicsApprovedAt: meta.lifecycle.physicsApprovedAt,
        }))
        .sort((a, b) => a.id.localeCompare(b.id));
      dispatch({ type: "SET_SAVED_PROPS", props: items });
    } finally {
      dispatch({ type: "SET_SAVED_LOADING", loading: false });
    }
  }, [dispatch]);

  const initialize = useCallback(async () => {
    await ensureSeedPresetFiles();
    const [colliderPresets, kindPresets] = await Promise.all([
      readColliderPresetFile(),
      readPhysicsKindPresetFile(),
    ]);
    dispatch({ type: "SET_COLLIDER_PRESETS", presets: colliderPresets });
    dispatch({ type: "SET_PHYSICS_KIND_PRESETS", presets: kindPresets });
    await loadSavedPropIndex();
  }, [dispatch, loadSavedPropIndex]);

  const loadPropIntoPipeline = useCallback(async (propId: string) => {
    const [meta, conceptImage] = await Promise.all([
      readForgeV2PropMeta(propId),
      readPropRawConceptImage(propId),
    ]);
    if (!meta) return;
    dispatch({ type: "LOAD_PROP_INTO_PIPELINE", meta, conceptImage });
  }, [dispatch]);

  const runImageGenerationForDraft = useCallback(async (
    draft: ForgeV2GenerationDraftProp,
    promptMode: "current-style" | "last-used"
  ) => {
    const token = (refs.imageJobTokens.current.get(draft.tempId) ?? 0) + 1;
    refs.imageJobTokens.current.set(draft.tempId, token);
    const composedPrompt =
      promptMode === "last-used" && draft.imageRevision > 0
        ? (draft as ForgeV2GenerationDraftProp & { lastPromptUsed?: string }).lastPromptUsed ?? buildComposedPrompt(state.styleGuide, draft.description)
        : buildComposedPrompt(state.styleGuide, draft.description);

    dispatch({ type: "UPDATE_DRAFT", id: draft.tempId, patch: { status: "generating-image", imageError: null, meshError: null } });
    dispatch({ type: "SET_STATUS_MESSAGE", message: `Generating image for ${draft.description}...` });

    try {
      const result = await generateImage(composedPrompt, state.styleGuide.imageSize || "1024x1024");
      if (refs.imageJobTokens.current.get(draft.tempId) !== token) return;
      let dataUrl: string;
      if (result.b64_json) {
        dataUrl = `data:image/png;base64,${result.b64_json}`;
      } else if (result.url) {
        const resp = await fetch(result.url);
        const blob = await resp.blob();
        dataUrl = await new Promise<string>((resolve) => {
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result as string);
          reader.readAsDataURL(blob);
        });
      } else {
        throw new Error("No image returned");
      }
      dispatch({
        type: "UPDATE_DRAFT",
        id: draft.tempId,
        patch: {
          conceptImage: dataUrl,
          status: "image-ready",
          imageRevision: draft.imageRevision + 1,
          imageError: null,
          rawGlb: null,
          meshRevision: 0,
          meshProgress: 0,
          meshProgressLabel: "idle",
        } as Partial<ForgeV2GenerationDraftProp>,
      });
      dispatch({ type: "SET_STATUS_MESSAGE", message: "" });

      // Update the ref stage artifact so the stage tab thumbnail refreshes
      dispatch({
        type: "SET_STAGE_ARTIFACT",
        stage: "ref",
        artifact: { conceptImage: dataUrl, imageRevision: draft.imageRevision + 1 },
      });

      // Persist image for saved (on-disk) props
      if (draft.tempId.startsWith("saved-")) {
        const idSlug = draft.tempId.slice("saved-".length);
        try {
          await writePropConceptImage(idSlug, dataUrl);
          const meta = await readForgeV2PropMeta(idSlug);
          if (meta) {
            meta.lifecycle.status = "image-ready";
            meta.generation.image.revision = draft.imageRevision + 1;
            meta.generation.image.generatedAt = new Date().toISOString();
            await writeForgeV2PropMeta(meta);
          }
          await loadSavedPropIndex();
        } catch {
          // persist is best-effort; image is already in draft state
        }
      }
    } catch (err) {
      if (refs.imageJobTokens.current.get(draft.tempId) !== token) return;
      const msg = err instanceof Error ? err.message : "Image generation failed";
      dispatch({
        type: "UPDATE_DRAFT",
        id: draft.tempId,
        patch: { status: draft.rawGlb ? "mesh-ready" : "draft", imageError: msg },
      });
      dispatch({ type: "SET_STATUS_ERROR", error: msg });
    }
  }, [dispatch, loadSavedPropIndex, refs, state.styleGuide]);

  const runMeshGenerationForDraft = useCallback(async (draft: ForgeV2GenerationDraftProp) => {
    if (!draft.conceptImage) return;
    const token = (refs.meshJobTokens.current.get(draft.tempId) ?? 0) + 1;
    refs.meshJobTokens.current.set(draft.tempId, token);
    refs.baseModelCache.current.delete(draft.tempId);

    dispatch({
      type: "UPDATE_DRAFT",
      id: draft.tempId,
      patch: { status: "generating-mesh", meshError: null, meshProgress: 0, meshProgressLabel: "Starting..." },
    });
    dispatch({ type: "SET_STATUS_MESSAGE", message: `Generating mesh for ${draft.description}...` });

    try {
      const resp = await fetch(draft.conceptImage);
      const blob = await resp.blob();
      const glb = await generateModel(blob, { faceLimit: draft.faceLimit, pbr: draft.pbr }, (progress, status) => {
        if (refs.meshJobTokens.current.get(draft.tempId) !== token) return;
        dispatch({
          type: "UPDATE_DRAFT",
          id: draft.tempId,
          patch: { meshProgress: Math.round(progress), meshProgressLabel: status },
        });
        dispatch({ type: "SET_STATUS_MESSAGE", message: `${draft.description}: ${status} (${Math.round(progress)}%)` });
      });
      if (refs.meshJobTokens.current.get(draft.tempId) !== token) return;
      dispatch({
        type: "UPDATE_DRAFT",
        id: draft.tempId,
        patch: { rawGlb: glb, status: "mesh-ready", meshRevision: draft.meshRevision + 1, meshProgress: 100, meshProgressLabel: "Done" },
      });
      dispatch({ type: "SET_STATUS_MESSAGE", message: "" });

      // Persist mesh for saved (on-disk) props
      if (draft.tempId.startsWith("saved-")) {
        const idSlug = draft.tempId.slice("saved-".length);
        try {
          await writePropRawGlb(idSlug, glb);
          const meta = await readForgeV2PropMeta(idSlug);
          if (meta) {
            meta.lifecycle.status = "mesh-ready";
            meta.generation.mesh.revision = draft.meshRevision + 1;
            meta.generation.mesh.generatedAt = new Date().toISOString();
            meta.generation.mesh.faceLimit = draft.faceLimit;
            meta.generation.mesh.pbr = draft.pbr;
            await writeForgeV2PropMeta(meta);
          }
          await loadSavedPropIndex();
        } catch {
          // persist is best-effort; mesh is already in draft state
        }
      }
    } catch (err) {
      if (refs.meshJobTokens.current.get(draft.tempId) !== token) return;
      const msg = err instanceof Error ? err.message : "3D generation failed";
      dispatch({
        type: "UPDATE_DRAFT",
        id: draft.tempId,
        patch: { status: draft.conceptImage ? "image-ready" : "draft", meshError: msg },
      });
      dispatch({ type: "SET_STATUS_ERROR", error: msg });
    }
  }, [dispatch, loadSavedPropIndex, refs]);

  const handleGenerateAllImages = useCallback(async () => {
    const queue = Array.from(state.drafts.values()).filter((item) => item.status === "draft" || item.status === "image-ready");
    if (queue.length <= 0) return;
    dispatch({ type: "SET_GENERATION_BUSY", patch: { images: true } });
    try {
      let nextIndex = 0;
      async function worker() {
        while (nextIndex < queue.length) {
          const current = nextIndex;
          nextIndex += 1;
          await runImageGenerationForDraft(queue[current], "current-style");
        }
      }
      await Promise.all(Array.from({ length: Math.min(4, queue.length) }, () => worker()));
    } finally {
      dispatch({ type: "SET_GENERATION_BUSY", patch: { images: false } });
    }
  }, [dispatch, runImageGenerationForDraft, state.drafts]);

  const handleGenerateAllMeshes = useCallback(async () => {
    const queue = Array.from(state.drafts.values()).filter((item) => item.conceptImage && (item.status === "image-ready" || item.status === "mesh-ready"));
    if (queue.length <= 0) return;
    dispatch({ type: "SET_GENERATION_BUSY", patch: { meshes: true } });
    try {
      let nextIndex = 0;
      async function worker() {
        while (nextIndex < queue.length) {
          const current = nextIndex;
          nextIndex += 1;
          await runMeshGenerationForDraft(queue[current]);
        }
      }
      await Promise.all(Array.from({ length: Math.min(3, queue.length) }, () => worker()));
    } finally {
      dispatch({ type: "SET_GENERATION_BUSY", patch: { meshes: false } });
    }
  }, [dispatch, runMeshGenerationForDraft, state.drafts]);

  const rebuildSelectedDraftPreview = useCallback(async () => {
    const draftId = state.selectedDraftId;
    const draft = draftId ? state.drafts.get(draftId) ?? null : null;
    const viewport = refs.generationViewport.current;
    if (!draft || !viewport || !draft.rawGlb) {
      refs.generationPixelBaseModel.current = null;
      viewport?.setModel(null);
      return { pixelModel: null };
    }

    const token = ++refs.previewBuildToken.current;
    let base = refs.baseModelCache.current.get(draft.tempId) ?? null;
    if (!base) {
      const parsed = await viewport.loadGlb(draft.rawGlb);
      normalizeTransforms(parsed);
      base = parsed;
      refs.baseModelCache.current.set(draft.tempId, parsed);
    }
    if (token !== refs.previewBuildToken.current) return { pixelModel: null };

    // Use pure processMesh pipeline
    const result = processMesh(base, {
      textureResolution: draft.textureResolution,
      pivot: draft.pivot,
      scaleMode: draft.scaleMode as ScaleModeV2,
      targetDimension: draft.targetDimension,
    });

    viewport.setModel(result.model);
    refs.generationMeshViewState.current = viewport.getViewState();
    refs.generationPixelBaseModel.current = result.pixelModel;

    // Store processed model in shared cache for cross-stage sync
    const propId = draft.tempId.startsWith("saved-") ? draft.tempId.slice("saved-".length) : draft.idSlug;
    refs.sharedModelCache.current.set(propId, "processed", result.model);

    dispatch({
      type: "UPDATE_DRAFT",
      id: draft.tempId,
      patch: {
        status: draft.status === "approved-generation" ? "approved-generation" : "mesh-ready",
        pivotOffset: result.pivotOffset,
        scale: result.scale,
        originalFaces: result.originalFaces,
        processedFaces: result.processedFaces,
        simplificationRatio: result.simplificationRatio,
        bboxProcessed: result.bbox,
      },
    });

    return { pixelModel: result.pixelModel };
  }, [dispatch, refs, state.drafts, state.selectedDraftId]);

  const persistProcessedMesh = useCallback(async () => {
    const draftId = state.selectedDraftId;
    const draft = draftId ? state.drafts.get(draftId) ?? null : null;
    if (!draft || !draft.tempId.startsWith("saved-") || !draft.rawGlb) return;
    const viewport = refs.generationViewport.current;
    const model = viewport?.getModel();
    if (!model) return;

    const idSlug = draft.tempId.slice("saved-".length);
    try {
      const processedGlb = await exportObjectToGlb(model);
      await writePropProcessedModelGlb(idSlug, processedGlb);

      const meta = await readForgeV2PropMeta(idSlug);
      if (meta) {
        meta.lifecycle.status = "generation-approved";
        meta.lifecycle.generationApprovedAt = new Date().toISOString();
        meta.processing.mesh.originalFaces = draft.originalFaces;
        meta.processing.mesh.processedFaces = draft.processedFaces;
        meta.processing.mesh.simplificationRatio = draft.simplificationRatio;
        meta.processing.mesh.textureResolution = draft.textureResolution;
        meta.processing.mesh.bboxProcessed = draft.bboxProcessed ?? undefined;
        meta.processing.transform.scale = [draft.scale, draft.scale, draft.scale];
        meta.processing.transform.provisionalPivot = {
          preset: draft.pivot,
          offset: draft.pivotOffset,
          basis: "mesh",
        };
        meta.processing.transform.targetDimension = {
          method: draft.scaleMode,
          value: draft.targetDimension,
        } as ForgeV2PropMeta["processing"]["transform"]["targetDimension"];
        await writeForgeV2PropMeta(meta);
      }

      dispatch({
        type: "UPDATE_DRAFT",
        id: draft.tempId,
        patch: { status: "approved-generation", generationApprovedAt: meta?.lifecycle.generationApprovedAt },
      });
      await loadSavedPropIndex();
    } catch {
      // best-effort
    }
  }, [dispatch, loadSavedPropIndex, refs, state.drafts, state.selectedDraftId]);

  const approveSelectedDraftGeneration = useCallback(async () => {
    const draftId = state.selectedDraftId;
    const draft = draftId ? state.drafts.get(draftId) ?? null : null;
    const viewport = refs.generationViewport.current;
    if (!draft || !viewport) return;
    const model = viewport.getModel();
    if (!model || !draft.rawGlb || !draft.conceptImage) return;

    const composedPrompt =
      (draft as ForgeV2GenerationDraftProp & { lastPromptUsed?: string }).lastPromptUsed ??
      buildComposedPrompt(state.styleGuide, draft.description);
    const pixelViewState = refs.generationPixelBaseViewState.current;

    const meta = createDefaultForgeV2Meta({
      id: draft.idSlug,
      description: draft.description,
      styleGuide: state.styleGuide,
      composedPrompt,
      faceLimit: draft.faceLimit,
      pbr: draft.pbr,
    });
    meta.lifecycle.status = "generation-approved";
    meta.lifecycle.generationApprovedAt = new Date().toISOString();
    meta.generation.image.revision = draft.imageRevision;
    meta.generation.image.generatedAt = draft.imageRevision > 0 ? new Date().toISOString() : undefined;
    meta.generation.mesh.faceLimit = draft.faceLimit;
    meta.generation.mesh.pbr = draft.pbr;
    meta.generation.mesh.revision = draft.meshRevision;
    meta.generation.mesh.generatedAt = draft.meshRevision > 0 ? new Date().toISOString() : undefined;
    meta.processing.mesh.originalFaces = draft.originalFaces;
    meta.processing.mesh.processedFaces = draft.processedFaces;
    meta.processing.mesh.simplificationRatio = draft.simplificationRatio;
    meta.processing.mesh.textureResolution = draft.textureResolution;
    meta.processing.mesh.bboxProcessed = draft.bboxProcessed ?? undefined;
    meta.processing.transform.unitScaleMetersPerUnit = UNIT_SCALE_METERS_PER_UNIT;
    meta.processing.transform.targetDimension = {
      method: draft.scaleMode,
      value: draft.targetDimension,
    } as ForgeV2PropMeta["processing"]["transform"]["targetDimension"];
    meta.processing.transform.scale = [draft.scale, draft.scale, draft.scale];
    meta.processing.transform.provisionalPivot = {
      preset: draft.pivot,
      offset: draft.pivotOffset,
      basis: "mesh",
    };
    meta.pixelPreview.cameraSyncState = {
      target: pixelViewState.target,
      yawTurns: pixelViewState.yawTurns,
      zoomLevel: Math.round(pixelViewState.zoom),
    };

    dispatch({ type: "SET_STATUS_MESSAGE", message: `Saving ${draft.description}...` });

    await writePropConceptImage(draft.idSlug, draft.conceptImage);
    await writePropPrompt(draft.idSlug, composedPrompt);
    await writePropRawGlb(draft.idSlug, draft.rawGlb);
    const processedGlb = await exportObjectToGlb(model);
    await writePropProcessedModelGlb(draft.idSlug, processedGlb);
    await writeForgeV2PropMeta(meta);

    dispatch({
      type: "UPDATE_DRAFT",
      id: draft.tempId,
      patch: { status: "approved-generation", generationApprovedAt: meta.lifecycle.generationApprovedAt },
    });
    dispatch({ type: "SET_STATUS_MESSAGE", message: "" });
    await loadSavedPropIndex();
  }, [dispatch, loadSavedPropIndex, refs, state.drafts, state.selectedDraftId, state.styleGuide]);

  const loadPhysicsProp = useCallback(async (propId: string) => {
    const meta = await readForgeV2PropMeta(propId);
    if (!meta) return;
    const conceptImage = await readPropRawConceptImage(propId);
    dispatch({ type: "SET_PHYSICS_PROP", propId, meta, conceptImage });
  }, [dispatch]);

  const computeSelectedPhysicsColliders = useCallback(async () => {
    if (!state.physicsSelectedPropId || !state.colliderPresets) return;
    const sourceViewport = refs.physicsMeshViewport.current;
    const sourceModel = sourceViewport?.getModel();
    if (!sourceViewport || !sourceModel) {
      dispatch({
        type: "SET_PHYSICS_BUILD_STATE",
        state: { running: false, progressText: "idle", statusText: "Load a prop mesh first.", error: "No source model loaded" },
      });
      return;
    }
    const allPresets = state.colliderPresets.presets;
    if (allPresets.length <= 0) {
      dispatch({
        type: "SET_PHYSICS_BUILD_STATE",
        state: { ...state.physicsColliderBuildState, error: "No collider presets defined." },
      });
      return;
    }

    refs.vhacdRunner.current.restart("Forge V2 collider recompute");
    dispatch({
      type: "SET_PHYSICS_BUILD_STATE",
      state: { running: true, progressText: "starting...", statusText: `Running ${allPresets.length} collider preset(s)...`, error: null },
    });

    const entries: ForgeV2ColliderResultEntry[] = [];
    try {
      for (let i = 0; i < allPresets.length; i += 1) {
        const preset = allPresets[i];
        dispatch({
          type: "SET_PHYSICS_BUILD_STATE",
          state: {
            running: true,
            progressText: state.physicsColliderBuildState.progressText,
            statusText: `Running ${preset.name} (${i + 1}/${allPresets.length})...`,
            error: null,
          },
        });
        const clone = sourceModel.clone(true);
        const built = await buildVhacdColliderForObject({
          sourceModel: clone,
          presetName: preset.name,
          inputOptions: preset.options,
          runner: refs.vhacdRunner.current,
          onProgress: (progress: VhacdProgress) => {
            dispatch({
              type: "SET_PHYSICS_BUILD_STATE",
              state: {
                running: true,
                progressText: `${preset.name}: ${formatVhacdProgress(progress)}`,
                statusText: `Running ${preset.name} (${i + 1}/${allPresets.length})...`,
                error: null,
              },
            });
          },
        });
        entries.push({
          presetId: preset.id,
          presetName: preset.name,
          enabled: true,
          file: `${makePropBaseDir(state.physicsSelectedPropId)}/processed/colliders/${preset.id}.glb`,
          collider: built.collider,
          generation: built.metadata,
        });
      }
      const currentDraft = state.selectedDraftId ? state.drafts.get(state.selectedDraftId) ?? null : null;
      dispatch({ type: "SET_PHYSICS_COLLIDER_RESULTS", results: entries, baseScale: currentDraft?.scale ?? 1 });
      // Auto-select default preset
      const defaultId = state.colliderPresets.defaultPresetId;
      const defaultEntry = entries.find((e) => e.presetId === defaultId) ?? entries[0];
      if (defaultEntry) {
        dispatch({ type: "SET_PHYSICS_SELECTED_COLLIDER", presetId: defaultEntry.presetId });
      }
      dispatch({
        type: "SET_PHYSICS_BUILD_STATE",
        state: { running: false, progressText: "done", statusText: `Computed ${entries.length} collider preset(s).`, error: null },
      });

      // Auto-persist (approve) physics setup
      await autoApprovePhysics({
        entries,
        selectedPresetId: defaultEntry?.presetId ?? entries[0]?.presetId ?? null,
      });
    } catch (err) {
      dispatch({
        type: "SET_PHYSICS_BUILD_STATE",
        state: { running: false, progressText: "failed", statusText: "Collider generation failed.", error: err instanceof Error ? err.message : "VHACD failed" },
      });
    }
  }, [dispatch, refs, state.colliderPresets, state.physicsColliderBuildState, state.physicsSelectedPropId]);

  // Auto-persist physics setup (called after collider compute, collider selection change, or kind change)
  // Accepts optional overrides for values that were just dispatched (not yet in state).
  const autoApprovePhysics = useCallback(async (opts?: {
    entries?: ForgeV2ColliderResultEntry[];
    selectedPresetId?: string | null;
    kindId?: string;
    settings?: ReturnType<typeof normalizeForgePhysicsSettings>;
  }) => {
    if (!state.physicsSelectedPropId) return;
    const baseMeta = await readForgeV2PropMeta(state.physicsSelectedPropId);
    if (!baseMeta) return;
    const colliderResults = opts?.entries ?? state.physicsColliderResults;
    const selId = opts?.selectedPresetId ?? state.physicsSelectedColliderPresetId;
    const kindId = opts?.kindId ?? state.physicsSelectedKindId;
    const physSettings = opts?.settings ?? state.physicsSettings;
    const selectedCollider =
      colliderResults.find((entry) => entry.presetId === selId) ??
      colliderResults[0] ?? null;
    if (!selectedCollider || colliderResults.length <= 0) return;

    for (const entry of colliderResults) {
      const scene = buildColliderExportSceneFromParams(entry.collider);
      const buffer = await exportObjectToGlb(scene);
      const rel = await writePropColliderGlb(state.physicsSelectedPropId, entry.presetId, buffer);
      entry.file = rel;
    }

    const colliderHelper = createColliderHelper(selectedCollider.collider);
    const colliderBBox = computeBBox(colliderHelper);
    const finalPivotOffset = computePivotOffset(colliderBBox, "bottom-center");

    const resolvedPhysics = normalizeForgePhysicsSettings(physSettings, state.physicsBBox);
    const previousResolved = baseMeta.physics?.resolved ?? null;
    const overrides: Partial<typeof resolvedPhysics> = {};
    if (previousResolved) {
      (Object.keys(resolvedPhysics) as Array<keyof typeof resolvedPhysics>).forEach((key) => {
        if (resolvedPhysics[key] !== previousResolved[key]) {
          (overrides as Record<string, unknown>)[key] = resolvedPhysics[key];
        }
      });
    }

    baseMeta.colliders = {
      selectedPresetId: selectedCollider.presetId,
      presets: colliderResults,
    };
    baseMeta.physics = {
      kind: kindId,
      overrides,
      resolved: resolvedPhysics,
      simulationChecks: {
        floorDrop: { scenario: "floorDrop", ...refs.physicsSimMetrics.current.floorDrop },
        slope30Drop: { scenario: "slope30Drop", ...refs.physicsSimMetrics.current.slope30Drop },
        edgeDrop: { scenario: "edgeDrop", ...refs.physicsSimMetrics.current.edgeDrop },
      },
    };
    baseMeta.processing.transform.finalPivot = {
      preset: "bottom-center",
      offset: [finalPivotOffset.x, finalPivotOffset.y, finalPivotOffset.z],
      basis: "collider",
      colliderPresetId: selectedCollider.presetId,
    };
    baseMeta.lifecycle.status = "physics-approved";
    baseMeta.lifecycle.physicsApprovedAt = new Date().toISOString();

    await writeForgeV2PropMeta(baseMeta);
    dispatch({ type: "SET_PHYSICS_PROP", propId: state.physicsSelectedPropId, meta: baseMeta, conceptImage: state.physicsConceptImage });
    await loadSavedPropIndex();
  }, [dispatch, loadSavedPropIndex, refs, state]);

  const addBatchDrafts = useCallback(() => {
    const lines = state.batchText
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    if (lines.length <= 0) return;
    const items = lines.map((line) => {
      const now = Date.now();
      const tempId = `draft-${now}-${Math.floor(Math.random() * 1000)}`;
      const slug = slugifyPropId(line) || `prop-${now}`;
      return {
        tempId,
        idSlug: slug,
        description: line,
        status: "draft" as const,
        conceptImage: null,
        rawGlb: null,
        imageError: null,
        meshError: null,
        imageRevision: 0,
        meshRevision: 0,
        meshProgress: 0,
        meshProgressLabel: "idle",
        faceLimit: state.defaultFaceLimit,
        pbr: true,
        textureResolution: 128,
        scaleMode: "max" as const,
        targetDimension: 1,
        scale: 1,
        pivot: "bottom-center" as PivotPreset,
        pivotOffset: [0, 0, 0] as [number, number, number],
        originalFaces: 0,
        processedFaces: 0,
        simplificationRatio: 1,
        bboxProcessed: null,
        pixelCamera: { target: [0, 0, 0] as [number, number, number], yawTurns: 0, zoomLevel: 1 },
      };
    });
    dispatch({ type: "ADD_DRAFTS", drafts: items });
    dispatch({ type: "SET_BATCH_TEXT", text: "" });
  }, [dispatch, state.batchText, state.defaultFaceLimit]);

  const selectProp = useCallback(async (propId: string) => {
    const [meta, conceptImage, rawGlb] = await Promise.all([
      readForgeV2PropMeta(propId),
      readPropRawConceptImage(propId),
      readPropRawGlb(propId),
    ]);
    if (!meta) return;

    // Set stage states from persisted meta
    dispatch({ type: "LOAD_PROP_INTO_PIPELINE", meta, conceptImage });

    // Create a working draft for operations (generate, approve, etc.)
    const tempId = `saved-${propId}`;
    const scaleModeRaw = meta.processing.transform.targetDimension.method;
    const scaleMode: ScaleModeV2 =
      scaleModeRaw === "width" || scaleModeRaw === "height" || scaleModeRaw === "max" || scaleModeRaw === "manual" || scaleModeRaw === "depth"
        ? scaleModeRaw
        : "max";

    const draft: ForgeV2GenerationDraftProp = {
      tempId,
      idSlug: propId,
      description: meta.description,
      status:
        rawGlb && conceptImage
          ? meta.lifecycle.status === "generation-approved" || meta.lifecycle.status === "physics-approved"
            ? "approved-generation"
            : "mesh-ready"
          : conceptImage
            ? "image-ready"
            : "draft",
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
      generationApprovedAt: meta.lifecycle.generationApprovedAt,
    };

    // Replace all drafts with just this prop
    dispatch({ type: "CLEAR_DRAFTS" });
    dispatch({ type: "ADD_DRAFTS", drafts: [draft] });
    dispatch({ type: "SELECT_DRAFT", id: tempId });

    // Also load physics data if available, otherwise clear stale physics state
    if (meta.lifecycle.status === "generation-approved" || meta.lifecycle.status === "physics-approved") {
      dispatch({ type: "SET_PHYSICS_PROP", propId, meta, conceptImage });
    } else {
      dispatch({ type: "CLEAR_PHYSICS_PROP" });
    }

    refs.zoomSyncScale.current = null;
  }, [dispatch, refs]);

  const createPropPlaceholders = useCallback(async () => {
    const lines = state.batchText
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    if (lines.length <= 0) return;

    const created: string[] = [];
    const errors: { id: string; error: string }[] = [];

    for (const line of lines) {
      const id = slugifyPropId(line) || `prop-${Date.now()}`;
      const composedPrompt = buildComposedPrompt(state.styleGuide, line);
      const meta = createDefaultForgeV2Meta({
        id,
        description: line,
        styleGuide: state.styleGuide,
        composedPrompt,
        faceLimit: state.defaultFaceLimit,
        pbr: true,
      });
      try {
        await writeForgeV2PropMeta(meta);
        created.push(id);
      } catch (err) {
        errors.push({ id, error: err instanceof Error ? err.message : "Unknown error" });
      }
    }

    dispatch({ type: "SET_BATCH_TEXT", text: "" });

    if (errors.length > 0) {
      const errMsg = errors.map((e) => `${e.id}: ${e.error}`).join("; ");
      dispatch({ type: "SET_STATUS_ERROR", error: `Failed to create ${errors.length} prop(s): ${errMsg}` });
    }
    if (created.length > 0) {
      dispatch({ type: "SET_STATUS_MESSAGE", message: `Created ${created.length} prop placeholder(s)` });
    }

    await loadSavedPropIndex();

    // Auto-select first created prop
    if (created.length > 0) {
      await selectProp(created[0]);
    }
  }, [dispatch, loadSavedPropIndex, selectProp, state.batchText, state.defaultFaceLimit, state.styleGuide]);

  const importSavedPropIntoGeneration = useCallback(async (propId: string) => {
    const [meta, conceptImage, rawGlb] = await Promise.all([
      readForgeV2PropMeta(propId),
      readPropRawConceptImage(propId),
      readPropRawGlb(propId),
    ]);
    if (!meta) return;
    const tempId = `saved-${propId}`;
    const scaleModeRaw = meta.processing.transform.targetDimension.method;
    const scaleMode: ScaleModeV2 =
      scaleModeRaw === "width" || scaleModeRaw === "height" || scaleModeRaw === "max" || scaleModeRaw === "manual" || scaleModeRaw === "depth"
        ? scaleModeRaw
        : "max";

    const draft: ForgeV2GenerationDraftProp = {
      tempId,
      idSlug: propId,
      description: meta.description,
      status:
        rawGlb && conceptImage
          ? meta.lifecycle.status === "generation-approved" || meta.lifecycle.status === "physics-approved"
            ? "approved-generation"
            : "mesh-ready"
          : conceptImage
            ? "image-ready"
            : "draft",
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
      generationApprovedAt: meta.lifecycle.generationApprovedAt,
    };

    dispatch({ type: "ADD_DRAFTS", drafts: [draft] });
    dispatch({ type: "SELECT_DRAFT", id: tempId });
    refs.zoomSyncScale.current = null;
  }, [dispatch, refs]);

  return {
    initialize,
    loadSavedPropIndex,
    loadPropIntoPipeline,
    selectProp,
    runImageGenerationForDraft,
    runMeshGenerationForDraft,
    handleGenerateAllImages,
    handleGenerateAllMeshes,
    rebuildSelectedDraftPreview,
    persistProcessedMesh,
    approveSelectedDraftGeneration,
    loadPhysicsProp,
    computeSelectedPhysicsColliders,
    autoApprovePhysics,
    addBatchDrafts,
    createPropPlaceholders,
    importSavedPropIntoGeneration,
  };
}
