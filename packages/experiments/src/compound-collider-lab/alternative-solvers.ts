import {
  fitCompoundBoxesGlobal,
  type BoxPart,
  type Point3
} from "./decomposition";

type Bounds = {
  minX: number;
  minY: number;
  minZ: number;
  maxX: number;
  maxY: number;
  maxZ: number;
};

type Resolution = {
  xSlices: number;
  ySlices: number;
  zSlices: number;
};

type Voxel = {
  x: number;
  y: number;
  z: number;
};

type VoxelBounds = {
  minX: number;
  minY: number;
  minZ: number;
  maxX: number;
  maxY: number;
  maxZ: number;
};

type TopCell = {
  x: number;
  z: number;
  minY: number;
  topY: number;
};

type TopRegion = {
  cells: TopCell[];
  fit: PlaneFit;
};

type PlaneFit = {
  a: number;
  b: number;
  c: number;
  rmse: number;
};

type SolverResult = {
  parts: BoxPart[];
  auto: {
    xSlices: number;
    ySlices: number;
    zSlices: number;
    occupiedVoxels: number;
    boxPenalty: number;
    maxBoxes: number;
    splitsAccepted: number;
    initialCost: number;
    finalCost: number;
    strategy: "plane-graph-prism";
    selectedBoxCount?: number;
    selectionScore?: number;
    statesEvaluated?: number;
    beamWidth?: number;
  };
};

type Prepared = {
  bounds: Bounds;
  resolution: Resolution;
  voxels: Voxel[];
  cellVolume: number;
  boxPenalty: number;
  maxBoxes: number;
};

type Vec3 = [number, number, number];

const MIN_EDGE = 0.0001;
const MIN_REGION_CELLS = 6;
const MIN_COMPONENT_VOXELS = 28;
const REGION_SPLIT_QUANTILES = [0.3, 0.4, 0.5, 0.6, 0.7] as const;
const MIN_REGION_SPLIT_GAIN = 0.14;
const MIN_SLOPE_MAGNITUDE = 0.11;

type RegionStats = {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
  spanX: number;
  spanZ: number;
  fill: number;
  minTop: number;
  maxTop: number;
};

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function computeBounds(points: readonly Point3[]): Bounds | null {
  if (points.length === 0) {
    return null;
  }

  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let minZ = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  let maxZ = Number.NEGATIVE_INFINITY;

  for (const point of points) {
    if (point.x < minX) minX = point.x;
    if (point.y < minY) minY = point.y;
    if (point.z < minZ) minZ = point.z;
    if (point.x > maxX) maxX = point.x;
    if (point.y > maxY) maxY = point.y;
    if (point.z > maxZ) maxZ = point.z;
  }

  return { minX, minY, minZ, maxX, maxY, maxZ };
}

function chooseAutoResolution(bounds: Bounds, pointCount: number): Resolution {
  const sizeX = Math.max(MIN_EDGE, bounds.maxX - bounds.minX);
  const sizeY = Math.max(MIN_EDGE, bounds.maxY - bounds.minY);
  const sizeZ = Math.max(MIN_EDGE, bounds.maxZ - bounds.minZ);
  const maxDim = Math.max(sizeX, sizeY, sizeZ, MIN_EDGE);
  const density = clamp(Math.log10(Math.max(48, pointCount)) / 4.1, 0, 1);
  const base = Math.round(clamp(18 + density * 24, 18, 56));

  return {
    xSlices: Math.round(clamp((sizeX / maxDim) * base, 10, 60)),
    ySlices: Math.round(clamp((sizeY / maxDim) * base, 10, 60)),
    zSlices: Math.round(clamp((sizeZ / maxDim) * base, 10, 60))
  };
}

function chooseBoxPenalty(occupiedVoxels: number): number {
  return Math.round(clamp(16 + Math.sqrt(occupiedVoxels) * 1.55, 22, 220));
}

function chooseSearchMaxBoxes(occupiedVoxels: number): number {
  return Math.round(clamp(4 + Math.sqrt(occupiedVoxels) / 4.1, 4, 14));
}

function voxelKey(x: number, y: number, z: number): string {
  return `${x}|${y}|${z}`;
}

