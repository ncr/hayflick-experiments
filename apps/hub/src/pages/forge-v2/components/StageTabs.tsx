import { useForgeState, useForgeDispatch } from "../state/forge-context";
import { StatusBadge } from "./shared/StatusBadge";
import type { StageId, StageStatus, RefArtifact } from "../state/forge-store";

type TabDef = {
  id: StageId;
  label: string;
  shortcut: string;
};

const TABS: TabDef[] = [
  { id: "ref", label: "REF", shortcut: "1" },
  { id: "mesh", label: "MESH", shortcut: "2" },
  { id: "physics", label: "PHYS", shortcut: "3" },
];

function isStageEnabled(
  stageId: StageId,
  refStatus: StageStatus,
  meshStatus: StageStatus
): boolean {
  switch (stageId) {
    case "ref":
      return true;
    case "mesh":
      return refStatus !== "EMPTY";
    case "physics":
      return meshStatus !== "EMPTY";
    default:
      return false;
  }
}

function disableTooltip(stageId: StageId): string {
  switch (stageId) {
    case "mesh":
      return "Generate a reference image first";
    case "physics":
      return "Generate a mesh first";
    default:
      return "";
  }
}

export function StageTabs() {
  const state = useForgeState();
  const dispatch = useForgeDispatch();

  const refArtifact = state.ref.artifact as RefArtifact | null;
  const conceptImage = refArtifact?.conceptImage ?? null;

  return (
    <nav className="ps-stage-tabs">
      {TABS.map((tab) => {
        const stage = state[tab.id];
        const enabled = isStageEnabled(
          tab.id,
          state.ref.status,
          state.mesh.status
        );
        const isActive = state.activeStage === tab.id;

        return (
          <button
            key={tab.id}
            className={`ps-stage-tab ${isActive ? "ps-stage-tab-active" : ""} ${!enabled ? "ps-stage-tab-disabled" : ""}`}
            onClick={() => enabled && dispatch({ type: "SET_ACTIVE_STAGE", stage: tab.id })}
            disabled={!enabled}
            title={enabled ? `${tab.label} (${tab.shortcut})` : disableTooltip(tab.id)}
          >
            {conceptImage && stage.status !== "EMPTY" ? (
              <div className="ps-stage-tab-thumb">
                <img src={conceptImage} alt={tab.label} />
              </div>
            ) : (
              <StatusBadge status={stage.status} size={8} />
            )}
            <span className="ps-stage-tab-label">{tab.label}</span>
            <span className="ps-stage-tab-shortcut">{tab.shortcut}</span>
          </button>
        );
      })}
    </nav>
  );
}
