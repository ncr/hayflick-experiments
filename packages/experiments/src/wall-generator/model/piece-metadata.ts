import type { PieceConfig, PieceMetadata, PieceConnectionPoint, Vec3 } from "./types";
import { isCorner, isFence } from "./piece-catalog";

/**
 * Generate a URL/filesystem-safe slug for a piece config.
 */
export function pieceSlug(config: PieceConfig): string {
  return `${config.kind}-${config.material.kind}`;
}

/**
 * Compute connection points for piece-to-piece snapping.
 */
export function computeConnectionPoints(config: PieceConfig): PieceConnectionPoint[] {
  const { kind, dimensions } = config;
  const { width, height, thickness } = dimensions;
  const points: PieceConnectionPoint[] = [];

  if (isCorner(kind)) {
    // L-shaped: connections at open ends of each arm
    points.push({
      position: [width - thickness, height / 2, 0],
      direction: [1, 0, 0],
      label: "arm-x-end",
    });
    points.push({
      position: [0, height / 2, width - thickness],
      direction: [0, 0, 1],
      label: "arm-z-end",
    });
  } else if (kind === "wall-end-cap") {
    // Only one connection on the non-capped end
    points.push({
      position: [-width / 2, height / 2, 0],
      direction: [-1, 0, 0],
      label: "open-end",
    });
  } else {
    // Straight wall/fence: connections on both ends
    points.push({
      position: [-width / 2, height / 2, 0],
      direction: [-1, 0, 0],
      label: "left",
    });
    points.push({
      position: [width / 2, height / 2, 0],
      direction: [1, 0, 0],
      label: "right",
    });
  }

  return points;
}

/**
 * Generate full piece metadata for export.
 */
export function generatePieceMetadata(config: PieceConfig): PieceMetadata {
  const { kind, dimensions, material } = config;
  const { width, height, thickness } = dimensions;

  const connections = computeConnectionPoints(config);

  // Bounding box depends on piece type
  let min: Vec3, max: Vec3;
  if (isCorner(kind)) {
    min = [-thickness / 2, 0, -thickness / 2];
    max = [width - thickness / 2, height, width - thickness / 2];
  } else {
    min = [-width / 2, 0, -thickness / 2];
    max = [width / 2, height, thickness / 2];
  }

  return {
    id: pieceSlug(config),
    kind,
    materialKind: material.kind,
    gridSize: 1.0,
    dimensions,
    connections,
    boundingBox: { min, max },
  };
}
