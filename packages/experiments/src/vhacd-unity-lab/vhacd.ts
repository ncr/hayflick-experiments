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
};

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
  };
  signature: string;
};

const DEFAULT_OPTIONS: VhacdOptions = {
  resolution: 40,
  concavity: 0.002,
  alpha: 0.05,
  beta: 0.05,
  planeDownsampling: 4,
  convexHullDownsampling: 4,
  maxConvexHulls: 12,
  minVoxelCountPerPart: 24,
  maxHullPointSamples: 1800
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

const EPSILON = 1e-9;
const MAX_GRID_CELLS = 1_900_000;
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

function createGrid(bounds: Bounds, resolution: number): VoxelGrid {
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

  while (nx * ny * nz > MAX_GRID_CELLS) {
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

function rasterizeTrianglesToShell(grid: VoxelGrid, triangles: Triangle[]): Uint8Array {
  const shell = new Uint8Array(grid.nx * grid.ny * grid.nz);
  const triStep = Math.max(1, Math.floor(triangles.length / 12000));

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
      generatedBeforeMerge: 0
    },
    signature: "empty"
  };
}

export function runVhacdFromObject(
  source: THREE.Object3D,
  inputOptions: Partial<VhacdOptions> = {}
): VhacdResult {
  const options: VhacdOptions = {
    ...DEFAULT_OPTIONS,
    ...inputOptions,
    resolution: clampInt(inputOptions.resolution ?? DEFAULT_OPTIONS.resolution, 10, 96),
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
    beta: clamp(inputOptions.beta ?? DEFAULT_OPTIONS.beta, 0, 1)
  };

  const extracted = collectTriangles(source);
  if (extracted.triangles.length <= 0 || !isFiniteBounds(extracted.bounds)) {
    return createFallbackResult();
  }

  const grid = createGrid(extracted.bounds, options.resolution);
  const shell = rasterizeTrianglesToShell(grid, extracted.triangles);
  const outside = floodFillExterior(grid, shell);
  const voxels = buildVoxelPoints(grid, shell, outside);

  if (voxels.length <= 0) {
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

  for (let level = 0; level < depth && workingParts.length > 0; level += 1) {
    ctx.stats.iterationCount += 1;
    const nextLevel: Part[] = [];

    for (const part of workingParts) {
      if (part.voxelIds.length < options.minVoxelCountPerPart * 2) {
        finalParts.push(part);
        continue;
      }

      const concavityInfo = computePartConcavity(part, ctx);
      if (concavityInfo.concavity <= options.concavity) {
        finalParts.push(part);
        continue;
      }

      const preferred = computePreferredDirection(part, ctx);
      const coarsePlanes = buildAxisPlanes(part, ctx, options.planeDownsampling);
      if (coarsePlanes.length <= 0) {
        finalParts.push(part);
        continue;
      }

      let best = evaluateSplitCost(
        part,
        ctx,
        coarsePlanes,
        concavityInfo.concavity,
        preferred.direction,
        preferred.weight,
        options.convexHullDownsampling
      );

      if (best && (options.planeDownsampling > 1 || options.convexHullDownsampling > 1)) {
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

      if (!best || best.concavity >= concavityInfo.concavity - 1e-6) {
        finalParts.push(part);
        continue;
      }

      nextLevel.push({ id: nextPartId, voxelIds: best.leftVoxels });
      nextPartId += 1;
      nextLevel.push({ id: nextPartId, voxelIds: best.rightVoxels });
      nextPartId += 1;
      ctx.stats.splitCount += 1;
    }

    workingParts = nextLevel;
  }

  for (const part of workingParts) {
    finalParts.push(part);
  }

  const generatedBeforeMerge = finalParts.length;
  const mergedParts = mergePartsToLimit(finalParts, ctx);

  const entries = mergedParts
    .map((part, index) => {
      const summary = summarizePart(part, ctx);
      const hull = buildHullGeometry(part, ctx);
      const concavity =
        Math.abs(hull.hullVolume - summary.volume) / Math.max(EPSILON, ctx.rootHullVolume);

      return {
        part,
        hull: {
          index,
          color: 0xffffff,
          geometry: hull.geometry,
          centroid: [summary.centroidX, summary.centroidY, summary.centroidZ],
          voxelCount: summary.voxelCount,
          voxelVolume: summary.volume,
          hullVolume: hull.hullVolume,
          concavity
        } satisfies VhacdHull
      };
    })
    .sort((a, b) => {
      if (a.hull.centroid[1] !== b.hull.centroid[1]) {
        return a.hull.centroid[1] - b.hull.centroid[1];
      }
      if (a.hull.centroid[0] !== b.hull.centroid[0]) {
        return a.hull.centroid[0] - b.hull.centroid[0];
      }
      return a.hull.centroid[2] - b.hull.centroid[2];
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
  const voxelParts: VhacdVoxelPart[] = [];

  for (let sortedIndex = 0; sortedIndex < entries.length; sortedIndex += 1) {
    const entry = entries[sortedIndex];
    const color = HULL_COLORS[sortedIndex % HULL_COLORS.length];

    hulls.push({
      ...entry.hull,
      index: sortedIndex,
      color
    });

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
  }

  const voxelPreviewCount = voxelParts.reduce(
    (sum, part) => sum + part.centers.length,
    0
  );

  const rootConcavity = Math.abs(rootHullVolume - rootSummary.volume) / Math.max(EPSILON, rootHullVolume);

  return {
    hulls,
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
      generatedBeforeMerge
    },
    signature: buildSignature(hulls)
  };
}

export function disposeVhacdResult(result: VhacdResult | null | undefined): void {
  if (!result) {
    return;
  }
  for (const hull of result.hulls) {
    hull.geometry.dispose();
  }
}
