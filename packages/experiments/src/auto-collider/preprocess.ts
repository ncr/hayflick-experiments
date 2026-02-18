import * as THREE from "three";
import type { PcaFrame, PreparedGeometry, PreparedTriangle } from "./types";

type Matrix3 = [
  [number, number, number],
  [number, number, number],
  [number, number, number]
];

const EPSILON = 1e-9;
const DEFAULT_SAMPLE_CAP = 1600;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
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

function matrixColumnToVector(matrix: Matrix3, index: 0 | 1 | 2): THREE.Vector3 {
  return new THREE.Vector3(matrix[0][index], matrix[1][index], matrix[2][index]);
}

function sortEigenPairs(eigenValues: number[], eigenVectors: Matrix3): {
  values: [number, number, number];
  vectors: [THREE.Vector3, THREE.Vector3, THREE.Vector3];
} {
  const entries = [0, 1, 2].map((index) => ({
    value: eigenValues[index],
    vector: matrixColumnToVector(eigenVectors, index as 0 | 1 | 2)
  }));

  entries.sort((a, b) => b.value - a.value);

  const vectors = entries.map((entry) => entry.vector.normalize()) as [
    THREE.Vector3,
    THREE.Vector3,
    THREE.Vector3
  ];

  return {
    values: [entries[0].value, entries[1].value, entries[2].value],
    vectors
  };
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

function computeCovariance(
  points: readonly THREE.Vector3[],
  mean: THREE.Vector3
): Matrix3 {
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

function chooseUpAxis(
  axes: [THREE.Vector3, THREE.Vector3, THREE.Vector3]
): 0 | 1 | 2 {
  const worldUp = new THREE.Vector3(0, 1, 0);
  let bestIndex: 0 | 1 | 2 = 0;
  let bestDot = Math.abs(axes[0].dot(worldUp));

  for (let index = 1 as 1 | 2; index < 3; index = (index + 1) as 1 | 2) {
    const score = Math.abs(axes[index].dot(worldUp));
    if (score > bestDot) {
      bestDot = score;
      bestIndex = index;
    }
  }

  return bestIndex;
}

function computePcaFrame(points: readonly THREE.Vector3[]): PcaFrame {
  const origin = computeMean(points);
  const covariance = computeCovariance(points, origin);
  const eigen = jacobiEigenDecomposition(covariance);
  const sorted = sortEigenPairs(eigen.eigenValues, eigen.eigenVectors);

  const canonicalAxes = sorted.vectors.map((axis) =>
    canonicalizeAxisSign(axis.clone())
  ) as [THREE.Vector3, THREE.Vector3, THREE.Vector3];

  const axes = enforceRightHanded(canonicalAxes);
  const upAxis = chooseUpAxis(axes);

  return { origin, axes, upAxis };
}

function toPcaPoint(point: THREE.Vector3, frame: PcaFrame): THREE.Vector3 {
  const delta = point.clone().sub(frame.origin);
  return new THREE.Vector3(
    delta.dot(frame.axes[0]),
    delta.dot(frame.axes[1]),
    delta.dot(frame.axes[2])
  );
}

function computeBounds(points: readonly THREE.Vector3[]): THREE.Box3 {
  const bounds = new THREE.Box3();
  for (const point of points) {
    bounds.expandByPoint(point);
  }
  return bounds;
}

function createTriangle(
  a: THREE.Vector3,
  b: THREE.Vector3,
  c: THREE.Vector3
): PreparedTriangle | null {
  const ab = b.clone().sub(a);
  const ac = c.clone().sub(a);
  const normal = ab.clone().cross(ac);
  const area = normal.length() * 0.5;
  if (!Number.isFinite(area) || area <= EPSILON) {
    return null;
  }
  normal.normalize();

  return {
    a,
    b,
    c,
    normal,
    area
  };
}

function collectTrianglesFromGeometry(
  geometry: THREE.BufferGeometry
): PreparedTriangle[] {
  const position = geometry.getAttribute("position");
  if (!(position instanceof THREE.BufferAttribute) || position.count < 3) {
    return [];
  }

  const triangles: PreparedTriangle[] = [];
  const index = geometry.getIndex();
  const triCount = Math.floor((index ? index.count : position.count) / 3);

  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();

  for (let tri = 0; tri < triCount; tri += 1) {
    const i0 = index ? index.getX(tri * 3) : tri * 3;
    const i1 = index ? index.getX(tri * 3 + 1) : tri * 3 + 1;
    const i2 = index ? index.getX(tri * 3 + 2) : tri * 3 + 2;

    a.fromBufferAttribute(position, i0);
    b.fromBufferAttribute(position, i1);
    c.fromBufferAttribute(position, i2);

    const triangle = createTriangle(a.clone(), b.clone(), c.clone());
    if (triangle) {
      triangles.push(triangle);
    }
  }

  return triangles;
}

function collectDeterministicSamples(
  triangles: readonly PreparedTriangle[],
  cap: number
): THREE.Vector3[] {
  if (triangles.length <= 0 || cap <= 0) {
    return [];
  }

  const perTri = 3;
  const triBudget = Math.max(1, Math.floor(cap / perTri));
  const stride = Math.max(1, Math.floor(triangles.length / triBudget));

  const samples: THREE.Vector3[] = [];

  for (let triIndex = 0; triIndex < triangles.length; triIndex += stride) {
    const tri = triangles[triIndex];

    const centroid = tri.a
      .clone()
      .add(tri.b)
      .add(tri.c)
      .multiplyScalar(1 / 3);

    const sample1 = tri.a
      .clone()
      .multiplyScalar(0.6)
      .add(tri.b.clone().multiplyScalar(0.3))
      .add(tri.c.clone().multiplyScalar(0.1));

    const sample2 = tri.a
      .clone()
      .multiplyScalar(0.15)
      .add(tri.b.clone().multiplyScalar(0.7))
      .add(tri.c.clone().multiplyScalar(0.15));

    samples.push(centroid, sample1, sample2);
    if (samples.length >= cap) {
      break;
    }
  }

  if (samples.length > cap) {
    samples.length = cap;
  }

  return samples;
}

function collectPointsFromTriangles(triangles: readonly PreparedTriangle[]): THREE.Vector3[] {
  const points: THREE.Vector3[] = [];
  for (const triangle of triangles) {
    points.push(triangle.a.clone(), triangle.b.clone(), triangle.c.clone());
  }
  return points;
}

export function collectRootLocalGeometry(
  root: THREE.Object3D
): THREE.BufferGeometry | null {
  root.updateMatrixWorld(true);
  const rootInverse = root.matrixWorld.clone().invert();

  const positionData: number[] = [];
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
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
    const triCount = Math.floor((index ? index.count : position.count) / 3);
    if (triCount <= 0) {
      return;
    }

    toRoot.multiplyMatrices(rootInverse, node.matrixWorld);

    for (let tri = 0; tri < triCount; tri += 1) {
      const i0 = index ? index.getX(tri * 3) : tri * 3;
      const i1 = index ? index.getX(tri * 3 + 1) : tri * 3 + 1;
      const i2 = index ? index.getX(tri * 3 + 2) : tri * 3 + 2;

      a.fromBufferAttribute(position, i0).applyMatrix4(toRoot);
      b.fromBufferAttribute(position, i1).applyMatrix4(toRoot);
      c.fromBufferAttribute(position, i2).applyMatrix4(toRoot);

      positionData.push(
        a.x,
        a.y,
        a.z,
        b.x,
        b.y,
        b.z,
        c.x,
        c.y,
        c.z
      );
    }
  });

  if (positionData.length < 9) {
    return null;
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute(
    "position",
    new THREE.Float32BufferAttribute(positionData, 3)
  );
  return geometry;
}

export function preprocessGeometry(
  geometry: THREE.BufferGeometry,
  options?: { sampleCap?: number }
): PreparedGeometry | null {
  const triangles = collectTrianglesFromGeometry(geometry);
  if (triangles.length <= 0) {
    return null;
  }

  const points = collectPointsFromTriangles(triangles);
  if (points.length <= 0) {
    return null;
  }

  const bounds = computeBounds(points);
  if (bounds.isEmpty()) {
    return null;
  }

  const size = bounds.getSize(new THREE.Vector3());
  const center = bounds.getCenter(new THREE.Vector3());
  const diagonal = size.length();

  const frame = computePcaFrame(points);
  const pcaPoints = points.map((point) => toPcaPoint(point, frame));
  const pcaBounds = computeBounds(pcaPoints);

  const sampleCap = Math.round(clamp(options?.sampleCap ?? DEFAULT_SAMPLE_CAP, 128, 8192));
  const samples = collectDeterministicSamples(triangles, sampleCap);

  return {
    points,
    triangles,
    samples,
    bounds,
    center,
    size,
    diagonal,
    pcaFrame: frame,
    pcaPoints,
    pcaBounds
  };
}
