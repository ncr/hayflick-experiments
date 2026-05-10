import { useCallback } from "react";
import { useForgeState, useForgeDispatch, useForgeRefs } from "../state/forge-context";
import { generateImage } from "../shared/api/openai";
import { generateModel } from "../shared/api/tripo";
import {
  type PivotPreset,
} from "../shared/processing/dimensions";
import {
  buildColliderExportSceneFromParams,
  buildVhacdColliderForObject,
} from "../shared/processing/collider-vhacd";
import { createColliderHelper } from "../shared/processing/colliders";
import {
  normalizeForgePhysicsSettings,
} from "../shared/processing/physics";
import { buildComposedPrompt, exportObjectToGlb, slugifyPropId } from "../io/forge-helpers";
import {
  createForgeProp,
  getForgeProp,
  getPropConceptImageUrl,
  listForgeProps,
  readColliderPresetFile,
  readPhysicsKindPresetFile,
  readPropRawGlb,
  saveMeshStage,
  savePhysicsStage,
  saveReferenceStage,
} from "../io/forge-client";
import { createDefaultForgeMeta } from "../state/schema";
import {
  processMesh,
  normalizeTransforms,
  type ForgeScaleMode,
} from "../model/MeshProcessor";
import type {
  ForgeColliderResultEntry,
  ForgeGenerationDraftProp,
} from "../types";
import type { VhacdProgress } from "@common/collider-vhacd";
import { computeBBox, computePivotOffset } from "../shared/processing/dimensions";
import {
  applyDraftMeshToMeta,
  applyDraftReferenceToMeta,
  applyPhysicsToMeta,
  canLoadPhysicsForLifecycle,
  draftFromSavedProp,
} from "../model/prop-mappers";

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
      const items = (await listForgeProps()).map((item) => ({
        id: item.id,
        description: item.description,
        status: item.status,
        conceptImage: item.hasConceptImage ? getPropConceptImageUrl(item.id) : null,
        createdAt: item.createdAt,
        updatedAt: item.updatedAt,
      }));
      dispatch({ type: "SET_SAVED_PROPS", props: items });
    } finally {
      dispatch({ type: "SET_SAVED_LOADING", loading: false });
    }
  }, [dispatch]);

  const initialize = useCallback(async () => {
    const [colliderPresets, kindPresets] = await Promise.all([
      readColliderPresetFile(),
      readPhysicsKindPresetFile(),
    ]);
    dispatch({ type: "SET_COLLIDER_PRESETS", presets: colliderPresets });
    dispatch({ type: "SET_PHYSICS_KIND_PRESETS", presets: kindPresets });
    await loadSavedPropIndex();
  }, [dispatch, loadSavedPropIndex]);

  const loadPropIntoPipeline = useCallback(async (propId: string) => {
    const record = await getForgeProp(propId);
    if (!record) return;
    dispatch({
      type: "LOAD_PROP_INTO_PIPELINE",
      meta: record.meta,
      conceptImage: record.hasConceptImage ? getPropConceptImageUrl(propId) : null,
    });
  }, [dispatch]);

  const runImageGenerationForDraft = useCallback(async (
    draft: ForgeGenerationDraftProp,
    promptMode: "current-style" | "last-used"
  ) => {
    const token = (refs.imageJobTokens.current.get(draft.tempId) ?? 0) + 1;
    refs.imageJobTokens.current.set(draft.tempId, token);
    const composedPrompt =
      promptMode === "last-used" && draft.imageRevision > 0
        ? (draft as ForgeGenerationDraftProp & { lastPromptUsed?: string }).lastPromptUsed ?? buildComposedPrompt(state.styleGuide, draft.description)
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
        } as Partial<ForgeGenerationDraftProp>,
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
          const record = await getForgeProp(idSlug);
          if (record) {
            const composedPrompt = (draft as ForgeGenerationDraftProp & { lastPromptUsed?: string }).lastPromptUsed
              ?? buildComposedPrompt(state.styleGuide, draft.description);
            const nextMeta = applyDraftReferenceToMeta(
              record.meta,
              {
                ...draft,
                conceptImage: dataUrl,
                imageRevision: draft.imageRevision + 1,
              },
              state.styleGuide,
              composedPrompt
            );
            await saveReferenceStage({
              propId: idSlug,
              meta: nextMeta,
              conceptImageDataUrl: dataUrl,
              prompt: composedPrompt,
            });
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

  const runMeshGenerationForDraft = useCallback(async (draft: ForgeGenerationDraftProp) => {
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
          const record = await getForgeProp(idSlug);
          if (record) {
            const nextMeta = applyDraftMeshToMeta(
              record.meta,
              {
                ...draft,
                rawGlb: glb,
                meshRevision: draft.meshRevision + 1,
              },
              refs.generationPixelBaseViewState.current
            );
            await saveMeshStage({
              propId: idSlug,
              meta: nextMeta,
              rawGlb: glb,
            });
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
      scaleMode: draft.scaleMode as ForgeScaleMode,
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
        status: "mesh-ready",
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

    refs.vhacdRunner.current.restart("Forge collider recompute");
    dispatch({
      type: "SET_PHYSICS_BUILD_STATE",
      state: { running: true, progressText: "starting...", statusText: `Running ${allPresets.length} collider preset(s)...`, error: null },
    });

    const entries: ForgeColliderResultEntry[] = [];
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
          file: `processed/colliders/${preset.id}.glb`,
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

      await persistPhysicsState({
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

  // Persist physics state after collider compute, collider selection, or kind changes.
  // Accepts optional overrides for values that were just dispatched (not yet in state).
  const persistPhysicsState = useCallback(async (opts?: {
    entries?: ForgeColliderResultEntry[];
    selectedPresetId?: string | null;
    kindId?: string;
    settings?: ReturnType<typeof normalizeForgePhysicsSettings>;
  }) => {
    if (!state.physicsSelectedPropId) return;
    const record = await getForgeProp(state.physicsSelectedPropId);
    if (!record) return;
    const baseMeta = record.meta;
    const colliderResults = opts?.entries ?? state.physicsColliderResults;
    const selId = opts?.selectedPresetId ?? state.physicsSelectedColliderPresetId;
    const kindId = opts?.kindId ?? state.physicsSelectedKindId;
    const physSettings = opts?.settings ?? state.physicsSettings;
    const selectedCollider =
      colliderResults.find((entry) => entry.presetId === selId) ??
      colliderResults[0] ?? null;
    if (!selectedCollider || colliderResults.length <= 0) return;

    const colliderGlbs: Array<{ presetId: string; glb: ArrayBuffer }> = [];
    for (const entry of colliderResults) {
      const scene = buildColliderExportSceneFromParams(entry.collider);
      const buffer = await exportObjectToGlb(scene);
      colliderGlbs.push({ presetId: entry.presetId, glb: buffer });
      entry.file = `processed/colliders/${entry.presetId}.glb`;
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

    const nextMeta = applyPhysicsToMeta(baseMeta, {
      selectedPresetId: selectedCollider.presetId,
      colliderResults,
      physics: {
        kind: kindId,
        overrides,
        resolved: resolvedPhysics,
        simulationChecks: {
          floorDrop: { scenario: "floorDrop", ...refs.physicsSimMetrics.current.floorDrop },
          slope30Drop: { scenario: "slope30Drop", ...refs.physicsSimMetrics.current.slope30Drop },
          edgeDrop: { scenario: "edgeDrop", ...refs.physicsSimMetrics.current.edgeDrop },
        },
      },
      finalPivotOffset: [finalPivotOffset.x, finalPivotOffset.y, finalPivotOffset.z],
    });

    await savePhysicsStage({
      propId: state.physicsSelectedPropId,
      meta: nextMeta,
      colliderGlbs,
    });
    dispatch({
      type: "SET_PHYSICS_PROP",
      propId: state.physicsSelectedPropId,
      meta: nextMeta,
      conceptImage: state.physicsConceptImage,
    });
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
    await refs.autoSaver.current.flush();
    const [record, rawGlb] = await Promise.all([
      getForgeProp(propId),
      readPropRawGlb(propId),
    ]);
    if (!record) return;
    const conceptImage = record.hasConceptImage ? getPropConceptImageUrl(propId) : null;
    const meta = record.meta;

    // Set stage states from persisted meta
    dispatch({ type: "LOAD_PROP_INTO_PIPELINE", meta, conceptImage });

    const draft = draftFromSavedProp({ meta, conceptImage, rawGlb });

    // Replace all drafts with just this prop
    dispatch({ type: "CLEAR_DRAFTS" });
    dispatch({ type: "ADD_DRAFTS", drafts: [draft] });
    dispatch({ type: "SELECT_DRAFT", id: draft.tempId });

    // Also load physics data if available, otherwise clear stale physics state
    if (canLoadPhysicsForLifecycle(meta.lifecycle.status)) {
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
      const meta = createDefaultForgeMeta({
        id,
        description: line,
        styleGuide: state.styleGuide,
        composedPrompt,
        faceLimit: state.defaultFaceLimit,
        pbr: true,
      });
      try {
        await createForgeProp(meta);
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
    const [record, rawGlb] = await Promise.all([
      getForgeProp(propId),
      readPropRawGlb(propId),
    ]);
    if (!record) return;
    const conceptImage = record.hasConceptImage ? getPropConceptImageUrl(propId) : null;
    const draft = draftFromSavedProp({ meta: record.meta, conceptImage, rawGlb });

    dispatch({ type: "ADD_DRAFTS", drafts: [draft] });
    dispatch({ type: "SELECT_DRAFT", id: draft.tempId });
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
    computeSelectedPhysicsColliders,
    persistPhysicsState,
    addBatchDrafts,
    createPropPlaceholders,
    importSavedPropIntoGeneration,
  };
}
