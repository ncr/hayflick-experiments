export type WallSegmentSpec = {
  index: number;
  centerX: number;
  suppressMinX: boolean;
  suppressMaxX: boolean;
};

export function buildWallSegmentSpecs(count: number, segmentLength: number): WallSegmentSpec[] {
  if (!Number.isInteger(count) || count < 1) {
    throw new Error("Wall segment count must be a positive integer.");
  }
  if (!Number.isFinite(segmentLength) || segmentLength <= 0) {
    throw new Error("Wall segment length must be positive.");
  }

  const startX = -((count - 1) * segmentLength) / 2;
  return Array.from({ length: count }, (_, index) => ({
    index,
    centerX: startX + index * segmentLength,
    suppressMinX: index > 0,
    suppressMaxX: index < count - 1
  }));
}