function voxelizePoints(
  points: readonly Point3[],
  bounds: Bounds,
  resolution: Resolution
): Voxel[] {
  const sizeX = Math.max(MIN_EDGE, bounds.maxX - bounds.minX);
  const sizeY = Math.max(MIN_EDGE, bounds.maxY - bounds.minY);
  const sizeZ = Math.max(MIN_EDGE, bounds.maxZ - bounds.minZ);

  const seen = new Set<string>();
  const voxels: Voxel[] = [];

  for (const point of points) {
    const xNorm = clamp((point.x - bounds.minX) / sizeX, 0, 0.999999);
    const yNorm = clamp((point.y - bounds.minY) / sizeY, 0, 0.999999);
    const zNorm = clamp((point.z - bounds.minZ) / sizeZ, 0, 0.999999);

    const x = Math.floor(xNorm * resolution.xSlices);
    const y = Math.floor(yNorm * resolution.ySlices);
    const z = Math.floor(zNorm * resolution.zSlices);

    const key = voxelKey(x, y, z);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    voxels.push({ x, y, z });
  }

  return voxels;
}

function computeVoxelBounds(voxels: readonly Voxel[]): VoxelBounds | null {
  if (voxels.length === 0) {
    return null;
  }

  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let minZ = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  let maxZ = Number.NEGATIVE_INFINITY;

  for (const voxel of voxels) {
    if (voxel.x < minX) minX = voxel.x;
    if (voxel.y < minY) minY = voxel.y;
    if (voxel.z < minZ) minZ = voxel.z;
    if (voxel.x > maxX) maxX = voxel.x;
    if (voxel.y > maxY) maxY = voxel.y;
    if (voxel.z > maxZ) maxZ = voxel.z;
  }

  return { minX, minY, minZ, maxX, maxY, maxZ };
}

function voxelBoundsVolume(bounds: VoxelBounds): number {
  const dx = bounds.maxX - bounds.minX + 1;
  const dy = bounds.maxY - bounds.minY + 1;
  const dz = bounds.maxZ - bounds.minZ + 1;
  return dx * dy * dz;
}

function prepare(points: readonly Point3[]): Prepared | null {
  const bounds = computeBounds(points);
  if (!bounds) {
    return null;
  }

  const resolution = chooseAutoResolution(bounds, points.length);
  const voxels = voxelizePoints(points, bounds, resolution);
  if (voxels.length === 0) {
    return null;
  }

  const boxPenalty = chooseBoxPenalty(voxels.length);
  const maxBoxes = chooseSearchMaxBoxes(voxels.length);

  const sizeX = Math.max(MIN_EDGE, bounds.maxX - bounds.minX);
  const sizeY = Math.max(MIN_EDGE, bounds.maxY - bounds.minY);
  const sizeZ = Math.max(MIN_EDGE, bounds.maxZ - bounds.minZ);
  const cellVolume =
    (sizeX / resolution.xSlices) *
    (sizeY / resolution.ySlices) *
    (sizeZ / resolution.zSlices);

  return {
    bounds,
    resolution,
    voxels,
    cellVolume: Math.max(MIN_EDGE, cellVolume),
    boxPenalty,
    maxBoxes
  };
}

function emptyResult(strategy: SolverResult["auto"]["strategy"]): SolverResult {
  return {
    parts: [],
    auto: {
      xSlices: 0,
      ySlices: 0,
      zSlices: 0,
      occupiedVoxels: 0,
      boxPenalty: 0,
      maxBoxes: 0,
      splitsAccepted: 0,
      initialCost: 0,
      finalCost: 0,
      strategy
    }
  };
}

function worldFromBoundary(
  boundary: readonly [number, number, number],
  bounds: Bounds,
  resolution: Resolution
): [number, number, number] {
  const sizeX = Math.max(MIN_EDGE, bounds.maxX - bounds.minX);
  const sizeY = Math.max(MIN_EDGE, bounds.maxY - bounds.minY);
  const sizeZ = Math.max(MIN_EDGE, bounds.maxZ - bounds.minZ);

  return [
    bounds.minX + (boundary[0] / resolution.xSlices) * sizeX,
    bounds.minY + (boundary[1] / resolution.ySlices) * sizeY,
    bounds.minZ + (boundary[2] / resolution.zSlices) * sizeZ
  ];
}

