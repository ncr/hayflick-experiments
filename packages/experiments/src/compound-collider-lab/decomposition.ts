export type Point3 = {
  x: number;
  y: number;
  z: number;
};

export type BoxPart = {
  position: [number, number, number];
  halfExtents: [number, number, number];
  label: string;
  corners?: [
    [number, number, number],
    [number, number, number],
    [number, number, number],
    [number, number, number],
    [number, number, number],
    [number, number, number],
    [number, number, number],
    [number, number, number]
  ];
};

export type CompoundObjectiveFitResult = {
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
    strategy?: "hybrid-greedy" | "global-beam";
    beamWidth?: number;
    statesEvaluated?: number;
    selectedBoxCount?: number;
    selectionScore?: number;
  };
};

type Bounds = {
  minX: number;
  minY: number;
  minZ: number;
  maxX: number;
  maxY: number;
  maxZ: number;
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

type VoxelBox = {
  id: number;
  voxels: Voxel[];
  bounds: VoxelBounds;
  volume: number;
  occupied: number;
  empty: number;
  effectiveEmpty: number;
  deformed: {
    enabled: boolean;
    dominantAxis: "x" | "z" | "both" | null;
    cornersBoundary?: [
      [number, number, number],
      [number, number, number],
      [number, number, number],
      [number, number, number],
      [number, number, number],
      [number, number, number],
      [number, number, number],
      [number, number, number]
    ];
  };
};

type SplitCandidate = {
  axis: "x" | "y" | "z";
  split: number;
  score: number;
  immediateGain: number;
  left: VoxelBox;
  right: VoxelBox;
};

const MIN_EDGE = 0.01;
const MIN_SPLIT_PART_VOXELS = 12;
const MAX_SPLIT_CANDIDATES_PER_AXIS = 14;
const LOOKAHEAD_WEIGHT = 0.72;
const SLOPE_MIN_MAGNITUDE = 0.075;
const SLOPE_MAX_RMSE = 1.1;
const SLOPE_COST_WEIGHT = 0.35;
const MAX_VALLEY_SPLITS_PER_AXIS = 4;
const GLOBAL_BEAM_WIDTH = 28;
const GLOBAL_TOP_SPLITS_PER_BOX = 3;

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

function chooseAutoResolution(bounds: Bounds, pointCount: number): {
  xSlices: number;
  ySlices: number;
  zSlices: number;
} {
  const sizeX = Math.max(MIN_EDGE, bounds.maxX - bounds.minX);
  const sizeY = Math.max(MIN_EDGE, bounds.maxY - bounds.minY);
  const sizeZ = Math.max(MIN_EDGE, bounds.maxZ - bounds.minZ);
  const maxDim = Math.max(sizeX, sizeY, sizeZ, MIN_EDGE);
  const density = clamp(Math.log10(Math.max(32, pointCount)) / 4.2, 0, 1);
  const base = Math.round(clamp(20 + density * 22, 20, 54));

  const xSlices = Math.round(clamp((sizeX / maxDim) * base, 12, 56));
  const ySlices = Math.round(clamp((sizeY / maxDim) * base, 12, 56));
  const zSlices = Math.round(clamp((sizeZ / maxDim) * base, 12, 56));
  return { xSlices, ySlices, zSlices };
}

function voxelKey(x: number, y: number, z: number): string {
  return `${x}|${y}|${z}`;
}

function voxelizePoints(
  points: readonly Point3[],
  bounds: Bounds,
  xSlices: number,
  ySlices: number,
  zSlices: number
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
    const x = Math.floor(xNorm * xSlices);
    const y = Math.floor(yNorm * ySlices);
    const z = Math.floor(zNorm * zSlices);
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

type TopEnvelopeSample = {
  x: number;
  z: number;
  minY: number;
  topBoundaryY: number;
};

type DeformedFit = {
  enabled: boolean;
  effectiveVolume: number;
  dominantAxis: "x" | "z" | "both" | null;
  cornersBoundary?: [
    [number, number, number],
    [number, number, number],
    [number, number, number],
    [number, number, number],
    [number, number, number],
    [number, number, number],
    [number, number, number],
    [number, number, number]
  ];
};

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
    if (Math.abs(m[pivot][col]) < 1e-8) {
      return null;
    }
    if (pivot !== col) {
      const tmp = m[col];
      m[col] = m[pivot];
      m[pivot] = tmp;
    }
    const pivotValue = m[col][col];
    for (let k = col; k < 4; k += 1) {
      m[col][k] /= pivotValue;
    }
    for (let row = 0; row < 3; row += 1) {
      if (row === col) {
        continue;
      }
      const factor = m[row][col];
      for (let k = col; k < 4; k += 1) {
        m[row][k] -= factor * m[col][k];
      }
    }
  }

  return [m[0][3], m[1][3], m[2][3]];
}

function buildTopEnvelope(box: VoxelBox): TopEnvelopeSample[] {
  const byCell = new Map<string, TopEnvelopeSample>();
  for (const voxel of box.voxels) {
    const key = `${voxel.x}|${voxel.z}`;
    const existing = byCell.get(key);
    if (!existing) {
      byCell.set(key, {
        x: voxel.x,
        z: voxel.z,
        minY: voxel.y,
        topBoundaryY: voxel.y + 1
      });
      continue;
    }
    if (voxel.y < existing.minY) {
      existing.minY = voxel.y;
    }
    const top = voxel.y + 1;
    if (top > existing.topBoundaryY) {
      existing.topBoundaryY = top;
    }
  }
  return [...byCell.values()];
}

