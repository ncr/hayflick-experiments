import { useForgeState, useForgeDispatch } from "../../state/forge-context";
import { usePipelineActions } from "../../hooks/usePipelineActions";

export function BatchPane() {
  const state = useForgeState();
  const dispatch = useForgeDispatch();
  const actions = usePipelineActions();

  const drafts = Array.from(state.drafts.values()).filter(
    (d) => !d.tempId.startsWith("saved-")
  );

  return (
    <div className="ps-batch-pane">
      <div className="ps-batch-pane-input">
        <textarea
          className="ps-textarea ps-batch-textarea"
          rows={8}
          value={state.batchText}
          onChange={(e) => dispatch({ type: "SET_BATCH_TEXT", text: e.target.value })}
          placeholder={"wooden chair\nstone well\niron lantern\n\nOne description per line"}
          autoFocus
        />
        <div className="ps-batch-pane-controls">
          <div className="ps-field ps-field-inline">
            <label className="ps-label">Face limit</label>
            <input
              type="number"
              className="ps-input ps-input-sm"
              min={1000}
              max={100000}
              step={1000}
              value={state.defaultFaceLimit}
              onChange={(e) =>
                dispatch({ type: "SET_DEFAULT_FACE_LIMIT", limit: Math.max(1000, Number(e.target.value) || 5000) })
              }
            />
          </div>
          <div className="ps-batch-pane-actions">
            <button
              className="forge-btn forge-btn-primary"
              onClick={() => void actions.createPropPlaceholders()}
              disabled={!state.batchText.trim()}
            >
              Create Props
            </button>
            <button
              className="forge-btn"
              onClick={() => actions.addBatchDrafts()}
              disabled={!state.batchText.trim()}
            >
              Add to Queue
            </button>
            <button
              className="forge-btn"
              onClick={() => {
                if (state.batchText.trim()) actions.addBatchDrafts();
                void actions.handleGenerateAllImages();
              }}
              disabled={state.generationBusy.images}
            >
              {state.generationBusy.images ? "Generating..." : "Generate All Images"}
            </button>
            {drafts.some((d) => d.conceptImage) && (
              <button
                className="forge-btn"
                onClick={() => void actions.handleGenerateAllMeshes()}
                disabled={state.generationBusy.meshes}
              >
                {state.generationBusy.meshes ? "Generating..." : "Generate All Meshes"}
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Queue preview */}
      {drafts.length > 0 && (
        <div className="ps-batch-queue">
          <div className="ps-batch-queue-header">
            Queue ({drafts.length})
          </div>
          <div className="ps-batch-queue-grid">
            {drafts.map((d) => (
              <div
                key={d.tempId}
                className={`ps-batch-queue-item ${state.selectedDraftId === d.tempId ? "ps-batch-queue-item-active" : ""}`}
                onClick={() => dispatch({ type: "SELECT_DRAFT", id: d.tempId })}
              >
                <div className="ps-batch-queue-thumb">
                  {d.conceptImage ? (
                    <img src={d.conceptImage} alt={d.description} />
                  ) : (
                    <div className="ps-batch-queue-placeholder">
                      {d.status === "generating-image" && <span className="ps-spinner" />}
                      {d.status === "generating-mesh" && <span className="ps-text-muted">{d.meshProgressLabel}</span>}
                    </div>
                  )}
                </div>
                <div className="ps-batch-queue-info">
                  <span className="ps-batch-queue-desc">{d.description}</span>
                  <span className="ps-text-muted">{d.status}</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