function partFromVoxelBounds(
  bounds: Bounds,
  resolution: Resolution,
  voxelBounds: VoxelBounds,
  label: string
): BoxPart {
  const min = worldFromBoundary([voxelBounds.minX, voxelBounds.minY, voxelBounds.minZ], bounds, resolution);
  const max = worldFromBoundary([voxelBounds.maxX + 1, voxelBounds.maxY + 1, voxelBounds.maxZ + 1], bounds, resolution);

  const sizeX = Math.max(MIN_EDGE, max[0] - min[0]);
  const sizeY = Math.max(MIN_EDGE, max[1] - min[1]);
  const sizeZ = Math.max(MIN_EDGE, max[2] - min[2]);

  return {
    label,
    position: [min[0] + sizeX * 0.5, min[1] + sizeY * 0.5, min[2] + sizeZ * 0.5],
    halfExtents: [sizeX * 0.5, sizeY * 0.5, sizeZ * 0.5]
  };
}

function boxVolume(part: BoxPart): number {
  return (
    part.halfExtents[0] * 2 *
    part.halfExtents[1] * 2 *
    part.halfExtents[2] * 2
  );
}

function solveLinear3(
  matrix: [[number, number, number], [number, number, number], [number, number, number]],
  vector: [number, number, number]
): [number, number, number] | null {
  const m = [
    [matrix[0][0], matrix[0][1], matrix[0][2], vector[0]],
    [matrix[1][0], matrix[1][1], matrix[1][2], vector[1]],
    [matrix[2][0], matrix[2][1], matrix[2][2], vector[2]]
  ];

  for (let col = 0; col < 3; col += 1) {
    let pivot = col;
    for (let row = col + 1; row < 3; row += 1) {
      if (Math.abs(m[row][col]) > Math.abs(m[pivot][col])) {
        pivot = row;
      }
    }

    if (Math.abs(m[pivot][col]) < 1e-9) {
      return null;
    }

    if (pivot !== col) {
      const tmp = m[col];
      m[col] = m[pivot];
      m[pivot] = tmp;
    }

    const divisor = m[col][col];
    for (let k = col; k < 4; k += 1) {
      m[col][k] /= divisor;
    }

    for (let row = 0; row < 3; row += 1) {
      if (row === col) {
        continue;
      }
      const factor = m[row][col];
      if (Math.abs(factor) < 1e-9) {
        continue;
      }
      for (let k = col; k < 4; k += 1) {
        m[row][k] -= factor * m[col][k];
      }
    }
  }

  return [m[0][3], m[1][3], m[2][3]];
}

function fitPlaneY(samples: Array<{ x: number; z: number; y: number }>): PlaneFit | null {
  if (samples.length < 3) {
    return null;
  }

  let sx = 0;
  let sz = 0;
  let sy = 0;
  let sxx = 0;
  let szz = 0;
  let sxz = 0;
  let sxy = 0;
  let szy = 0;
  const n = samples.length;

  for (const sample of samples) {
    sx += sample.x;
    sz += sample.z;
    sy += sample.y;
    sxx += sample.x * sample.x;
    szz += sample.z * sample.z;
    sxz += sample.x * sample.z;
    sxy += sample.x * sample.y;
    szy += sample.z * sample.y;
  }

  const solved = solveLinear3(
    [
      [sxx, sxz, sx],
      [sxz, szz, sz],
      [sx, sz, n]
    ],
    [sxy, szy, sy]
  );
  if (!solved) {
    return null;
  }

  const [a, b, c] = solved;
  let sq = 0;
  for (const sample of samples) {
    const predicted = a * sample.x + b * sample.z + c;
    const diff = predicted - sample.y;
    sq += diff * diff;
  }

  return {
    a,
    b,
    c,
    rmse: Math.sqrt(sq / Math.max(1, n))
  };
}

function buildTopCells(voxels: readonly Voxel[]): Map<string, TopCell> {
  const cells = new Map<string, TopCell>();
  for (const voxel of voxels) {
    const key = `${voxel.x}|${voxel.z}`;
    const existing = cells.get(key);
    if (!existing) {
      cells.set(key, {
        x: voxel.x,
        z: voxel.z,
        minY: voxel.y,
        topY: voxel.y + 1
      });
      continue;
    }
    if (voxel.y < existing.minY) {
      existing.minY = voxel.y;
    }
    if (voxel.y + 1 > existing.topY) {
      existing.topY = voxel.y + 1;
    }
  }
  return cells;
}

