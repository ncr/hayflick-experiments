import * as THREE from "three";
import { ConvexGeometry } from "three/examples/jsm/geometries/ConvexGeometry.js";

export type ConvexSegmentationOptions = {
  targetParts: number;
  iterations?: number;
  maxSamplePoints?: number;
  maxHullPoints?: number;
  minClusterPoints?: number;
  histogramBins?: number;
  minSplitImprovement?: number;
  minSplitImprovementAfterBase?: number;
};

export type ConvexSegmentPart = {
  index: number;
  centroid: [number, number, number];
  yMin: number;
  yMax: number;
  pointCount: number;
  hullPointCount: number;
  vertices: Array<[number, number, number]>;
  concavityProxy: number;
  segmentIndex: number;
};

export type ConvexSegmentationResult = {
  overlay: THREE.Group;
  parts: ConvexSegmentPart[];
  sampledPoints: number;
  targetParts: number;
  cutHeights: number[];
  signature: string;
};

type Matrix3 = [
  [number, number, number],
  [number, number, number],
  [number, number, number]
];

type CollectedTriangle = {
  a: THREE.Vector3;
  b: THREE.Vector3;
  c: THREE.Vector3;
  centroid: THREE.Vector3;
};

type TriangleWithPca = CollectedTriangle & {
  pcaA: THREE.Vector3;
  pcaB: THREE.Vector3;
  pcaC: THREE.Vector3;
  pcaCentroid: THREE.Vector3;
};

type PcaFrame = {
  origin: THREE.Vector3;
  axes: [THREE.Vector3, THREE.Vector3, THREE.Vector3];
};

type InternalHullPart = {
  geometry: THREE.BufferGeometry;
  centroid: THREE.Vector3;
  yMin: number;
  yMax: number;
  pointCount: number;
  hullPointCount: number;
  vertices: Array<[number, number, number]>;
  hullVolume: number;
  concavityProxy: number;
  segmentIndex: number;
};

type SplitCandidate = {
  improvement: number;
  leftTriangles: TriangleWithPca[];
  rightTriangles: TriangleWithPca[];
  left: InternalHullPart;
  right: InternalHullPart;
};

const COLOR_PALETTE = [
  0x8fd3ff,
  0x9cffb5,
  0xffc47f,
  0xd3a9ff,
  0xff98b2,
  0xa4f3ff,
  0xfff39f,
  0x9fb7ff
];

const EPSILON = 1e-8;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function tuple(x: number, y: number, z: number): [number, number, number] {
  return [x, y, z];
}

function identityMatrix3(): Matrix3 {
  return [
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1]
  ];
}

function cloneMatrix3(matrix: Matrix3): Matrix3 {
  return [
    [matrix[0][0], matrix[0][1], matrix[0][2]],
    [matrix[1][0], matrix[1][1], matrix[1][2]],
    [matrix[2][0], matrix[2][1], matrix[2][2]]
  ];
}

function matrixColumnToVector(matrix: Matrix3, column: 0 | 1 | 2): THREE.Vector3 {
  return new THREE.Vector3(matrix[0][column], matrix[1][column], matrix[2][column]);
}

function canonicalizeAxisSign(axis: THREE.Vector3): THREE.Vector3 {
  const absX = Math.abs(axis.x);
  const absY = Math.abs(axis.y);
  const absZ = Math.abs(axis.z);

  if (absX >= absY && absX >= absZ) {
    return axis.x < 0 ? axis.multiplyScalar(-1) : axis;
  }
  if (absY >= absZ) {
    return axis.y < 0 ? axis.multiplyScalar(-1) : axis;
  }
  return axis.z < 0 ? axis.multiplyScalar(-1) : axis;
}

function enforceRightHanded(
  axes: [THREE.Vector3, THREE.Vector3, THREE.Vector3]
): [THREE.Vector3, THREE.Vector3, THREE.Vector3] {
  const a0 = axes[0].clone().normalize();
  const a1 = axes[1].clone().normalize();
  let a2 = axes[2].clone().normalize();

  if (a0.clone().cross(a1).dot(a2) < 0) {
    a2 = a2.multiplyScalar(-1);
  }

  return [a0, a1, a2];
}

