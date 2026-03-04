import type { CsgSubtraction, PieceConfig, WallDimensions, OpeningDesc } from "./types";
import { hasOpening } from "./piece-catalog";

/**
 * Build the list of CSG subtraction descriptors for a given piece config.
 * This is a pure data function — actual CSG execution is in the view layer.
 */
export function buildSubtractionList(config: PieceConfig): CsgSubtraction[] {
  const { kind, dimensions, opening } = config;
  if (!hasOpening(kind)) return [];

  return computeOpeningSubtractions(dimensions, opening, kind);
}

function computeOpeningSubtractions(
  dims: WallDimensions,
  opening: OpeningDesc,
  kind: PieceConfig["kind"],
): CsgSubtraction[] {
  const subs: CsgSubtraction[] = [];

  // Main opening cut
  const cutDepth = dims.thickness + 0.02;
  subs.push({
    type: "box",
    position: [opening.offsetX, opening.offsetY + opening.height / 2, 0],
    size: [opening.width, opening.height, cutDepth],
  });

  // For doors, extend cut to bottom
  if (kind === "wall-door") {
    subs[0].position = [
      opening.offsetX,
      opening.height / 2,
      0,
    ];
    subs[0].size = [
      opening.width,
      opening.height,
      cutDepth,
    ];
  }

  return subs;
}

/**
 * Validate that an opening fits within wall dimensions.
 */
export function validateOpening(
  dims: WallDimensions,
  opening: OpeningDesc,
): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  const leftEdge = opening.offsetX - opening.width / 2;
  const rightEdge = opening.offsetX + opening.width / 2;
  const topEdge = opening.offsetY + opening.height;

  if (leftEdge < -dims.width / 2) errors.push("Opening extends past left edge");
  if (rightEdge > dims.width / 2) errors.push("Opening extends past right edge");
  if (topEdge > dims.height) errors.push("Opening extends past top edge");
  if (opening.offsetY < 0) errors.push("Opening starts below wall bottom");

  return { valid: errors.length === 0, errors };
}
