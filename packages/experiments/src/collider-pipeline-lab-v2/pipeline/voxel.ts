import type { BoundingBox, Vec3Tuple, VoxelGrid } from "../types";
import { clamp } from "./math";

const EPSILON = 1e-9;

function index3(
  x: number,
  y: number,
  z: number,
  resolution: number
): number {
  return x + y * resolution + z * resolution * resolution;
}

function cellFromPoint(
  point: Vec3Tuple,
  bounds: BoundingBox,
  resolution: number
): [number, number, number] {
  const sx = Math.max(EPSILON, bounds.size[0]);
  const sy = Math.max(EPSILON, bounds.size[1]);
  const sz = Math.max(EPSILON, bounds.size[2]);

  const fx = (point[0] - bounds.min[0]) / sx;
  const fy = (point[1] - bounds.min[1]) / sy;
  const fz = (point[2] - bounds.min[2]) / sz;

  return [
    clamp(Math.floor(fx * resolution), 0, resolution - 1),
    clamp(Math.floor(fy * resolution), 0, resolution - 1),
    clamp(Math.floor(fz * resolution), 0, resolution - 1)
  ];
}

function dilateOccupied(
  occupied: Uint8Array<ArrayBufferLike>,
  resolution: number
): Uint8Array<ArrayBufferLike> {
  const next = occupied.slice();
  for (let z = 0; z < resolution; z += 1) {
    for (let y = 0; y < resolution; y += 1) {
      for (let x = 0; x < resolution; x += 1) {
        const idx = index3(x, y, z, resolution);
        if (occupied[idx] !== 0) {
          continue;
        }

        let neighborHit = false;
        for (let dz = -1; dz <= 1 && !neighborHit; dz += 1) {
          const nz = z + dz;
          if (nz < 0 || nz >= resolution) {
            continue;
          }
          for (let dy = -1; dy <= 1 && !neighborHit; dy += 1) {
            const ny = y + dy;
            if (ny < 0 || ny >= resolution) {
              continue;
            }
            for (let dx = -1; dx <= 1; dx += 1) {
              const nx = x + dx;
              if (nx < 0 || nx >= resolution) {
                continue;
              }
              if (occupied[index3(nx, ny, nz, resolution)] !== 0) {
                neighborHit = true;
                break;
              }
            }
          }
        }

        if (neighborHit) {
          next[idx] = 1;
        }
      }
    }
  }
  return next;
}

export function buildVoxelGridFromPoints(
  points: Vec3Tuple[],
  bounds: BoundingBox,
  resolution: number,
  dilatePasses = 1
): VoxelGrid {
  const safeResolution = Math.max(4, Math.floor(resolution));
  const total = safeResolution * safeResolution * safeResolution;
  let occupied: Uint8Array<ArrayBufferLike> = new Uint8Array(total);
  for (const point of points) {
    const [x, y, z] = cellFromPoint(point, bounds, safeResolution);
    occupied[index3(x, y, z, safeResolution)] = 1;
  }

  for (let i = 0; i < dilatePasses; i += 1) {
    occupied = dilateOccupied(occupied, safeResolution);
  }

  return {
    resolution: safeResolution,
    occupied,
    min: bounds.min,
    size: bounds.size
  };
}

export function voxelIndex(
  resolution: number,
  x: number,
  y: number,
  z: number
): number {
  return index3(x, y, z, resolution);
}

export function voxelCenter(grid: VoxelGrid, x: number, y: number, z: number): Vec3Tuple {
  const r = grid.resolution;
  const dx = grid.size[0] / r;
  const dy = grid.size[1] / r;
  const dz = grid.size[2] / r;
  return [
    grid.min[0] + (x + 0.5) * dx,
    grid.min[1] + (y + 0.5) * dy,
    grid.min[2] + (z + 0.5) * dz
  ];
}

export function occupiedRatio(grid: VoxelGrid): number {
  if (grid.occupied.length <= 0) {
    return 0;
  }
  let count = 0;
  for (const value of grid.occupied) {
    if (value !== 0) {
      count += 1;
    }
  }
  return count / grid.occupied.length;
}

export function computeColumnGapRatio(grid: VoxelGrid): number {
  const r = grid.resolution;
  let gapCount = 0;
  let spanCount = 0;
  for (let z = 0; z < r; z += 1) {
    for (let x = 0; x < r; x += 1) {
      let minY = -1;
      let maxY = -1;
      for (let y = 0; y < r; y += 1) {
        if (grid.occupied[voxelIndex(r, x, y, z)] === 0) {
          continue;
        }
        if (minY < 0) {
          minY = y;
        }
        maxY = y;
      }
      if (minY < 0 || maxY < 0 || maxY <= minY) {
        continue;
      }

      for (let y = minY; y <= maxY; y += 1) {
        spanCount += 1;
        if (grid.occupied[voxelIndex(r, x, y, z)] === 0) {
          gapCount += 1;
        }
      }
    }
  }

  if (spanCount <= 0) {
    return 0;
  }
  return gapCount / spanCount;
}
