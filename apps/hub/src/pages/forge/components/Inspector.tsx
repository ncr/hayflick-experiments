import { useForgeState } from "../state/forge-context";
import { RefInspector } from "./stages/RefInspector";
import { MeshInspector } from "./stages/MeshInspector";
import { PhysicsInspector } from "./stages/PhysicsInspector";

export function Inspector() {
  const { activeStage } = useForgeState();

  return (
    <div className="ps-inspector">
      {activeStage === "ref" && <RefInspector />}
      {activeStage === "mesh" && <MeshInspector />}
      {activeStage === "phy" && <PhysicsInspector />}
    </div>
  );
}
