import type { StrategyGenerator } from "../types";
import { generateLayeredAxisCollider } from "./layered-axis";

export const generateLayeredXCollider: StrategyGenerator<"layered-x"> =
  generateLayeredAxisCollider("x") as StrategyGenerator<"layered-x">;
