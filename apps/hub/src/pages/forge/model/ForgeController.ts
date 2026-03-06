/**
 * ForgeController — business logic orchestrator.
 *
 * Owns the mesh rebuild pipeline, physics model loading, thumbnail feeding,
 * and debounced slider handling. Lives outside React and is independently
 * testable. React components call controller methods and subscribe to updates.
 */
import type * as THREE from "three";
import type { Dispatch } from "react";
import type { ForgeAction, ForgeStoreState } from "../state/forge-store";
import type { ForgeRuntimeRefs } from "../state/forge-context";
import type { ForgeGenerationDraftProp } from "../types";
import {
  processMesh,
  deepCloneWithMaterials,
  normalizeTransforms,
  type ForgeScaleMode,
} from "./MeshProcessor";
import type { AutoSaver } from "./AutoSaver";
import type { SharedModelCache } from "./SharedModelCache";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type PixelModelListener = (model: THREE.Group | null) => void;

// ---------------------------------------------------------------------------
// Controller
// ---------------------------------------------------------------------------

export class ForgeController {
  private disposed = false;
  private rebuildRaf: number | null = null;
  private physicsSyncTimer: ReturnType<typeof setTimeout> | null = null;
  private pixelModelListeners = new Set<PixelModelListener>();

  // Snapshot of state — updated every render via syncState()
  private state: ForgeStoreState | null = null;

  constructor(
    private getDispatch: () => Dispatch<ForgeAction>,
    private getRefs: () => ForgeRuntimeRefs,
    private modelCache: SharedModelCache,
    private autoSaver: AutoSaver,
  ) {}

  // ---------------------------------------------------------------------------
  // State sync — called every render from the provider
  // ---------------------------------------------------------------------------

  syncState(state: ForgeStoreState): void {
    this.state = state;
  }

  // ---------------------------------------------------------------------------
  // Mesh settings (debounced rebuild)
  // ---------------------------------------------------------------------------

  /**
   * Called by MeshSettings UI on slider/button changes.
   * 1. Immediately dispatches UPDATE_DRAFT (UI stays responsive)
   * 2. Debounces the actual rebuild by 250ms
   */
  setMeshSetting(draftId: string, patch: Partial<ForgeGenerationDraftProp>): void {
    this.getDispatch()({ type: "UPDATE_DRAFT", id: draftId, patch });
    this.scheduleRebuild();
  }

  // ---------------------------------------------------------------------------
  // Rebuild pipeline
  // ---------------------------------------------------------------------------

