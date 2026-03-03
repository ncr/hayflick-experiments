import { useForgeState, useForgeDispatch } from "../../state/forge-context";
import { usePipelineActions } from "../../hooks/usePipelineActions";
import { PhysicsPanel } from "../../../forge/PhysicsPanel";
import {
  normalizeForgePhysicsSettings,
  resolveForgeMass,
} from "../../../forge/processing/physics";
import type { ForgeV2PhysicsKindPresetFile } from "../../types";

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

export function PhysicsInspector() {
  const state = useForgeState();
  const dispatch = useForgeDispatch();
  const actions = usePipelineActions();

  if (!state.physicsSelectedPropId || !state.physicsMeta) {
    return (
      <div className="ps-inspector-content">
        <div className="ps-section">
          <div className="ps-section-body">
            <p className="ps-text-muted">
              Select a generation-approved prop from the gallery to configure colliders and physics.
            </p>
          </div>
        </div>
      </div>
    );
  }

  const meta = state.physicsMeta;

  return (
    <div className="ps-inspector-content">
      <div className="ps-section">
        <div className="ps-section-header"><span>Colliders</span></div>
        <div className="ps-section-body">
          <div className="ps-btn-row" style={{ marginBottom: 8 }}>
            <button
              className="forge-btn forge-btn-primary"
              onClick={() => void actions.computeSelectedPhysicsColliders()}
              disabled={!state.physicsSelectedPropId || state.physicsColliderBuildState.running}
            >
              {state.physicsColliderBuildState.running ? "Computing..." : "Recompute"}
            </button>
          </div>
          {state.physicsColliderBuildState.error && (
            <div className="ps-text-error">{state.physicsColliderBuildState.error}</div>
          )}
          {state.physicsColliderResults.length > 0 && (
            <div className="ps-btn-group ps-btn-group-vertical">
              {state.physicsColliderResults.map((entry) => (
                <button
                  key={entry.presetId}
                  className={`forge-btn forge-btn-xs ${state.physicsSelectedColliderPresetId === entry.presetId ? "forge-btn-active" : ""}`}
                  onClick={() => {
                    dispatch({ type: "SET_PHYSICS_SELECTED_COLLIDER", presetId: entry.presetId });
                    void actions.autoApprovePhysics({ selectedPresetId: entry.presetId });
                  }}
                >
                  {entry.presetName} ({entry.generation.hullCount} hulls)
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      <div className="ps-section">
        <div className="ps-section-header"><span>Physics</span></div>
        <div className="ps-section-body">
          <div className="ps-detail-title">{meta.description}</div>
          {state.physicsConceptImage && (
            <div className="ps-concept-preview">
              <img src={state.physicsConceptImage} alt={meta.description} />
            </div>
          )}

          <div className="ps-field">
            <label className="ps-label">Kind</label>
            <div className="ps-btn-group ps-btn-group-vertical">
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

          <div className="ps-info-block">
            <div>Mass: {resolveForgeMass(state.physicsSettings, state.physicsBBox).toFixed(3)}</div>
          </div>

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
      </div>
    </div>
  );
}
