import { useForgeState } from "../state/forge-context";
import { RefInspector } from "./stages/RefInspector";
import { MeshInspector } from "./stages/MeshInspector";
import { PixInspector } from "./stages/PixInspector";
import { PhysicsInspector } from "./stages/PhysicsInspector";

export function Inspector() {
  const { activeStage } = useForgeState();

  return (
    <div className="ps-inspector">
      {activeStage === "ref" && <RefInspector />}
      {activeStage === "mesh" && <MeshInspector />}
      {activeStage === "pix" && <PixInspector />}
      {activeStage === "phy" && <PhysicsInspector />}
    </div>
  );
}
