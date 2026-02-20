import type { StrategyGenerator } from "../types";
import { generateLayeredAxisCollider } from "./layered-axis";

export const generateLayeredZCollider: StrategyGenerator<"layered-z"> =
  generateLayeredAxisCollider("z") as StrategyGenerator<"layered-z">;