function fitSlopedTop(box: VoxelBox): DeformedFit {
  const envelope = buildTopEnvelope(box);
  if (envelope.length < 6) {
    return {
      enabled: false,
      effectiveVolume: box.volume,
      dominantAxis: null
    };
  }

  let sx = 0;
  let sz = 0;
  let sy = 0;
  let sxx = 0;
  let szz = 0;
  let sxz = 0;
  let sxy = 0;
  let szy = 0;
  const n = envelope.length;

  for (const sample of envelope) {
    const x = sample.x + 0.5;
    const z = sample.z + 0.5;
    const y = sample.topBoundaryY;
    sx += x;
    sz += z;
    sy += y;
    sxx += x * x;
    szz += z * z;
    sxz += x * z;
    sxy += x * y;
    szy += z * y;
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
    return {
      enabled: false,
      effectiveVolume: box.volume,
      dominantAxis: null
    };
  }

  const [ax, bz, c] = solved;
  let constrainedC = c;
  let topUnderfit = 0;
  for (const sample of envelope) {
    const x = sample.x + 0.5;
    const z = sample.z + 0.5;
    const predicted = ax * x + bz * z + constrainedC;
    const violation = sample.topBoundaryY - predicted;
    if (violation > topUnderfit) {
      topUnderfit = violation;
    }
  }
  constrainedC += topUnderfit;
  const slopeMagnitude = Math.sqrt(ax * ax + bz * bz);
  let sqError = 0;
  for (const sample of envelope) {
    const x = sample.x + 0.5;
    const z = sample.z + 0.5;
    const predicted = ax * x + bz * z + constrainedC;
    const diff = predicted - sample.topBoundaryY;
    sqError += diff * diff;
  }
  const rmse = Math.sqrt(sqError / Math.max(1, envelope.length));
  const slopeEnabled =
    slopeMagnitude >= SLOPE_MIN_MAGNITUDE * 0.7 && rmse <= SLOPE_MAX_RMSE;

  const minBoundaryY = box.bounds.minY;
  const maxBoundaryY = box.bounds.maxY + 1;
  const x0 = box.bounds.minX;
  const x1 = box.bounds.maxX + 1;
  const z0 = box.bounds.minZ;
  const z1 = box.bounds.maxZ + 1;

  const clampTop = (value: number): number => {
    return clamp(value, minBoundaryY + 1, maxBoundaryY);
  };

  const topCorners: [number, number, number, number] = [
    clampTop(ax * x0 + bz * z0 + constrainedC),
    clampTop(ax * x1 + bz * z0 + constrainedC),
    clampTop(ax * x1 + bz * z1 + constrainedC),
    clampTop(ax * x0 + bz * z1 + constrainedC)
  ];

  let effectiveVolume = 0;
  for (const sample of envelope) {
    const x = sample.x + 0.5;
    const z = sample.z + 0.5;
    const predictedTop = slopeEnabled
      ? clampTop(ax * x + bz * z + constrainedC)
      : maxBoundaryY;
    const localBottom = Math.min(sample.minY, minBoundaryY);
    const localHeight = Math.max(1, predictedTop - localBottom);
    effectiveVolume += localHeight;
  }
  effectiveVolume = Math.max(box.occupied, effectiveVolume);

  if (!slopeEnabled) {
    return {
      enabled: false,
      effectiveVolume: box.volume,
      dominantAxis: null
    };
  }

  return {
    enabled: true,
    effectiveVolume,
    dominantAxis: Math.abs(ax) >= Math.abs(bz) ? "x" : "z",
    cornersBoundary: [
      [x0, minBoundaryY, z0],
      [x1, minBoundaryY, z0],
      [x1, minBoundaryY, z1],
      [x0, minBoundaryY, z1],
      [x0, topCorners[0], z0],
      [x1, topCorners[1], z0],
      [x1, topCorners[2], z1],
      [x0, topCorners[3], z1]
    ]
  };
}

function fitLinear1D(samples: Array<{ t: number; value: number }>): {
  a: number;
  b: number;
  rmse: number;
} | null {
  if (samples.length < 4) {
    return null;
  }
  let st = 0;
  let sv = 0;
  let stt = 0;
  let stv = 0;
  const n = samples.length;
  for (const sample of samples) {
    st += sample.t;
    sv += sample.value;
    stt += sample.t * sample.t;
    stv += sample.t * sample.value;
  }
  const det = n * stt - st * st;
  if (Math.abs(det) < 1e-8) {
    return null;
  }
  const a = (n * stv - st * sv) / det;
  const b = (sv - a * st) / n;
  let sq = 0;
  for (const sample of samples) {
    const diff = a * sample.t + b - sample.value;
    sq += diff * diff;
  }
  const rmse = Math.sqrt(sq / n);
  return { a, b, rmse };
}

function constrainLinearFitToEnvelope(
  fit: { a: number; b: number; rmse: number },
  samples: ReadonlyArray<{ t: number; value: number }>,
  mode: "min" | "max"
): { a: number; b: number; rmse: number } {
  let offset = 0;
  for (const sample of samples) {
    const predicted = fit.a * sample.t + fit.b;
    const violation =
      mode === "min"
        ? predicted - sample.value
        : sample.value - predicted;
    if (violation > offset) {
      offset = violation;
    }
  }

  const b = mode === "min" ? fit.b - offset : fit.b + offset;
  let sq = 0;
  for (const sample of samples) {
    const diff = fit.a * sample.t + b - sample.value;
    sq += diff * diff;
  }
  const rmse = Math.sqrt(sq / Math.max(1, samples.length));
  return { a: fit.a, b, rmse };
}

