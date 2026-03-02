import { useCallback, useState } from "react";
import { useForgeState, useForgeDispatch } from "../../state/forge-context";
import { usePipelineActions } from "../../hooks/usePipelineActions";

export function RefWorkspace() {
  const state = useForgeState();
  const dispatch = useForgeDispatch();
  const actions = usePipelineActions();

  const draft = state.selectedDraftId ? state.drafts.get(state.selectedDraftId) ?? null : null;
  const [prompt, setPrompt] = useState(draft?.description ?? "");

  // Sync prompt when draft changes
  const draftDesc = draft?.description ?? "";
  const [prevDesc, setPrevDesc] = useState(draftDesc);
  if (draftDesc !== prevDesc) {
    setPrevDesc(draftDesc);
    setPrompt(draftDesc);
  }

  const handleRegen = useCallback(() => {
    if (!draft) return;
    if (prompt !== draft.description) {
      dispatch({ type: "UPDATE_DRAFT", id: draft.tempId, patch: { description: prompt } });
    }
    void actions.runImageGenerationForDraft(
      { ...draft, description: prompt },
      "current-style"
    );
  }, [draft, prompt, dispatch, actions]);

  if (!draft) {
    return (
      <div className="ps-ref-workspace">
        <div className="ps-workspace-empty">
          <p>No prop selected.</p>
          <p className="ps-text-muted">
            Click + to add descriptions and generate images,
            or select an existing prop from the gallery.
          </p>
        </div>
      </div>
    );
  }

  const generating = draft.status === "generating-image";

  return (
    <div className="ps-ref-workspace">
      <div className="ps-ref-prompt-row">
        <input
          className="ps-input ps-ref-prompt-input"
          type="text"
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") handleRegen(); }}
          placeholder="Prop description..."
          disabled={generating}
        />
        <button
          className="forge-btn forge-btn-primary"
          onClick={handleRegen}
          disabled={generating}
        >
          {generating ? "Generating..." : draft.conceptImage ? "Regen" : "Generate"}
        </button>
      </div>
      {draft.conceptImage && (
        <div className="ps-ref-image-viewer ps-viewport-labeled">
          <div className="ps-viewport-label">Reference</div>
          <img
            src={draft.conceptImage}
            alt={draft.description}
            className="ps-ref-image-large"
          />
        </div>
      )}
    </div>
  );
}