function jacobiEigenDecomposition(matrixInput: Matrix3): {
  eigenValues: [number, number, number];
  eigenVectors: Matrix3;
} {
  const matrix = cloneMatrix3(matrixInput);
  const vectors = identityMatrix3();

  for (let iteration = 0; iteration < 24; iteration += 1) {
    let p: 0 | 1 | 2 = 0;
    let q: 0 | 1 | 2 = 1;
    let maxAbs = Math.abs(matrix[0][1]);

    const pairs: Array<[0 | 1 | 2, 0 | 1 | 2]> = [
      [0, 1],
      [0, 2],
      [1, 2]
    ];

    for (const [i, j] of pairs) {
      const value = Math.abs(matrix[i][j]);
      if (value > maxAbs) {
        maxAbs = value;
        p = i;
        q = j;
      }
    }

    if (maxAbs < EPSILON) {
      break;
    }

    const app = matrix[p][p];
    const aqq = matrix[q][q];
    const apq = matrix[p][q];

    const phi = 0.5 * Math.atan2(2 * apq, aqq - app);
    const c = Math.cos(phi);
    const s = Math.sin(phi);

    for (let k = 0 as 0 | 1 | 2; k < 3; k = (k + 1) as 0 | 1 | 2) {
      const aik = matrix[p][k];
      const aqk = matrix[q][k];
      matrix[p][k] = c * aik - s * aqk;
      matrix[q][k] = s * aik + c * aqk;
    }

    for (let k = 0 as 0 | 1 | 2; k < 3; k = (k + 1) as 0 | 1 | 2) {
      const akp = matrix[k][p];
      const akq = matrix[k][q];
      matrix[k][p] = c * akp - s * akq;
      matrix[k][q] = s * akp + c * akq;
    }

    matrix[p][q] = 0;
    matrix[q][p] = 0;

    for (let k = 0 as 0 | 1 | 2; k < 3; k = (k + 1) as 0 | 1 | 2) {
      const vkp = vectors[k][p];
      const vkq = vectors[k][q];
      vectors[k][p] = c * vkp - s * vkq;
      vectors[k][q] = s * vkp + c * vkq;
    }
  }

  return {
    eigenValues: [matrix[0][0], matrix[1][1], matrix[2][2]],
    eigenVectors: vectors
  };
}

function computeMean(points: readonly THREE.Vector3[]): THREE.Vector3 {
  const mean = new THREE.Vector3();
  if (points.length <= 0) {
    return mean;
  }

  for (const point of points) {
    mean.add(point);
  }

  return mean.multiplyScalar(1 / points.length);
}

function computeCovariance(points: readonly THREE.Vector3[], mean: THREE.Vector3): Matrix3 {
  if (points.length <= 0) {
    return identityMatrix3();
  }

  let xx = 0;
  let xy = 0;
  let xz = 0;
  let yy = 0;
  let yz = 0;
  let zz = 0;

  for (const point of points) {
    const dx = point.x - mean.x;
    const dy = point.y - mean.y;
    const dz = point.z - mean.z;

    xx += dx * dx;
    xy += dx * dy;
    xz += dx * dz;
    yy += dy * dy;
    yz += dy * dz;
    zz += dz * dz;
  }

  const scale = 1 / Math.max(1, points.length - 1);

  return [
    [xx * scale, xy * scale, xz * scale],
    [xy * scale, yy * scale, yz * scale],
    [xz * scale, yz * scale, zz * scale]
  ];
}

function computePcaFrame(points: readonly THREE.Vector3[]): PcaFrame {
  const origin = computeMean(points);
  const covariance = computeCovariance(points, origin);
  const eigen = jacobiEigenDecomposition(covariance);

  const entries = [0, 1, 2].map((index) => ({
    value: eigen.eigenValues[index],
    axis: matrixColumnToVector(eigen.eigenVectors, index as 0 | 1 | 2)
  }));

  entries.sort((a, b) => b.value - a.value);

  const sortedAxes = entries.map((entry) =>
    canonicalizeAxisSign(entry.axis.clone().normalize())
  );
  const sortedAxesTuple = sortedAxes as [
    THREE.Vector3,
    THREE.Vector3,
    THREE.Vector3
  ];

  const axes = enforceRightHanded(sortedAxesTuple);

  return { origin, axes };
}