function fitSideSlope(
  box: VoxelBox,
  axis: "x" | "z"
): DeformedFit {
  const samplesByY = new Map<number, { min: number; max: number }>();
  for (const voxel of box.voxels) {
    const y = voxel.y;
    const value = axis === "x" ? voxel.x : voxel.z;
    const existing = samplesByY.get(y);
    if (!existing) {
      samplesByY.set(y, { min: value, max: value + 1 });
      continue;
    }
    if (value < existing.min) {
      existing.min = value;
    }
    if (value + 1 > existing.max) {
      existing.max = value + 1;
    }
  }

  const mins: Array<{ t: number; value: number }> = [];
  const maxs: Array<{ t: number; value: number }> = [];
  for (const [y, band] of samplesByY.entries()) {
    const t = y + 0.5;
    mins.push({ t, value: band.min });
    maxs.push({ t, value: band.max });
  }
  const minFitRaw = fitLinear1D(mins);
  const maxFitRaw = fitLinear1D(maxs);
  if (!minFitRaw || !maxFitRaw) {
    return {
      enabled: false,
      effectiveVolume: box.volume,
      dominantAxis: null
    };
  }
  const minFit = constrainLinearFitToEnvelope(minFitRaw, mins, "min");
  const maxFit = constrainLinearFitToEnvelope(maxFitRaw, maxs, "max");

  const slopeMagnitude = Math.max(Math.abs(minFit.a), Math.abs(maxFit.a));
  const rmse = Math.max(minFit.rmse, maxFit.rmse);
  if (
    slopeMagnitude < SLOPE_MIN_MAGNITUDE * 0.8 ||
    rmse > SLOPE_MAX_RMSE * 1.2
  ) {
    return {
      enabled: false,
      effectiveVolume: box.volume,
      dominantAxis: null
    };
  }

  const minBoundaryY = box.bounds.minY;
  const maxBoundaryY = box.bounds.maxY + 1;
  const varMin = axis === "x" ? box.bounds.minX : box.bounds.minZ;
  const varMax = axis === "x" ? box.bounds.maxX + 1 : box.bounds.maxZ + 1;
  const clampVar = (value: number): number =>
    clamp(value, varMin, varMax);

  const minAt = (t: number): number => clampVar(minFit.a * t + minFit.b);
  const maxAt = (t: number): number => clampVar(maxFit.a * t + maxFit.b);

  const minBottom = minAt(minBoundaryY);
  const maxBottom = Math.max(minBottom + 1, maxAt(minBoundaryY));
  const minTop = minAt(maxBoundaryY);
  const maxTop = Math.max(minTop + 1, maxAt(maxBoundaryY));

  const spanOther =
    axis === "x"
      ? box.bounds.maxZ - box.bounds.minZ + 1
      : box.bounds.maxX - box.bounds.minX + 1;
  let effectiveVolume = 0;
  for (const [y] of samplesByY.entries()) {
    const t = y + 0.5;
    const minPred = minAt(t);
    const maxPred = Math.max(minPred + 1, maxAt(t));
    const width = Math.max(1, maxPred - minPred);
    effectiveVolume += width * spanOther;
  }
  effectiveVolume = Math.max(box.occupied, effectiveVolume);

  const x0 = box.bounds.minX;
  const x1 = box.bounds.maxX + 1;
  const z0 = box.bounds.minZ;
  const z1 = box.bounds.maxZ + 1;
  const corners =
    axis === "z"
      ? ([
          [x0, minBoundaryY, minBottom],
          [x1, minBoundaryY, minBottom],
          [x1, minBoundaryY, maxBottom],
          [x0, minBoundaryY, maxBottom],
          [x0, maxBoundaryY, minTop],
          [x1, maxBoundaryY, minTop],
          [x1, maxBoundaryY, maxTop],
          [x0, maxBoundaryY, maxTop]
        ] as const)
      : ([
          [minBottom, minBoundaryY, z0],
          [maxBottom, minBoundaryY, z0],
          [maxBottom, minBoundaryY, z1],
          [minBottom, minBoundaryY, z1],
          [minTop, maxBoundaryY, z0],
          [maxTop, maxBoundaryY, z0],
          [maxTop, maxBoundaryY, z1],
          [minTop, maxBoundaryY, z1]
        ] as const);

  return {
    enabled: true,
    effectiveVolume,
    dominantAxis: axis,
    cornersBoundary: [
      [corners[0][0], corners[0][1], corners[0][2]],
      [corners[1][0], corners[1][1], corners[1][2]],
      [corners[2][0], corners[2][1], corners[2][2]],
      [corners[3][0], corners[3][1], corners[3][2]],
      [corners[4][0], corners[4][1], corners[4][2]],
      [corners[5][0], corners[5][1], corners[5][2]],
      [corners[6][0], corners[6][1], corners[6][2]],
      [corners[7][0], corners[7][1], corners[7][2]]
    ]
  };
}

function fitBiSideSlope(box: VoxelBox): DeformedFit {
  const bands = new Map<
    number,
    { minX: number; maxX: number; minZ: number; maxZ: number }
  >();
  for (const voxel of box.voxels) {
    const y = voxel.y;
    const existing = bands.get(y);
    if (!existing) {
      bands.set(y, {
        minX: voxel.x,
        maxX: voxel.x + 1,
        minZ: voxel.z,
        maxZ: voxel.z + 1
      });
      continue;
    }
    if (voxel.x < existing.minX) {
      existing.minX = voxel.x;
    }
    if (voxel.x + 1 > existing.maxX) {
      existing.maxX = voxel.x + 1;
    }
    if (voxel.z < existing.minZ) {
      existing.minZ = voxel.z;
    }
    if (voxel.z + 1 > existing.maxZ) {
      existing.maxZ = voxel.z + 1;
    }
  }

  const minXSamples: Array<{ t: number; value: number }> = [];
  const maxXSamples: Array<{ t: number; value: number }> = [];
  const minZSamples: Array<{ t: number; value: number }> = [];
  const maxZSamples: Array<{ t: number; value: number }> = [];
  for (const [y, band] of bands.entries()) {
    const t = y + 0.5;
    minXSamples.push({ t, value: band.minX });
    maxXSamples.push({ t, value: band.maxX });
    minZSamples.push({ t, value: band.minZ });
    maxZSamples.push({ t, value: band.maxZ });
  }

  const minXFitRaw = fitLinear1D(minXSamples);
  const maxXFitRaw = fitLinear1D(maxXSamples);
  const minZFitRaw = fitLinear1D(minZSamples);
  const maxZFitRaw = fitLinear1D(maxZSamples);
  if (!minXFitRaw || !maxXFitRaw || !minZFitRaw || !maxZFitRaw) {
    return {
      enabled: false,
      effectiveVolume: box.volume,
      dominantAxis: null
    };
  }
  const minXFit = constrainLinearFitToEnvelope(minXFitRaw, minXSamples, "min");
  const maxXFit = constrainLinearFitToEnvelope(maxXFitRaw, maxXSamples, "max");
  const minZFit = constrainLinearFitToEnvelope(minZFitRaw, minZSamples, "min");
  const maxZFit = constrainLinearFitToEnvelope(maxZFitRaw, maxZSamples, "max");

  const slopeX = Math.max(Math.abs(minXFit.a), Math.abs(maxXFit.a));
  const slopeZ = Math.max(Math.abs(minZFit.a), Math.abs(maxZFit.a));
  const rmse = Math.max(minXFit.rmse, maxXFit.rmse, minZFit.rmse, maxZFit.rmse);
  if (
    Math.max(slopeX, slopeZ) < SLOPE_MIN_MAGNITUDE * 0.75 ||
    rmse > SLOPE_MAX_RMSE * 1.25
  ) {
    return {
      enabled: false,
      effectiveVolume: box.volume,
      dominantAxis: null
    };
  }

  const minBoundaryY = box.bounds.minY;
  const maxBoundaryY = box.bounds.maxY + 1;
  const clampX = (value: number): number =>
    clamp(value, box.bounds.minX, box.bounds.maxX + 1);
  const clampZ = (value: number): number =>
    clamp(value, box.bounds.minZ, box.bounds.maxZ + 1);
  const minXAt = (t: number): number => clampX(minXFit.a * t + minXFit.b);
  const maxXAt = (t: number): number => clampX(maxXFit.a * t + maxXFit.b);
  const minZAt = (t: number): number => clampZ(minZFit.a * t + minZFit.b);
  const maxZAt = (t: number): number => clampZ(maxZFit.a * t + maxZFit.b);

  const xMinBottom = minXAt(minBoundaryY);
  const xMaxBottom = Math.max(xMinBottom + 1, maxXAt(minBoundaryY));
  const zMinBottom = minZAt(minBoundaryY);
  const zMaxBottom = Math.max(zMinBottom + 1, maxZAt(minBoundaryY));
  const xMinTop = minXAt(maxBoundaryY);
  const xMaxTop = Math.max(xMinTop + 1, maxXAt(maxBoundaryY));
  const zMinTop = minZAt(maxBoundaryY);
  const zMaxTop = Math.max(zMinTop + 1, maxZAt(maxBoundaryY));

  let effectiveVolume = 0;
  for (const [y] of bands.entries()) {
    const t = y + 0.5;
    const xMin = minXAt(t);
    const xMax = Math.max(xMin + 1, maxXAt(t));
    const zMin = minZAt(t);
    const zMax = Math.max(zMin + 1, maxZAt(t));
    effectiveVolume += Math.max(1, xMax - xMin) * Math.max(1, zMax - zMin);
  }
  effectiveVolume = Math.max(box.occupied, effectiveVolume);

  const dominantAxis: "x" | "z" | "both" =
    slopeX >= SLOPE_MIN_MAGNITUDE && slopeZ >= SLOPE_MIN_MAGNITUDE
      ? "both"
      : slopeX >= slopeZ
        ? "x"
        : "z";

  return {
    enabled: true,
    effectiveVolume,
    dominantAxis,
    cornersBoundary: [
      [xMinBottom, minBoundaryY, zMinBottom],
      [xMaxBottom, minBoundaryY, zMinBottom],
      [xMaxBottom, minBoundaryY, zMaxBottom],
      [xMinBottom, minBoundaryY, zMaxBottom],
      [xMinTop, maxBoundaryY, zMinTop],
      [xMaxTop, maxBoundaryY, zMinTop],
      [xMaxTop, maxBoundaryY, zMaxTop],
      [xMinTop, maxBoundaryY, zMaxTop]
    ]
  };
}

