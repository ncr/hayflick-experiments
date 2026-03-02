import type { StageStatus } from "../../state/forge-store";

interface Props {
  status: StageStatus;
  hasArtifact: boolean;
  onClick: () => void;
  disabled?: boolean;
  generateLabel?: string;
  regenerateLabel?: string;
}

export function GenerateButton({
  status,
  hasArtifact,
  onClick,
  disabled,
  generateLabel = "Generate",
  regenerateLabel = "Regenerate",
}: Props) {
  const isBuilding = status === "BUILDING";
  const label = isBuilding
    ? "Building..."
    : hasArtifact
      ? regenerateLabel
      : generateLabel;

  return (
    <button
      className="forge-btn forge-btn-primary ps-generate-btn"
      onClick={onClick}
      disabled={disabled || isBuilding}
    >
      {isBuilding && <span className="ps-spinner" />}
      {label}
    </button>
  );
}