  /**
   * Trigger a rebuild of the selected draft's mesh preview.
   * Returns the pixel model for the PixelQuad component.
   */
  async rebuildSelectedDraft(): Promise<THREE.Group | null> {
    const state = this.state;
    if (!state) return null;

    const draftId = state.selectedDraftId;
    const draft = draftId ? state.drafts.get(draftId) ?? null : null;
    const refs = this.getRefs();
    const viewport = refs.generationViewport.current;

    if (!draft || !viewport || !draft.rawGlb) {
      refs.generationPixelBaseModel.current = null;
      viewport?.setModel(null);
      this.notifyPixelModel(null);
      return null;
    }

    const token = ++refs.previewBuildToken.current;
    let base = refs.baseModelCache.current.get(draft.tempId) ?? null;
    if (!base) {
      const parsed = await viewport.loadGlb(draft.rawGlb);
      normalizeTransforms(parsed);
      base = parsed;
      refs.baseModelCache.current.set(draft.tempId, parsed);
    }
    if (token !== refs.previewBuildToken.current) return null;

    const result = processMesh(base, {
      textureResolution: draft.textureResolution,
      pivot: draft.pivot,
      scaleMode: draft.scaleMode as ForgeScaleMode,
      targetDimension: draft.targetDimension,
    });

    // Preserve camera when replacing an existing model (settings change).
    // Only fit-to-object on the very first model load.
    const prevView = viewport.getModel() ? viewport.getViewState() : null;
    viewport.setModel(result.model);
    if (prevView) viewport.setViewState(prevView);
    refs.generationMeshViewState.current = viewport.getViewState();
    refs.generationPixelBaseModel.current = result.pixelModel;

    // Store in shared cache for cross-stage sync
    const propId = draft.tempId.startsWith("saved-") ? draft.tempId.slice("saved-".length) : draft.idSlug;
    this.modelCache.set(propId, "processed", result.model);

    this.getDispatch()({
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

    // Feed thumbnails
    this.feedMeshTabThumb(result.model);

    // Mark dirty for autosave
    if (draft.tempId.startsWith("saved-")) {
      this.autoSaver.markDirty(propId);
    }

    // Propagate to physics stage (debounced 500ms so slider drags don't
    // constantly restart the simulation)
    this.schedulePhysicsSync();

    this.notifyPixelModel(result.pixelModel);
    return result.pixelModel;
  }

  // ---------------------------------------------------------------------------
  // Physics model loading
  // ---------------------------------------------------------------------------

  /**
   * Load the physics model from shared cache (instant) or disk (fallback).
   * Called when activeStage switches to "phy" or when physicsSelectedPropId changes.
   */
  async loadPhysicsModel(propId: string): Promise<void> {
    const refs = this.getRefs();
    const viewport = refs.physicsMeshViewport.current;
    if (!viewport) return;

    // Try shared cache first (instant, no disk I/O)
    const cached = this.modelCache.get(propId, "processed");
    if (cached) {
      const clone = deepCloneWithMaterials(cached);
      viewport.setModel(clone);
      const bbox = viewport.getBBox();
      this.getDispatch()({ type: "SET_PHYSICS_BBOX", bbox });
      refs.physicsSimSourceModel.current = deepCloneWithMaterials(clone);
      return;
    }

    // Disk fallback — handled by PhysicsWorkspace effect
  }

  // ---------------------------------------------------------------------------
  // Thumbnail feeding
  // ---------------------------------------------------------------------------

  private feedMeshTabThumb(model: THREE.Group): void {
    const refs = this.getRefs();
    const thumb = refs.meshTabThumb.current;
    if (!thumb) return;
    thumb.setModel(deepCloneWithMaterials(model));
    thumb.setAxesVisible(false);
    const vs = thumb.getViewState();
    if (vs) thumb.setViewState({ ...vs, distance: vs.distance * 0.65 });
  }

  // ---------------------------------------------------------------------------
  // Pixel model subscription
  // ---------------------------------------------------------------------------

  subscribePixelModel(cb: PixelModelListener): () => void {
    this.pixelModelListeners.add(cb);
    return () => { this.pixelModelListeners.delete(cb); };
  }

  private notifyPixelModel(model: THREE.Group | null): void {
    for (const cb of this.pixelModelListeners) {
      cb(model);
    }
  }

  // ---------------------------------------------------------------------------
  // Debounce internals
  // ---------------------------------------------------------------------------

  private scheduleRebuild(): void {
    if (this.rebuildRaf !== null) {
      cancelAnimationFrame(this.rebuildRaf);
    }
    this.rebuildRaf = requestAnimationFrame(() => {
      this.rebuildRaf = null;
      void this.rebuildSelectedDraft();
    });
  }

  private schedulePhysicsSync(): void {
    if (this.physicsSyncTimer !== null) {
      clearTimeout(this.physicsSyncTimer);
    }
    this.physicsSyncTimer = setTimeout(() => {
      this.physicsSyncTimer = null;
      this.getDispatch()({ type: "INCREMENT_PHYSICS_MODEL_REVISION" });
    }, 500);
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  dispose(): void {
    this.disposed = true;
    if (this.rebuildRaf !== null) {
      cancelAnimationFrame(this.rebuildRaf);
      this.rebuildRaf = null;
    }
    if (this.physicsSyncTimer !== null) {
      clearTimeout(this.physicsSyncTimer);
      this.physicsSyncTimer = null;
    }
    this.pixelModelListeners.clear();
  }
}