function detectTopRegions(cells: Map<string, TopCell>): { regions: TopRegion[]; statesEvaluated: number } {
  const visited = new Set<string>();
  const regions: TopRegion[] = [];
  let statesEvaluated = 0;

  for (const [startKey, startCell] of cells.entries()) {
    if (visited.has(startKey)) {
      continue;
    }

    const queue: TopCell[] = [startCell];
    visited.add(startKey);
    const regionCells: TopCell[] = [];

    for (let i = 0; i < queue.length; i += 1) {
      const current = queue[i];
      regionCells.push(current);

      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
        const nextKey = `${current.x + dx}|${current.z + dz}`;
        if (visited.has(nextKey)) {
          continue;
        }
        const next = cells.get(nextKey);
        if (!next) {
          continue;
        }

        const localStep = Math.abs(next.topY - current.topY);
        if (localStep > 2) {
          continue;
        }

        let accept = true;
        if (regionCells.length >= 5) {
          const fit = fitPlaneY(
            regionCells.map((cell) => ({ x: cell.x + 0.5, z: cell.z + 0.5, y: cell.topY }))
          );
          if (fit) {
            const predicted = fit.a * (next.x + 0.5) + fit.b * (next.z + 0.5) + fit.c;
            const residual = Math.abs(predicted - next.topY);
            statesEvaluated += 1;
            if (residual > 1.35 || fit.rmse > 1.25) {
              accept = false;
            }
          }
        }

        if (!accept) {
          continue;
        }

        visited.add(nextKey);
        queue.push(next);
      }
    }

    if (regionCells.length < MIN_REGION_CELLS) {
      continue;
    }

    const fit = fitPlaneY(
      regionCells.map((cell) => ({ x: cell.x + 0.5, z: cell.z + 0.5, y: cell.topY }))
    );
    if (!fit || fit.rmse > 1.4) {
      continue;
    }

    regions.push({
      cells: regionCells,
      fit
    });
  }

  regions.sort((a, b) => b.cells.length - a.cells.length);
  return { regions, statesEvaluated };
}

function smoothTopCells(cells: Map<string, TopCell>, passes = 1): Map<string, TopCell> {
  let current = new Map<string, TopCell>();
  for (const [key, cell] of cells.entries()) {
    current.set(key, { ...cell });
  }

  const neighbors: Array<[number, number]> = [
    [0, 0],
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
    [1, 1],
    [-1, -1],
    [1, -1],
    [-1, 1]
  ];

  for (let pass = 0; pass < passes; pass += 1) {
    const next = new Map<string, TopCell>();
    for (const [key, cell] of current.entries()) {
      const tops: number[] = [];
      for (const [dx, dz] of neighbors) {
        const neighbor = current.get(`${cell.x + dx}|${cell.z + dz}`);
        if (neighbor) {
          tops.push(neighbor.topY);
        }
      }
      const medianTop = percentile(tops, 0.5);
      next.set(key, {
        ...cell,
        topY: cell.topY * 0.5 + medianTop * 0.5
      });
    }
    current = next;
  }

  return current;
}

function computeRegionStats(cells: readonly TopCell[]): RegionStats {
  let minX = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let minZ = Number.POSITIVE_INFINITY;
  let maxZ = Number.NEGATIVE_INFINITY;
  let minTop = Number.POSITIVE_INFINITY;
  let maxTop = Number.NEGATIVE_INFINITY;

  for (const cell of cells) {
    if (cell.x < minX) minX = cell.x;
    if (cell.x > maxX) maxX = cell.x;
    if (cell.z < minZ) minZ = cell.z;
    if (cell.z > maxZ) maxZ = cell.z;
    if (cell.topY < minTop) minTop = cell.topY;
    if (cell.topY > maxTop) maxTop = cell.topY;
  }

  const spanX = maxX - minX + 1;
  const spanZ = maxZ - minZ + 1;
  const footprintArea = Math.max(1, spanX * spanZ);

  return {
    minX,
    maxX,
    minZ,
    maxZ,
    spanX,
    spanZ,
    fill: cells.length / footprintArea,
    minTop,
    maxTop
  };
}

function fitRegion(cells: TopCell[]): TopRegion | null {
  if (cells.length < MIN_REGION_CELLS) {
    return null;
  }
  const fit = fitPlaneY(
    cells.map((cell) => ({ x: cell.x + 0.5, z: cell.z + 0.5, y: cell.topY }))
  );
  if (!fit || fit.rmse > 1.45) {
    return null;
  }
  return { cells, fit };
}

function splitRegionByAxis(
  region: TopRegion,
  axis: "x" | "z",
  split: number
): [TopRegion, TopRegion] | null {
  const leftCells: TopCell[] = [];
  const rightCells: TopCell[] = [];
  for (const cell of region.cells) {
    const value = axis === "x" ? cell.x : cell.z;
    if (value <= split) {
      leftCells.push(cell);
    } else {
      rightCells.push(cell);
    }
  }
  if (leftCells.length < MIN_REGION_CELLS || rightCells.length < MIN_REGION_CELLS) {
    return null;
  }

  const left = fitRegion(leftCells);
  const right = fitRegion(rightCells);
  if (!left || !right) {
    return null;
  }

  return [left, right];
}

