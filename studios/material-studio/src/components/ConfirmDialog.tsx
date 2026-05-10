import { type ReactNode } from "react";

type Props = {
  title: string;
  body: ReactNode;
  confirmLabel: string;
  confirmVariant?: "primary" | "danger";
  onConfirm: () => void;
  onCancel: () => void;
  busy?: boolean;
};

export function ConfirmDialog({ title, body, confirmLabel, confirmVariant = "primary", onConfirm, onCancel, busy }: Props) {
  return (
    <div className="ms-overlay" role="dialog" aria-modal="true">
      <div className="ms-overlay-panel">
        <div className="ms-overlay-header">
          <strong>{title}</strong>
          <button className="ms-icon-btn" onClick={onCancel} title="Close" disabled={busy}>
            ✕
          </button>
        </div>
        <div className="ms-overlay-body">{body}</div>
        <div className="ms-overlay-footer">
          <button className="ms-btn" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <button
            className={`ms-btn ${confirmVariant === "danger" ? "ms-btn-danger" : "ms-btn-primary"}`}
            onClick={onConfirm}
            disabled={busy}
          >
            {busy ? "Working…" : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
