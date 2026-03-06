import { useForgeState, useForgeDispatch } from "../../state/forge-context";
import { usePipelineActions } from "../../hooks/usePipelineActions";
import { OutdatedBanner } from "../shared/OutdatedBanner";
import { GenerateButton } from "../shared/GenerateButton";
import type { PivotPreset, ScaleMode } from "../../../forge-core/processing/dimensions";

type ForgeScaleMode = ScaleMode | "depth";
const UNIT_SCALE_METERS_PER_UNIT = 1.28;

function formatStatusTime(iso?: string): string {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString();
}

export function MeshInspector() {
  const state = useForgeState();
  const dispatch = useForgeDispatch();
  const actions = usePipelineActions();

  const draft = state.selectedDraftId ? state.drafts.get(state.selectedDraftId) ?? null : null;

  if (!draft) {
    return (
      <div className="ps-inspector-content">
        <div className="ps-section">
          <div className="ps-section-body">
            <p className="ps-text-muted">Select a prop with a concept image to configure mesh generation.</p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="ps-inspector-content">
      <div className="ps-section">
        <div className="ps-section-header"><span>{draft.description}</span></div>
        <div className="ps-section-body">
          {draft.conceptImage && (
            <div className="ps-concept-preview">
              <img src={draft.conceptImage} alt={draft.description} />
            </div>
          )}

          <div className="ps-detail-grid">
            <div>
              <span className="ps-detail-label">Status</span>
              <strong>{draft.status}</strong>
            </div>
            <div>
              <span className="ps-detail-label">Faces</span>
              <strong>{draft.processedFaces || draft.originalFaces || 0}</strong>
            </div>
            <div>
              <span className="ps-detail-label">Scale</span>
              <strong>{draft.scale.toFixed(3)}</strong>
            </div>
            <div>
              <span className="ps-detail-label">ID</span>
              <strong>{draft.idSlug}</strong>
            </div>
          </div>
        </div>
      </div>

      <div className="ps-section">
        <div className="ps-section-header"><span>Mesh Parameters</span></div>
        <div className="ps-section-body">
          <div className="ps-field">
            <label className="ps-label">Face limit (Tripo)</label>
            <input
              type="number"
              className="ps-input"
              min={1000}
              max={100000}
              step={1000}
              value={draft.faceLimit}
              onChange={(e) =>
                dispatch({
                  type: "UPDATE_DRAFT",
                  id: draft.tempId,
                  patch: { faceLimit: Math.max(1000, Number(e.target.value) || 5000) },
                })
              }
            />
          </div>

          <div className="ps-field">
            <label className="ps-label">Texture downscale</label>
            <select
              className="ps-select"
              value={draft.textureResolution}
              onChange={(e) =>
                dispatch({
                  type: "UPDATE_DRAFT",
                  id: draft.tempId,
                  patch: { textureResolution: Number(e.target.value) },
                })
              }
            >
              <option value={0}>Original</option>
              <option value={1024}>1024px</option>
              <option value={512}>512px</option>
              <option value={256}>256px</option>
              <option value={128}>128px</option>
            </select>
          </div>

          <div className="ps-field">
            <label className="ps-label">Size target mode</label>
            <select
              className="ps-select"
              value={draft.scaleMode}
              onChange={(e) =>
                dispatch({
                  type: "UPDATE_DRAFT",
                  id: draft.tempId,
                  patch: { scaleMode: e.target.value as ForgeScaleMode },
                })
              }
            >
              <option value="height">Height</option>
              <option value="width">Width</option>
              <option value="depth">Depth</option>
              <option value="max">Max Dimension</option>
              <option value="manual">Manual Uniform Scale</option>
            </select>
          </div>

          <div className="ps-field">
            <label className="ps-label">
              {draft.scaleMode === "manual" ? "Scale Factor" : "Target Size (world units)"}
            </label>
            <input
              type="number"
              className="ps-input"
              min={0.01}
              step={0.01}
              value={draft.targetDimension}
              onChange={(e) =>
                dispatch({
                  type: "UPDATE_DRAFT",
                  id: draft.tempId,
                  patch: { targetDimension: Math.max(0.01, Number(e.target.value) || 1) },
                })
              }
            />
            <span className="ps-text-muted">1u = {UNIT_SCALE_METERS_PER_UNIT.toFixed(2)}m</span>
          </div>

          {draft.bboxProcessed && (
            <div className="ps-bbox-info">
              W: <strong>{draft.bboxProcessed.width.toFixed(3)}u</strong>{" "}
              H: <strong>{draft.bboxProcessed.height.toFixed(3)}u</strong>{" "}
              D: <strong>{draft.bboxProcessed.depth.toFixed(3)}u</strong>
            </div>
          )}

          <div className="ps-field">
            <label className="ps-label">Pivot</label>
            <div className="ps-btn-group">
              {(["bottom-center", "center", "bottom-front-center"] as PivotPreset[]).map((preset) => (
                <button
                  key={preset}
                  className={`forge-btn ${draft.pivot === preset ? "forge-btn-active" : ""}`}
                  onClick={() =>
                    dispatch({
                      type: "UPDATE_DRAFT",
                      id: draft.tempId,
                      patch: { pivot: preset },
                    })
                  }
                >
                  {preset}
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>

      <div className="ps-section">
        <div className="ps-section-body">
          {state.mesh.status === "OUTDATED" && (
            <OutdatedBanner message="Reference image changed. Regenerate mesh to update." />
          )}
          {state.pix.status === "OUTDATED" && (
            <OutdatedBanner message="Mesh was regenerated. Re-approve to update." />
          )}
          <div className="ps-btn-row">
            <GenerateButton
              status={draft.status === "generating-mesh" ? "BUILDING" : state.mesh.status}
              hasArtifact={!!draft.rawGlb}
              onClick={() => void actions.runMeshGenerationForDraft(draft)}
              disabled={!draft.conceptImage || draft.status === "generating-mesh"}
              generateLabel="Generate Mesh"
              regenerateLabel="Regenerate Mesh"
            />
            <button
              className="forge-btn forge-btn-primary"
              onClick={() => void actions.approveSelectedDraftGeneration()}
              disabled={!draft.rawGlb || !draft.conceptImage}
            >
              {draft.generationApprovedAt ? "Re-Approve" : "Approve"}
            </button>
          </div>
          {draft.generationApprovedAt && (
            <div className="ps-text-success" style={{ marginTop: 8 }}>
              Generation approved ({formatStatusTime(draft.generationApprovedAt)})
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