function splitPositions(min: number, max: number): number[] {
  const span = max - min + 1;
  if (span < 6) {
    return [];
  }
  const out = new Set<number>();
  for (const q of REGION_SPLIT_QUANTILES) {
    const split = Math.floor(min + span * q);
    if (split <= min + 1 || split >= max - 1) {
      continue;
    }
    out.add(split);
  }
  return [...out];
}

function scoreRegionSplit(parent: TopRegion, left: TopRegion, right: TopRegion): number {
  const parentStats = computeRegionStats(parent.cells);
  const leftStats = computeRegionStats(left.cells);
  const rightStats = computeRegionStats(right.cells);
  const total = parent.cells.length;
  const leftWeight = left.cells.length / total;
  const rightWeight = right.cells.length / total;
  const weightedRmse = left.fit.rmse * leftWeight + right.fit.rmse * rightWeight;
  const weightedFill = leftStats.fill * leftWeight + rightStats.fill * rightWeight;
  const rmseGain = parent.fit.rmse - weightedRmse;
  const fillGain = weightedFill - parentStats.fill;
  const balance = Math.min(leftWeight, rightWeight);
  return rmseGain * 1.3 + fillGain * 0.9 + balance * 0.18 - 0.09;
}

function refineTopRegions(
  regions: TopRegion[],
  maxRegions: number
): { regions: TopRegion[]; statesEvaluated: number } {
  const refined = [...regions];
  let statesEvaluated = 0;

  while (refined.length < maxRegions) {
    let bestSplit:
      | {
          index: number;
          children: [TopRegion, TopRegion];
          score: number;
        }
      | null = null;

    for (let index = 0; index < refined.length; index += 1) {
      const region = refined[index];
      if (region.cells.length < MIN_REGION_CELLS * 2) {
        continue;
      }

      const stats = computeRegionStats(region.cells);
      if (Math.max(stats.spanX, stats.spanZ) < 5) {
        continue;
      }

      const dominantAxis: "x" | "z" = Math.abs(region.fit.a) >= Math.abs(region.fit.b) ? "x" : "z";
      const secondaryAxis: "x" | "z" = dominantAxis === "x" ? "z" : "x";
      const axes: Array<"x" | "z"> = stats.fill < 0.72 ? [dominantAxis, secondaryAxis] : [dominantAxis];

      for (const axis of axes) {
        const min = axis === "x" ? stats.minX : stats.minZ;
        const max = axis === "x" ? stats.maxX : stats.maxZ;
        for (const split of splitPositions(min, max)) {
          const children = splitRegionByAxis(region, axis, split);
          statesEvaluated += 1;
          if (!children) {
            continue;
          }
          const score = scoreRegionSplit(region, children[0], children[1]);
          if (score < MIN_REGION_SPLIT_GAIN) {
            continue;
          }
          if (!bestSplit || score > bestSplit.score) {
            bestSplit = {
              index,
              children,
              score
            };
          }
        }
      }
    }

    if (!bestSplit) {
      break;
    }

    refined.splice(bestSplit.index, 1, bestSplit.children[0], bestSplit.children[1]);
  }

  refined.sort((a, b) => b.cells.length - a.cells.length);
  return { regions: refined, statesEvaluated };
}

function nearestCellTopY(cells: readonly TopCell[], x: number, z: number): number {
  let best = cells[0]?.topY ?? 0;
  let bestDist = Number.POSITIVE_INFINITY;
  for (const cell of cells) {
    const dx = cell.x + 0.5 - x;
    const dz = cell.z + 0.5 - z;
    const dist = dx * dx + dz * dz;
    if (dist < bestDist) {
      bestDist = dist;
      best = cell.topY;
    }
  }
  return best;
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const index = clamp(Math.floor((sorted.length - 1) * p), 0, sorted.length - 1);
  return sorted[index];
}

