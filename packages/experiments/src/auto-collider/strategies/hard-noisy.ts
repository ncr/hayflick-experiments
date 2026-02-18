import type { StrategyContext, StrategyResult } from "../types";
import { choosePartBudget } from "./common";
import { generateConcaveFurnitureStrategy } from "./concave-furniture";
import { generateSingleConvexStrategy } from "./single-convex";

export function generateHardNoisyStrategy(
  context: StrategyContext
): StrategyResult {
  const concave = generateConcaveFurnitureStrategy(context);
  const convex = generateSingleConvexStrategy(context);

  if (concave.rapier.type === "compound") {
    const maxParts = choosePartBudget(context.metrics.diagonal, context.options.budget);
    const partCount = concave.rapier.parts.length;

    if (
      partCount > 0 &&
      partCount <= maxParts &&
      (context.metrics.cavityScore >= 0.28 || context.metrics.noiseScore <= 0.82)
    ) {
      return {
        kind: "hard-noisy",
        rapier: concave.rapier
      };
    }
  }

  return {
    kind: "hard-noisy",
    rapier: convex.rapier
  };
}
