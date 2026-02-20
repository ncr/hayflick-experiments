import type { StrategyGenerator } from "../types";
import { axisAlignedPartFromBounds, sanitizeParts } from "./common";

export const generateAabbCollider: StrategyGenerator<"aabb"> = (
  prop,
  params
) => {
  const part = axisAlignedPartFromBounds(prop.bbox.min, prop.bbox.max, params.inflate);
  return sanitizeParts([part]);
};