function toPca(point: THREE.Vector3, frame: PcaFrame): THREE.Vector3 {
  const delta = point.clone().sub(frame.origin);
  return new THREE.Vector3(
    delta.dot(frame.axes[0]),
    delta.dot(frame.axes[1]),
    delta.dot(frame.axes[2])
  );
}

function collectTriangles(root: THREE.Object3D): CollectedTriangle[] {
  root.updateMatrixWorld(true);
  const rootInverse = root.matrixWorld.clone().invert();

  const triangles: CollectedTriangle[] = [];
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  const centroid = new THREE.Vector3();
  const toRoot = new THREE.Matrix4();

  root.traverse((node) => {
    if (!(node instanceof THREE.Mesh)) {
      return;
    }
    if (!(node.geometry instanceof THREE.BufferGeometry)) {
      return;
    }

    const position = node.geometry.getAttribute("position");
    if (!(position instanceof THREE.BufferAttribute) || position.count < 3) {
      return;
    }

    const index = node.geometry.getIndex();
    const triangleCount = Math.floor((index ? index.count : position.count) / 3);
    if (triangleCount <= 0) {
      return;
    }

    toRoot.multiplyMatrices(rootInverse, node.matrixWorld);

    for (let tri = 0; tri < triangleCount; tri += 1) {
      const i0 = index ? index.getX(tri * 3) : tri * 3;
      const i1 = index ? index.getX(tri * 3 + 1) : tri * 3 + 1;
      const i2 = index ? index.getX(tri * 3 + 2) : tri * 3 + 2;

      a.fromBufferAttribute(position, i0).applyMatrix4(toRoot);
      b.fromBufferAttribute(position, i1).applyMatrix4(toRoot);
      c.fromBufferAttribute(position, i2).applyMatrix4(toRoot);

      centroid.copy(a).add(b).add(c).multiplyScalar(1 / 3);

      triangles.push({
        a: a.clone(),
        b: b.clone(),
        c: c.clone(),
        centroid: centroid.clone()
      });
    }
  });

  return triangles;
}

function collectVerticesFromTriangles(triangles: readonly CollectedTriangle[]): THREE.Vector3[] {
  const points: THREE.Vector3[] = [];
  for (const triangle of triangles) {
    points.push(triangle.a.clone(), triangle.b.clone(), triangle.c.clone());
  }
  return points;
}

function collectSurfaceSamples(
  triangles: readonly CollectedTriangle[],
  maxSamplePoints: number
): THREE.Vector3[] {
  if (triangles.length <= maxSamplePoints) {
    return triangles.map((triangle) => triangle.centroid.clone());
  }

  const samples: THREE.Vector3[] = [];
  const stride = Math.max(1, Math.floor(triangles.length / maxSamplePoints));
  for (let i = 0; i < triangles.length && samples.length < maxSamplePoints; i += stride) {
    samples.push(triangles[i].centroid.clone());
  }
  return samples;
}

function chooseUpAxisFromExtent(
  pcaPoints: readonly THREE.Vector3[]
): 0 | 1 | 2 {
  const bounds = new THREE.Box3();
  for (const point of pcaPoints) {
    bounds.expandByPoint(point);
  }

  const size = bounds.getSize(new THREE.Vector3());
  if (size.x >= size.y && size.x >= size.z) {
    return 0;
  }
  if (size.y >= size.z) {
    return 1;
  }
  return 2;
}

function collectPcaTriangles(
  triangles: readonly CollectedTriangle[],
  frame: PcaFrame
): TriangleWithPca[] {
  return triangles.map((triangle) => ({
    ...triangle,
    pcaA: toPca(triangle.a, frame),
    pcaB: toPca(triangle.b, frame),
    pcaC: toPca(triangle.c, frame),
    pcaCentroid: toPca(triangle.centroid, frame)
  }));
}