function fitDeformedBox(box: VoxelBox): DeformedFit {
  const baseline: DeformedFit = {
    enabled: false,
    effectiveVolume: box.volume,
    dominantAxis: null
  };
  const candidates = [
    fitSlopedTop(box),
    fitBiSideSlope(box),
    fitSideSlope(box, "z"),
    fitSideSlope(box, "x")
  ].filter((candidate) => candidate.enabled);

  if (candidates.length === 0) {
    return baseline;
  }

  candidates.sort((a, b) => a.effectiveVolume - b.effectiveVolume);
  const best = candidates[0];
  if (!best) {
    return baseline;
  }

  const improvement = box.volume - best.effectiveVolume;
  if (improvement < Math.max(2, box.volume * 0.015)) {
    return baseline;
  }
  return best;
}

function createVoxelBox(id: number, voxels: Voxel[]): VoxelBox {
  const bounds = computeVoxelBounds(voxels);
  if (!bounds) {
    throw new Error("Cannot create voxel box from empty voxel set.");
  }

  const volume = voxelBoundsVolume(bounds);
  const occupied = voxels.length;
  const empty = Math.max(0, volume - occupied);
  const fit = fitDeformedBox({
    id,
    voxels,
    bounds,
    volume,
    occupied,
    empty,
    effectiveEmpty: empty,
    deformed: {
      enabled: false,
      dominantAxis: null
    }
  });
  const effectiveEmpty = Math.max(0, fit.effectiveVolume - occupied);
  return {
    id,
    voxels,
    bounds,
    volume,
    occupied,
    empty,
    effectiveEmpty,
    deformed: {
      enabled: fit.enabled,
      dominantAxis: fit.dominantAxis,
      cornersBoundary: fit.cornersBoundary
    }
  };
}

function chooseBoxPenalty(occupiedVoxels: number): number {
  return Math.round(
    clamp(16 + Math.sqrt(occupiedVoxels) * 1.6, 22, 220)
  );
}

function chooseSearchMaxBoxes(occupiedVoxels: number): number {
  return Math.round(clamp(4 + Math.sqrt(occupiedVoxels) / 4, 4, 14));
}

function modelSelectionPenalty(
  boxCount: number,
  boxPenalty: number
): number {
  const extra = Math.max(0, boxCount - 1);
  if (extra <= 0) {
    return 0;
  }
  return boxPenalty * 0.45 * Math.pow(extra, 1.35);
}

type SearchCandidateState = {
  boxes: VoxelBox[];
  cost: number;
  splitsAccepted: number;
};

type SearchSelection = {
  state: SearchCandidateState;
  selectionScore: number;
};

function selectionScoreForState(
  state: SearchCandidateState,
  boxPenalty: number
): number {
  return (
    state.cost +
    modelSelectionPenalty(state.boxes.length, boxPenalty)
  );
}

function lineDistance(
  x: number,
  y: number,
  x1: number,
  y1: number,
  x2: number,
  y2: number
): number {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const denom = Math.hypot(dx, dy);
  if (denom <= 1e-9) {
    return 0;
  }
  return Math.abs(dy * x - dx * y + x2 * y1 - y2 * x1) / denom;
}

function selectOptimalStateFromFrontier(
  states: readonly SearchCandidateState[],
  boxPenalty: number
): SearchSelection {
  if (states.length === 0) {
    throw new Error("Cannot select optimal state from an empty frontier.");
  }

  const sorted = [...states].sort((a, b) => {
    if (a.boxes.length !== b.boxes.length) {
      return a.boxes.length - b.boxes.length;
    }
    return a.cost - b.cost;
  });

  let bestByScore = sorted[0];
  let bestScore = selectionScoreForState(bestByScore, boxPenalty);
  for (let i = 1; i < sorted.length; i += 1) {
    const candidate = sorted[i];
    const score = selectionScoreForState(candidate, boxPenalty);
    if (score < bestScore) {
      bestByScore = candidate;
      bestScore = score;
    }
  }

  if (sorted.length < 3) {
    return {
      state: bestByScore,
      selectionScore: bestScore
    };
  }

  const first = sorted[0];
  const last = sorted[sorted.length - 1];
  const x1 = first.boxes.length;
  const y1 = first.cost;
  const x2 = last.boxes.length;
  const y2 = last.cost;
  let elbowState = first;
  let elbowDistance = Number.NEGATIVE_INFINITY;

  for (let i = 1; i < sorted.length - 1; i += 1) {
    const candidate = sorted[i];
    const distance = lineDistance(
      candidate.boxes.length,
      candidate.cost,
      x1,
      y1,
      x2,
      y2
    );
    if (distance > elbowDistance) {
      elbowDistance = distance;
      elbowState = candidate;
    }
  }

  const elbowScore = selectionScoreForState(elbowState, boxPenalty);
  const bestCount = bestByScore.boxes.length;
  const elbowCount = elbowState.boxes.length;
  const prefersElbowCount = elbowCount <= bestCount && elbowCount + 1 >= bestCount;
  const elbowWithinTolerance = elbowScore <= bestScore + boxPenalty * 0.12;

  if (prefersElbowCount && elbowWithinTolerance) {
    return {
      state: elbowState,
      selectionScore: elbowScore
    };
  }

  return {
    state: bestByScore,
    selectionScore: bestScore
  };
}

