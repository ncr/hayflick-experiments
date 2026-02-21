import * as THREE from "three";
import { ConvexGeometry } from "three/examples/jsm/geometries/ConvexGeometry.js";

type SplitWorkerInitRequest = {
  type: "init";
  options: {
    concavity: number;
    alpha: number;
    beta: number;
    sliverPenalty: number;
    planeDownsampling: number;
    convexHullDownsampling: number;
    minVoxelCountPerPart: number;
    maxHullPointSamples: number;
  };
  cellVolume: number;
  rootHullVolume: number;
  voxelX: Float32Array;
  voxelY: Float32Array;
  voxelZ: Float32Array;
  voxelCellX: Int32Array;
  voxelCellY: Int32Array;
  voxelCellZ: Int32Array;
};

type SplitWorkerEvaluateRequest = {
  type: "evaluate";
  requestId: number;
  voxelIds: Uint32Array;
};

type SplitWorkerRequest = SplitWorkerInitRequest | SplitWorkerEvaluateRequest;

type SplitWorkerReadyResponse = {
  type: "ready";
};

type SplitWorkerResultKeepResponse = {
  type: "result";
  requestId: number;
  kind: "keep";
  candidatePlaneCount: number;
};

type SplitWorkerResultSplitResponse = {
  type: "result";
  requestId: number;
  kind: "split";
  candidatePlaneCount: number;
  leftVoxelIds: Uint32Array;
  rightVoxelIds: Uint32Array;
};

type SplitWorkerErrorResponse = {
  type: "error";
  requestId?: number;
  error: string;
};

type SplitWorkerResponse =
  | SplitWorkerReadyResponse
  | SplitWorkerResultKeepResponse
  | SplitWorkerResultSplitResponse
  | SplitWorkerErrorResponse;

type WorkerState = {
  options: SplitWorkerInitRequest["options"];
  cellVolume: number;
  rootHullVolume: number;
  voxelX: Float32Array;
  voxelY: Float32Array;
  voxelZ: Float32Array;
  voxelCellX: Int32Array;
  voxelCellY: Int32Array;
  voxelCellZ: Int32Array;
};

type PartSummary = {
  voxelCount: number;
  volume: number;
  centroidX: number;
  centroidY: number;
  centroidZ: number;
  minCellX: number;
  minCellY: number;
  minCellZ: number;
  maxCellX: number;
  maxCellY: number;
  maxCellZ: number;
};

type PlaneCandidate = {
  axis: 0 | 1 | 2;
  index: number;
};

type SplitCost = {
  total: number;
  concavity: number;
  leftVoxels: number[];
  rightVoxels: number[];
  candidate: PlaneCandidate;
};

const EPSILON = 1e-9;

let state: WorkerState | null = null;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function summarizePart(voxelIds: Uint32Array): PartSummary {
  if (!state) {
    return {
      voxelCount: 0,
      volume: 0,
      centroidX: 0,
      centroidY: 0,
      centroidZ: 0,
      minCellX: 0,
      minCellY: 0,
      minCellZ: 0,
      maxCellX: 0,
      maxCellY: 0,
      maxCellZ: 0
    };
  }

  let sumX = 0;
  let sumY = 0;
  let sumZ = 0;
  let minCellX = Number.POSITIVE_INFINITY;
  let minCellY = Number.POSITIVE_INFINITY;
  let minCellZ = Number.POSITIVE_INFINITY;
  let maxCellX = Number.NEGATIVE_INFINITY;
  let maxCellY = Number.NEGATIVE_INFINITY;
  let maxCellZ = Number.NEGATIVE_INFINITY;

  for (const voxelId of voxelIds) {
    sumX += state.voxelX[voxelId] ?? 0;
    sumY += state.voxelY[voxelId] ?? 0;
    sumZ += state.voxelZ[voxelId] ?? 0;

    const cellX = state.voxelCellX[voxelId] ?? 0;
    const cellY = state.voxelCellY[voxelId] ?? 0;
    const cellZ = state.voxelCellZ[voxelId] ?? 0;

    if (cellX < minCellX) {
      minCellX = cellX;
    }
    if (cellY < minCellY) {
      minCellY = cellY;
    }
    if (cellZ < minCellZ) {
      minCellZ = cellZ;
    }
    if (cellX > maxCellX) {
      maxCellX = cellX;
    }
    if (cellY > maxCellY) {
      maxCellY = cellY;
    }
    if (cellZ > maxCellZ) {
      maxCellZ = cellZ;
    }
  }

  const voxelCount = voxelIds.length;
  const inv = voxelCount > 0 ? 1 / voxelCount : 0;

  return {
    voxelCount,
    volume: voxelCount * state.cellVolume,
    centroidX: sumX * inv,
    centroidY: sumY * inv,
    centroidZ: sumZ * inv,
    minCellX: Number.isFinite(minCellX) ? minCellX : 0,
    minCellY: Number.isFinite(minCellY) ? minCellY : 0,
    minCellZ: Number.isFinite(minCellZ) ? minCellZ : 0,
    maxCellX: Number.isFinite(maxCellX) ? maxCellX : 0,
    maxCellY: Number.isFinite(maxCellY) ? maxCellY : 0,
    maxCellZ: Number.isFinite(maxCellZ) ? maxCellZ : 0
  };
}