function movingAverage(values: readonly number[], radius: number): number[] {
  const result = new Array<number>(values.length).fill(0);
  for (let i = 0; i < values.length; i += 1) {
    let sum = 0;
    let count = 0;
    const start = Math.max(0, i - radius);
    const end = Math.min(values.length - 1, i + radius);

    for (let j = start; j <= end; j += 1) {
      sum += values[j];
      count += 1;
    }

    result[i] = count <= 0 ? 0 : sum / count;
  }
  return result;
}

function detectCutBins(
  histogram: readonly number[],
  upMin: number,
  upMax: number
): number[] {
  if (histogram.length < 6 || upMax <= upMin + EPSILON) {
    return [];
  }

  const smooth = movingAverage(histogram, 1);
  const derivative: number[] = [];
  for (let i = 1; i < smooth.length; i += 1) {
    derivative.push(smooth[i] - smooth[i - 1]);
  }

  const maxCount = Math.max(1, ...histogram);
  const minSeparation = Math.max(3, Math.floor(histogram.length / 10));

  const candidates: Array<{ bin: number; drop: number }> = [];
  for (let i = 1; i < derivative.length - 1; i += 1) {
    const drop = derivative[i] / maxCount;
    if (drop >= -0.05) {
      continue;
    }

    if (derivative[i] <= derivative[i - 1] && derivative[i] <= derivative[i + 1]) {
      candidates.push({ bin: i, drop });
    }
  }

  candidates.sort((a, b) => a.drop - b.drop);

  let primary: number | null = null;
  let secondary: number | null = null;

  for (const candidate of candidates) {
    if (candidate.bin < 2 || candidate.bin > histogram.length - 3) {
      continue;
    }

    if (primary === null) {
      primary = candidate.bin;
      continue;
    }

    if (Math.abs(candidate.bin - primary) < minSeparation) {
      continue;
    }

    if (candidate.bin < primary && candidate.bin < Math.floor(histogram.length * 0.7)) {
      secondary = candidate.bin;
      break;
    }
  }

  if (primary === null) {
    return [];
  }

  if (secondary === null) {
    return [primary];
  }

  return [secondary, primary].sort((a, b) => a - b);
}

function cutHeightsFromBins(
  bins: readonly number[],
  upMin: number,
  upMax: number,
  histogramBins: number
): number[] {
  const range = upMax - upMin;
  if (range <= EPSILON) {
    return [];
  }

  return bins.map((bin) => upMin + ((bin + 1) / histogramBins) * range);
}

function segmentTrianglesByCutHeights(
  triangles: readonly TriangleWithPca[],
  cutHeights: readonly number[]
): TriangleWithPca[][] {
  if (triangles.length <= 0) {
    return [];
  }

  const sortedCuts = [...cutHeights].sort((a, b) => a - b);
  const segments: TriangleWithPca[][] = Array.from(
    { length: sortedCuts.length + 1 },
    () => []
  );

  for (const triangle of triangles) {
    const up = triangle.centroid.y;

    let segment = 0;
    while (segment < sortedCuts.length && up > sortedCuts[segment]) {
      segment += 1;
    }
    segments[segment].push(triangle);
  }

  return segments.filter((segment) => segment.length > 0);
}

function averageUp(
  triangles: readonly TriangleWithPca[]
): number {
  if (triangles.length <= 0) {
    return 0;
  }

  let sum = 0;
  for (const triangle of triangles) {
    sum += triangle.centroid.y;
  }

  return sum / triangles.length;
}

function yRangeOfTriangles(
  triangles: readonly TriangleWithPca[]
): { yMin: number; yMax: number } {
  let yMin = Number.POSITIVE_INFINITY;
  let yMax = Number.NEGATIVE_INFINITY;
  for (const triangle of triangles) {
    const y = triangle.centroid.y;
    if (y < yMin) yMin = y;
    if (y > yMax) yMax = y;
  }
  if (!Number.isFinite(yMin) || !Number.isFinite(yMax)) {
    return { yMin: 0, yMax: 0 };
  }
  return { yMin, yMax };
}

