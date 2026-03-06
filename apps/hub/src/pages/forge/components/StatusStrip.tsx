import { useForgeState, useForgeDispatch } from "../state/forge-context";

const SAVE_STATUS_LABELS: Record<string, string> = {
  idle: "",
  dirty: "Unsaved",
  saving: "Saving...",
  saved: "Saved",
  error: "Save failed",
};

export function StatusStrip() {
  const { statusMessage, statusError, savedProps, saveStatus } = useForgeState();
  const dispatch = useForgeDispatch();
  const saveLabel = SAVE_STATUS_LABELS[saveStatus] ?? "";

  return (
    <div className="ps-status-strip">
      <div className="ps-status-left">
        {statusMessage && <span className="ps-status-progress">{statusMessage}</span>}
      </div>
      <div className="ps-status-center">
        {statusError && (
          <span
            className="ps-status-error"
            onClick={() => dispatch({ type: "SET_STATUS_ERROR", error: null })}
            title="Click to dismiss"
          >
            {statusError}
          </span>
        )}
      </div>
      <div className="ps-status-right">
        {saveLabel && (
          <span className={`ps-status-save ps-status-save-${saveStatus}`}>{saveLabel}</span>
        )}
        <span className="ps-status-count">{savedProps.length} props</span>
        <span className="ps-status-hint">1-4: stages · Cmd+Enter: generate · Esc: blur</span>
      </div>
    </div>
  );
}