function worldPartFromBoundaryCorners(
  cornersBoundary: [
    [number, number, number],
    [number, number, number],
    [number, number, number],
    [number, number, number],
    [number, number, number],
    [number, number, number],
    [number, number, number],
    [number, number, number]
  ],
  bounds: Bounds,
  resolution: Resolution,
  label: string
): BoxPart {
  const corners = cornersBoundary.map((corner) =>
    worldFromBoundary(corner, bounds, resolution)
  ) as [
    [number, number, number],
    [number, number, number],
    [number, number, number],
    [number, number, number],
    [number, number, number],
    [number, number, number],
    [number, number, number],
    [number, number, number]
  ];

  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let minZ = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  let maxZ = Number.NEGATIVE_INFINITY;

  for (const [x, y, z] of corners) {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (z < minZ) minZ = z;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
    if (z > maxZ) maxZ = z;
  }

  return {
    label,
    position: [(minX + maxX) * 0.5, (minY + maxY) * 0.5, (minZ + maxZ) * 0.5],
    halfExtents: [
      Math.max(MIN_EDGE, (maxX - minX) * 0.5),
      Math.max(MIN_EDGE, (maxY - minY) * 0.5),
      Math.max(MIN_EDGE, (maxZ - minZ) * 0.5)
    ],
    corners
  };
}

function connectedComponents(voxels: readonly Voxel[]): Voxel[][] {
  if (voxels.length === 0) {
    return [];
  }

  const byKey = new Map<string, Voxel>();
  for (const voxel of voxels) {
    byKey.set(voxelKey(voxel.x, voxel.y, voxel.z), voxel);
  }

  const visited = new Set<string>();
  const components: Voxel[][] = [];
  const dirs: Array<[number, number, number]> = [
    [1, 0, 0],
    [-1, 0, 0],
    [0, 1, 0],
    [0, -1, 0],
    [0, 0, 1],
    [0, 0, -1]
  ];

  for (const voxel of voxels) {
    const key = voxelKey(voxel.x, voxel.y, voxel.z);
    if (visited.has(key)) {
      continue;
    }

    const queue: Voxel[] = [voxel];
    visited.add(key);
    const component: Voxel[] = [];

    for (let i = 0; i < queue.length; i += 1) {
      const current = queue[i];
      component.push(current);
      for (const [dx, dy, dz] of dirs) {
        const nextKey = voxelKey(current.x + dx, current.y + dy, current.z + dz);
        if (visited.has(nextKey)) {
          continue;
        }
        const next = byKey.get(nextKey);
        if (!next) {
          continue;
        }
        visited.add(nextKey);
        queue.push(next);
      }
    }

    if (component.length >= MIN_COMPONENT_VOXELS) {
      components.push(component);
    }
  }

  components.sort((a, b) => b.length - a.length);
  return components;
}

function pointInPart(point: Vec3, part: BoxPart): boolean {
  return (
    point[0] >= part.position[0] - part.halfExtents[0] &&
    point[0] <= part.position[0] + part.halfExtents[0] &&
    point[1] >= part.position[1] - part.halfExtents[1] &&
    point[1] <= part.position[1] + part.halfExtents[1] &&
    point[2] >= part.position[2] - part.halfExtents[2] &&
    point[2] <= part.position[2] + part.halfExtents[2]
  );
}

function voxelCenterWorld(voxel: Voxel, prepared: Prepared): Vec3 {
  const { bounds, resolution } = prepared;
  const sizeX = Math.max(MIN_EDGE, bounds.maxX - bounds.minX);
  const sizeY = Math.max(MIN_EDGE, bounds.maxY - bounds.minY);
  const sizeZ = Math.max(MIN_EDGE, bounds.maxZ - bounds.minZ);

  return [
    bounds.minX + ((voxel.x + 0.5) / resolution.xSlices) * sizeX,
    bounds.minY + ((voxel.y + 0.5) / resolution.ySlices) * sizeY,
    bounds.minZ + ((voxel.z + 0.5) / resolution.zSlices) * sizeZ
  ];
}