function mergeTinySegments(
  segments: TriangleWithPca[][],
  minTriangles: number
): TriangleWithPca[][] {
  const working = segments.map((segment) => segment.slice());

  let merged = true;
  while (merged) {
    merged = false;

    let tinyIndex = -1;
    for (let i = 0; i < working.length; i += 1) {
      if (working[i].length < minTriangles) {
        tinyIndex = i;
        break;
      }
    }

    if (tinyIndex < 0 || working.length <= 1) {
      break;
    }

    const tinyAverage = averageUp(working[tinyIndex]);
    let target = tinyIndex === 0 ? 1 : tinyIndex - 1;
    let bestDistance = Math.abs(averageUp(working[target]) - tinyAverage);

    const right = tinyIndex + 1;
    if (right < working.length) {
      const rightDistance = Math.abs(averageUp(working[right]) - tinyAverage);
      if (rightDistance < bestDistance) {
        target = right;
        bestDistance = rightDistance;
      }
    }

    if (bestDistance >= 0) {
      working[target].push(...working[tinyIndex]);
      working.splice(tinyIndex, 1);
      merged = true;
    }
  }

  return working;
}

function collectSegmentPoints(
  triangles: readonly TriangleWithPca[]
): { world: THREE.Vector3[]; pca: THREE.Vector3[] } {
  const world: THREE.Vector3[] = [];
  const pca: THREE.Vector3[] = [];

  // Keep segment hull construction inside the Y-banded partition by using
  // interior samples (centroids) rather than full triangle vertices.
  for (const triangle of triangles) {
    world.push(triangle.centroid.clone());
    pca.push(triangle.pcaCentroid.clone());
  }

  return { world, pca };
}

function downsamplePoints(points: readonly THREE.Vector3[], maxPoints: number): THREE.Vector3[] {
  if (points.length <= maxPoints) {
    return points.map((point) => point.clone());
  }

  const sampled: THREE.Vector3[] = [];
  const stride = Math.max(1, Math.ceil(points.length / maxPoints));

  for (let i = 0; i < points.length && sampled.length < maxPoints; i += stride) {
    sampled.push(points[i].clone());
  }

  return sampled;
}