function sampleVoxelPoints(
  voxelIds: Uint32Array,
  downsampling: number,
  maxSamples: number
): THREE.Vector3[] {
  if (!state || voxelIds.length <= 0) {
    return [];
  }

  const points: THREE.Vector3[] = [];
  const strideFromDownsampling = Math.max(1, downsampling);
  const strideFromBudget = Math.max(1, Math.ceil(voxelIds.length / Math.max(8, maxSamples)));
  const stride = Math.max(strideFromDownsampling, strideFromBudget);

  for (let i = 0; i < voxelIds.length; i += stride) {
    const voxelId = voxelIds[i] ?? 0;
    points.push(
      new THREE.Vector3(
        state.voxelX[voxelId] ?? 0,
        state.voxelY[voxelId] ?? 0,
        state.voxelZ[voxelId] ?? 0
      )
    );
  }

  const lastVoxelId = voxelIds[voxelIds.length - 1] ?? 0;
  if (points.length > 0) {
    const lastPoint = points[points.length - 1];
    const lx = state.voxelX[lastVoxelId] ?? 0;
    const ly = state.voxelY[lastVoxelId] ?? 0;
    const lz = state.voxelZ[lastVoxelId] ?? 0;
    if (
      Math.abs(lastPoint.x - lx) > EPSILON ||
      Math.abs(lastPoint.y - ly) > EPSILON ||
      Math.abs(lastPoint.z - lz) > EPSILON
    ) {
      points.push(new THREE.Vector3(lx, ly, lz));
    }
  }

  return points;
}

function computeGeometryVolume(geometry: THREE.BufferGeometry): number {
  const position = geometry.getAttribute("position");
  if (!(position instanceof THREE.BufferAttribute) || position.count < 3) {
    return 0;
  }

  const index = geometry.getIndex();
  let volume = 0;

  const readVertex = (i: number): [number, number, number] => {
    return [position.getX(i), position.getY(i), position.getZ(i)];
  };

  const triangleCount = index ? Math.floor(index.count / 3) : Math.floor(position.count / 3);
  for (let tri = 0; tri < triangleCount; tri += 1) {
    const i0 = index ? (index.array[tri * 3] ?? 0) : tri * 3;
    const i1 = index ? (index.array[tri * 3 + 1] ?? 0) : tri * 3 + 1;
    const i2 = index ? (index.array[tri * 3 + 2] ?? 0) : tri * 3 + 2;

    const [ax, ay, az] = readVertex(i0);
    const [bx, by, bz] = readVertex(i1);
    const [cx, cy, cz] = readVertex(i2);

    const cpx = by * cz - bz * cy;
    const cpy = bz * cx - bx * cz;
    const cpz = bx * cy - by * cx;

    volume += ax * cpx + ay * cpy + az * cpz;
  }

  return Math.abs(volume / 6);
}

function computeHullEstimate(voxelIds: Uint32Array, downsampling: number): number {
  if (!state) {
    return 0;
  }

  const points = sampleVoxelPoints(
    voxelIds,
    downsampling,
    state.options.maxHullPointSamples
  );
  if (points.length < 4) {
    return voxelIds.length * state.cellVolume;
  }

  try {
    const geometry = new ConvexGeometry(points);
    const hullVolume = Math.max(EPSILON, computeGeometryVolume(geometry));
    geometry.dispose();
    return hullVolume;
  } catch {
    return voxelIds.length * state.cellVolume;
  }
}

