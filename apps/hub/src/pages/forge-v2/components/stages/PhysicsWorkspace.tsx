import { useCallback, useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { useForgeState, useForgeDispatch, useForgeRefs } from "../../state/forge-context";
import { usePipelineActions } from "../../hooks/usePipelineActions";
import { usePhysicsSimulation } from "../../hooks/usePhysicsSimulation";
import {
  ForgeScissorViewportPane,
  ForgeScissorViewportStage,
} from "../../ScissorViewport3d";
import { PixelQuad } from "../../PixelQuad";
import { PhysicsPanel } from "../../../forge/PhysicsPanel";
import {
  normalizeForgePhysicsSettings,
  resolveForgeMass,
} from "../../../forge/processing/physics";
import { computeBBox, normalizeTransforms } from "../../../forge/processing/dimensions";
import { createColliderHelper, scaleColliderParams } from "../../../forge/processing/colliders";
import { readPropProcessedModelGlb, readPropRawGlb } from "../../state/persistence";
import { deepCloneWithMaterials } from "../../model/MeshProcessor";
import type { PixelViewportViewState } from "../../../forge/ViewportPixel";
import type { Viewport3dViewState } from "../../../forge/Viewport";
import type { ForgeV2PhysicsKindPresetFile } from "../../types";

type PhysicsPreviewScenario = "floorDrop" | "slope30Drop" | "edgeDrop";
const PHYSICS_SCENARIOS: PhysicsPreviewScenario[] = ["floorDrop", "slope30Drop", "edgeDrop"];
const PHYSICS_SCENARIO_LABELS: Record<PhysicsPreviewScenario, string> = {
  floorDrop: "Floor Drop",
  slope30Drop: "30deg Slope",
  edgeDrop: "Edge Drop",
};

function buildPhysicsSettingsFromKind(kind: ForgeV2PhysicsKindPresetFile["kinds"][number]) {
  return normalizeForgePhysicsSettings(
    {
      mobility: kind.mobility,
      material: kind.material,
      massMode: kind.massMode,
      massScale: kind.massScale,
      manualMass: kind.manualMass,
      friction: kind.friction,
      restitution: kind.restitution,
      linearDamping: kind.linearDamping,
      angularDamping: kind.angularDamping,
      activationDelayMs: kind.activationDelayMs,
    },
    null
  );
}

export function PhysicsWorkspace() {
  const state = useForgeState();
  const dispatch = useForgeDispatch();
  const refs = useForgeRefs();
  const actions = usePipelineActions();

  const [simPixelModels, setSimPixelModels] = useState<Record<PhysicsPreviewScenario, THREE.Group | null>>({
    floorDrop: null,
    slope30Drop: null,
    edgeDrop: null,
  });
  const [simPixelBaseViewStates, setSimPixelBaseViewStates] = useState<
    Record<PhysicsPreviewScenario, PixelViewportViewState>
  >({
    floorDrop: { target: [0, 0, 0], yawTurns: 0, zoom: 1 },
    slope30Drop: { target: [0, 0, 0], yawTurns: 0, zoom: 1 },
    edgeDrop: { target: [0, 0, 0], yawTurns: 0, zoom: 1 },
  });

  // Load model into physics viewport when prop changes
  useEffect(() => {
    // Clear the tab thumbnail immediately so stale colliders don't linger
    // while the new prop loads.  The thumb effect below will repopulate
    // once collider results are available for the new prop.
    const thumb = refs.physicsTabThumb.current;
    if (thumb) {
      thumb.setModel(null);
      thumb.setColliderPreviewObject(null);
    }

    // Reset captured sim camera so next sim setup re-seeds from mesh view
    refs.physicsSimMeshViewState.current = null;

    const viewport = refs.physicsMeshViewport.current;
    if (!viewport || !state.physicsSelectedPropId) {
      viewport?.setModel(null);
      refs.physicsSimSourceModel.current = null;
      return;
    }

    let active = true;
    const propId = state.physicsSelectedPropId;

    // Try shared model cache first (instant, no disk I/O)
    const cached = refs.sharedModelCache.current.get(propId, "processed");
    if (cached) {
      const clone = deepCloneWithMaterials(cached);
      viewport.setModel(clone);
      const bbox = viewport.getBBox();
      dispatch({ type: "SET_PHYSICS_BBOX", bbox });
      refs.physicsSimSourceModel.current = deepCloneWithMaterials(clone);
      return;
    }

    // Disk fallback
    void (async () => {
      const [processedGlb, rawGlb] = await Promise.all([
        readPropProcessedModelGlb(propId),
        readPropRawGlb(propId),
      ]);
      if (!active) return;
      const glb = processedGlb ?? rawGlb;
      if (!glb) {
        viewport.setModel(null);
        refs.physicsSimSourceModel.current = null;
        return;
      }
      const group = await viewport.loadGlb(glb);
      if (!active) return;
      if (!processedGlb) normalizeTransforms(group);

      // Old processed GLBs may be missing the root scale transform (the
      // GLTFExporter used to drop scene-level transforms). Detect this by
      // comparing the loaded bbox with bboxProcessed from meta and apply
      // the meta scale if the loaded model is significantly larger.
      if (processedGlb && state.physicsMeta) {
        const bp = state.physicsMeta.processing?.mesh?.bboxProcessed;
        const metaScale = state.physicsMeta.processing?.transform?.scale;
        if (bp && metaScale && metaScale[0] < 0.99) {
          const loadedBbox = computeBBox(group);
          if (loadedBbox) {
            const loadedMax = Math.max(loadedBbox.width, loadedBbox.height, loadedBbox.depth);
            const processedMax = Math.max(bp.width ?? 0, bp.height ?? 0, bp.depth ?? 0);
            if (processedMax > 0 && loadedMax > processedMax * 1.5) {
              group.scale.set(metaScale[0], metaScale[1], metaScale[2]);
              group.updateMatrixWorld(true);
            }
          }
        }
      }

      viewport.setModel(group);
      const bbox = viewport.getBBox();
      dispatch({ type: "SET_PHYSICS_BBOX", bbox });
      refs.physicsSimSourceModel.current = deepCloneWithMaterials(group);
    })();

    return () => { active = false; };
  }, [dispatch, refs, state.physicsSelectedPropId]);

  // Re-sync physics model when mesh settings change (debounced from controller).
  // This is separate from the prop-loading effect above: it preserves camera,
  // doesn't clear collider results, and only touches the viewport + source ref.
  const prevRevisionRef = useRef(state.physicsModelRevision);
  useEffect(() => {
    // Skip initial mount (revision 0) and no-change renders
    if (
      state.physicsModelRevision === 0 ||
      state.physicsModelRevision === prevRevisionRef.current
    ) {
      prevRevisionRef.current = state.physicsModelRevision;
      return;
    }
    prevRevisionRef.current = state.physicsModelRevision;

    const propId = state.physicsSelectedPropId;
    if (!propId) return;

    const cached = refs.sharedModelCache.current.get(propId, "processed");
    if (!cached) return;

    const viewport = refs.physicsMeshViewport.current;
    if (!viewport) return;

    // Preserve camera position and keep collider panes in sync
    const prevView = viewport.getModel() ? viewport.getViewState() : null;
    const clone = deepCloneWithMaterials(cached);
    viewport.setModel(clone);
    if (prevView) {
      viewport.setViewState(prevView);
      // setViewState doesn't emit onViewChange, so update the shared ref
      // manually — collider pane effect reads this to stay in sync.
      refs.physicsViewState.current = prevView;
    }

    const bbox = viewport.getBBox();
    dispatch({ type: "SET_PHYSICS_BBOX", bbox });
    refs.physicsSimSourceModel.current = deepCloneWithMaterials(clone);

    // Scale existing collider results to match the new mesh scale
    const draft = state.selectedDraftId ? state.drafts.get(state.selectedDraftId) ?? null : null;
    const currentScale = draft?.scale ?? 1;
    const baseScale = state.physicsColliderBaseScale;
    if (baseScale > 0 && state.physicsColliderBaseResults.length > 0) {
      const ratio = currentScale / baseScale;
      if (Math.abs(ratio - 1) > 1e-6) {
        const scaled = state.physicsColliderBaseResults.map((entry) => ({
          ...entry,
          collider: scaleColliderParams(entry.collider, ratio),
        }));
        dispatch({ type: "SET_PHYSICS_COLLIDER_RESULTS", results: scaled });
      }
    }
  }, [dispatch, refs, state.physicsModelRevision, state.physicsSelectedPropId, state.selectedDraftId, state.drafts, state.physicsColliderBaseScale, state.physicsColliderBaseResults]);

  // Update collider preview panes
  useEffect(() => {
    const viewports = refs.physicsColliderPresetViewports.current;
    const sourceModel = refs.physicsSimSourceModel.current;

    for (const [presetId, viewport] of Object.entries(viewports)) {
      if (!viewport) continue;
      if (!sourceModel) {
        viewport.setModel(null);
        viewport.setColliderPreviewObject(null);
        continue;
      }
      const entry = state.physicsColliderResults.find((e) => e.presetId === presetId);
      if (!entry) {
        viewport.setModel(null);
        viewport.setColliderPreviewObject(null);
        continue;
      }
      // Load the mesh (needed for bounding-box framing) but hide it —
      // the collider pane should only show the collider wireframe.
      refs.physicsSuppressAssetViewSync.current = true;
      viewport.setModel(deepCloneWithMaterials(sourceModel));
      viewport.setModelVisible(false);
      viewport.setColliderPreviewObject(createColliderHelper(entry.collider));
      const viewState = refs.physicsViewState.current;
      if (viewState) viewport.setViewState(viewState);
      refs.physicsSuppressAssetViewSync.current = false;
    }
    // physicsBBox is included so this re-runs after the async model load
    // completes (the load effect dispatches SET_PHYSICS_BBOX after setting
    // refs.physicsSimSourceModel).  Without it, pre-existing collider results
    // loaded from meta would trigger this effect before the model is ready,
    // and it would never re-run.
  }, [refs, state.physicsColliderResults, state.physicsSelectedPropId, state.physicsBBox]);

  // Physics simulation loop
  const setSimStatus = useCallback(
    (scenario: PhysicsPreviewScenario, text: string) => {
      dispatch({ type: "SET_PHYSICS_SIM_STATUS", scenario, text });
    },
    [dispatch]
  );

  usePhysicsSimulation({
    refs,
    physicsSelectedPropId: state.physicsSelectedPropId,
    physicsSelectedColliderPresetId: state.physicsSelectedColliderPresetId,
    physicsColliderResults: state.physicsColliderResults,
    physicsSettings: state.physicsSettings,
    physicsBBox: state.physicsBBox,
    physicsModelRevision: state.physicsModelRevision,
    setSimPixelModels,
    setSimStatus,
  });

  // Feed the physics tab thumbnail viewport (live 3D pane in sidebar)
  useEffect(() => {
    const thumb = refs.physicsTabThumb.current;
    if (!thumb) return;
    const selectedId = state.physicsSelectedColliderPresetId;
    const sourceModel = refs.physicsSimSourceModel.current;
    if (!selectedId || !sourceModel || state.physicsColliderResults.length <= 0) {
      thumb.setModel(null);
      thumb.setColliderPreviewObject(null);
      return;
    }
    const entry = state.physicsColliderResults.find((e) => e.presetId === selectedId);
    if (!entry) {
      thumb.setModel(null);
      thumb.setColliderPreviewObject(null);
      return;
    }
    thumb.setModel(deepCloneWithMaterials(sourceModel));
    thumb.setModelVisible(false);
    thumb.setColliderPreviewObject(createColliderHelper(entry.collider));
    thumb.setAxesVisible(false);
    // Tighten framing for thumbnail
    const vs = thumb.getViewState();
    if (vs) thumb.setViewState({ ...vs, distance: vs.distance * 0.65 });
  }, [refs, state.physicsSelectedColliderPresetId, state.physicsColliderResults, state.physicsBBox, state.physicsSelectedPropId]);

  const handlePhysicsAssetViewChange = useCallback((viewState: Viewport3dViewState) => {
    if (refs.physicsSuppressAssetViewSync.current) return;
    refs.physicsViewState.current = viewState;
    // Sync mesh ↔ collider views (they share the same scene framing).
    for (const viewport of Object.values(refs.physicsColliderPresetViewports.current)) {
      viewport?.setViewState(viewState);
    }
    // Simulation views are independent — no sync from asset views.
  }, [refs]);

  const handleColliderViewChange = useCallback((viewState: Viewport3dViewState) => {
    if (refs.physicsSuppressAssetViewSync.current) return;
    refs.physicsViewState.current = viewState;
    // Sync to source mesh viewport
    refs.physicsMeshViewport.current?.setViewState(viewState);
    // Sync to all collider viewports
    for (const viewport of Object.values(refs.physicsColliderPresetViewports.current)) {
      viewport?.setViewState(viewState);
    }
    // Simulation views are independent — no sync from collider views.
  }, [refs]);

  const meta = state.physicsMeta;

  if (!state.physicsSelectedPropId || !meta) {
    return (
      <div className="ps-physics-workspace">
        <div className="ps-workspace-empty">
          <p>Select a generation-approved prop from the gallery to configure colliders and physics.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="ps-physics-workspace">
      {/* Physics controls toolbar */}
      <div className="ps-workspace-toolbar ps-physics-toolbar">
        <div className="ps-toolbar-row">
          <button
            className="forge-btn forge-btn-primary"
            onClick={() => void actions.computeSelectedPhysicsColliders()}
            disabled={!state.physicsSelectedPropId || state.physicsColliderBuildState.running}
          >
            {state.physicsColliderBuildState.running ? "Computing..." : "Compute Colliders"}
          </button>
          {state.physicsColliderBuildState.error && (
            <span className="ps-text-error">{state.physicsColliderBuildState.error}</span>
          )}
          {state.physicsColliderBuildState.running && (
            <span className="ps-text-muted">{state.physicsColliderBuildState.statusText}</span>
          )}
          <span className="ps-text-muted">Mass: {resolveForgeMass(state.physicsSettings, state.physicsBBox).toFixed(3)}</span>
        </div>

        {/* Collider preset radio buttons */}
        {state.physicsColliderResults.length > 0 && (
          <div className="ps-toolbar-row">
            <label className="ps-label">Collider</label>
            <div className="ps-btn-group">
              {state.physicsColliderResults.map((entry) => (
                <button
                  key={entry.presetId}
                  className={`forge-btn forge-btn-xs ${state.physicsSelectedColliderPresetId === entry.presetId ? "forge-btn-active" : ""}`}
                  onClick={() => {
                    dispatch({ type: "SET_PHYSICS_SELECTED_COLLIDER", presetId: entry.presetId });
                    void actions.autoApprovePhysics({ selectedPresetId: entry.presetId });
                  }}
                >
                  {entry.presetName} ({entry.generation.hullCount} hulls, {(JSON.stringify(entry.collider).length / 1024).toFixed(1)} KB)
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Kind radio buttons */}
        <div className="ps-toolbar-row">
          <label className="ps-label">Kind</label>
          <div className="ps-btn-group">
            {(state.physicsKindPresets?.kinds ?? []).map((kind) => (
              <button
                key={kind.id}
                className={`forge-btn forge-btn-xs ${state.physicsSelectedKindId === kind.id ? "forge-btn-active" : ""}`}
                onClick={() => {
                  const settings = buildPhysicsSettingsFromKind(kind);
                  dispatch({ type: "SET_PHYSICS_KIND", kindId: kind.id });
                  dispatch({ type: "SET_PHYSICS_SETTINGS", settings });
                  void actions.autoApprovePhysics({ kindId: kind.id, settings });
                }}
              >
                {kind.name}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Physics panel (collapsible) */}
      <details className="ps-physics-details">
        <summary className="ps-physics-details-summary">Advanced Physics Settings</summary>
        <div className="ps-physics-details-body">
          <PhysicsPanel
            value={state.physicsSettings}
            bbox={state.physicsBBox}
            onChange={(settings) => {
              dispatch({ type: "SET_PHYSICS_SETTINGS", settings });
              void actions.autoApprovePhysics({ settings });
            }}
            hideTitle
          />
        </div>
      </details>

      {/* Viewport area — single shared scissor stage, cards must be
           transparent so the canvas behind them is visible. */}
      <ForgeScissorViewportStage className="ps-physics-viewports">
        <div className="ps-viewport-row-scroll">
          <div className="ps-viewport-card">
            <div className="ps-viewport-card-header"><strong>Original Mesh</strong></div>
            <div className="ps-viewport-labeled">
              <div className="ps-viewport-label">Mesh</div>
              <ForgeScissorViewportPane
                paneId="physics-source-mesh"
                className="ps-viewport-host ps-viewport-host-sm ps-viewport-host-interactive"
                ref={refs.physicsMeshViewport}
                interactive
                onViewChange={handlePhysicsAssetViewChange}
              />
            </div>
          </div>

          {state.physicsColliderResults.map((entry) => (
            <div
              key={`collider-pane-${entry.presetId}`}
              className={`ps-viewport-card ps-collider-preview-btn ${
                state.physicsSelectedColliderPresetId === entry.presetId ? "ps-viewport-card-active" : ""
              }`}
              title={`Use ${entry.presetName} collider for physics sim`}
            >
              <div
                className="ps-viewport-card-header"
                style={{ cursor: "pointer" }}
                onClick={() => dispatch({ type: "SET_PHYSICS_SELECTED_COLLIDER", presetId: entry.presetId })}
              >
                <strong>{entry.presetName}</strong>
                <span className="ps-text-muted">
                  {entry.generation.hullCount} hulls · {(JSON.stringify(entry.collider).length / 1024).toFixed(1)} KB
                  {state.physicsSelectedColliderPresetId === entry.presetId ? " · active" : ""}
                </span>
              </div>
              <div className="ps-viewport-labeled">
                <div className="ps-viewport-label">Collider</div>
                <ForgeScissorViewportPane
                  paneId={`collider-${entry.presetId}`}
                  className="ps-viewport-host ps-viewport-host-sm ps-viewport-host-interactive"
                  ref={(handle) => {
                    refs.physicsColliderPresetViewports.current[entry.presetId] = handle;
                  }}
                  interactive
                  onViewChange={handleColliderViewChange}
                />
              </div>
            </div>
          ))}

          {state.physicsSelectedPropId && state.physicsColliderResults.length <= 0 && (
            <div className="ps-viewport-card ps-placeholder-card">
              <div className="ps-viewport-card-header"><strong>Collider Presets</strong></div>
              <div className="ps-placeholder-body">
                Compute collider presets to populate separate preview panes.
              </div>
            </div>
          )}
        </div>

        <div className="ps-physics-sim-rows">
          {PHYSICS_SCENARIOS.map((scenario) => (
            <div key={`sim-row-${scenario}`} className="ps-viewport-card">
              <div className="ps-viewport-card-header">
                <strong>{PHYSICS_SCENARIO_LABELS[scenario]}</strong>
                <span className="ps-text-muted">{state.physicsSimStatusByScenario[scenario]}</span>
              </div>
              <div className="ps-viewport-pixel-split">
                <div className="ps-viewport-labeled">
                  <div className="ps-viewport-label">3D</div>
                  <ForgeScissorViewportPane
                    paneId={`sim-${scenario}`}
                    className="ps-viewport-host ps-viewport-host-interactive"
                    ref={(handle) => {
                      refs.physicsSimMeshViewports.current[scenario] = handle;
                    }}
                    interactive
                    onViewChange={undefined}
                  />
                </div>
                <PixelQuad
                  ref={(handle) => {
                    refs.physicsSimPixelQuads.current[scenario] = handle;
                  }}
                  model={simPixelModels[scenario]}
                  baseViewState={simPixelBaseViewStates[scenario]}
                  onBaseViewStateChange={(newState) => {
                    setSimPixelBaseViewStates((prev) => ({ ...prev, [scenario]: newState }));
                  }}
                  className="ps-pixel-strip"
                  interactive
                  viewportFramingScale={1.0}
                  verticalBias={1 / 3}
                  paneIdPrefix={`physics-pixel-${scenario}-`}
                />
              </div>
            </div>
          ))}
        </div>
      </ForgeScissorViewportStage>
    </div>
  );
}