function chooseSplitPositions(
  box: VoxelBox,
  axis: "x" | "y" | "z"
): number[] {
  const values = new Set<number>();
  const max =
    axis === "x" ? box.bounds.maxX : axis === "y" ? box.bounds.maxY : box.bounds.maxZ;

  for (const voxel of box.voxels) {
    const value = axis === "x" ? voxel.x : axis === "y" ? voxel.y : voxel.z;
    if (value < max) {
      values.add(value);
    }
  }

  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length <= MAX_SPLIT_CANDIDATES_PER_AXIS) {
    return sorted;
  }

  const sampled = new Set<number>();
  const last = sorted.length - 1;
  for (let i = 1; i <= MAX_SPLIT_CANDIDATES_PER_AXIS; i += 1) {
    const index = Math.floor((i / (MAX_SPLIT_CANDIDATES_PER_AXIS + 1)) * last);
    sampled.add(sorted[index]);
  }
  return [...sampled].sort((a, b) => a - b);
}

function axisRange(box: VoxelBox, axis: "x" | "y" | "z"): { min: number; max: number } {
  if (axis === "x") {
    return { min: box.bounds.minX, max: box.bounds.maxX };
  }
  if (axis === "y") {
    return { min: box.bounds.minY, max: box.bounds.maxY };
  }
  return { min: box.bounds.minZ, max: box.bounds.maxZ };
}

function dominantSlopeAxis(box: VoxelBox): "x" | "z" | "both" | null {
  if (!box.deformed.enabled) {
    return null;
  }
  return box.deformed.dominantAxis;
}

function chooseValleySplitPositions(
  box: VoxelBox,
  axis: "x" | "y" | "z"
): number[] {
  const { min, max } = axisRange(box, axis);
  const length = max - min + 1;
  if (length < 3) {
    return [];
  }
  const counts = new Array<number>(length).fill(0);
  for (const voxel of box.voxels) {
    const value = axis === "x" ? voxel.x : axis === "y" ? voxel.y : voxel.z;
    counts[value - min] += 1;
  }

  const smooth = counts.map((_, index) => {
    const prev = counts[Math.max(0, index - 1)];
    const next = counts[Math.min(length - 1, index + 1)];
    return (prev + counts[index] + next) / 3;
  });
  const avg = smooth.reduce((sum, value) => sum + value, 0) / Math.max(1, smooth.length);
  const valleys: Array<{ split: number; score: number }> = [];

  for (let i = 1; i < length - 1; i += 1) {
    const value = smooth[i];
    if (value > smooth[i - 1] || value > smooth[i + 1]) {
      continue;
    }
    if (value > avg * 0.7) {
      continue;
    }
    const split = min + i;
    if (split >= max) {
      continue;
    }
    valleys.push({ split, score: value });
  }

  valleys.sort((a, b) => a.score - b.score);
  return valleys.slice(0, MAX_VALLEY_SPLITS_PER_AXIS).map((entry) => entry.split);
}

function chooseCandidateSplits(
  box: VoxelBox,
  axis: "x" | "y" | "z"
): number[] {
  const candidates = new Set<number>([
    ...chooseSplitPositions(box, axis),
    ...chooseValleySplitPositions(box, axis)
  ]);

  const slopeAxis = dominantSlopeAxis(box);
  if (slopeAxis && (slopeAxis === axis || slopeAxis === "both")) {
    const { min, max } = axisRange(box, axis);
    const span = max - min + 1;
    if (span >= 4) {
      const quarter = Math.floor(min + span * 0.25);
      const mid = Math.floor(min + span * 0.5);
      const threeQuarter = Math.floor(min + span * 0.75);
      for (const split of [quarter, mid, threeQuarter]) {
        if (split >= min && split < max) {
          candidates.add(split);
        }
      }
    }
  }

  return [...candidates].sort((a, b) => a - b);
}

function splitVoxels(
  voxels: readonly Voxel[],
  axis: "x" | "y" | "z",
  split: number
): { left: Voxel[]; right: Voxel[] } {
  const left: Voxel[] = [];
  const right: Voxel[] = [];

  for (const voxel of voxels) {
    const value = axis === "x" ? voxel.x : axis === "y" ? voxel.y : voxel.z;
    if (value <= split) {
      left.push(voxel);
    } else {
      right.push(voxel);
    }
  }

  return { left, right };
}

function boxSignature(box: VoxelBox): string {
  const b = box.bounds;
  return `${b.minX}:${b.minY}:${b.minZ}:${b.maxX}:${b.maxY}:${b.maxZ}:${box.occupied}`;
}

function computeImmediateGain(
  parent: VoxelBox,
  left: VoxelBox,
  right: VoxelBox,
  boxPenalty: number
): number | null {
  const leftFill = left.occupied / Math.max(1, left.volume);
  const rightFill = right.occupied / Math.max(1, right.volume);
  if (leftFill < 0.08 || rightFill < 0.08) {
    return null;
  }

  const rawEmptyReduction = parent.empty - (left.empty + right.empty);
  const slopedEmptyReduction =
    parent.effectiveEmpty - (left.effectiveEmpty + right.effectiveEmpty);
  const emptyReduction =
    rawEmptyReduction * (1 - SLOPE_COST_WEIGHT) +
    slopedEmptyReduction * SLOPE_COST_WEIGHT;
  const balance =
    Math.min(left.occupied, right.occupied) /
    Math.max(1, Math.max(left.occupied, right.occupied));
  const balancePenalty = (1 - balance) * boxPenalty * 0.25;
  return emptyReduction - boxPenalty - balancePenalty;
}

function estimateBestImmediateGain(
  box: VoxelBox,
  boxPenalty: number,
  cache: Map<string, number>
): number {
  const key = boxSignature(box);
  const cached = cache.get(key);
  if (cached !== undefined) {
    return cached;
  }

  let bestGain = Number.NEGATIVE_INFINITY;
  for (const axis of ["x", "y", "z"] as const) {
    const candidates = chooseCandidateSplits(box, axis);
    for (const split of candidates) {
      const partition = splitVoxels(box.voxels, axis, split);
      if (
        partition.left.length < MIN_SPLIT_PART_VOXELS ||
        partition.right.length < MIN_SPLIT_PART_VOXELS
      ) {
        continue;
      }

      const left = createVoxelBox(-1, partition.left);
      const right = createVoxelBox(-1, partition.right);
      const gain = computeImmediateGain(box, left, right, boxPenalty);
      if (gain === null) {
        continue;
      }
      if (gain > bestGain) {
        bestGain = gain;
      }
    }
  }

  cache.set(key, bestGain);
  return bestGain;
}