function computePartConcavity(voxelIds: Uint32Array): {
  summary: PartSummary;
  concavity: number;
} {
  if (!state) {
    return {
      summary: summarizePart(new Uint32Array()),
      concavity: 0
    };
  }

  const summary = summarizePart(voxelIds);
  const hullVolume = computeHullEstimate(voxelIds, state.options.convexHullDownsampling);
  const concavity = Math.abs(hullVolume - summary.volume) / Math.max(EPSILON, state.rootHullVolume);
  return {
    summary,
    concavity
  };
}

function computePreferredDirection(
  voxelIds: Uint32Array,
  summary: PartSummary
): {
  direction: [number, number, number];
  weight: number;
} {
  if (!state || summary.voxelCount <= 1) {
    return {
      direction: [1, 0, 0],
      weight: 0
    };
  }

  let varX = 0;
  let varY = 0;
  let varZ = 0;

  for (const voxelId of voxelIds) {
    const dx = (state.voxelX[voxelId] ?? 0) - summary.centroidX;
    const dy = (state.voxelY[voxelId] ?? 0) - summary.centroidY;
    const dz = (state.voxelZ[voxelId] ?? 0) - summary.centroidZ;
    varX += dx * dx;
    varY += dy * dy;
    varZ += dz * dz;
  }

  const ex = varX / summary.voxelCount;
  const ey = varY / summary.voxelCount;
  const ez = varZ / summary.voxelCount;

  const vx = (ey - ez) * (ey - ez);
  const vy = (ex - ez) * (ex - ez);
  const vz = (ex - ey) * (ex - ey);

  if (vx < vy && vx < vz) {
    const e = ey * ey + ez * ez;
    return {
      direction: [1, 0, 0],
      weight: e <= EPSILON ? 0 : 1 - vx / e
    };
  }

  if (vy < vx && vy < vz) {
    const e = ex * ex + ez * ez;
    return {
      direction: [0, 1, 0],
      weight: e <= EPSILON ? 0 : 1 - vy / e
    };
  }

  const e = ex * ex + ey * ey;
  return {
    direction: [0, 0, 1],
    weight: e <= EPSILON ? 0 : 1 - vz / e
  };
}

function buildAxisPlanes(summary: PartSummary, step: number): PlaneCandidate[] {
  const planes: PlaneCandidate[] = [];
  const stride = Math.max(1, step);

  const addAxis = (
    axis: 0 | 1 | 2,
    minCell: number,
    maxCell: number
  ): void => {
    if (maxCell - minCell <= 1) {
      return;
    }

    for (let index = minCell; index < maxCell; index += stride) {
      planes.push({ axis, index });
    }

    if ((maxCell - minCell) % stride !== 0 && planes.length > 0) {
      const last = planes[planes.length - 1];
      if (last.axis === axis && last.index !== maxCell - 1) {
        planes.push({ axis, index: maxCell - 1 });
      }
    }
  };

  addAxis(0, summary.minCellX, summary.maxCellX);
  addAxis(1, summary.minCellY, summary.maxCellY);
  addAxis(2, summary.minCellZ, summary.maxCellZ);
  return planes;
}

function refinePlanesAroundBest(summary: PartSummary, best: PlaneCandidate): PlaneCandidate[] {
  if (!state) {
    return [];
  }
  const minCell = best.axis === 0 ? summary.minCellX : best.axis === 1 ? summary.minCellY : summary.minCellZ;
  const maxCell = best.axis === 0 ? summary.maxCellX : best.axis === 1 ? summary.maxCellY : summary.maxCellZ;

  const radius = Math.max(1, state.options.planeDownsampling);
  const start = Math.max(minCell, best.index - radius);
  const end = Math.min(maxCell - 1, best.index + radius);

  const refined: PlaneCandidate[] = [];
  for (let index = start; index <= end; index += 1) {
    refined.push({ axis: best.axis, index });
  }
  return refined;
}

function splitVoxelIdsByPlane(
  voxelIds: Uint32Array,
  candidate: PlaneCandidate
): {
  left: number[];
  right: number[];
} {
  if (!state) {
    return {
      left: [],
      right: []
    };
  }

  const left: number[] = [];
  const right: number[] = [];

  for (const voxelId of voxelIds) {
    const cellValue =
      candidate.axis === 0
        ? state.voxelCellX[voxelId] ?? 0
        : candidate.axis === 1
          ? state.voxelCellY[voxelId] ?? 0
          : state.voxelCellZ[voxelId] ?? 0;

    if (cellValue <= candidate.index) {
      left.push(voxelId);
    } else {
      right.push(voxelId);
    }
  }

  return { left, right };
}