function uniqueHullVertices(geometry: THREE.BufferGeometry): Array<[number, number, number]> {
  const position = geometry.getAttribute("position");
  if (!(position instanceof THREE.BufferAttribute)) {
    return [];
  }

  const seen = new Set<string>();
  const vertices: Array<[number, number, number]> = [];

  for (let i = 0; i < position.count; i += 1) {
    const x = Number(position.getX(i).toFixed(5));
    const y = Number(position.getY(i).toFixed(5));
    const z = Number(position.getZ(i).toFixed(5));
    const key = `${x}|${y}|${z}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    vertices.push([x, y, z]);
  }

  return vertices;
}

function convexHullVolume(geometry: THREE.BufferGeometry): number {
  const position = geometry.getAttribute("position");
  if (!(position instanceof THREE.BufferAttribute) || position.count < 3) {
    return 0;
  }

  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();

  let volume = 0;
  const triCount = Math.floor(position.count / 3);
  for (let tri = 0; tri < triCount; tri += 1) {
    a.fromBufferAttribute(position, tri * 3);
    b.fromBufferAttribute(position, tri * 3 + 1);
    c.fromBufferAttribute(position, tri * 3 + 2);
    volume += a.dot(b.clone().cross(c)) / 6;
  }

  return Math.abs(volume);
}

function estimatePointCloudVolume(points: readonly THREE.Vector3[]): number {
  if (points.length <= 0) {
    return 0;
  }

  const bounds = new THREE.Box3();
  for (const point of points) {
    bounds.expandByPoint(point);
  }

  const size = bounds.getSize(new THREE.Vector3());
  const maxDim = Math.max(size.x, size.y, size.z, EPSILON);

  const base = 18;
  const xCount = Math.max(8, Math.round((size.x / maxDim) * base));
  const yCount = Math.max(8, Math.round((size.y / maxDim) * base));
  const zCount = Math.max(8, Math.round((size.z / maxDim) * base));

  const occupancy = new Uint8Array(xCount * yCount * zCount);

  const index = (x: number, y: number, z: number): number => x + xCount * (y + yCount * z);

  for (const point of points) {
    const xNorm = clamp((point.x - bounds.min.x) / Math.max(EPSILON, size.x), 0, 0.999999);
    const yNorm = clamp((point.y - bounds.min.y) / Math.max(EPSILON, size.y), 0, 0.999999);
    const zNorm = clamp((point.z - bounds.min.z) / Math.max(EPSILON, size.z), 0, 0.999999);

    const x = Math.floor(xNorm * xCount);
    const y = Math.floor(yNorm * yCount);
    const z = Math.floor(zNorm * zCount);
    occupancy[index(x, y, z)] = 1;
  }

  let occupied = 0;
  for (let i = 0; i < occupancy.length; i += 1) {
    occupied += occupancy[i] === 0 ? 0 : 1;
  }

  const cellVolume =
    (Math.max(EPSILON, size.x) / xCount) *
    (Math.max(EPSILON, size.y) / yCount) *
    (Math.max(EPSILON, size.z) / zCount);

  return occupied * cellVolume;
}

function makeHullPart(
  triangles: readonly TriangleWithPca[],
  segmentIndex: number,
  maxHullPoints: number
): InternalHullPart | null {
  const points = collectSegmentPoints(triangles);
  if (points.world.length < 4) {
    return null;
  }

  const sampled = downsamplePoints(points.world, maxHullPoints);
  if (sampled.length < 4) {
    return null;
  }

  const geometry = new ConvexGeometry(sampled);
  const vertices = uniqueHullVertices(geometry);
  if (vertices.length < 4) {
    geometry.dispose();
    return null;
  }

  const hullVolume = Math.max(EPSILON, convexHullVolume(geometry));
  const segmentVolume = estimatePointCloudVolume(points.pca);
  const concavityProxy = clamp(1 - segmentVolume / hullVolume, 0, 1);
  const yRange = yRangeOfTriangles(triangles);

  const centroid = computeMean(points.world);

  return {
    geometry,
    centroid,
    yMin: yRange.yMin,
    yMax: yRange.yMax,
    pointCount: points.world.length,
    hullPointCount: sampled.length,
    vertices,
    hullVolume,
    concavityProxy,
    segmentIndex
  };
}

function hasYRangeOverlap(
  ranges: readonly { yMin: number; yMax: number }[],
  epsilon = 1e-4
): boolean {
  if (ranges.length <= 1) {
    return false;
  }

  const sorted = [...ranges].sort((a, b) => a.yMin - b.yMin);
  for (let i = 1; i < sorted.length; i += 1) {
    if (sorted[i].yMin < sorted[i - 1].yMax - epsilon) {
      return true;
    }
  }
  return false;
}

function splitSegmentByY(
  triangles: readonly TriangleWithPca[]
): { left: TriangleWithPca[]; right: TriangleWithPca[] } | null {
  if (triangles.length < 12) {
    return null;
  }

  const values = triangles.map((triangle) => triangle.centroid.y);
  values.sort((a, b) => a - b);
  const median = values[Math.floor(values.length * 0.5)];

  const left: TriangleWithPca[] = [];
  const right: TriangleWithPca[] = [];

  for (const triangle of triangles) {
    if (triangle.centroid.y <= median) {
      left.push(triangle);
    } else {
      right.push(triangle);
    }
  }

  if (left.length < 8 || right.length < 8) {
    return null;
  }

  return { left, right };
}

function trySplitHull(
  triangles: readonly TriangleWithPca[],
  single: InternalHullPart,
  segmentIndex: number,
  maxHullPoints: number,
  minImprovement: number
): SplitCandidate | null {
  const split = splitSegmentByY(triangles);
  if (!split) {
    return null;
  }

  const leftPart = makeHullPart(split.left, segmentIndex, maxHullPoints);
  const rightPart = makeHullPart(split.right, segmentIndex, maxHullPoints);
  if (!leftPart || !rightPart) {
    if (leftPart) leftPart.geometry.dispose();
    if (rightPart) rightPart.geometry.dispose();
    return null;
  }

  if (hasYRangeOverlap([leftPart, rightPart])) {
    leftPart.geometry.dispose();
    rightPart.geometry.dispose();
    return null;
  }

  const combined = leftPart.hullVolume + rightPart.hullVolume;
  const improvement = clamp((single.hullVolume - combined) / single.hullVolume, 0, 1);

  if (improvement < minImprovement) {
    leftPart.geometry.dispose();
    rightPart.geometry.dispose();
    return null;
  }

  return {
    improvement,
    leftTriangles: split.left,
    rightTriangles: split.right,
    left: leftPart,
    right: rightPart
  };
}

function sortParts(parts: ConvexSegmentPart[]): ConvexSegmentPart[] {
  return [...parts].sort((a, b) =>
    a.centroid[1] !== b.centroid[1]
      ? b.centroid[1] - a.centroid[1]
      : a.centroid[0] !== b.centroid[0]
        ? a.centroid[0] - b.centroid[0]
        : a.centroid[2] - b.centroid[2]
  );
}

function signatureFromParts(
  parts: readonly ConvexSegmentPart[],
  cutHeights: readonly number[]
): string {
  return JSON.stringify({
    cuts: cutHeights.map((value) => Number(value.toFixed(4))),
    parts: parts.map((part) => ({
      centroid: part.centroid.map((value) => Number(value.toFixed(4))),
      pointCount: part.pointCount,
      hullPointCount: part.hullPointCount,
      vertices: part.vertices.length,
      concavity: Number(part.concavityProxy.toFixed(4))
    }))
  });
}

function cleanupUnusedSplit(split: SplitCandidate | null): void {
  if (!split) {
    return;
  }
  split.left.geometry.dispose();
  split.right.geometry.dispose();
}

export function segmentIntoConvexHulls(
  root: THREE.Object3D,
  options: ConvexSegmentationOptions
): ConvexSegmentationResult {
  const targetParts = Math.floor(clamp(options.targetParts, 1, 8));
  const maxSamplePoints = Math.floor(clamp(options.maxSamplePoints ?? 2600, 300, 7000));
  const maxHullPoints = Math.floor(clamp(options.maxHullPoints ?? 180, 24, 500));
  const minClusterPoints = Math.floor(clamp(options.minClusterPoints ?? 24, 8, 180));
  const histogramBins = Math.floor(clamp(options.histogramBins ?? 64, 16, 128));
  const minSplitImprovement = clamp(options.minSplitImprovement ?? 0.07, 0, 0.25);
  const minSplitImprovementAfterBase = clamp(
    options.minSplitImprovementAfterBase ?? 0.02,
    0,
    0.2
  );

  const triangles = collectTriangles(root);
  if (triangles.length <= 0) {
    return {
      overlay: new THREE.Group(),
      parts: [],
      sampledPoints: 0,
      targetParts,
      cutHeights: [],
      signature: "[]"
    };
  }

  const allPoints = collectVerticesFromTriangles(triangles);
  const surfaceSamples = collectSurfaceSamples(triangles, maxSamplePoints);
  const frame = computePcaFrame(allPoints);
  const withPca = collectPcaTriangles(triangles, frame);

  let upMin = Number.POSITIVE_INFINITY;
  let upMax = Number.NEGATIVE_INFINITY;
  for (const triangle of withPca) {
    const up = triangle.centroid.y;
    upMin = Math.min(upMin, up);
    upMax = Math.max(upMax, up);
  }

  const histogram = new Array<number>(histogramBins).fill(0);
  const upRange = Math.max(EPSILON, upMax - upMin);
  for (const triangle of withPca) {
    const up = triangle.centroid.y;

    const normalized = clamp((up - upMin) / upRange, 0, 0.999999);
    const bin = Math.floor(normalized * histogramBins);
    histogram[bin] += 1;
  }

  const cutBins = detectCutBins(histogram, upMin, upMax);
  const cutHeights = cutHeightsFromBins(cutBins, upMin, upMax, histogramBins);

  let segments = segmentTrianglesByCutHeights(withPca, cutHeights);
  segments = mergeTinySegments(segments, minClusterPoints);

  type ActiveHull = {
    segmentIndex: number;
    triangles: TriangleWithPca[];
    hull: InternalHullPart;
  };

  const activeHulls: ActiveHull[] = [];
  for (let segmentIndex = 0; segmentIndex < segments.length; segmentIndex += 1) {
    const hull = makeHullPart(segments[segmentIndex], segmentIndex, maxHullPoints);
    if (!hull) {
      continue;
    }
    activeHulls.push({
      segmentIndex,
      triangles: segments[segmentIndex],
      hull
    });
  }

  const maxParts = Math.max(1, targetParts);
  while (activeHulls.length < maxParts) {
    let bestIndex = -1;
    let bestCandidate: SplitCandidate | null = null;
    let bestScore = Number.NEGATIVE_INFINITY;

    const minImprovement =
      activeHulls.length < Math.min(4, maxParts)
        ? minSplitImprovement
        : minSplitImprovementAfterBase;

    for (let index = 0; index < activeHulls.length; index += 1) {
      const source = activeHulls[index];
      const candidate = trySplitHull(
        source.triangles,
        source.hull,
        source.segmentIndex,
        maxHullPoints,
        minImprovement
      );
      if (!candidate) {
        continue;
      }

      const ranges = activeHulls
        .filter((_, activeIndex) => activeIndex !== index)
        .map((entry) => ({ yMin: entry.hull.yMin, yMax: entry.hull.yMax }));
      ranges.push(
        { yMin: candidate.left.yMin, yMax: candidate.left.yMax },
        { yMin: candidate.right.yMin, yMax: candidate.right.yMax }
      );
      if (hasYRangeOverlap(ranges)) {
        cleanupUnusedSplit(candidate);
        continue;
      }

      const score = candidate.improvement + source.hull.concavityProxy * 0.06;
      if (score > bestScore) {
        if (bestCandidate) {
          cleanupUnusedSplit(bestCandidate);
        }
        bestCandidate = candidate;
        bestScore = score;
        bestIndex = index;
      } else {
        cleanupUnusedSplit(candidate);
      }
    }

    if (!bestCandidate || bestIndex < 0) {
      break;
    }

    const source = activeHulls[bestIndex];
    source.hull.geometry.dispose();

    const left: ActiveHull = {
      segmentIndex: source.segmentIndex,
      triangles: bestCandidate.leftTriangles,
      hull: bestCandidate.left
    };
    const right: ActiveHull = {
      segmentIndex: source.segmentIndex,
      triangles: bestCandidate.rightTriangles,
      hull: bestCandidate.right
    };
    activeHulls.splice(bestIndex, 1, left, right);
  }

  const overlay = new THREE.Group();
  overlay.name = "convex-segmentation-overlay";

  const rawParts: ConvexSegmentPart[] = [];
  let colorIndex = 0;

  const orderedHulls = [...activeHulls].sort((a, b) =>
    a.segmentIndex !== b.segmentIndex
      ? a.segmentIndex - b.segmentIndex
      : b.hull.centroid.y !== a.hull.centroid.y
        ? b.hull.centroid.y - a.hull.centroid.y
        : a.hull.centroid.x - b.hull.centroid.x
  );

  for (const entry of orderedHulls) {
    const part = entry.hull;
    const color = COLOR_PALETTE[colorIndex % COLOR_PALETTE.length];
    const mesh = new THREE.Mesh(
      part.geometry,
      new THREE.MeshBasicMaterial({
        color,
        wireframe: true,
        transparent: true,
        opacity: 0.56
      })
    );
    mesh.name = `convex-segment-${colorIndex + 1}`;
    overlay.add(mesh);

    rawParts.push({
      index: colorIndex,
      centroid: tuple(part.centroid.x, part.centroid.y, part.centroid.z),
      yMin: part.yMin,
      yMax: part.yMax,
      pointCount: part.pointCount,
      hullPointCount: part.hullPointCount,
      vertices: part.vertices,
      concavityProxy: part.concavityProxy,
      segmentIndex: entry.segmentIndex
    });

    colorIndex += 1;
  }

  const parts = sortParts(rawParts).map((part, index) => ({
    ...part,
    index
  }));

  return {
    overlay,
    parts,
    sampledPoints: surfaceSamples.length,
    targetParts,
    cutHeights,
    signature: signatureFromParts(parts, cutHeights)
  };
}