function evaluateTopSplitsForBox(
  box: VoxelBox,
  boxPenalty: number,
  immediateGainCache: Map<string, number>,
  limit: number
): SplitCandidate[] {
  const candidatesOut: SplitCandidate[] = [];
  for (const axis of ["x", "y", "z"] as const) {
    const candidates = chooseCandidateSplits(box, axis);
    for (const split of candidates) {
      const partition = splitVoxels(box.voxels, axis, split);
      if (
        partition.left.length < MIN_SPLIT_PART_VOXELS ||
        partition.right.length < MIN_SPLIT_PART_VOXELS
      ) {
        continue;
      }

      const left = createVoxelBox(-1, partition.left);
      const right = createVoxelBox(-1, partition.right);
      const immediateGain = computeImmediateGain(box, left, right, boxPenalty);
      if (immediateGain === null) {
        continue;
      }

      const leftBest = estimateBestImmediateGain(left, boxPenalty, immediateGainCache);
      const rightBest = estimateBestImmediateGain(right, boxPenalty, immediateGainCache);
      const futureGain =
        Math.max(0, Number.isFinite(leftBest) ? leftBest : Number.NEGATIVE_INFINITY) +
        Math.max(0, Number.isFinite(rightBest) ? rightBest : Number.NEGATIVE_INFINITY);
      const score = immediateGain + LOOKAHEAD_WEIGHT * futureGain;
      if (score <= 0) {
        continue;
      }

      candidatesOut.push({
        axis,
        split,
        score,
        immediateGain,
        left,
        right
      });
    }
  }

  candidatesOut.sort((a, b) => {
    if (b.score !== a.score) {
      return b.score - a.score;
    }
    if (b.immediateGain !== a.immediateGain) {
      return b.immediateGain - a.immediateGain;
    }
    if (a.axis !== b.axis) {
      return a.axis.localeCompare(b.axis);
    }
    return a.split - b.split;
  });

  return candidatesOut.slice(0, Math.max(1, limit));
}

function evaluateBestSplit(
  box: VoxelBox,
  boxPenalty: number,
  nextIdRef: { value: number },
  immediateGainCache: Map<string, number>
): SplitCandidate | null {
  const [best] = evaluateTopSplitsForBox(
    box,
    boxPenalty,
    immediateGainCache,
    1
  );

  if (!best || best.score <= 0) {
    return null;
  }

  best.left.id = nextIdRef.value;
  best.right.id = nextIdRef.value + 1;
  nextIdRef.value += 2;
  return best;
}

function worldMinMaxFromVoxelBounds(
  bounds: Bounds,
  voxelBounds: VoxelBounds,
  xSlices: number,
  ySlices: number,
  zSlices: number
): {
  minX: number;
  minY: number;
  minZ: number;
  maxX: number;
  maxY: number;
  maxZ: number;
} {
  const sizeX = Math.max(MIN_EDGE, bounds.maxX - bounds.minX);
  const sizeY = Math.max(MIN_EDGE, bounds.maxY - bounds.minY);
  const sizeZ = Math.max(MIN_EDGE, bounds.maxZ - bounds.minZ);

  const minX = bounds.minX + (voxelBounds.minX / xSlices) * sizeX;
  const minY = bounds.minY + (voxelBounds.minY / ySlices) * sizeY;
  const minZ = bounds.minZ + (voxelBounds.minZ / zSlices) * sizeZ;
  const maxX = bounds.minX + ((voxelBounds.maxX + 1) / xSlices) * sizeX;
  const maxY = bounds.minY + ((voxelBounds.maxY + 1) / ySlices) * sizeY;
  const maxZ = bounds.minZ + ((voxelBounds.maxZ + 1) / zSlices) * sizeZ;
  return { minX, minY, minZ, maxX, maxY, maxZ };
}

function toWorldBoxPart(
  box: VoxelBox,
  bounds: Bounds,
  xSlices: number,
  ySlices: number,
  zSlices: number,
  index: number
): BoxPart {
  const world = worldMinMaxFromVoxelBounds(bounds, box.bounds, xSlices, ySlices, zSlices);
  const sizeX = Math.max(MIN_EDGE, world.maxX - world.minX);
  const sizeY = Math.max(MIN_EDGE, world.maxY - world.minY);
  const sizeZ = Math.max(MIN_EDGE, world.maxZ - world.minZ);

  const worldSizeX = Math.max(MIN_EDGE, bounds.maxX - bounds.minX);
  const worldSizeY = Math.max(MIN_EDGE, bounds.maxY - bounds.minY);
  const worldSizeZ = Math.max(MIN_EDGE, bounds.maxZ - bounds.minZ);

  const boundaryToWorld = (
    boundary: readonly [number, number, number]
  ): [number, number, number] => [
    bounds.minX + (boundary[0] / xSlices) * worldSizeX,
    bounds.minY + (boundary[1] / ySlices) * worldSizeY,
    bounds.minZ + (boundary[2] / zSlices) * worldSizeZ
  ];

  const corners = box.deformed.enabled && box.deformed.cornersBoundary
    ? [
        boundaryToWorld(box.deformed.cornersBoundary[0]),
        boundaryToWorld(box.deformed.cornersBoundary[1]),
        boundaryToWorld(box.deformed.cornersBoundary[2]),
        boundaryToWorld(box.deformed.cornersBoundary[3]),
        boundaryToWorld(box.deformed.cornersBoundary[4]),
        boundaryToWorld(box.deformed.cornersBoundary[5]),
        boundaryToWorld(box.deformed.cornersBoundary[6]),
        boundaryToWorld(box.deformed.cornersBoundary[7])
      ]
    : undefined;

  return {
    label: `part-${index + 1}`,
    position: [
      world.minX + sizeX * 0.5,
      world.minY + sizeY * 0.5,
      world.minZ + sizeZ * 0.5
    ],
    halfExtents: [sizeX * 0.5, sizeY * 0.5, sizeZ * 0.5],
    corners: corners
      ? [
          [corners[0][0], corners[0][1], corners[0][2]],
          [corners[1][0], corners[1][1], corners[1][2]],
          [corners[2][0], corners[2][1], corners[2][2]],
          [corners[3][0], corners[3][1], corners[3][2]],
          [corners[4][0], corners[4][1], corners[4][2]],
          [corners[5][0], corners[5][1], corners[5][2]],
          [corners[6][0], corners[6][1], corners[6][2]],
          [corners[7][0], corners[7][1], corners[7][2]]
        ]
      : undefined
  };
}

function boxCost(box: VoxelBox, boxPenalty: number): number {
  const weightedEmpty =
    box.empty * (1 - SLOPE_COST_WEIGHT) +
    box.effectiveEmpty * SLOPE_COST_WEIGHT;
  return weightedEmpty + boxPenalty;
}

