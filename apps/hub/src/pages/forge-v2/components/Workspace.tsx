import { useForgeState } from "../state/forge-context";
import { RefWorkspace } from "./stages/RefWorkspace";
import { MeshWorkspace } from "./stages/MeshWorkspace";
import { PhysicsWorkspace } from "./stages/PhysicsWorkspace";
import { BatchPane } from "./stages/BatchPane";

export function Workspace() {
  const { activeStage, batchMode } = useForgeState();

  if (batchMode) {
    return (
      <div className="ps-workspace">
        <BatchPane />
      </div>
    );
  }

  return (
    <div className="ps-workspace">
      {activeStage === "ref" && <RefWorkspace />}

      {/* Mesh viewport persists for Three.js continuity */}
      <div
        className="ps-workspace-viewport-persistent"
        style={{ display: activeStage === "mesh" ? "flex" : "none" }}
      >
        <MeshWorkspace />
      </div>

      {activeStage === "physics" && <PhysicsWorkspace />}
    </div>
  );
}
