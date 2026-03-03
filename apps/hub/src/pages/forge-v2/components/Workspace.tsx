import { useForgeState } from "../state/forge-context";
import { RefWorkspace } from "./stages/RefWorkspace";
import { MeshWorkspace } from "./stages/MeshWorkspace";
import { PhysicsWorkspace } from "./stages/PhysicsWorkspace";

export function Workspace() {
  const { activeStage } = useForgeState();

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

      {/* Physics viewport persists so collider thumbnails capture without tab visit */}
      <div
        className="ps-workspace-viewport-persistent"
        style={{ display: activeStage === "phy" ? "flex" : "none" }}
      >
        <PhysicsWorkspace />
      </div>
    </div>
  );
}
