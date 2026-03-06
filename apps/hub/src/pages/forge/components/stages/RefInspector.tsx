import { useState } from "react";
import { useForgeState, useForgeDispatch } from "../../state/forge-context";
import { usePipelineActions } from "../../hooks/usePipelineActions";
import { StyleGuidePanel } from "../../../forge-core/StyleGuidePanel";
import { OutdatedBanner } from "../shared/OutdatedBanner";
import { GenerateButton } from "../shared/GenerateButton";

export function RefInspector() {
  const state = useForgeState();
  const dispatch = useForgeDispatch();
  const actions = usePipelineActions();
  const [styleOpen, setStyleOpen] = useState(false);

  const draft = state.selectedDraftId ? state.drafts.get(state.selectedDraftId) ?? null : null;
  const drafts = Array.from(state.drafts.values());
  const draftCount = drafts.length;

  return (
    <div className="ps-inspector-content">
      {/* Style Guide (collapsed section) */}
      <div className="ps-section">
        <button
          className="ps-section-header ps-section-toggle"
          onClick={() => setStyleOpen(!styleOpen)}
        >
          <span>Style Guide</span>
          <span className="ps-section-chevron">{styleOpen ? "▾" : "▸"}</span>
        </button>
        {styleOpen && (
          <div className="ps-section-body">
            <StyleGuidePanel
              value={state.styleGuide}
              onChange={(guide) => dispatch({ type: "SET_STYLE_GUIDE", guide })}
            />
          </div>
        )}
      </div>

      {/* Batch */}
      <div className="ps-section">
        <div className="ps-section-header">
          <span>Batch Descriptions</span>
        </div>
        <div className="ps-section-body">
          <textarea
            className="ps-textarea"
            rows={4}
            value={state.batchText}
            onChange={(e) => dispatch({ type: "SET_BATCH_TEXT", text: e.target.value })}
            placeholder={"wooden chair\nstone well\niron lantern"}
          />
          <div className="ps-field">
            <label className="ps-label">Default face limit</label>
            <input
              type="number"
              className="ps-input"
              min={1000}
              max={100000}
              step={1000}
              value={state.defaultFaceLimit}
              onChange={(e) =>
                dispatch({ type: "SET_DEFAULT_FACE_LIMIT", limit: Math.max(1000, Number(e.target.value) || 5000) })
              }
            />
          </div>
          <div className="ps-btn-row">
            <button
              className="forge-btn"
              onClick={actions.addBatchDrafts}
              disabled={!state.batchText.trim()}
            >
              Add to Queue
            </button>
            <button
              className="forge-btn forge-btn-primary"
              onClick={() => void actions.handleGenerateAllImages()}
              disabled={state.generationBusy.images || draftCount <= 0}
            >
              {state.generationBusy.images
                ? "Generating Images..."
                : `Generate All Images (${draftCount})`}
            </button>
          </div>
        </div>
      </div>

      {/* Queue */}
      <div className="ps-section">
        <div className="ps-section-header">
          <span>Queue ({draftCount})</span>
        </div>
        <div className="ps-section-body">
          <div className="ps-draft-list">
            {drafts.map((d) => (
              <button
                key={d.tempId}
                className={`ps-draft-card ${state.selectedDraftId === d.tempId ? "ps-draft-card-active" : ""}`}
                onClick={() => dispatch({ type: "SELECT_DRAFT", id: d.tempId })}
              >
                <div className="ps-draft-card-thumb">
                  {d.conceptImage ? (
                    <img src={d.conceptImage} alt={d.description} />
                  ) : (
                    <span className="ps-text-muted">{d.description.slice(0, 20)}</span>
                  )}
                </div>
                <div className="ps-draft-card-info">
                  <div className="ps-draft-card-title">{d.description}</div>
                  <div className="ps-draft-card-status">{d.status}</div>
                  {d.status === "generating-mesh" && (
                    <div className="ps-text-muted">{d.meshProgress}% · {d.meshProgressLabel}</div>
                  )}
                  {d.imageError && <div className="ps-text-error">{d.imageError}</div>}
                  {d.meshError && <div className="ps-text-error">{d.meshError}</div>}
                </div>
              </button>
            ))}
            {draftCount <= 0 && <div className="ps-text-muted">No props in queue yet.</div>}
          </div>
        </div>
      </div>

      {/* Per-prop actions */}
      {draft && (
        <div className="ps-section">
          <div className="ps-section-header">
            <span>{draft.description}</span>
          </div>
          <div className="ps-section-body">
            {state.ref.status === "OUTDATED" && (
              <OutdatedBanner message="Style guide changed since this image was generated." />
            )}
            <div className="ps-btn-row">
              <button
                className="forge-btn"
                onClick={() => void actions.runImageGenerationForDraft(draft, "last-used")}
                disabled={draft.status === "generating-image"}
              >
                Regen (saved prompt)
              </button>
              <button
                className="forge-btn"
                onClick={() => void actions.runImageGenerationForDraft(draft, "current-style")}
                disabled={draft.status === "generating-image"}
              >
                Regen (current guide)
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