export function fitCompoundBoxesPlaneGraphPrism(points: readonly Point3[]): SolverResult {
  const prepared = prepare(points);
  if (!prepared) {
    return emptyResult("plane-graph-prism");
  }

  const rootBounds = computeVoxelBounds(prepared.voxels);
  if (!rootBounds) {
    return emptyResult("plane-graph-prism");
  }

  const initialCost =
    Math.max(0, voxelBoundsVolume(rootBounds) - prepared.voxels.length) +
    prepared.boxPenalty;

  const topCellsRaw = buildTopCells(prepared.voxels);
  const topCells = smoothTopCells(topCellsRaw, 1);
  const detected = detectTopRegions(topCells);
  const refined = refineTopRegions(
    detected.regions,
    Math.max(2, Math.min(prepared.maxBoxes + 1, 6))
  );
  const regions = refined.regions;
  let statesEvaluated = detected.statesEvaluated + refined.statesEvaluated;

  const covered = new Set<string>();
  const planarParts: Array<{ part: BoxPart; score: number }> = [];
  const minRegionCells = Math.max(
    MIN_REGION_CELLS,
    Math.floor(topCells.size * 0.08)
  );
  const rootVoxelVolume = voxelBoundsVolume(rootBounds);
  const rootWorldVolume = rootVoxelVolume * prepared.cellVolume;

  for (const [index, region] of regions.entries()) {
    if (region.cells.length < minRegionCells) {
      continue;
    }
    const regionStats = computeRegionStats(region.cells);
    const heights: number[] = [];

    for (const cell of region.cells) {
      heights.push(cell.topY - cell.minY);
    }

    const spanX = regionStats.spanX;
    const spanZ = regionStats.spanZ;
    if (spanX * spanZ < 12 || spanX < 2 || spanZ < 2) {
      continue;
    }
    if (regionStats.fill < 0.45) {
      continue;
    }

    const thickness = Math.max(
      1,
      Math.round(
        clamp(
          percentile(heights, 0.25),
          1,
          Math.max(2, Math.floor(prepared.resolution.ySlices * 0.14))
        )
      )
    );

    const x0 = regionStats.minX;
    const x1 = regionStats.maxX + 1;
    const z0 = regionStats.minZ;
    const z1 = regionStats.maxZ + 1;

    const topAt = (x: number, z: number): number =>
      clamp(
        region.fit.a * x + region.fit.b * z + region.fit.c,
        rootBounds.minY + 1,
        rootBounds.maxY + 1
      );

    const topMaxClamp = Math.min(rootBounds.maxY + 1, regionStats.maxTop + 0.5);
    const topMinClamp = Math.max(rootBounds.minY + 1, regionStats.minTop - 0.5);
    const cornerTop = (x: number, z: number): number => {
      const plane = topAt(x, z);
      const observed = nearestCellTopY(region.cells, x, z);
      return clamp(plane * 0.72 + observed * 0.28, topMinClamp, topMaxClamp);
    };
    const slopeMagnitude = Math.hypot(region.fit.a, region.fit.b);
    const flatTop = clamp(
      percentile(region.cells.map((cell) => cell.topY), 0.72),
      rootBounds.minY + 1,
      rootBounds.maxY + 1
    );

    const top0 =
      slopeMagnitude >= MIN_SLOPE_MAGNITUDE && region.fit.rmse <= 1.12
        ? cornerTop(x0, z0)
        : flatTop;
    const top1 =
      slopeMagnitude >= MIN_SLOPE_MAGNITUDE && region.fit.rmse <= 1.12
        ? cornerTop(x1, z0)
        : flatTop;
    const top2 =
      slopeMagnitude >= MIN_SLOPE_MAGNITUDE && region.fit.rmse <= 1.12
        ? cornerTop(x1, z1)
        : flatTop;
    const top3 =
      slopeMagnitude >= MIN_SLOPE_MAGNITUDE && region.fit.rmse <= 1.12
        ? cornerTop(x0, z1)
        : flatTop;

    const bot0 = clamp(top0 - thickness, rootBounds.minY, rootBounds.maxY);
    const bot1 = clamp(top1 - thickness, rootBounds.minY, rootBounds.maxY);
    const bot2 = clamp(top2 - thickness, rootBounds.minY, rootBounds.maxY);
    const bot3 = clamp(top3 - thickness, rootBounds.minY, rootBounds.maxY);

    const part = worldPartFromBoundaryCorners(
      [
        [x0, bot0, z0],
        [x1, bot1, z0],
        [x1, bot2, z1],
        [x0, bot3, z1],
        [x0, top0, z0],
        [x1, top1, z0],
        [x1, top2, z1],
        [x0, top3, z1]
      ],
      prepared.bounds,
      prepared.resolution,
      `plane-${index + 1}`
    );

    planarParts.push({
      part,
      score:
        region.cells.length *
        (1 / Math.max(0.2, region.fit.rmse)) *
        (0.65 + regionStats.fill)
    });

    for (const cell of region.cells) {
      const shellTop = Math.max(cell.minY + 1, Math.ceil(cell.topY));
      const shellBottom = Math.max(cell.minY, shellTop - thickness);
      for (let y = shellBottom; y < shellTop; y += 1) {
        covered.add(voxelKey(cell.x, y, cell.z));
      }
    }
  }

  planarParts.sort((a, b) => b.score - a.score);

  const residualVoxels = prepared.voxels.filter(
    (voxel) => !covered.has(voxelKey(voxel.x, voxel.y, voxel.z))
  );
  const residualComponents = connectedComponents(residualVoxels);
  const minResidualVoxels = Math.max(
    MIN_COMPONENT_VOXELS,
    Math.floor(prepared.voxels.length * 0.06)
  );

  const residualParts = residualComponents.map((component, index) => {
    if (component.length < minResidualVoxels) {
      return null;
    }
    const bounds = computeVoxelBounds(component);
    if (!bounds) {
      return null;
    }
    return {
      part: partFromVoxelBounds(prepared.bounds, prepared.resolution, bounds, `residual-${index + 1}`),
      score: component.length
    };
  }).filter((entry): entry is { part: BoxPart; score: number } => entry !== null);

  residualParts.sort((a, b) => b.score - a.score);

  const selected: BoxPart[] = [];
  const maxPlanarParts = Math.max(1, Math.min(4, prepared.maxBoxes - 1));
  for (const entry of planarParts) {
    if (selected.length >= maxPlanarParts) {
      break;
    }
    selected.push(entry.part);
  }
  for (const entry of residualParts) {
    if (selected.length >= prepared.maxBoxes) {
      break;
    }
    selected.push(entry.part);
  }

  if (selected.length === 0) {
    selected.push(partFromVoxelBounds(prepared.bounds, prepared.resolution, rootBounds, "plane-1"));
  }

  const voxelWorld = prepared.voxels.map((voxel) => voxelCenterWorld(voxel, prepared));
  let uncovered = 0;
  for (const point of voxelWorld) {
    let inside = false;
    for (const part of selected) {
      if (pointInPart(point, part)) {
        inside = true;
        break;
      }
    }
    if (!inside) {
      uncovered += 1;
    }
  }

  const totalVolume = selected.reduce((sum, part) => sum + boxVolume(part), 0);
  const avgVolume = totalVolume / Math.max(1, selected.length);
  const finalCost =
    totalVolume / prepared.cellVolume +
    uncovered * 0.75 +
    prepared.boxPenalty * 0.15 * Math.max(0, selected.length - 1);

  const uncoveredRatio = uncovered / Math.max(1, prepared.voxels.length);
  const fragmented =
    selected.length >= 3 && avgVolume < rootWorldVolume * 0.06;
  if (fragmented || uncoveredRatio > 0.42) {
    const worldPoints: Point3[] = prepared.voxels.map((voxel) => {
      const point = voxelCenterWorld(voxel, prepared);
      return { x: point[0], y: point[1], z: point[2] };
    });
    const fallback = fitCompoundBoxesGlobal(worldPoints);
    return {
      parts: fallback.parts,
      auto: {
        xSlices: prepared.resolution.xSlices,
        ySlices: prepared.resolution.ySlices,
        zSlices: prepared.resolution.zSlices,
        occupiedVoxels: prepared.voxels.length,
        boxPenalty: prepared.boxPenalty,
        maxBoxes: prepared.maxBoxes,
        splitsAccepted: fallback.auto.splitsAccepted,
        initialCost,
        finalCost: fallback.auto.finalCost,
        strategy: "plane-graph-prism",
        selectedBoxCount: fallback.auto.selectedBoxCount ?? fallback.parts.length,
        selectionScore: fallback.auto.selectionScore ?? fallback.auto.finalCost,
        statesEvaluated: (fallback.auto.statesEvaluated ?? 0) + statesEvaluated + residualComponents.length,
        beamWidth: fallback.auto.beamWidth
      }
    };
  }

  return {
    parts: selected,
    auto: {
      xSlices: prepared.resolution.xSlices,
      ySlices: prepared.resolution.ySlices,
      zSlices: prepared.resolution.zSlices,
      occupiedVoxels: prepared.voxels.length,
      boxPenalty: prepared.boxPenalty,
      maxBoxes: prepared.maxBoxes,
      splitsAccepted: Math.max(0, selected.length - 1),
      initialCost,
      finalCost,
      strategy: "plane-graph-prism",
      selectedBoxCount: selected.length,
      selectionScore: finalCost,
      statesEvaluated: statesEvaluated + residualComponents.length
    }
  };
}

export type { SolverResult as CompoundLabSolverResult };
