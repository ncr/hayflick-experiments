import { useForgeState, useForgeDispatch } from "../state/forge-context";

export function StatusStrip() {
  const { statusMessage, statusError, savedProps } = useForgeState();
  const dispatch = useForgeDispatch();

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
        <span className="ps-status-count">{savedProps.length} props</span>
        <span className="ps-status-hint">1-4: stages · Cmd+Enter: generate · Esc: blur</span>
      </div>
    </div>
  );
}
