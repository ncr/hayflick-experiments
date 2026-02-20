import type { StrategyGenerator, Vec3Tuple } from "../types";
import { buildVoxelGridFromPoints, voxelIndex } from "../pipeline/voxel";
import { axisAlignedPartFromBounds, compactPartCount, sanitizeParts } from "./common";

function cellBounds(
  min: Vec3Tuple,
  size: Vec3Tuple,
  resolution: number,
  x0: number,
  y0: number,
  z0: number,
  x1: number,
  y1: number,
  z1: number
): {
  min: Vec3Tuple;
  max: Vec3Tuple;
} {
  const dx = size[0] / resolution;
  const dy = size[1] / resolution;
  const dz = size[2] / resolution;
  return {
    min: [
      min[0] + x0 * dx,
      min[1] + y0 * dy,
      min[2] + z0 * dz
    ],
    max: [
      min[0] + (x1 + 1) * dx,
      min[1] + (y1 + 1) * dy,
      min[2] + (z1 + 1) * dz
    ]
  };
}

export const generateVoxelGreedyCollider: StrategyGenerator<"voxel-greedy"> = (
  prop,
  params
) => {
  if (prop.points.length <= 0) {
    return [];
  }

  const resolution = Math.max(6, Math.floor(params.resolution));
  const grid = buildVoxelGridFromPoints(prop.points, prop.bbox, resolution, 1);
  const r = grid.resolution;
  const visited = new Uint8Array(r * r * r);
  const parts = [];

  const isFreeOccupied = (x: number, y: number, z: number): boolean => {
    const idx = voxelIndex(r, x, y, z);
    return grid.occupied[idx] !== 0 && visited[idx] === 0;
  };

  const canExpandX = (xNext: number, y: number, zStart: number, zEnd: number): boolean => {
    for (let z = zStart; z <= zEnd; z += 1) {
      if (!isFreeOccupied(xNext, y, z)) {
        return false;
      }
    }
    return true;
  };

  const canExpandZ = (
    zNext: number,
    y: number,
    xStart: number,
    xEnd: number
  ): boolean => {
    for (let x = xStart; x <= xEnd; x += 1) {
      if (!isFreeOccupied(x, y, zNext)) {
        return false;
      }
    }
    return true;
  };

  const canExpandY = (
    yNext: number,
    xStart: number,
    xEnd: number,
    zStart: number,
    zEnd: number
  ): boolean => {
    for (let z = zStart; z <= zEnd; z += 1) {
      for (let x = xStart; x <= xEnd; x += 1) {
        if (!isFreeOccupied(x, yNext, z)) {
          return false;
        }
      }
    }
    return true;
  };

  for (let y = 0; y < r; y += 1) {
    for (let z = 0; z < r; z += 1) {
      for (let x = 0; x < r; x += 1) {
        if (!isFreeOccupied(x, y, z)) {
          continue;
        }

        let xEnd = x;
        let zEnd = z;
        let yEnd = y;

        while (xEnd + 1 < r && canExpandX(xEnd + 1, y, z, zEnd)) {
          xEnd += 1;
        }
        while (zEnd + 1 < r && canExpandZ(zEnd + 1, y, x, xEnd)) {
          zEnd += 1;
        }
        while (yEnd + 1 < r && canExpandY(yEnd + 1, x, xEnd, z, zEnd)) {
          yEnd += 1;
        }

        for (let yy = y; yy <= yEnd; yy += 1) {
          for (let zz = z; zz <= zEnd; zz += 1) {
            for (let xx = x; xx <= xEnd; xx += 1) {
              visited[voxelIndex(r, xx, yy, zz)] = 1;
            }
          }
        }

        const bounds = cellBounds(
          grid.min,
          grid.size,
          r,
          x,
          y,
          z,
          xEnd,
          yEnd,
          zEnd
        );
        parts.push(axisAlignedPartFromBounds(bounds.min, bounds.max, params.inflate));
      }
    }
  }

  return compactPartCount(
    sanitizeParts(parts),
    Math.max(1, Math.floor(params.maxParts))
  );
};

