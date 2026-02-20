import type { StrategyGenerator } from "../types";
import { generateLayeredAxisCollider } from "./layered-axis";

export const generateLayeredYCollider: StrategyGenerator<"layered-y"> =
  generateLayeredAxisCollider("y") as StrategyGenerator<"layered-y">;
