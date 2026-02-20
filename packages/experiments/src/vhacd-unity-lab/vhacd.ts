import * as THREE from "three";
import { ConvexGeometry } from "three/examples/jsm/geometries/ConvexGeometry.js";

export type VhacdOptions = {
  resolution: number;
  concavity: number;
  alpha: number;
  beta: number;
  planeDownsampling: number;
  convexHullDownsampling: number;
  maxConvexHulls: number;
  minVoxelCountPerPart: number;
  maxHullPointSamples: number;
  projectHullVertices: boolean;
  precomputeBothHullVariants: boolean;
  maxGridCells: number;
  voxelizationTriangleSampleCount: number;
};

export type VhacdHullVariant = "projected" | "unprojected";

export type VhacdHull = {
  index: number;
  color: number;
  geometry: THREE.BufferGeometry;
  centroid: [number, number, number];
  voxelCount: number;
  voxelVolume: number;
  hullVolume: number;
  concavity: number;
};

export type VhacdVoxelPart = {
  index: number;
  color: number;
  voxelCount: number;
  centers: Array<[number, number, number]>;
};

export type VhacdResult = {
  hulls: VhacdHull[];
  hullVariants?: {
    projected: VhacdHull[];
    unprojected: VhacdHull[];
  };
  activeHullVariant?: VhacdHullVariant;
  voxelView: {
    voxelSize: number;
    parts: VhacdVoxelPart[];
  };
  stats: {
    sourceTriangleCount: number;
    voxelCount: number;
    voxelPreviewCount: number;
    voxelSize: number;
    rootVolume: number;
    rootHullVolume: number;
    rootConcavity: number;
    splitCount: number;
    mergeCount: number;
    candidatePlaneCount: number;
    iterationCount: number;
    generatedBeforeMerge: number;
    splitEvaluationMode: "parallel" | "sequential" | "mixed";
    splitWorkerCount: number;
  };
  signature: string;
  signatures?: {
    projected: string;
    unprojected: string;
  };
};

export type VhacdSourceData = {
  // Flat triangle positions in world space: [ax, ay, az, bx, by, bz, cx, cy, cz] per triangle.
  positions: Float32Array;
};

export type VhacdSerializedHull = Omit<VhacdHull, "geometry"> & {
  positions: Float32Array;
  indices: Uint32Array;
};

export type VhacdSerializedVoxelPart = Omit<VhacdVoxelPart, "centers"> & {
  centers: Float32Array;
};

export type VhacdSerializedResult = {
  hulls: VhacdSerializedHull[];
  hullVariants?: {
    projected: VhacdSerializedHull[];
    unprojected: VhacdSerializedHull[];
  };
  activeHullVariant?: VhacdHullVariant;
  voxelView: {
    voxelSize: number;
    parts: VhacdSerializedVoxelPart[];
  };
  stats: VhacdResult["stats"];
  signature: string;
  signatures?: {
    projected: string;
    unprojected: string;
  };
};

export type VhacdProgress = {
  phase:
    | "collect"
    | "voxelize"
    | "flood-fill"
    | "build-voxels"
    | "split"
    | "merge"
    | "build-hulls"
    | "project"
    | "finalize";
  propProgress: number;
  message: string;
};

const DEFAULT_OPTIONS: VhacdOptions = {
  resolution: 128,
  concavity: 0.002,
  alpha: 0.05,
  beta: 0.05,
  planeDownsampling: 1,
  convexHullDownsampling: 1,
  maxConvexHulls: 24,
  minVoxelCountPerPart: 24,
  maxHullPointSamples: 1800,
  projectHullVertices: true,
  precomputeBothHullVariants: false,
  maxGridCells: 20_000_000,
  voxelizationTriangleSampleCount: 12_000
};

type Triangle = {
  ax: number;
  ay: number;
  az: number;
  bx: number;
  by: number;
  bz: number;
  cx: number;
  cy: number;
  cz: number;
  maxEdgeLength: number;
};

type Bounds = {
  minX: number;
  minY: number;
  minZ: number;
  maxX: number;
  maxY: number;
  maxZ: number;
};

type VoxelGrid = {
  minX: number;
  minY: number;
  minZ: number;
  voxelSize: number;
  nx: number;
  ny: number;
  nz: number;
  xy: number;
  cellVolume: number;
};

type VoxelPoint = {
  index: number;
  x: number;
  y: number;
  z: number;
  cellX: number;
  cellY: number;
  cellZ: number;
};

type DecompositionContext = {
  options: VhacdOptions;
  grid: VoxelGrid;
  voxels: VoxelPoint[];
  rootHullVolume: number;
  stats: {
    candidatePlaneCount: number;
    splitCount: number;
    mergeCount: number;
    iterationCount: number;
  };
};