function computeSliverScore(voxelIds: number[]): number {
  if (!state || voxelIds.length <= 0) {
    return 0;
  }

  let minCellX = Number.POSITIVE_INFINITY;
  let minCellY = Number.POSITIVE_INFINITY;
  let minCellZ = Number.POSITIVE_INFINITY;
  let maxCellX = Number.NEGATIVE_INFINITY;
  let maxCellY = Number.NEGATIVE_INFINITY;
  let maxCellZ = Number.NEGATIVE_INFINITY;

  for (const voxelId of voxelIds) {
    const cellX = state.voxelCellX[voxelId] ?? 0;
    const cellY = state.voxelCellY[voxelId] ?? 0;
    const cellZ = state.voxelCellZ[voxelId] ?? 0;

    if (cellX < minCellX) {
      minCellX = cellX;
    }
    if (cellY < minCellY) {
      minCellY = cellY;
    }
    if (cellZ < minCellZ) {
      minCellZ = cellZ;
    }
    if (cellX > maxCellX) {
      maxCellX = cellX;
    }
    if (cellY > maxCellY) {
      maxCellY = cellY;
    }
    if (cellZ > maxCellZ) {
      maxCellZ = cellZ;
    }
  }

  if (
    !Number.isFinite(minCellX) ||
    !Number.isFinite(minCellY) ||
    !Number.isFinite(minCellZ) ||
    !Number.isFinite(maxCellX) ||
    !Number.isFinite(maxCellY) ||
    !Number.isFinite(maxCellZ)
  ) {
    return 0;
  }

  const spanX = Math.max(1, maxCellX - minCellX + 1);
  const spanY = Math.max(1, maxCellY - minCellY + 1);
  const spanZ = Math.max(1, maxCellZ - minCellZ + 1);

  const minSpan = Math.max(1, Math.min(spanX, spanY, spanZ));
  const maxSpan = Math.max(1, Math.max(spanX, spanY, spanZ));
  const thinRatio = minSpan / maxSpan;

  const bboxCells = Math.max(1, spanX * spanY * spanZ);
  const fillRatio = voxelIds.length / bboxCells;

  const thinDeficit = clamp((0.2 - thinRatio) / 0.2, 0, 1);
  const sparseDeficit = clamp((0.55 - fillRatio) / 0.55, 0, 1);
  return thinDeficit * (0.35 + 0.65 * sparseDeficit);
}

function evaluateSplitCost(
  voxelIds: Uint32Array,
  planes: PlaneCandidate[],
  partConcavity: number,
  preferredDirection: [number, number, number],
  preferredWeight: number,
  downsampling: number
): {
  best: SplitCost | null;
  candidatePlaneCount: number;
} {
  if (!state) {
    return {
      best: null,
      candidatePlaneCount: 0
    };
  }

  let best: SplitCost | null = null;
  let candidatePlaneCount = 0;

  const alpha = partConcavity * state.options.alpha;
  const beta = partConcavity * state.options.beta;
  const gamma = partConcavity * state.options.sliverPenalty;

  for (const candidate of planes) {
    candidatePlaneCount += 1;
    const split = splitVoxelIdsByPlane(voxelIds, candidate);
    if (
      split.left.length < state.options.minVoxelCountPerPart ||
      split.right.length < state.options.minVoxelCountPerPart
    ) {
      continue;
    }

    const leftIds = Uint32Array.from(split.left);
    const rightIds = Uint32Array.from(split.right);
    const leftVolume = split.left.length * state.cellVolume;
    const rightVolume = split.right.length * state.cellVolume;

    const leftHull = computeHullEstimate(leftIds, downsampling);
    const rightHull = computeHullEstimate(rightIds, downsampling);

    const concavityLeft = Math.abs(leftHull - leftVolume) / Math.max(EPSILON, state.rootHullVolume);
    const concavityRight = Math.abs(rightHull - rightVolume) / Math.max(EPSILON, state.rootHullVolume);
    const concavity = concavityLeft + concavityRight;

    const balance =
      alpha * Math.abs(leftVolume - rightVolume) / Math.max(EPSILON, state.rootHullVolume);

    const axisDot =
      candidate.axis === 0
        ? preferredDirection[0]
        : candidate.axis === 1
          ? preferredDirection[1]
          : preferredDirection[2];
    const symmetry = beta * preferredWeight * axisDot;
    const sliver = gamma * (computeSliverScore(split.left) + computeSliverScore(split.right));
    const total = concavity + balance + symmetry + sliver;

    if (!best || total < best.total) {
      best = {
        total,
        concavity,
        leftVoxels: split.left,
        rightVoxels: split.right,
        candidate
      };
    }
  }

  return {
    best,
    candidatePlaneCount
  };
}

