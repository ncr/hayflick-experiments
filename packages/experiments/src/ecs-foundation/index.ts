import type { ExperimentModule } from "../runtime/types";
import { runEcsFoundationDemo } from "./demo";

export * from "./types";
export * from "./store";
export * from "./events";
export * from "./save-load";
export * from "./systems";
export * from "./world";

const experiment: ExperimentModule = {
  id: "ecs-foundation",
  title: "ECS Foundation",
  tags: ["ecs", "typescript", "game-loop", "save-load", "browser"],
  init: ({ mount }) => {
    return runEcsFoundationDemo(mount);
  }
};

export default experiment;