type Part = {
  id: number;
  voxelIds: number[];
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

type HullEstimate = {
  hullVolume: number;
  sampleCount: number;
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

type SplitPartDecisionKeep = {
  kind: "keep";
  candidatePlaneCount: number;
};

type SplitPartDecisionSplit = {
  kind: "split";
  candidatePlaneCount: number;
  leftVoxelIds: number[];
  rightVoxelIds: number[];
};

type SplitPartDecision = SplitPartDecisionKeep | SplitPartDecisionSplit;

type SplitWorkerInitRequest = {
  type: "init";
  options: {
    concavity: number;
    alpha: number;
    beta: number;
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

type SplitWorkerTask = {
  requestId: number;
  payload: Uint32Array;
  resolve: (result: SplitPartDecision) => void;
  reject: (error: Error) => void;
};

type SplitWorkerSlot = {
  worker: Worker;
  ready: boolean;
  busy: boolean;
  currentRequestId: number | null;
};

type SplitWorkerPool = {
  evaluatePart: (part: Part) => Promise<SplitPartDecision>;
  workerCount: number;
  dispose: () => void;
};

const EPSILON = 1e-9;
const HULL_COLORS = [
  0x5ec9ff,
  0x76f5b1,
  0xffcf7f,
  0xff8ead,
  0xc7a6ff,
  0x8be4ff,
  0xfff39a,
  0x9fd6ff,
  0xb8ffa7,
  0xffbf95,
  0xdaa6ff,
  0x96f3d9
] as const;
const MAX_VOXEL_PREVIEW_COUNT = 80_000;

function yieldToUi(): Promise<void> {
  return new Promise((resolve) => {
    if (typeof requestAnimationFrame === "function") {
      requestAnimationFrame(() => resolve());
      return;
    }
    setTimeout(resolve, 0);
  });
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function clampInt(value: number, min: number, max: number): number {
  return Math.floor(clamp(value, min, max));
}

function makeEmptyBounds(): Bounds {
  return {
    minX: Number.POSITIVE_INFINITY,
    minY: Number.POSITIVE_INFINITY,
    minZ: Number.POSITIVE_INFINITY,
    maxX: Number.NEGATIVE_INFINITY,
    maxY: Number.NEGATIVE_INFINITY,
    maxZ: Number.NEGATIVE_INFINITY
  };
}

function includePoint(bounds: Bounds, x: number, y: number, z: number): void {
  if (x < bounds.minX) {
    bounds.minX = x;
  }
  if (y < bounds.minY) {
    bounds.minY = y;
  }
  if (z < bounds.minZ) {
    bounds.minZ = z;
  }
  if (x > bounds.maxX) {
    bounds.maxX = x;
  }
  if (y > bounds.maxY) {
    bounds.maxY = y;
  }
  if (z > bounds.maxZ) {
    bounds.maxZ = z;
  }
}

function isFiniteBounds(bounds: Bounds): boolean {
  return (
    Number.isFinite(bounds.minX) &&
    Number.isFinite(bounds.minY) &&
    Number.isFinite(bounds.minZ) &&
    Number.isFinite(bounds.maxX) &&
    Number.isFinite(bounds.maxY) &&
    Number.isFinite(bounds.maxZ)
  );
}

function triangleMaxEdgeLength(triangle: Triangle): number {
  const abx = triangle.ax - triangle.bx;
  const aby = triangle.ay - triangle.by;
  const abz = triangle.az - triangle.bz;
  const bcx = triangle.bx - triangle.cx;
  const bcy = triangle.by - triangle.cy;
  const bcz = triangle.bz - triangle.cz;
  const cax = triangle.cx - triangle.ax;
  const cay = triangle.cy - triangle.ay;
  const caz = triangle.cz - triangle.az;

  const ab = abx * abx + aby * aby + abz * abz;
  const bc = bcx * bcx + bcy * bcy + bcz * bcz;
  const ca = cax * cax + cay * cay + caz * caz;
  return Math.sqrt(Math.max(ab, bc, ca));
}

function collectTriangles(root: THREE.Object3D): {
  triangles: Triangle[];
  bounds: Bounds;
} {
  const bounds = makeEmptyBounds();
  const triangles: Triangle[] = [];

  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();

  root.updateWorldMatrix(true, true);
  root.traverse((node) => {
    if (!(node instanceof THREE.Mesh)) {
      return;
    }
    const geometry = node.geometry;
    if (!geometry) {
      return;
    }
    const position = geometry.getAttribute("position");
    if (!(position instanceof THREE.BufferAttribute)) {
      return;
    }

    const index = geometry.getIndex();
    const getIndexValue = (idx: number): number => {
      if (!index) {
        return idx;
      }
      return index.array[idx] ?? 0;
    };

    const triangleCount = index ? Math.floor(index.count / 3) : Math.floor(position.count / 3);
    for (let tri = 0; tri < triangleCount; tri += 1) {
      const i0 = getIndexValue(tri * 3);
      const i1 = getIndexValue(tri * 3 + 1);
      const i2 = getIndexValue(tri * 3 + 2);

      a.fromBufferAttribute(position, i0).applyMatrix4(node.matrixWorld);
      b.fromBufferAttribute(position, i1).applyMatrix4(node.matrixWorld);
      c.fromBufferAttribute(position, i2).applyMatrix4(node.matrixWorld);

      if (
        !Number.isFinite(a.x) ||
        !Number.isFinite(a.y) ||
        !Number.isFinite(a.z) ||
        !Number.isFinite(b.x) ||
        !Number.isFinite(b.y) ||
        !Number.isFinite(b.z) ||
        !Number.isFinite(c.x) ||
        !Number.isFinite(c.y) ||
        !Number.isFinite(c.z)
      ) {
        continue;
      }

      includePoint(bounds, a.x, a.y, a.z);
      includePoint(bounds, b.x, b.y, b.z);
      includePoint(bounds, c.x, c.y, c.z);

      const triangle: Triangle = {
        ax: a.x,
        ay: a.y,
        az: a.z,
        bx: b.x,
        by: b.y,
        bz: b.z,
        cx: c.x,
        cy: c.y,
        cz: c.z,
        maxEdgeLength: 0
      };
      triangle.maxEdgeLength = triangleMaxEdgeLength(triangle);
      triangles.push(triangle);
    }
  });

  return { triangles, bounds };
}

export function extractVhacdSourceData(source: THREE.Object3D): VhacdSourceData | null {
  const extracted = collectTriangles(source);
  if (extracted.triangles.length <= 0 || !isFiniteBounds(extracted.bounds)) {
    return null;
  }

  const positions = new Float32Array(extracted.triangles.length * 9);
  let cursor = 0;
  for (const triangle of extracted.triangles) {
    positions[cursor] = triangle.ax;
    positions[cursor + 1] = triangle.ay;
    positions[cursor + 2] = triangle.az;
    positions[cursor + 3] = triangle.bx;
    positions[cursor + 4] = triangle.by;
    positions[cursor + 5] = triangle.bz;
    positions[cursor + 6] = triangle.cx;
    positions[cursor + 7] = triangle.cy;
    positions[cursor + 8] = triangle.cz;
    cursor += 9;
  }

  return { positions };
}

function createGrid(bounds: Bounds, resolution: number, maxGridCells: number): VoxelGrid {
  const spanX = Math.max(EPSILON, bounds.maxX - bounds.minX);
  const spanY = Math.max(EPSILON, bounds.maxY - bounds.minY);
  const spanZ = Math.max(EPSILON, bounds.maxZ - bounds.minZ);
  const longest = Math.max(spanX, spanY, spanZ);

  let voxelSize = longest / Math.max(4, resolution);
  if (!Number.isFinite(voxelSize) || voxelSize <= EPSILON) {
    voxelSize = 1;
  }

  const padding = 1;

  const computeAxisCount = (span: number, size: number): number => {
    return Math.max(3, Math.ceil((span + size * padding * 2) / size));
  };

  let nx = computeAxisCount(spanX, voxelSize);
  let ny = computeAxisCount(spanY, voxelSize);
  let nz = computeAxisCount(spanZ, voxelSize);

  const cellBudget = Math.max(250_000, Math.floor(maxGridCells));
  while (nx * ny * nz > cellBudget) {
    voxelSize *= 1.12;
    nx = computeAxisCount(spanX, voxelSize);
    ny = computeAxisCount(spanY, voxelSize);
    nz = computeAxisCount(spanZ, voxelSize);
  }

  return {
    minX: bounds.minX - voxelSize * padding,
    minY: bounds.minY - voxelSize * padding,
    minZ: bounds.minZ - voxelSize * padding,
    voxelSize,
    nx,
    ny,
    nz,
    xy: nx * ny,
    cellVolume: voxelSize * voxelSize * voxelSize
  };
}

function toLinearIndex(grid: VoxelGrid, x: number, y: number, z: number): number {
  return x + y * grid.nx + z * grid.xy;
}

function markShellVoxel(grid: VoxelGrid, shell: Uint8Array, x: number, y: number, z: number): void {
  const ix = Math.floor((x - grid.minX) / grid.voxelSize);
  const iy = Math.floor((y - grid.minY) / grid.voxelSize);
  const iz = Math.floor((z - grid.minZ) / grid.voxelSize);
  if (ix < 0 || iy < 0 || iz < 0 || ix >= grid.nx || iy >= grid.ny || iz >= grid.nz) {
    return;
  }
  shell[toLinearIndex(grid, ix, iy, iz)] = 1;
}

function rasterizeTrianglesToShell(
  grid: VoxelGrid,
  triangles: Triangle[],
  triangleSampleCount: number
): Uint8Array {
  const shell = new Uint8Array(grid.nx * grid.ny * grid.nz);
  const budget = Math.max(1, Math.floor(triangleSampleCount));
  const triStep = Math.max(1, Math.floor(triangles.length / budget));

  for (let index = 0; index < triangles.length; index += triStep) {
    const triangle = triangles[index];
    if (!triangle) {
      continue;
    }

    const steps = clampInt(Math.ceil(triangle.maxEdgeLength / (grid.voxelSize * 0.85)), 1, 20);

    for (let i = 0; i <= steps; i += 1) {
      const u = i / steps;
      for (let j = 0; j <= steps - i; j += 1) {
        const v = j / steps;
        const w = 1 - u - v;
        const x = triangle.ax * w + triangle.bx * u + triangle.cx * v;
        const y = triangle.ay * w + triangle.by * u + triangle.cy * v;
        const z = triangle.az * w + triangle.bz * u + triangle.cz * v;
        markShellVoxel(grid, shell, x, y, z);
      }
    }

    markShellVoxel(grid, shell, triangle.ax, triangle.ay, triangle.az);
    markShellVoxel(grid, shell, triangle.bx, triangle.by, triangle.bz);
    markShellVoxel(grid, shell, triangle.cx, triangle.cy, triangle.cz);

    markShellVoxel(
      grid,
      shell,
      (triangle.ax + triangle.bx) * 0.5,
      (triangle.ay + triangle.by) * 0.5,
      (triangle.az + triangle.bz) * 0.5
    );
    markShellVoxel(
      grid,
      shell,
      (triangle.bx + triangle.cx) * 0.5,
      (triangle.by + triangle.cy) * 0.5,
      (triangle.bz + triangle.cz) * 0.5
    );
    markShellVoxel(
      grid,
      shell,
      (triangle.cx + triangle.ax) * 0.5,
      (triangle.cy + triangle.ay) * 0.5,
      (triangle.cz + triangle.az) * 0.5
    );
  }

  return shell;
}

function floodFillExterior(grid: VoxelGrid, shell: Uint8Array): Uint8Array {
  const total = shell.length;
  const outside = new Uint8Array(total);
  const queue = new Uint32Array(total);
  let head = 0;
  let tail = 0;

  const enqueue = (x: number, y: number, z: number): void => {
    const idx = toLinearIndex(grid, x, y, z);
    if (shell[idx] !== 0 || outside[idx] !== 0) {
      return;
    }
    outside[idx] = 1;
    queue[tail] = idx;
    tail += 1;
  };

  for (let x = 0; x < grid.nx; x += 1) {
    for (let y = 0; y < grid.ny; y += 1) {
      enqueue(x, y, 0);
      enqueue(x, y, grid.nz - 1);
    }
  }
  for (let x = 0; x < grid.nx; x += 1) {
    for (let z = 0; z < grid.nz; z += 1) {
      enqueue(x, 0, z);
      enqueue(x, grid.ny - 1, z);
    }
  }
  for (let y = 0; y < grid.ny; y += 1) {
    for (let z = 0; z < grid.nz; z += 1) {
      enqueue(0, y, z);
      enqueue(grid.nx - 1, y, z);
    }
  }

  while (head < tail) {
    const idx = queue[head];
    head += 1;

    const z = Math.floor(idx / grid.xy);
    const rem = idx - z * grid.xy;
    const y = Math.floor(rem / grid.nx);
    const x = rem - y * grid.nx;

    if (x > 0) {
      enqueue(x - 1, y, z);
    }
    if (x + 1 < grid.nx) {
      enqueue(x + 1, y, z);
    }
    if (y > 0) {
      enqueue(x, y - 1, z);
    }
    if (y + 1 < grid.ny) {
      enqueue(x, y + 1, z);
    }
    if (z > 0) {
      enqueue(x, y, z - 1);
    }
    if (z + 1 < grid.nz) {
      enqueue(x, y, z + 1);
    }
  }

  return outside;
}

function buildVoxelPoints(grid: VoxelGrid, shell: Uint8Array, outside: Uint8Array): VoxelPoint[] {
  const voxels: VoxelPoint[] = [];
  for (let z = 0; z < grid.nz; z += 1) {
    for (let y = 0; y < grid.ny; y += 1) {
      for (let x = 0; x < grid.nx; x += 1) {
        const idx = toLinearIndex(grid, x, y, z);
        if (shell[idx] === 0 && outside[idx] !== 0) {
          continue;
        }

        voxels.push({
          index: idx,
          x: grid.minX + (x + 0.5) * grid.voxelSize,
          y: grid.minY + (y + 0.5) * grid.voxelSize,
          z: grid.minZ + (z + 0.5) * grid.voxelSize,
          cellX: x,
          cellY: y,
          cellZ: z
        });
      }
    }
  }
  return voxels;
}

function summarizePart(part: Part, ctx: DecompositionContext): PartSummary {
  let sumX = 0;
  let sumY = 0;
  let sumZ = 0;
  let minCellX = Number.POSITIVE_INFINITY;
  let minCellY = Number.POSITIVE_INFINITY;
  let minCellZ = Number.POSITIVE_INFINITY;
  let maxCellX = Number.NEGATIVE_INFINITY;
  let maxCellY = Number.NEGATIVE_INFINITY;
  let maxCellZ = Number.NEGATIVE_INFINITY;

  for (const voxelId of part.voxelIds) {
    const voxel = ctx.voxels[voxelId];
    if (!voxel) {
      continue;
    }
    sumX += voxel.x;
    sumY += voxel.y;
    sumZ += voxel.z;

    if (voxel.cellX < minCellX) {
      minCellX = voxel.cellX;
    }
    if (voxel.cellY < minCellY) {
      minCellY = voxel.cellY;
    }
    if (voxel.cellZ < minCellZ) {
      minCellZ = voxel.cellZ;
    }
    if (voxel.cellX > maxCellX) {
      maxCellX = voxel.cellX;
    }
    if (voxel.cellY > maxCellY) {
      maxCellY = voxel.cellY;
    }
    if (voxel.cellZ > maxCellZ) {
      maxCellZ = voxel.cellZ;
    }
  }

  const voxelCount = Math.max(0, part.voxelIds.length);
  const inv = voxelCount > 0 ? 1 / voxelCount : 0;

  return {
    voxelCount,
    volume: voxelCount * ctx.grid.cellVolume,
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
  voxelIds: number[],
  ctx: DecompositionContext,
  downsampling: number,
  maxSamples: number
): THREE.Vector3[] {
  const points: THREE.Vector3[] = [];
  if (voxelIds.length <= 0) {
    return points;
  }

  const strideFromDownsampling = Math.max(1, downsampling);
  const strideFromBudget = Math.max(1, Math.ceil(voxelIds.length / Math.max(8, maxSamples)));
  const stride = Math.max(strideFromDownsampling, strideFromBudget);

  for (let i = 0; i < voxelIds.length; i += stride) {
    const voxel = ctx.voxels[voxelIds[i]];
    if (!voxel) {
      continue;
    }
    points.push(new THREE.Vector3(voxel.x, voxel.y, voxel.z));
  }

  const lastVoxel = ctx.voxels[voxelIds[voxelIds.length - 1]];
  if (lastVoxel && points.length > 0) {
    const lastPoint = points[points.length - 1];
    if (
      Math.abs(lastPoint.x - lastVoxel.x) > EPSILON ||
      Math.abs(lastPoint.y - lastVoxel.y) > EPSILON ||
      Math.abs(lastPoint.z - lastVoxel.z) > EPSILON
    ) {
      points.push(new THREE.Vector3(lastVoxel.x, lastVoxel.y, lastVoxel.z));
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

function computeHullEstimate(
  voxelIds: number[],
  ctx: DecompositionContext,
  downsampling: number
): HullEstimate {
  const points = sampleVoxelPoints(
    voxelIds,
    ctx,
    downsampling,
    ctx.options.maxHullPointSamples
  );

  if (points.length < 4) {
    return {
      hullVolume: voxelIds.length * ctx.grid.cellVolume,
      sampleCount: points.length
    };
  }

  try {
    const geometry = new ConvexGeometry(points);
    const hullVolume = Math.max(EPSILON, computeGeometryVolume(geometry));
    geometry.dispose();
    return {
      hullVolume,
      sampleCount: points.length
    };
  } catch {
    return {
      hullVolume: voxelIds.length * ctx.grid.cellVolume,
      sampleCount: points.length
    };
  }
}

function buildHullGeometry(part: Part, ctx: DecompositionContext): {
  geometry: THREE.BufferGeometry;
  sampleCount: number;
  hullVolume: number;
} {
  const points = sampleVoxelPoints(part.voxelIds, ctx, 1, ctx.options.maxHullPointSamples * 2);

  if (points.length >= 4) {
    try {
      const geometry = new ConvexGeometry(points);
      geometry.computeBoundingBox();
      return {
        geometry,
        sampleCount: points.length,
        hullVolume: Math.max(EPSILON, computeGeometryVolume(geometry))
      };
    } catch {
      // fall through to AABB fallback
    }
  }

  const summary = summarizePart(part, ctx);
  const sizeX = Math.max(ctx.grid.voxelSize, (summary.maxCellX - summary.minCellX + 1) * ctx.grid.voxelSize);
  const sizeY = Math.max(ctx.grid.voxelSize, (summary.maxCellY - summary.minCellY + 1) * ctx.grid.voxelSize);
  const sizeZ = Math.max(ctx.grid.voxelSize, (summary.maxCellZ - summary.minCellZ + 1) * ctx.grid.voxelSize);

  const centerX = ctx.grid.minX + (summary.minCellX + summary.maxCellX + 1) * ctx.grid.voxelSize * 0.5;
  const centerY = ctx.grid.minY + (summary.minCellY + summary.maxCellY + 1) * ctx.grid.voxelSize * 0.5;
  const centerZ = ctx.grid.minZ + (summary.minCellZ + summary.maxCellZ + 1) * ctx.grid.voxelSize * 0.5;

  const geometry = new THREE.BoxGeometry(sizeX, sizeY, sizeZ);
  geometry.translate(centerX, centerY, centerZ);
  geometry.computeBoundingBox();

  return {
    geometry,
    sampleCount: points.length,
    hullVolume: Math.max(EPSILON, sizeX * sizeY * sizeZ)
  };
}

function cloneHullGeometry(geometry: THREE.BufferGeometry): THREE.BufferGeometry {
  const clone = geometry.clone();
  if (!clone.getAttribute("normal")) {
    clone.computeVertexNormals();
  }
  clone.computeBoundingBox();
  return clone;
}

function extractUniqueGeometryPoints(
  geometry: THREE.BufferGeometry,
  maxPoints: number
): THREE.Vector3[] {
  const position = geometry.getAttribute("position");
  if (!(position instanceof THREE.BufferAttribute) || position.count <= 0) {
    return [];
  }

  const points: THREE.Vector3[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < position.count; i += 1) {
    const x = position.getX(i);
    const y = position.getY(i);
    const z = position.getZ(i);
    const key = `${x.toFixed(6)}|${y.toFixed(6)}|${z.toFixed(6)}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    points.push(new THREE.Vector3(x, y, z));
    if (points.length >= maxPoints) {
      break;
    }
  }
  return points;
}

function buildProjectionTriangles(sourceTriangles: Triangle[]): THREE.Triangle[] {
  return sourceTriangles.map((triangle) => {
    return new THREE.Triangle(
      new THREE.Vector3(triangle.ax, triangle.ay, triangle.az),
      new THREE.Vector3(triangle.bx, triangle.by, triangle.bz),
      new THREE.Vector3(triangle.cx, triangle.cy, triangle.cz)
    );
  });
}

function projectHullGeometryToSource(
  geometry: THREE.BufferGeometry,
  sourceTriangles: THREE.Triangle[],
  maxProjectedPoints: number
): {
  geometry: THREE.BufferGeometry;
  hullVolume: number;
} | null {
  if (sourceTriangles.length <= 0) {
    return null;
  }

  const points = extractUniqueGeometryPoints(
    geometry,
    clampInt(maxProjectedPoints, 64, 40_000)
  );
  if (points.length < 4) {
    return null;
  }

  const projectedPoints: THREE.Vector3[] = [];
  const closest = new THREE.Vector3();
  const bestPoint = new THREE.Vector3();

  for (const point of points) {
    let bestDistSq = Number.POSITIVE_INFINITY;
    let hit = false;

    for (const sourceTriangle of sourceTriangles) {
      sourceTriangle.closestPointToPoint(point, closest);
      const distSq = closest.distanceToSquared(point);
      if (distSq < bestDistSq) {
        bestDistSq = distSq;
        bestPoint.copy(closest);
        hit = true;
      }
    }

    projectedPoints.push(hit ? bestPoint.clone() : point.clone());
  }

  if (projectedPoints.length < 4) {
    return null;
  }

  try {
    const projectedHull = new ConvexGeometry(projectedPoints);
    projectedHull.computeBoundingBox();
    return {
      geometry: projectedHull,
      hullVolume: Math.max(EPSILON, computeGeometryVolume(projectedHull))
    };
  } catch {
    return null;
  }
}

function computePartConcavity(part: Part, ctx: DecompositionContext): {
  summary: PartSummary;
  concavity: number;
  hullVolume: number;
} {
  const summary = summarizePart(part, ctx);
  const estimate = computeHullEstimate(part.voxelIds, ctx, ctx.options.convexHullDownsampling);
  const concavity = Math.abs(estimate.hullVolume - summary.volume) / Math.max(EPSILON, ctx.rootHullVolume);
  return {
    summary,
    concavity,
    hullVolume: estimate.hullVolume
  };
}

function computePreferredDirection(part: Part, ctx: DecompositionContext): {
  direction: [number, number, number];
  weight: number;
} {
  const summary = summarizePart(part, ctx);
  if (summary.voxelCount <= 1) {
    return {
      direction: [1, 0, 0],
      weight: 0
    };
  }

  let varX = 0;
  let varY = 0;
  let varZ = 0;

  for (const voxelId of part.voxelIds) {
    const voxel = ctx.voxels[voxelId];
    if (!voxel) {
      continue;
    }
    const dx = voxel.x - summary.centroidX;
    const dy = voxel.y - summary.centroidY;
    const dz = voxel.z - summary.centroidZ;
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

function buildAxisPlanes(part: Part, ctx: DecompositionContext, step: number): PlaneCandidate[] {
  const summary = summarizePart(part, ctx);
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

function refinePlanesAroundBest(part: Part, ctx: DecompositionContext, best: PlaneCandidate): PlaneCandidate[] {
  const summary = summarizePart(part, ctx);

  const minCell = best.axis === 0 ? summary.minCellX : best.axis === 1 ? summary.minCellY : summary.minCellZ;
  const maxCell = best.axis === 0 ? summary.maxCellX : best.axis === 1 ? summary.maxCellY : summary.maxCellZ;

  const radius = Math.max(1, ctx.options.planeDownsampling);
  const start = Math.max(minCell, best.index - radius);
  const end = Math.min(maxCell - 1, best.index + radius);

  const refined: PlaneCandidate[] = [];
  for (let index = start; index <= end; index += 1) {
    refined.push({ axis: best.axis, index });
  }
  return refined;
}

function splitVoxelIdsByPlane(
  part: Part,
  ctx: DecompositionContext,
  candidate: PlaneCandidate
): {
  left: number[];
  right: number[];
} {
  const left: number[] = [];
  const right: number[] = [];

  for (const voxelId of part.voxelIds) {
    const voxel = ctx.voxels[voxelId];
    if (!voxel) {
      continue;
    }

    const cellValue =
      candidate.axis === 0
        ? voxel.cellX
        : candidate.axis === 1
          ? voxel.cellY
          : voxel.cellZ;

    if (cellValue <= candidate.index) {
      left.push(voxelId);
    } else {
      right.push(voxelId);
    }
  }

  return { left, right };
}

function evaluateSplitCost(
  part: Part,
  ctx: DecompositionContext,
  planes: PlaneCandidate[],
  partConcavity: number,
  preferredDirection: [number, number, number],
  preferredWeight: number,
  downsampling: number
): SplitCost | null {
  let best: SplitCost | null = null;

  const alpha = partConcavity * ctx.options.alpha;
  const beta = partConcavity * ctx.options.beta;

  for (const candidate of planes) {
    ctx.stats.candidatePlaneCount += 1;

    const split = splitVoxelIdsByPlane(part, ctx, candidate);
    if (
      split.left.length < ctx.options.minVoxelCountPerPart ||
      split.right.length < ctx.options.minVoxelCountPerPart
    ) {
      continue;
    }

    const leftVolume = split.left.length * ctx.grid.cellVolume;
    const rightVolume = split.right.length * ctx.grid.cellVolume;

    const leftHull = computeHullEstimate(split.left, ctx, downsampling);
    const rightHull = computeHullEstimate(split.right, ctx, downsampling);

    const concavityLeft =
      Math.abs(leftHull.hullVolume - leftVolume) / Math.max(EPSILON, ctx.rootHullVolume);
    const concavityRight =
      Math.abs(rightHull.hullVolume - rightVolume) / Math.max(EPSILON, ctx.rootHullVolume);
    const concavity = concavityLeft + concavityRight;

    const balance =
      alpha * Math.abs(leftVolume - rightVolume) / Math.max(EPSILON, ctx.rootHullVolume);

    const axisDot = candidate.axis === 0 ? preferredDirection[0] : candidate.axis === 1 ? preferredDirection[1] : preferredDirection[2];
    const symmetry = beta * preferredWeight * axisDot;

    const total = concavity + balance + symmetry;

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

  return best;
}

function evaluatePartSplitLocally(part: Part, ctx: DecompositionContext): SplitPartDecision {
  if (part.voxelIds.length < ctx.options.minVoxelCountPerPart * 2) {
    return {
      kind: "keep",
      candidatePlaneCount: 0
    };
  }

  const candidateStart = ctx.stats.candidatePlaneCount;
  const concavityInfo = computePartConcavity(part, ctx);
  if (concavityInfo.concavity <= ctx.options.concavity) {
    return {
      kind: "keep",
      candidatePlaneCount: ctx.stats.candidatePlaneCount - candidateStart
    };
  }

  const preferred = computePreferredDirection(part, ctx);
  const coarsePlanes = buildAxisPlanes(part, ctx, ctx.options.planeDownsampling);
  if (coarsePlanes.length <= 0) {
    return {
      kind: "keep",
      candidatePlaneCount: ctx.stats.candidatePlaneCount - candidateStart
    };
  }

  let best = evaluateSplitCost(
    part,
    ctx,
    coarsePlanes,
    concavityInfo.concavity,
    preferred.direction,
    preferred.weight,
    ctx.options.convexHullDownsampling
  );

  if (best && (ctx.options.planeDownsampling > 1 || ctx.options.convexHullDownsampling > 1)) {
    const refinedPlanes = refinePlanesAroundBest(part, ctx, best.candidate);
    const refined = evaluateSplitCost(
      part,
      ctx,
      refinedPlanes,
      concavityInfo.concavity,
      preferred.direction,
      preferred.weight,
      1
    );
    if (refined && refined.total <= best.total) {
      best = refined;
    }
  }

  const candidatePlaneCount = ctx.stats.candidatePlaneCount - candidateStart;
  if (!best || best.concavity >= concavityInfo.concavity - 1e-6) {
    return {
      kind: "keep",
      candidatePlaneCount
    };
  }

  return {
    kind: "split",
    candidatePlaneCount,
    leftVoxelIds: best.leftVoxels,
    rightVoxelIds: best.rightVoxels
  };
}

async function createSplitWorkerPool(ctx: DecompositionContext): Promise<SplitWorkerPool | null> {
  if (typeof Worker === "undefined") {
    return null;
  }

  const hardwareConcurrency =
    typeof navigator !== "undefined" && Number.isFinite(navigator.hardwareConcurrency)
      ? Math.max(1, Math.floor(navigator.hardwareConcurrency))
      : 2;
  const bytesPerWorker = Math.max(1, ctx.voxels.length) * 24;
  const memoryBudgetBytes = 768 * 1024 * 1024;
  const workersByMemory = Math.max(1, Math.floor(memoryBudgetBytes / bytesPerWorker));
  const maxWorkersFromVoxels =
    ctx.voxels.length > 2_500_000 ? 4 : ctx.voxels.length > 1_000_000 ? 6 : 8;
  const workerCount = clampInt(
    Math.min(hardwareConcurrency - 1, workersByMemory, maxWorkersFromVoxels),
    0,
    8
  );
  if (workerCount < 2) {
    return null;
  }

  const voxelCount = ctx.voxels.length;
  const voxelX = new Float32Array(voxelCount);
  const voxelY = new Float32Array(voxelCount);
  const voxelZ = new Float32Array(voxelCount);
  const voxelCellX = new Int32Array(voxelCount);
  const voxelCellY = new Int32Array(voxelCount);
  const voxelCellZ = new Int32Array(voxelCount);
  for (let i = 0; i < voxelCount; i += 1) {
    const voxel = ctx.voxels[i];
    voxelX[i] = voxel?.x ?? 0;
    voxelY[i] = voxel?.y ?? 0;
    voxelZ[i] = voxel?.z ?? 0;
    voxelCellX[i] = voxel?.cellX ?? 0;
    voxelCellY[i] = voxel?.cellY ?? 0;
    voxelCellZ[i] = voxel?.cellZ ?? 0;
  }

  const initMessage: SplitWorkerInitRequest = {
    type: "init",
    options: {
      concavity: ctx.options.concavity,
      alpha: ctx.options.alpha,
      beta: ctx.options.beta,
      planeDownsampling: ctx.options.planeDownsampling,
      convexHullDownsampling: ctx.options.convexHullDownsampling,
      minVoxelCountPerPart: ctx.options.minVoxelCountPerPart,
      maxHullPointSamples: ctx.options.maxHullPointSamples
    },
    cellVolume: ctx.grid.cellVolume,
    rootHullVolume: ctx.rootHullVolume,
    voxelX,
    voxelY,
    voxelZ,
    voxelCellX,
    voxelCellY,
    voxelCellZ
  };

  let disposed = false;
  let nextRequestId = 1;

  const slots: SplitWorkerSlot[] = [];
  const queue: SplitWorkerTask[] = [];
  const pendingByRequestId = new Map<number, SplitWorkerTask>();
  let readyCount = 0;

  let readyResolve: (() => void) | null = null;
  let readyReject: ((error: Error) => void) | null = null;
  const readyPromise = new Promise<void>((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
  });

  const rejectAllPending = (reason: string): void => {
    for (const task of queue.splice(0, queue.length)) {
      task.reject(new Error(reason));
    }
    for (const task of pendingByRequestId.values()) {
      task.reject(new Error(reason));
    }
    pendingByRequestId.clear();
    for (const slot of slots) {
      slot.busy = false;
      slot.currentRequestId = null;
    }
  };

  const dispatch = (): void => {
    if (disposed) {
      return;
    }

    for (const slot of slots) {
      if (!slot.ready || slot.busy) {
        continue;
      }
      const nextTask = queue.shift();
      if (!nextTask) {
        break;
      }
      slot.busy = true;
      slot.currentRequestId = nextTask.requestId;
      pendingByRequestId.set(nextTask.requestId, nextTask);
      const request: SplitWorkerEvaluateRequest = {
        type: "evaluate",
        requestId: nextTask.requestId,
        voxelIds: nextTask.payload
      };
      slot.worker.postMessage(request, [nextTask.payload.buffer]);
    }
  };

  const onWorkerError = (error: unknown): void => {
    const detail = error instanceof Error ? error.message : String(error);
    if (!disposed) {
      disposed = true;
      rejectAllPending(`Split worker pool failed: ${detail}`);
      readyReject?.(new Error(`Split worker pool failed: ${detail}`));
    }
    for (const slot of slots) {
      slot.worker.terminate();
    }
  };

  const onWorkerMessage = (
    slot: SplitWorkerSlot,
    message: SplitWorkerResponse
  ): void => {
    if (disposed) {
      return;
    }

    if (message.type === "ready") {
      if (!slot.ready) {
        slot.ready = true;
        readyCount += 1;
        if (readyCount >= slots.length) {
          readyResolve?.();
        }
      }
      dispatch();
      return;
    }

    if (message.type === "error") {
      if (typeof message.requestId === "number") {
        const task = pendingByRequestId.get(message.requestId);
        pendingByRequestId.delete(message.requestId);
        if (task) {
          task.reject(new Error(message.error || "Split worker failed"));
        }
        if (slot.currentRequestId === message.requestId) {
          slot.currentRequestId = null;
          slot.busy = false;
        }
        dispatch();
        return;
      }

      onWorkerError(new Error(message.error || "Split worker pool failed"));
      return;
    }

    const task = pendingByRequestId.get(message.requestId);
    pendingByRequestId.delete(message.requestId);
    if (slot.currentRequestId === message.requestId) {
      slot.currentRequestId = null;
      slot.busy = false;
    }

    if (!task) {
      dispatch();
      return;
    }

    if (message.kind === "split") {
      task.resolve({
        kind: "split",
        candidatePlaneCount: message.candidatePlaneCount,
        leftVoxelIds: Array.from(message.leftVoxelIds),
        rightVoxelIds: Array.from(message.rightVoxelIds)
      });
    } else {
      task.resolve({
        kind: "keep",
        candidatePlaneCount: message.candidatePlaneCount
      });
    }

    dispatch();
  };

  for (let i = 0; i < workerCount; i += 1) {
    const worker = new Worker(new URL("./vhacd.split.worker.ts", import.meta.url), {
      type: "module"
    });
    const slot: SplitWorkerSlot = {
      worker,
      ready: false,
      busy: false,
      currentRequestId: null
    };
    worker.addEventListener("message", (event: MessageEvent<SplitWorkerResponse>) => {
      onWorkerMessage(slot, event.data);
    });
    worker.addEventListener("error", (event: ErrorEvent) => {
      onWorkerError(event.error ?? new Error(event.message || "split worker crashed"));
    });
    worker.postMessage(initMessage);
    slots.push(slot);
  }

  try {
    await readyPromise;
  } catch {
    for (const slot of slots) {
      slot.worker.terminate();
    }
    return null;
  }

  return {
    evaluatePart: (part: Part): Promise<SplitPartDecision> => {
      if (disposed) {
        return Promise.reject(new Error("Split worker pool is disposed"));
      }

      return new Promise<SplitPartDecision>((resolve, reject) => {
        const requestId = nextRequestId;
        nextRequestId += 1;
        queue.push({
          requestId,
          payload: Uint32Array.from(part.voxelIds),
          resolve,
          reject
        });
        dispatch();
      });
    },
    dispose: (): void => {
      if (disposed) {
        return;
      }
      disposed = true;
      rejectAllPending("Split worker pool disposed");
      for (const slot of slots) {
        slot.worker.terminate();
      }
    },
    workerCount
  };
}

function deriveDecompositionDepth(maxConvexHulls: number): number {
  let hullCount = 2;
  let depth = 1;
  while (maxConvexHulls > hullCount) {
    depth += 1;
    hullCount *= 2;
  }
  return depth + 1;
}

function mergePartsToLimit(parts: Part[], ctx: DecompositionContext): Part[] {
  if (parts.length <= ctx.options.maxConvexHulls) {
    return parts;
  }

  const nextParts = [...parts];
  let nextPartId = Math.max(0, ...nextParts.map((entry) => entry.id)) + 1;

  while (nextParts.length > ctx.options.maxConvexHulls) {
    let bestI = -1;
    let bestJ = -1;
    let bestCost = Number.POSITIVE_INFINITY;

    for (let i = 0; i < nextParts.length; i += 1) {
      for (let j = i + 1; j < nextParts.length; j += 1) {
        const partI = nextParts[i];
        const partJ = nextParts[j];
        if (!partI || !partJ) {
          continue;
        }
        const mergedVoxelIds = [...partI.voxelIds, ...partJ.voxelIds];
        const mergedVolume = mergedVoxelIds.length * ctx.grid.cellVolume;
        const hull = computeHullEstimate(mergedVoxelIds, ctx, 1);
        const cost =
          Math.abs(hull.hullVolume - mergedVolume) / Math.max(EPSILON, ctx.rootHullVolume);

        if (cost < bestCost) {
          bestCost = cost;
          bestI = i;
          bestJ = j;
        }
      }
    }

    if (bestI < 0 || bestJ < 0) {
      break;
    }

    const merged: Part = {
      id: nextPartId,
      voxelIds: [...nextParts[bestI].voxelIds, ...nextParts[bestJ].voxelIds]
    };
    nextPartId += 1;

    const keep = Math.min(bestI, bestJ);
    const drop = Math.max(bestI, bestJ);
    nextParts.splice(drop, 1);
    nextParts.splice(keep, 1, merged);
    ctx.stats.mergeCount += 1;
  }

  return nextParts;
}

function buildSignature(hulls: VhacdHull[]): string {
  return hulls
    .map((hull) => {
      return [
        hull.voxelCount,
        hull.concavity.toFixed(5),
        hull.centroid[0].toFixed(3),
        hull.centroid[1].toFixed(3),
        hull.centroid[2].toFixed(3)
      ].join(":");
    })
    .join("|");
}

function createFallbackResult(): VhacdResult {
  return {
    hulls: [],
    hullVariants: {
      projected: [],
      unprojected: []
    },
    activeHullVariant: "unprojected",
    voxelView: {
      voxelSize: 0,
      parts: []
    },
    stats: {
      sourceTriangleCount: 0,
      voxelCount: 0,
      voxelPreviewCount: 0,
      voxelSize: 0,
      rootVolume: 0,
      rootHullVolume: 0,
      rootConcavity: 0,
      splitCount: 0,
      mergeCount: 0,
      candidatePlaneCount: 0,
      iterationCount: 0,
      generatedBeforeMerge: 0,
      splitEvaluationMode: "sequential",
      splitWorkerCount: 1
    },
    signature: "empty",
    signatures: {
      projected: "empty",
      unprojected: "empty"
    }
  };
}

export async function runVhacdFromObject(
  source: THREE.Object3D,
  inputOptions: Partial<VhacdOptions> = {},
  onProgress?: (progress: VhacdProgress) => void
): Promise<VhacdResult> {
  const options: VhacdOptions = {
    ...DEFAULT_OPTIONS,
    ...inputOptions,
    resolution: clampInt(inputOptions.resolution ?? DEFAULT_OPTIONS.resolution, 10, 256),
    planeDownsampling: clampInt(
      inputOptions.planeDownsampling ?? DEFAULT_OPTIONS.planeDownsampling,
      1,
      12
    ),
    convexHullDownsampling: clampInt(
      inputOptions.convexHullDownsampling ?? DEFAULT_OPTIONS.convexHullDownsampling,
      1,
      12
    ),
    maxConvexHulls: clampInt(inputOptions.maxConvexHulls ?? DEFAULT_OPTIONS.maxConvexHulls, 1, 64),
    minVoxelCountPerPart: clampInt(
      inputOptions.minVoxelCountPerPart ?? DEFAULT_OPTIONS.minVoxelCountPerPart,
      4,
      200
    ),
    maxHullPointSamples: clampInt(
      inputOptions.maxHullPointSamples ?? DEFAULT_OPTIONS.maxHullPointSamples,
      64,
      9000
    ),
    concavity: clamp(inputOptions.concavity ?? DEFAULT_OPTIONS.concavity, 0, 1),
    alpha: clamp(inputOptions.alpha ?? DEFAULT_OPTIONS.alpha, 0, 1),
    beta: clamp(inputOptions.beta ?? DEFAULT_OPTIONS.beta, 0, 1),
    projectHullVertices: inputOptions.projectHullVertices ?? DEFAULT_OPTIONS.projectHullVertices,
    precomputeBothHullVariants:
      inputOptions.precomputeBothHullVariants ?? DEFAULT_OPTIONS.precomputeBothHullVariants,
    maxGridCells: clampInt(inputOptions.maxGridCells ?? DEFAULT_OPTIONS.maxGridCells, 250_000, 20_000_000),
    voxelizationTriangleSampleCount: clampInt(
      inputOptions.voxelizationTriangleSampleCount ?? DEFAULT_OPTIONS.voxelizationTriangleSampleCount,
      1_000,
      120_000
    )
  };

  const reportProgress = async (
    phase: VhacdProgress["phase"],
    propProgress: number,
    message: string
  ): Promise<void> => {
    onProgress?.({
      phase,
      propProgress: clamp(propProgress, 0, 1),
      message
    });
    await yieldToUi();
  };

  await reportProgress("collect", 0.02, "Collecting source triangles");
  const extracted = collectTriangles(source);
  if (extracted.triangles.length <= 0 || !isFiniteBounds(extracted.bounds)) {
    await reportProgress("finalize", 1, "No source triangles");
    return createFallbackResult();
  }

  await reportProgress("voxelize", 0.08, "Voxelizing source mesh");
  const grid = createGrid(extracted.bounds, options.resolution, options.maxGridCells);
  const shell = rasterizeTrianglesToShell(
    grid,
    extracted.triangles,
    options.voxelizationTriangleSampleCount
  );

  await reportProgress("flood-fill", 0.34, "Flood filling exterior");
  const outside = floodFillExterior(grid, shell);

  await reportProgress("build-voxels", 0.42, "Building solid voxel field");
  const voxels = buildVoxelPoints(grid, shell, outside);

  if (voxels.length <= 0) {
    await reportProgress("finalize", 1, "No voxels generated");
    return createFallbackResult();
  }

  const rootPart: Part = {
    id: 0,
    voxelIds: voxels.map((_, index) => index)
  };

  const rootSummary = summarizePart(rootPart, {
    options,
    grid,
    voxels,
    rootHullVolume: 1,
    stats: {
      candidatePlaneCount: 0,
      splitCount: 0,
      mergeCount: 0,
      iterationCount: 0
    }
  });
  const rootHull = computeHullEstimate(rootPart.voxelIds, {
    options,
    grid,
    voxels,
    rootHullVolume: 1,
    stats: {
      candidatePlaneCount: 0,
      splitCount: 0,
      mergeCount: 0,
      iterationCount: 0
    }
  }, 1);
  const rootHullVolume = Math.max(EPSILON, rootHull.hullVolume);

  const ctx: DecompositionContext = {
    options,
    grid,
    voxels,
    rootHullVolume,
    stats: {
      candidatePlaneCount: 0,
      splitCount: 0,
      mergeCount: 0,
      iterationCount: 0
    }
  };

  const finalParts: Part[] = [];
  let workingParts: Part[] = [rootPart];
  let nextPartId = 1;
  const depth = deriveDecompositionDepth(options.maxConvexHulls);
  let splitPool: SplitWorkerPool | null = await createSplitWorkerPool(ctx);
  const splitWorkerCount = splitPool?.workerCount ?? 1;
  let splitEvaluationMode: "parallel" | "sequential" | "mixed" = splitPool
    ? "parallel"
    : "sequential";
  const splitModeLabel = (): string => {
    if (splitEvaluationMode === "parallel") {
      return `parallel x${splitWorkerCount}`;
    }
    if (splitEvaluationMode === "mixed") {
      return `mixed (fallback to sequential)`;
    }
    return "sequential";
  };

  await reportProgress("split", 0.5, `Splitting parts (depth ${depth}, ${splitModeLabel()})`);
  try {
    for (let level = 0; level < depth && workingParts.length > 0; level += 1) {
      ctx.stats.iterationCount += 1;
      const nextLevel: Part[] = [];
      await reportProgress(
        "split",
        0.5 + 0.3 * (level / Math.max(1, depth)),
        `Split level ${level + 1}/${depth} (${splitModeLabel()})`
      );

      if (splitPool && workingParts.length > 1) {
        const activeSplitPool = splitPool;
        try {
          let completed = 0;
          const updateStride = Math.max(1, Math.floor(workingParts.length / 6));
          const decisions = await Promise.all(
            workingParts.map(async (part, partIndex) => {
              const decision = await activeSplitPool.evaluatePart(part);
              completed += 1;
              if (completed % updateStride === 0 || completed === workingParts.length) {
                const levelRatio = completed / Math.max(1, workingParts.length);
                await reportProgress(
                  "split",
                  0.5 + 0.3 * ((level + levelRatio) / Math.max(1, depth)),
                  `Split level ${level + 1}/${depth}: ${completed}/${workingParts.length} (${splitModeLabel()})`
                );
              }
              return {
                partIndex,
                part,
                decision
              };
            })
          );

          decisions.sort((a, b) => a.partIndex - b.partIndex);
          for (const { part, decision } of decisions) {
            ctx.stats.candidatePlaneCount += decision.candidatePlaneCount;
            if (decision.kind === "split") {
              nextLevel.push({ id: nextPartId, voxelIds: decision.leftVoxelIds });
              nextPartId += 1;
              nextLevel.push({ id: nextPartId, voxelIds: decision.rightVoxelIds });
              nextPartId += 1;
              ctx.stats.splitCount += 1;
              continue;
            }
            finalParts.push(part);
          }
        } catch {
          splitPool.dispose();
          splitPool = null;
          splitEvaluationMode = "mixed";
          await reportProgress(
            "split",
            0.5 + 0.3 * (level / Math.max(1, depth)),
            `Split worker pool failed, continuing sequentially (${splitModeLabel()})`
          );
        }
      }

      if (!splitPool || workingParts.length <= 1) {
        for (let partIndex = 0; partIndex < workingParts.length; partIndex += 1) {
          const part = workingParts[partIndex];
          const decision = evaluatePartSplitLocally(part, ctx);
          if (decision.kind === "split") {
            nextLevel.push({ id: nextPartId, voxelIds: decision.leftVoxelIds });
            nextPartId += 1;
            nextLevel.push({ id: nextPartId, voxelIds: decision.rightVoxelIds });
            nextPartId += 1;
            ctx.stats.splitCount += 1;
          } else {
            finalParts.push(part);
          }
          if ((partIndex + 1) % 3 === 0 || partIndex === workingParts.length - 1) {
            const levelRatio = (partIndex + 1) / Math.max(1, workingParts.length);
            await reportProgress(
              "split",
              0.5 + 0.3 * ((level + levelRatio) / Math.max(1, depth)),
              `Split level ${level + 1}/${depth}: ${partIndex + 1}/${workingParts.length} (${splitModeLabel()})`
            );
          }
        }
      }

      workingParts = nextLevel;
    }
  } finally {
    splitPool?.dispose();
  }

  for (const part of workingParts) {
    finalParts.push(part);
  }

  const generatedBeforeMerge = finalParts.length;
  await reportProgress("merge", 0.82, `Merging ${generatedBeforeMerge} parts`);
  const mergedParts = mergePartsToLimit(finalParts, ctx);
  const shouldBuildProjectedHulls =
    options.projectHullVertices || options.precomputeBothHullVariants;
  const activeHullVariant: VhacdHullVariant = options.projectHullVertices
    ? "projected"
    : "unprojected";
  const projectionTriangles = shouldBuildProjectedHulls
    ? buildProjectionTriangles(extracted.triangles)
    : [];
  const hullBuildPhase: VhacdProgress["phase"] = shouldBuildProjectedHulls ? "project" : "build-hulls";

  await reportProgress(
    hullBuildPhase,
    0.86,
    options.precomputeBothHullVariants
      ? "Building hull variants (raw + projected)"
      : options.projectHullVertices
        ? "Building and projecting hulls"
        : "Building hulls"
  );

  const entries: Array<{
    part: Part;
    centroid: [number, number, number];
    voxelCount: number;
    voxelVolume: number;
    unprojectedGeometry: THREE.BufferGeometry;
    unprojectedHullVolume: number;
    projectedGeometry: THREE.BufferGeometry | null;
    projectedHullVolume: number;
  }> = [];

  for (let index = 0; index < mergedParts.length; index += 1) {
    const part = mergedParts[index];
    const summary = summarizePart(part, ctx);
    const baseHull = buildHullGeometry(part, ctx);

    let projectedGeometry: THREE.BufferGeometry | null = null;
    let projectedHullVolume = baseHull.hullVolume;
    if (shouldBuildProjectedHulls) {
      const projected = projectHullGeometryToSource(
        baseHull.geometry,
        projectionTriangles,
        options.maxHullPointSamples
      );
      if (projected) {
        projectedGeometry = projected.geometry;
        projectedHullVolume = projected.hullVolume;
      } else {
        projectedGeometry = cloneHullGeometry(baseHull.geometry);
      }
    }

    entries.push({
      part,
      centroid: [summary.centroidX, summary.centroidY, summary.centroidZ],
      voxelCount: summary.voxelCount,
      voxelVolume: summary.volume,
      unprojectedGeometry: baseHull.geometry,
      unprojectedHullVolume: baseHull.hullVolume,
      projectedGeometry,
      projectedHullVolume
    });

    if ((index + 1) % 2 === 0 || index === mergedParts.length - 1) {
      const fraction = (index + 1) / Math.max(1, mergedParts.length);
      await reportProgress(
        hullBuildPhase,
        0.86 + fraction * 0.11,
        options.precomputeBothHullVariants
          ? `Building hull variants ${index + 1}/${mergedParts.length}`
          : options.projectHullVertices
            ? `Projecting hulls ${index + 1}/${mergedParts.length}`
            : `Building hulls ${index + 1}/${mergedParts.length}`
      );
    }
  }

  entries.sort((a, b) => {
    if (a.centroid[1] !== b.centroid[1]) {
      return a.centroid[1] - b.centroid[1];
    }
    if (a.centroid[0] !== b.centroid[0]) {
      return a.centroid[0] - b.centroid[0];
    }
    return a.centroid[2] - b.centroid[2];
  });

  const totalVoxelCountForPreview = entries.reduce(
    (sum, entry) => sum + entry.part.voxelIds.length,
    0
  );
  const previewStride = Math.max(
    1,
    Math.ceil(totalVoxelCountForPreview / MAX_VOXEL_PREVIEW_COUNT)
  );

  const hulls: VhacdHull[] = [];
  const projectedHulls: VhacdHull[] = [];
  const unprojectedHulls: VhacdHull[] = [];
  const voxelParts: VhacdVoxelPart[] = [];

  await reportProgress("finalize", 0.97, "Packing hull previews");
  for (let sortedIndex = 0; sortedIndex < entries.length; sortedIndex += 1) {
    const entry = entries[sortedIndex];
    const color = HULL_COLORS[sortedIndex % HULL_COLORS.length];

    const unprojectedConcavity =
      Math.abs(entry.unprojectedHullVolume - entry.voxelVolume) / Math.max(EPSILON, ctx.rootHullVolume);
    const unprojectedHull: VhacdHull = {
      index: sortedIndex,
      color,
      geometry: entry.unprojectedGeometry,
      centroid: entry.centroid,
      voxelCount: entry.voxelCount,
      voxelVolume: entry.voxelVolume,
      hullVolume: entry.unprojectedHullVolume,
      concavity: unprojectedConcavity
    };
    unprojectedHulls.push(unprojectedHull);

    let projectedHull: VhacdHull | null = null;
    if (entry.projectedGeometry) {
      const projectedConcavity =
        Math.abs(entry.projectedHullVolume - entry.voxelVolume) / Math.max(EPSILON, ctx.rootHullVolume);
      projectedHull = {
        index: sortedIndex,
        color,
        geometry: entry.projectedGeometry,
        centroid: entry.centroid,
        voxelCount: entry.voxelCount,
        voxelVolume: entry.voxelVolume,
        hullVolume: entry.projectedHullVolume,
        concavity: projectedConcavity
      };
      projectedHulls.push(projectedHull);
    }

    if (activeHullVariant === "projected" && projectedHull) {
      hulls.push(projectedHull);
    } else {
      hulls.push(unprojectedHull);
    }

    const centers: Array<[number, number, number]> = [];
    for (let i = 0; i < entry.part.voxelIds.length; i += previewStride) {
      const voxel = ctx.voxels[entry.part.voxelIds[i]];
      if (!voxel) {
        continue;
      }
      centers.push([voxel.x, voxel.y, voxel.z]);
    }
    const lastVoxel = ctx.voxels[entry.part.voxelIds[entry.part.voxelIds.length - 1]];
    if (lastVoxel) {
      const lastCenter = centers[centers.length - 1];
      if (
        !lastCenter ||
        Math.abs(lastCenter[0] - lastVoxel.x) > EPSILON ||
        Math.abs(lastCenter[1] - lastVoxel.y) > EPSILON ||
        Math.abs(lastCenter[2] - lastVoxel.z) > EPSILON
      ) {
        centers.push([lastVoxel.x, lastVoxel.y, lastVoxel.z]);
      }
    }

    voxelParts.push({
      index: sortedIndex,
      color,
      voxelCount: entry.part.voxelIds.length,
      centers
    });

    if ((sortedIndex + 1) % 8 === 0 || sortedIndex === entries.length - 1) {
      const fraction = (sortedIndex + 1) / Math.max(1, entries.length);
      await reportProgress(
        "finalize",
        0.97 + fraction * 0.03,
        `Packing previews ${sortedIndex + 1}/${entries.length}`
      );
    }
  }

  const voxelPreviewCount = voxelParts.reduce(
    (sum, part) => sum + part.centers.length,
    0
  );

  const rootConcavity = Math.abs(rootHullVolume - rootSummary.volume) / Math.max(EPSILON, rootHullVolume);
  const unprojectedSignature = buildSignature(unprojectedHulls);
  const projectedSignature =
    projectedHulls.length > 0 ? buildSignature(projectedHulls) : unprojectedSignature;

  await reportProgress("finalize", 1, "Done");
  return {
    hulls,
    hullVariants:
      projectedHulls.length > 0
        ? {
            projected: projectedHulls,
            unprojected: unprojectedHulls
          }
        : undefined,
    activeHullVariant,
    voxelView: {
      voxelSize: grid.voxelSize,
      parts: voxelParts
    },
    stats: {
      sourceTriangleCount: extracted.triangles.length,
      voxelCount: voxels.length,
      voxelPreviewCount,
      voxelSize: grid.voxelSize,
      rootVolume: rootSummary.volume,
      rootHullVolume,
      rootConcavity,
      splitCount: ctx.stats.splitCount,
      mergeCount: ctx.stats.mergeCount,
      candidatePlaneCount: ctx.stats.candidatePlaneCount,
      iterationCount: ctx.stats.iterationCount,
      generatedBeforeMerge,
      splitEvaluationMode,
      splitWorkerCount
    },
    signature: activeHullVariant === "projected" ? projectedSignature : unprojectedSignature,
    signatures: {
      projected: projectedSignature,
      unprojected: unprojectedSignature
    }
  };
}

export async function runVhacdFromSourceData(
  sourceData: VhacdSourceData,
  inputOptions: Partial<VhacdOptions> = {},
  onProgress?: (progress: VhacdProgress) => void
): Promise<VhacdResult> {
  if (!(sourceData.positions instanceof Float32Array) || sourceData.positions.length < 9) {
    return createFallbackResult();
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute(
    "position",
    new THREE.BufferAttribute(new Float32Array(sourceData.positions), 3)
  );

  const material = new THREE.MeshBasicMaterial();
  const mesh = new THREE.Mesh(geometry, material);

  try {
    return await runVhacdFromObject(mesh, inputOptions, onProgress);
  } finally {
    geometry.dispose();
    material.dispose();
  }
}

function serializeGeometry(
  geometry: THREE.BufferGeometry
): {
  positions: Float32Array;
  indices: Uint32Array;
} {
  const position = geometry.getAttribute("position");
  if (!(position instanceof THREE.BufferAttribute) || position.count <= 0) {
    return {
      positions: new Float32Array(),
      indices: new Uint32Array()
    };
  }

  const positions = new Float32Array(position.count * 3);
  for (let i = 0; i < position.count; i += 1) {
    const base = i * 3;
    positions[base] = position.getX(i);
    positions[base + 1] = position.getY(i);
    positions[base + 2] = position.getZ(i);
  }

  const index = geometry.getIndex();
  if (!index) {
    const indices = new Uint32Array(position.count);
    for (let i = 0; i < position.count; i += 1) {
      indices[i] = i;
    }
    return { positions, indices };
  }

  const indices = new Uint32Array(index.count);
  for (let i = 0; i < index.count; i += 1) {
    indices[i] = index.array[i] ?? 0;
  }

  return { positions, indices };
}

export function serializeVhacdResult(result: VhacdResult): VhacdSerializedResult {
  const serializeHulls = (hulls: VhacdHull[]): VhacdSerializedHull[] => {
    return hulls.map((hull) => {
      const geometry = serializeGeometry(hull.geometry);
      return {
        index: hull.index,
        color: hull.color,
        centroid: hull.centroid,
        voxelCount: hull.voxelCount,
        voxelVolume: hull.voxelVolume,
        hullVolume: hull.hullVolume,
        concavity: hull.concavity,
        positions: geometry.positions,
        indices: geometry.indices
      };
    });
  };

  let serializedHulls = serializeHulls(result.hulls);
  let serializedVariants:
    | {
        projected: VhacdSerializedHull[];
        unprojected: VhacdSerializedHull[];
      }
    | undefined;
  let activeHullVariant = result.activeHullVariant;

  if (result.hullVariants) {
    const projected = serializeHulls(result.hullVariants.projected);
    const unprojected = serializeHulls(result.hullVariants.unprojected);
    serializedVariants = {
      projected,
      unprojected
    };

    const inferredActive =
      activeHullVariant ??
      (result.hulls === result.hullVariants.projected ? "projected" : "unprojected");
    activeHullVariant = inferredActive;
    serializedHulls = inferredActive === "projected" ? projected : unprojected;
  }

  return {
    hulls: serializedHulls,
    hullVariants: serializedVariants,
    activeHullVariant,
    voxelView: {
      voxelSize: result.voxelView.voxelSize,
      parts: result.voxelView.parts.map((part) => {
        const centers = new Float32Array(part.centers.length * 3);
        for (let i = 0; i < part.centers.length; i += 1) {
          const center = part.centers[i];
          const base = i * 3;
          centers[base] = center[0];
          centers[base + 1] = center[1];
          centers[base + 2] = center[2];
        }
        return {
          index: part.index,
          color: part.color,
          voxelCount: part.voxelCount,
          centers
        };
      })
    },
    stats: { ...result.stats },
    signature: result.signature,
    signatures: result.signatures ? { ...result.signatures } : undefined
  };
}

export function deserializeVhacdResult(serialized: VhacdSerializedResult): VhacdResult {
  const deserializeHulls = (hulls: VhacdSerializedHull[]): VhacdHull[] => {
    return hulls.map((hull) => {
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute("position", new THREE.BufferAttribute(hull.positions, 3));
      if (hull.indices.length > 0) {
        geometry.setIndex(new THREE.BufferAttribute(hull.indices, 1));
      }
      geometry.computeVertexNormals();
      geometry.computeBoundingBox();
      return {
        index: hull.index,
        color: hull.color,
        geometry,
        centroid: hull.centroid,
        voxelCount: hull.voxelCount,
        voxelVolume: hull.voxelVolume,
        hullVolume: hull.hullVolume,
        concavity: hull.concavity
      };
    });
  };

  let hulls: VhacdHull[] = [];
  let hullVariants:
    | {
        projected: VhacdHull[];
        unprojected: VhacdHull[];
      }
    | undefined;
  let activeHullVariant: VhacdHullVariant | undefined = serialized.activeHullVariant;

  if (serialized.hullVariants) {
    const projected = deserializeHulls(serialized.hullVariants.projected);
    const unprojected = deserializeHulls(serialized.hullVariants.unprojected);
    hullVariants = {
      projected,
      unprojected
    };
    if (activeHullVariant !== "projected" && activeHullVariant !== "unprojected") {
      activeHullVariant = "unprojected";
    }
    hulls = activeHullVariant === "projected" ? projected : unprojected;
  } else {
    hulls = deserializeHulls(serialized.hulls);
  }

  let signatures = serialized.signatures
    ? { ...serialized.signatures }
    : undefined;
  if (!signatures && hullVariants) {
    signatures = {
      projected: buildSignature(hullVariants.projected),
      unprojected: buildSignature(hullVariants.unprojected)
    };
  }

  return {
    hulls,
    hullVariants,
    activeHullVariant,
    voxelView: {
      voxelSize: serialized.voxelView.voxelSize,
      parts: serialized.voxelView.parts.map((part) => {
        const centers: Array<[number, number, number]> = [];
        for (let i = 0; i < part.centers.length; i += 3) {
          centers.push([part.centers[i] ?? 0, part.centers[i + 1] ?? 0, part.centers[i + 2] ?? 0]);
        }
        return {
          index: part.index,
          color: part.color,
          voxelCount: part.voxelCount,
          centers
        };
      })
    },
    stats: { ...serialized.stats },
    signature:
      activeHullVariant === "projected" && signatures
        ? signatures.projected
        : activeHullVariant === "unprojected" && signatures
          ? signatures.unprojected
          : serialized.signature,
    signatures
  };
}

export function disposeVhacdResult(result: VhacdResult | null | undefined): void {
  if (!result) {
    return;
  }
  const geometries = new Set<THREE.BufferGeometry>();
  for (const hull of result.hulls) {
    geometries.add(hull.geometry);
  }
  if (result.hullVariants) {
    for (const hull of result.hullVariants.projected) {
      geometries.add(hull.geometry);
    }
    for (const hull of result.hullVariants.unprojected) {
      geometries.add(hull.geometry);
    }
  }
  for (const geometry of geometries) {
    geometry.dispose();
  }
}
