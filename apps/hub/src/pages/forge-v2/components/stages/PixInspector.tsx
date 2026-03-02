import { useForgeState } from "../../state/forge-context";
import { usePipelineActions } from "../../hooks/usePipelineActions";
import { OutdatedBanner } from "../shared/OutdatedBanner";

function formatStatusTime(iso?: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString();
}

export function PixInspector() {
  const state = useForgeState();
  const actions = usePipelineActions();

  const draft = state.selectedDraftId ? state.drafts.get(state.selectedDraftId) ?? null : null;

  if (!draft) {
    return (
      <div className="ps-inspector-content">
        <div className="ps-section">
          <div className="ps-section-body">
            <p className="ps-text-muted">Select a prop with a mesh to review and approve generation.</p>
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
              <span className="ps-detail-label">Faces</span>
              <strong>{draft.processedFaces}</strong>
            </div>
            <div>
              <span className="ps-detail-label">Scale</span>
              <strong>{draft.scale.toFixed(3)}</strong>
            </div>
          </div>

          {draft.bboxProcessed && (
            <div className="ps-bbox-info">
              W: <strong>{draft.bboxProcessed.width.toFixed(3)}u</strong>{" "}
              H: <strong>{draft.bboxProcessed.height.toFixed(3)}u</strong>{" "}
              D: <strong>{draft.bboxProcessed.depth.toFixed(3)}u</strong>
            </div>
          )}
        </div>
      </div>

      <div className="ps-section">
        <div className="ps-section-header"><span>Camera Sync</span></div>
        <div className="ps-section-body">
          <p className="ps-text-muted">
            Orbit the mesh viewport to adjust camera angles. The pixel quad views sync automatically.
          </p>
        </div>
      </div>

      <div className="ps-section">
        <div className="ps-section-body">
          {state.pix.status === "OUTDATED" && (
            <OutdatedBanner message="Mesh was regenerated. Re-approve to update." />
          )}
          <button
            className="forge-btn forge-btn-primary ps-generate-btn"
            onClick={() => void actions.approveSelectedDraftGeneration()}
            disabled={!draft.rawGlb || !draft.conceptImage}
          >
            {draft.generationApprovedAt ? "Re-Approve Generation" : "Approve Generation"}
          </button>
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
