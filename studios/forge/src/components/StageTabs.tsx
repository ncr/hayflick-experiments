import { useForgeState, useForgeDispatch, useForgeRefs } from "../state/forge-context";
import {
  ForgeScissorViewportStage,
  ForgeScissorViewportPane,
} from "../ScissorViewport3d";
import type { StageId, StageStatus, RefArtifact } from "../state/forge-store";

type TabDef = {
  id: StageId;
  label: string;
};

const TABS: TabDef[] = [
  { id: "ref", label: "REF" },
  { id: "mesh", label: "MESH" },
  { id: "phy", label: "PHY" },
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
    case "phy":
      return meshStatus !== "EMPTY";
    default:
      return false;
  }
}

function disableTooltip(stageId: StageId): string {
  switch (stageId) {
    case "mesh":
      return "Generate a reference image first";
    case "phy":
      return "Generate a mesh first";
    default:
      return "";
  }
}

/** Classic magenta/black checkerboard — the universal "missing texture" sign. */
function MissingTexturePlaceholder() {
  return (
    <div className="ps-stage-tab-missing" title="nothing to see here yet" />
  );
}

const TAB_ORBIT_SPEED = 0.3;

export function StageTabs() {
  const state = useForgeState();
  const dispatch = useForgeDispatch();
  const refs = useForgeRefs();

  const refArtifact = state.ref.artifact as RefArtifact | null;
  const conceptImage = refArtifact?.conceptImage ?? null;

  return (
    <ForgeScissorViewportStage className="ps-stage-tabs-stage" clearColor={0x000000} clearAlpha={0}>
      {/* eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions */}
      <nav className="ps-stage-tabs" onDragStart={(e) => e.preventDefault()}>
        {TABS.map((tab) => {
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
              title={enabled ? tab.label : disableTooltip(tab.id)}
            >
              {tab.id === "ref" ? (
                conceptImage ? (
                  <div className="ps-stage-tab-thumb">
                    <img src={conceptImage} alt={tab.label} draggable={false} />
                  </div>
                ) : (
                  <MissingTexturePlaceholder />
                )
              ) : tab.id === "mesh" ? (
                <ForgeScissorViewportPane
                  paneId="tab-thumb-mesh"
                  className="ps-stage-tab-viewport"
                  ref={refs.meshTabThumb}
                  autoOrbitSpeed={TAB_ORBIT_SPEED}
                />
              ) : tab.id === "phy" ? (
                <ForgeScissorViewportPane
                  paneId="tab-thumb-physics"
                  className="ps-stage-tab-viewport"
                  ref={refs.physicsTabThumb}
                  autoOrbitSpeed={TAB_ORBIT_SPEED}
                />
              ) : (
                <MissingTexturePlaceholder />
              )}
              <span className="ps-stage-tab-label">{tab.label}</span>
            </button>
          );
        })}
      </nav>
    </ForgeScissorViewportStage>
  );
}
