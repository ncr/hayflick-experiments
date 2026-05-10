import type { StageStatus } from "../../state/forge-store";

const STATUS_COLORS: Record<StageStatus, string> = {
  EMPTY: "var(--ps-status-empty, #666)",
  VALID: "var(--ps-status-valid, #4CAF50)",
  OUTDATED: "var(--ps-status-outdated, #FFB020)",
  BUILDING: "var(--ps-status-building, #3ABEFF)",
  FAILED: "var(--ps-status-failed, #F44336)",
};

const STATUS_LABELS: Record<StageStatus, string> = {
  EMPTY: "Empty",
  VALID: "Valid",
  OUTDATED: "Outdated",
  BUILDING: "Building...",
  FAILED: "Failed",
};

interface Props {
  status: StageStatus;
  size?: number;
  showLabel?: boolean;
}

export function StatusBadge({ status, size = 8, showLabel }: Props) {
  const color = STATUS_COLORS[status];
  const isBuilding = status === "BUILDING";

  return (
    <span className="ps-status-badge" title={STATUS_LABELS[status]}>
      <span
        className={`ps-status-dot ${isBuilding ? "ps-status-dot-pulse" : ""}`}
        style={{
          display: "inline-block",
          width: size,
          height: size,
          borderRadius: "50%",
          backgroundColor: color,
          flexShrink: 0,
        }}
      />
      {showLabel && (
        <span className="ps-status-label" style={{ marginLeft: 4, fontSize: "0.72rem" }}>
          {STATUS_LABELS[status]}
        </span>
      )}
    </span>
  );
}
