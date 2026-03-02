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

function formatStatusTime(iso?: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString();
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
        <div className="ps-section-header"><span>Collider Presets</span></div>
        <div className="ps-section-body">
          {state.colliderPresets ? (
            <div className="ps-checkbox-list">
              {state.colliderPresets.presets.map((preset) => (
                <label key={preset.id} className="ps-checkbox-row">
                  <input
                    type="checkbox"
                    checked={preset.enabledByDefault !== false}
                    onChange={(e) => {
                      if (!state.colliderPresets) return;
                      dispatch({
                        type: "SET_COLLIDER_PRESETS",
                        presets: {
                          ...state.colliderPresets,
                          presets: state.colliderPresets.presets.map((entry) =>
                            entry.id === preset.id
                              ? { ...entry, enabledByDefault: e.target.checked }
                              : entry
                          ),
                        },
                      });
                    }}
                  />
                  {preset.name}
                </label>
              ))}
            </div>
          ) : (
            <div className="ps-text-muted">Loading collider presets...</div>
          )}
          <div className="ps-btn-row" style={{ marginTop: 8 }}>
            <button
              className="forge-btn forge-btn-primary"
              onClick={() => void actions.computeSelectedPhysicsColliders()}
              disabled={!state.physicsSelectedPropId || state.physicsColliderBuildState.running}
            >
              {state.physicsColliderBuildState.running ? "Computing..." : "Recompute Colliders"}
            </button>
          </div>
          <div className="ps-info-block">
            <div>Status: {state.physicsColliderBuildState.statusText}</div>
            <div>Progress: {state.physicsColliderBuildState.progressText}</div>
            {state.physicsColliderBuildState.error && (
              <div className="ps-text-error">{state.physicsColliderBuildState.error}</div>
            )}
          </div>
        </div>
      </div>

      <div className="ps-section">
        <div className="ps-section-header"><span>Physics Setup</span></div>
        <div className="ps-section-body">
          <div className="ps-detail-title">{meta.description}</div>
          {state.physicsConceptImage && (
            <div className="ps-concept-preview">
              <img src={state.physicsConceptImage} alt={meta.description} />
            </div>
          )}

          <div className="ps-field">
            <label className="ps-label">Physics Kind (preset)</label>
            <select
              className="ps-select"
              value={state.physicsSelectedKindId}
              onChange={(e) => {
                const kindId = e.target.value;
                dispatch({ type: "SET_PHYSICS_KIND", kindId });
                const kind = state.physicsKindPresets?.kinds.find((k) => k.id === kindId);
                if (kind) {
                  dispatch({ type: "SET_PHYSICS_SETTINGS", settings: buildPhysicsSettingsFromKind(kind) });
                }
              }}
            >
              {(state.physicsKindPresets?.kinds ?? []).map((kind) => (
                <option key={kind.id} value={kind.id}>{kind.name}</option>
              ))}
            </select>
          </div>

          <div className="ps-field">
            <label className="ps-label">Active Collider Preset</label>
            <select
              className="ps-select"
              value={state.physicsSelectedColliderPresetId ?? ""}
              onChange={(e) =>
                dispatch({ type: "SET_PHYSICS_SELECTED_COLLIDER", presetId: e.target.value || null })
              }
            >
              <option value="">-- Select --</option>
              {state.physicsColliderResults.map((entry) => (
                <option key={entry.presetId} value={entry.presetId}>
                  {entry.presetName} ({entry.generation.hullCount} hulls)
                </option>
              ))}
            </select>
          </div>

          {state.physicsColliderResults.length > 0 && (
            <div className="ps-info-block">
              {state.physicsColliderResults.map((entry) => (
                <div key={entry.presetId}>
                  {entry.presetName}: {entry.generation.hullCount} hulls, {entry.generation.stats.voxelCount} voxels
                </div>
              ))}
            </div>
          )}

          <PhysicsPanel
            value={state.physicsSettings}
            bbox={state.physicsBBox}
            onChange={(settings) => dispatch({ type: "SET_PHYSICS_SETTINGS", settings })}
            hideTitle
          />

          <div className="ps-info-block">
            <div>Estimated Mass: {resolveForgeMass(state.physicsSettings, state.physicsBBox).toFixed(3)}</div>
          </div>

          <button
            className="forge-btn forge-btn-primary ps-generate-btn"
            onClick={() => void actions.approvePhysicsSetup()}
            disabled={!state.physicsSelectedColliderPresetId || state.physicsColliderResults.length <= 0}
          >
            Approve Physics Setup
          </button>

          {meta.lifecycle.physicsApprovedAt && (
            <div className="ps-text-success" style={{ marginTop: 8 }}>
              Physics approved: {formatStatusTime(meta.lifecycle.physicsApprovedAt)}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
