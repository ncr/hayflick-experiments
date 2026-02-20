import type { StrategyGenerator, Vec3Tuple } from "../types";
import { buildVoxelGridFromPoints, voxelIndex } from "../pipeline/voxel";
import { axisAlignedPartFromBounds, compactPartCount, sanitizeParts } from "./common";

type Component2D = {
  cells: Array<[number, number]>;
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
};

function buildTopBand(
  occupancyByY: number[],
  threshold: number
): { start: number; end: number } | null {
  let currentStart = -1;
  let currentEnd = -1;
  for (let y = occupancyByY.length - 1; y >= 0; y -= 1) {
    if (occupancyByY[y] >= threshold) {
      if (currentEnd < 0) {
        currentEnd = y;
      }
      currentStart = y;
      continue;
    }
    if (currentEnd >= 0) {
      break;
    }
  }

  if (currentStart < 0 || currentEnd < 0 || currentEnd < currentStart) {
    return null;
  }
  return {
    start: currentStart,
    end: currentEnd
  };
}

function connectedComponents2D(mask: Uint8Array, resolution: number): Component2D[] {
  const visited = new Uint8Array(mask.length);
  const components: Component2D[] = [];
  const neighbors = [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1]
  ] as const;

  const index = (x: number, z: number): number => x + z * resolution;

  for (let z = 0; z < resolution; z += 1) {
    for (let x = 0; x < resolution; x += 1) {
      const idx = index(x, z);
      if (mask[idx] === 0 || visited[idx] !== 0) {
        continue;
      }

      const queue: Array<[number, number]> = [[x, z]];
      visited[idx] = 1;
      const component: Component2D = {
        cells: [],
        minX: x,
        maxX: x,
        minZ: z,
        maxZ: z
      };

      while (queue.length > 0) {
        const [qx, qz] = queue.shift() as [number, number];
        component.cells.push([qx, qz]);
        component.minX = Math.min(component.minX, qx);
        component.maxX = Math.max(component.maxX, qx);
        component.minZ = Math.min(component.minZ, qz);
        component.maxZ = Math.max(component.maxZ, qz);

        for (const [dx, dz] of neighbors) {
          const nx = qx + dx;
          const nz = qz + dz;
          if (nx < 0 || nx >= resolution || nz < 0 || nz >= resolution) {
            continue;
          }
          const nIdx = index(nx, nz);
          if (mask[nIdx] === 0 || visited[nIdx] !== 0) {
            continue;
          }
          visited[nIdx] = 1;
          queue.push([nx, nz]);
        }
      }
      components.push(component);
    }
  }

  return components;
}

function voxelAabb(
  min: Vec3Tuple,
  size: Vec3Tuple,
  resolution: number,
  x0: number,
  y0: number,
  z0: number,
  x1: number,
  y1: number,
  z1: number
): { min: Vec3Tuple; max: Vec3Tuple } {
  const dx = size[0] / resolution;
  const dy = size[1] / resolution;
  const dz = size[2] / resolution;
  return {
    min: [min[0] + x0 * dx, min[1] + y0 * dy, min[2] + z0 * dz],
    max: [min[0] + (x1 + 1) * dx, min[1] + (y1 + 1) * dy, min[2] + (z1 + 1) * dz]
  };
}

export const generateSupportColumnsCollider: StrategyGenerator<"support-columns"> = (
  prop,
  params
) => {
  if (prop.points.length <= 0) {
    return [];
  }

  const resolution = Math.max(8, Math.floor(params.resolution));
  const maxParts = Math.max(1, Math.floor(params.maxParts));
  const baseLayers = Math.max(1, Math.floor(params.baseLayers));
  const topCoverage = Math.max(0.01, Math.min(0.9, params.topCoverageThreshold));

  const grid = buildVoxelGridFromPoints(prop.points, prop.bbox, resolution, 1);
  const r = grid.resolution;
  const totalSliceCells = r * r;
  const occupancyByY = Array.from({ length: r }, (_, y) => {
    let count = 0;
    for (let z = 0; z < r; z += 1) {
      for (let x = 0; x < r; x += 1) {
        if (grid.occupied[voxelIndex(r, x, y, z)] !== 0) {
          count += 1;
        }
      }
    }
    return count / totalSliceCells;
  });

  const topBand = buildTopBand(occupancyByY, topCoverage);
  const baseMask = new Uint8Array(r * r);
  for (let z = 0; z < r; z += 1) {
    for (let x = 0; x < r; x += 1) {
      for (let y = 0; y < Math.min(baseLayers, r); y += 1) {
        if (grid.occupied[voxelIndex(r, x, y, z)] !== 0) {
          baseMask[x + z * r] = 1;
          break;
        }
      }
    }
  }

  const components = connectedComponents2D(baseMask, r);
  const columnParts = [];
  for (const component of components) {
    let minY = r;
    let maxY = 0;
    for (const [x, z] of component.cells) {
      for (let y = 0; y < r; y += 1) {
        if (grid.occupied[voxelIndex(r, x, y, z)] === 0) {
          continue;
        }
        minY = Math.min(minY, y);
        maxY = Math.max(maxY, y);
      }
    }
    if (minY > maxY) {
      continue;
    }
    if (topBand) {
      maxY = Math.min(maxY, Math.max(topBand.start - 1, minY));
    }
    const bounds = voxelAabb(
      grid.min,
      grid.size,
      r,
      component.minX,
      minY,
      component.minZ,
      component.maxX,
      maxY,
      component.maxZ
    );
    columnParts.push(axisAlignedPartFromBounds(bounds.min, bounds.max, params.inflate));
  }

  const parts = [...columnParts];
  if (topBand) {
    let topMinX = r;
    let topMinZ = r;
    let topMaxX = 0;
    let topMaxZ = 0;
    let found = false;
    for (let z = 0; z < r; z += 1) {
      for (let x = 0; x < r; x += 1) {
        let occupied = false;
        for (let y = topBand.start; y <= topBand.end; y += 1) {
          if (grid.occupied[voxelIndex(r, x, y, z)] !== 0) {
            occupied = true;
            break;
          }
        }
        if (!occupied) {
          continue;
        }
        found = true;
        topMinX = Math.min(topMinX, x);
        topMaxX = Math.max(topMaxX, x);
        topMinZ = Math.min(topMinZ, z);
        topMaxZ = Math.max(topMaxZ, z);
      }
    }

    if (found) {
      const topBounds = voxelAabb(
        grid.min,
        grid.size,
        r,
        topMinX,
        topBand.start,
        topMinZ,
        topMaxX,
        topBand.end,
        topMaxZ
      );
      parts.push(axisAlignedPartFromBounds(topBounds.min, topBounds.max, params.inflate));
    }
  }

  return compactPartCount(sanitizeParts(parts), maxParts);
};