function emptyResult(
  strategy: "hybrid-greedy" | "global-beam",
  resolution?: { xSlices: number; ySlices: number; zSlices: number }
): CompoundObjectiveFitResult {
  return {
    parts: [],
    auto: {
      xSlices: resolution?.xSlices ?? 0,
      ySlices: resolution?.ySlices ?? 0,
      zSlices: resolution?.zSlices ?? 0,
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

function materializeParts(
  boxes: VoxelBox[],
  bounds: Bounds,
  resolution: { xSlices: number; ySlices: number; zSlices: number }
): BoxPart[] {
  boxes.sort((a, b) => b.volume - a.volume);
  return boxes.map((box, index) =>
    toWorldBoxPart(
      box,
      bounds,
      resolution.xSlices,
      resolution.ySlices,
      resolution.zSlices,
      index
    )
  );
}

function cloneCornersBoundary(
  corners: NonNullable<VoxelBox["deformed"]["cornersBoundary"]>
): NonNullable<VoxelBox["deformed"]["cornersBoundary"]> {
  return [
    [corners[0][0], corners[0][1], corners[0][2]],
    [corners[1][0], corners[1][1], corners[1][2]],
    [corners[2][0], corners[2][1], corners[2][2]],
    [corners[3][0], corners[3][1], corners[3][2]],
    [corners[4][0], corners[4][1], corners[4][2]],
    [corners[5][0], corners[5][1], corners[5][2]],
    [corners[6][0], corners[6][1], corners[6][2]],
    [corners[7][0], corners[7][1], corners[7][2]]
  ];
}

function cloneBoxesForOutput(boxes: readonly VoxelBox[]): VoxelBox[] {
  return boxes.map((box) => ({
    id: box.id,
    voxels: box.voxels,
    bounds: {
      minX: box.bounds.minX,
      minY: box.bounds.minY,
      minZ: box.bounds.minZ,
      maxX: box.bounds.maxX,
      maxY: box.bounds.maxY,
      maxZ: box.bounds.maxZ
    },
    volume: box.volume,
    occupied: box.occupied,
    empty: box.empty,
    effectiveEmpty: box.effectiveEmpty,
    deformed: {
      enabled: box.deformed.enabled,
      dominantAxis: box.deformed.dominantAxis,
      cornersBoundary: box.deformed.cornersBoundary
        ? cloneCornersBoundary(box.deformed.cornersBoundary)
        : undefined
    }
  }));
}

function hasOpenOverlap(
  minA: number,
  maxA: number,
  minB: number,
  maxB: number
): boolean {
  return Math.min(maxA, maxB) > Math.max(minA, minB);
}

function anchorFaceBoundary(
  box: VoxelBox,
  face: "minX" | "maxX" | "minZ" | "maxZ",
  value: number
): void {
  if (!box.deformed.cornersBoundary) {
    return;
  }
  const corners = box.deformed.cornersBoundary;
  const indices =
    face === "minX"
      ? [0, 3, 4, 7]
      : face === "maxX"
        ? [1, 2, 5, 6]
        : face === "minZ"
          ? [0, 1, 4, 5]
          : [2, 3, 6, 7];
  const axisIndex = face === "minX" || face === "maxX" ? 0 : 2;
  for (const index of indices) {
    corners[index][axisIndex] = value;
  }
}

function enforceAdjacentFaceContinuity(boxes: VoxelBox[]): void {
  for (let i = 0; i < boxes.length; i += 1) {
    for (let j = i + 1; j < boxes.length; j += 1) {
      const a = boxes[i];
      const b = boxes[j];
      const aMinY = a.bounds.minY;
      const aMaxY = a.bounds.maxY + 1;
      const bMinY = b.bounds.minY;
      const bMaxY = b.bounds.maxY + 1;
      const aMinZ = a.bounds.minZ;
      const aMaxZ = a.bounds.maxZ + 1;
      const bMinZ = b.bounds.minZ;
      const bMaxZ = b.bounds.maxZ + 1;
      const aMinX = a.bounds.minX;
      const aMaxX = a.bounds.maxX + 1;
      const bMinX = b.bounds.minX;
      const bMaxX = b.bounds.maxX + 1;

      const yzOverlap = hasOpenOverlap(aMinY, aMaxY, bMinY, bMaxY) &&
        hasOpenOverlap(aMinZ, aMaxZ, bMinZ, bMaxZ);
      if (yzOverlap && aMaxX === bMinX) {
        anchorFaceBoundary(a, "maxX", aMaxX);
        anchorFaceBoundary(b, "minX", bMinX);
      } else if (yzOverlap && bMaxX === aMinX) {
        anchorFaceBoundary(a, "minX", aMinX);
        anchorFaceBoundary(b, "maxX", bMaxX);
      }

      const xyOverlap = hasOpenOverlap(aMinY, aMaxY, bMinY, bMaxY) &&
        hasOpenOverlap(aMinX, aMaxX, bMinX, bMaxX);
      if (xyOverlap && aMaxZ === bMinZ) {
        anchorFaceBoundary(a, "maxZ", aMaxZ);
        anchorFaceBoundary(b, "minZ", bMinZ);
      } else if (xyOverlap && bMaxZ === aMinZ) {
        anchorFaceBoundary(a, "minZ", aMinZ);
        anchorFaceBoundary(b, "maxZ", bMaxZ);
      }
    }
  }
}

export function fitCompoundBoxesHybrid(
  points: readonly Point3[]
): CompoundObjectiveFitResult {
  const bounds = computeBounds(points);
  if (!bounds) {
    return emptyResult("hybrid-greedy");
  }

  const resolution = chooseAutoResolution(bounds, points.length);
  const voxels = voxelizePoints(
    points,
    bounds,
    resolution.xSlices,
    resolution.ySlices,
    resolution.zSlices
  );
  if (voxels.length === 0) {
    return emptyResult("hybrid-greedy", resolution);
  }

  const boxPenalty = chooseBoxPenalty(voxels.length);
  const maxBoxes = chooseSearchMaxBoxes(voxels.length);
  const nextIdRef = { value: 1 };
  const immediateGainCache = new Map<string, number>();
  const root = createVoxelBox(0, voxels);
  const initialCost = boxCost(root, boxPenalty);
  const boxes: VoxelBox[] = [root];
  let currentCost = initialCost;

  let splitsAccepted = 0;
  const frontierStates: SearchCandidateState[] = [
    { boxes: boxes.slice(), cost: currentCost, splitsAccepted }
  ];

  while (boxes.length < maxBoxes) {
    let bestIndex = -1;
    let bestSplit: SplitCandidate | null = null;

    for (let i = 0; i < boxes.length; i += 1) {
      const split = evaluateBestSplit(
        boxes[i],
        boxPenalty,
        nextIdRef,
        immediateGainCache
      );
      if (!split) {
        continue;
      }
      if (
        !bestSplit ||
        split.score > bestSplit.score ||
        (split.score === bestSplit.score && split.immediateGain > bestSplit.immediateGain)
      ) {
        bestSplit = split;
        bestIndex = i;
      }
    }

    if (!bestSplit || bestIndex < 0) {
      break;
    }

    boxes.splice(bestIndex, 1, bestSplit.left, bestSplit.right);
    splitsAccepted += 1;

    currentCost = boxes.reduce(
      (sum, entry) => sum + boxCost(entry, boxPenalty),
      0
    );
    frontierStates.push({
      boxes: boxes.slice(),
      cost: currentCost,
      splitsAccepted
    });
  }

  const selection = selectOptimalStateFromFrontier(frontierStates, boxPenalty);
  const selected = selection.state;
  const outputBoxes = cloneBoxesForOutput(selected.boxes);
  enforceAdjacentFaceContinuity(outputBoxes);
  const parts = materializeParts(outputBoxes, bounds, resolution);
  const finalCost = selected.cost;

  return {
    parts,
    auto: {
      xSlices: resolution.xSlices,
      ySlices: resolution.ySlices,
      zSlices: resolution.zSlices,
      occupiedVoxels: voxels.length,
      boxPenalty,
      maxBoxes,
      splitsAccepted: selected.splitsAccepted,
      initialCost,
      finalCost,
      strategy: "hybrid-greedy",
      selectedBoxCount: selected.boxes.length,
      selectionScore: selection.selectionScore
    }
  };
}

function partitionSignature(boxes: readonly VoxelBox[]): string {
  return [...boxes]
    .map((box) => boxSignature(box))
    .sort()
    .join("|");
}

export function fitCompoundBoxesGlobal(
  points: readonly Point3[],
  beamWidth = GLOBAL_BEAM_WIDTH
): CompoundObjectiveFitResult {
  const bounds = computeBounds(points);
  if (!bounds) {
    return emptyResult("global-beam");
  }

  const resolution = chooseAutoResolution(bounds, points.length);
  const voxels = voxelizePoints(
    points,
    bounds,
    resolution.xSlices,
    resolution.ySlices,
    resolution.zSlices
  );
  if (voxels.length === 0) {
    return emptyResult("global-beam", resolution);
  }

  const boxPenalty = chooseBoxPenalty(voxels.length);
  const maxBoxes = chooseSearchMaxBoxes(voxels.length);
  const immediateGainCache = new Map<string, number>();
  const root = createVoxelBox(0, voxels);
  const initialCost = boxCost(root, boxPenalty);
  const normalizedBeamWidth = Math.max(8, Math.floor(beamWidth));

  type BeamState = {
    boxes: VoxelBox[];
    cost: number;
    splitsAccepted: number;
  };

  let bestState: BeamState = {
    boxes: [root],
    cost: initialCost,
    splitsAccepted: 0
  };
  let beam: BeamState[] = [bestState];
  let statesEvaluated = 1;
  const bestByCount = new Map<number, BeamState>([
    [1, bestState]
  ]);

  while (true) {
    const nextCandidates: BeamState[] = [];
    for (const state of beam) {
      if (state.boxes.length >= maxBoxes) {
        nextCandidates.push(state);
        continue;
      }

      for (let i = 0; i < state.boxes.length; i += 1) {
        const box = state.boxes[i];
        const splits = evaluateTopSplitsForBox(
          box,
          boxPenalty,
          immediateGainCache,
          GLOBAL_TOP_SPLITS_PER_BOX
        );
        for (const split of splits) {
          const boxes = state.boxes.slice();
          boxes.splice(i, 1, split.left, split.right);
          const cost = boxes.reduce((sum, entry) => sum + boxCost(entry, boxPenalty), 0);
          const candidate: BeamState = {
            boxes,
            cost,
            splitsAccepted: state.splitsAccepted + 1
          };
          nextCandidates.push(candidate);
          const boxCount = candidate.boxes.length;
          const existing = bestByCount.get(boxCount);
          if (!existing || candidate.cost < existing.cost) {
            bestByCount.set(boxCount, candidate);
          }
          statesEvaluated += 1;
        }
      }
    }

    if (nextCandidates.length === 0) {
      break;
    }

    nextCandidates.sort((a, b) => {
      const aScore = selectionScoreForState(a, boxPenalty);
      const bScore = selectionScoreForState(b, boxPenalty);
      if (aScore !== bScore) {
        return aScore - bScore;
      }
      if (a.cost !== b.cost) {
        return a.cost - b.cost;
      }
      if (a.boxes.length !== b.boxes.length) {
        return a.boxes.length - b.boxes.length;
      }
      return a.splitsAccepted - b.splitsAccepted;
    });

    const deduped: BeamState[] = [];
    const seen = new Set<string>();
    for (const candidate of nextCandidates) {
      const key = partitionSignature(candidate.boxes);
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      deduped.push(candidate);
      if (deduped.length >= normalizedBeamWidth) {
        break;
      }
    }

    if (deduped.length === 0) {
      break;
    }

    beam = deduped;
    const canExpandFurther = beam.some((state) => state.boxes.length < maxBoxes);
    if (!canExpandFurther) {
      break;
    }
  }

  const frontierStates: SearchCandidateState[] = [...bestByCount.values()].map((state) => ({
    boxes: state.boxes,
    cost: state.cost,
    splitsAccepted: state.splitsAccepted
  }));
  const selection = selectOptimalStateFromFrontier(frontierStates, boxPenalty);
  bestState = {
    boxes: selection.state.boxes,
    cost: selection.state.cost,
    splitsAccepted: selection.state.splitsAccepted
  };

  const outputBoxes = cloneBoxesForOutput(bestState.boxes);
  enforceAdjacentFaceContinuity(outputBoxes);
  const parts = materializeParts(outputBoxes, bounds, resolution);

  return {
    parts,
    auto: {
      xSlices: resolution.xSlices,
      ySlices: resolution.ySlices,
      zSlices: resolution.zSlices,
      occupiedVoxels: voxels.length,
      boxPenalty,
      maxBoxes,
      splitsAccepted: bestState.splitsAccepted,
      initialCost,
      finalCost: bestState.cost,
      strategy: "global-beam",
      beamWidth: normalizedBeamWidth,
      statesEvaluated,
      selectedBoxCount: bestState.boxes.length,
      selectionScore: selection.selectionScore
    }
  };
}

export const fitCompoundBoxesObjective = fitCompoundBoxesHybrid;
export const fitDeskCompoundBoxes = fitCompoundBoxesHybrid;