function evaluatePart(
  requestId: number,
  voxelIds: Uint32Array
): SplitWorkerResultKeepResponse | SplitWorkerResultSplitResponse {
  if (!state) {
    return {
      type: "result",
      requestId,
      kind: "keep",
      candidatePlaneCount: 0
    };
  }

  const minVoxelCount = Math.max(1, state.options.minVoxelCountPerPart);
  if (voxelIds.length < minVoxelCount * 2) {
    return {
      type: "result",
      requestId,
      kind: "keep",
      candidatePlaneCount: 0
    };
  }

  const concavityInfo = computePartConcavity(voxelIds);
  if (concavityInfo.concavity <= clamp(state.options.concavity, 0, 1)) {
    return {
      type: "result",
      requestId,
      kind: "keep",
      candidatePlaneCount: 0
    };
  }

  const preferred = computePreferredDirection(voxelIds, concavityInfo.summary);
  const coarsePlanes = buildAxisPlanes(concavityInfo.summary, state.options.planeDownsampling);
  if (coarsePlanes.length <= 0) {
    return {
      type: "result",
      requestId,
      kind: "keep",
      candidatePlaneCount: 0
    };
  }

  const coarse = evaluateSplitCost(
    voxelIds,
    coarsePlanes,
    concavityInfo.concavity,
    preferred.direction,
    preferred.weight,
    state.options.convexHullDownsampling
  );
  let best = coarse.best;
  let candidatePlaneCount = coarse.candidatePlaneCount;

  if (best && (state.options.planeDownsampling > 1 || state.options.convexHullDownsampling > 1)) {
    const refinedPlanes = refinePlanesAroundBest(concavityInfo.summary, best.candidate);
    const refined = evaluateSplitCost(
      voxelIds,
      refinedPlanes,
      concavityInfo.concavity,
      preferred.direction,
      preferred.weight,
      1
    );
    candidatePlaneCount += refined.candidatePlaneCount;
    if (refined.best && refined.best.total <= best.total) {
      best = refined.best;
    }
  }

  if (!best || best.concavity >= concavityInfo.concavity - 1e-6) {
    return {
      type: "result",
      requestId,
      kind: "keep",
      candidatePlaneCount
    };
  }

  return {
    type: "result",
    requestId,
    kind: "split",
    candidatePlaneCount,
    leftVoxelIds: Uint32Array.from(best.leftVoxels),
    rightVoxelIds: Uint32Array.from(best.rightVoxels)
  };
}

const scope = self as unknown as {
  addEventListener: (
    type: "message",
    listener: (event: MessageEvent<SplitWorkerRequest>) => void
  ) => void;
  postMessage: (message: SplitWorkerResponse, transfer?: Transferable[]) => void;
};

scope.addEventListener("message", (event: MessageEvent<SplitWorkerRequest>) => {
  const message = event.data;
  if (!message || typeof message !== "object") {
    return;
  }

  if (message.type === "init") {
    state = {
      options: message.options,
      cellVolume: message.cellVolume,
      rootHullVolume: Math.max(EPSILON, message.rootHullVolume),
      voxelX: message.voxelX,
      voxelY: message.voxelY,
      voxelZ: message.voxelZ,
      voxelCellX: message.voxelCellX,
      voxelCellY: message.voxelCellY,
      voxelCellZ: message.voxelCellZ
    };
    scope.postMessage({ type: "ready" });
    return;
  }

  if (message.type !== "evaluate") {
    return;
  }

  try {
    const result = evaluatePart(message.requestId, message.voxelIds);
    if (result.kind === "split") {
      scope.postMessage(result, [result.leftVoxelIds.buffer, result.rightVoxelIds.buffer]);
      return;
    }
    scope.postMessage(result);
  } catch (error) {
    scope.postMessage({
      type: "error",
      requestId: message.requestId,
      error: error instanceof Error ? error.message : String(error)
    });
  }
});
