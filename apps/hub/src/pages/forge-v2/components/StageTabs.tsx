import { useForgeState, useForgeDispatch } from "../state/forge-context";
import type { StageId, StageStatus, RefArtifact } from "../state/forge-store";

type TabDef = {
  id: StageId;
  label: string;
};

const TABS: TabDef[] = [
  { id: "ref", label: "REF" },
  { id: "mesh", label: "MESH" },
  { id: "physics", label: "PHYS" },
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

/** Classic magenta/black checkerboard — the universal "missing texture" sign. */
function MissingTexturePlaceholder() {
  return (
    <div className="ps-stage-tab-missing" title="nothing to see here yet" />
  );
}

export function StageTabs() {
  const state = useForgeState();
  const dispatch = useForgeDispatch();

  const refArtifact = state.ref.artifact as RefArtifact | null;
  const conceptImage = refArtifact?.conceptImage ?? null;

  const draft = state.selectedDraftId ? state.drafts.get(state.selectedDraftId) ?? null : null;
  const hasMesh = !!draft?.rawGlb;
  const hasPhysics = state.physics.status === "VALID" || state.physics.status === "OUTDATED";

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

        // Pick thumbnail per stage: ref image, mesh (concept when mesh exists),
        // physics (concept when physics exists).  Fallback: missing texture meme.
        let thumb: "image" | "missing" = "missing";
        if (tab.id === "ref" && conceptImage) thumb = "image";
        if (tab.id === "mesh" && conceptImage && hasMesh) thumb = "image";
        if (tab.id === "physics" && conceptImage && hasPhysics) thumb = "image";

        return (
          <button
            key={tab.id}
            className={`ps-stage-tab ${isActive ? "ps-stage-tab-active" : ""} ${!enabled ? "ps-stage-tab-disabled" : ""}`}
            onClick={() => enabled && dispatch({ type: "SET_ACTIVE_STAGE", stage: tab.id })}
            disabled={!enabled}
            title={enabled ? tab.label : disableTooltip(tab.id)}
          >
            {thumb === "image" ? (
              <div className="ps-stage-tab-thumb">
                <img src={conceptImage!} alt={tab.label} />
              </div>
            ) : (
              <MissingTexturePlaceholder />
            )}
            <span className="ps-stage-tab-label">{tab.label}</span>
          </button>
        );
      })}
    </nav>
  );
}
