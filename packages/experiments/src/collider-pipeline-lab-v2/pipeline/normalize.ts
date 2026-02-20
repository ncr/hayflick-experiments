import * as THREE from "three";
import type { NormalizationTransform, NormalizedProp, Vec3Tuple } from "../types";
import {
  bboxFromPoints,
  cross3,
  dot3,
  normalize3,
  scale3,
  sub3,
  toFixedNumber
} from "./math";

type RawTriangle = {
  a: Vec3Tuple;
  b: Vec3Tuple;
  c: Vec3Tuple;
};

function extractRawGeometry(root: THREE.Object3D): {
  points: Vec3Tuple[];
  triangles: RawTriangle[];
} {
  root.updateMatrixWorld(true);
  const points: Vec3Tuple[] = [];
  const triangles: RawTriangle[] = [];

  const tempA = new THREE.Vector3();
  const tempB = new THREE.Vector3();
  const tempC = new THREE.Vector3();

  root.traverse((node) => {
    if (!(node instanceof THREE.Mesh)) {
      return;
    }
    const geometry = node.geometry;
    const position = geometry.getAttribute("position");
    if (!position) {
      return;
    }

    const matrix = node.matrixWorld;
    const index = geometry.getIndex();
    const vertexAt = (vertexIndex: number, target: THREE.Vector3): Vec3Tuple => {
      target.fromBufferAttribute(position, vertexIndex).applyMatrix4(matrix);
      return [target.x, target.y, target.z];
    };

    if (index) {
      for (let i = 0; i < index.count; i += 3) {
        const i0 = index.getX(i);
        const i1 = index.getX(i + 1);
        const i2 = index.getX(i + 2);
        const a = vertexAt(i0, tempA);
        const b = vertexAt(i1, tempB);
        const c = vertexAt(i2, tempC);
        points.push(a, b, c);
        triangles.push({ a, b, c });
      }
      return;
    }

    for (let i = 0; i < position.count; i += 3) {
      const a = vertexAt(i, tempA);
      const b = vertexAt(i + 1, tempB);
      const c = vertexAt(i + 2, tempC);
      points.push(a, b, c);
      triangles.push({ a, b, c });
    }
  });

  return { points, triangles };
}

function computeNormalizationTransform(points: Vec3Tuple[]): NormalizationTransform {
  const bounds = bboxFromPoints(points);
  const longestAxis = Math.max(bounds.size[0], bounds.size[1], bounds.size[2], 1e-6);
  return {
    offset: [bounds.center[0], bounds.min[1], bounds.center[2]],
    scale: 1 / longestAxis
  };
}

function applyTransformToPoint(
  point: Vec3Tuple,
  transform: NormalizationTransform
): Vec3Tuple {
  return [
    (point[0] - transform.offset[0]) * transform.scale,
    (point[1] - transform.offset[1]) * transform.scale,
    (point[2] - transform.offset[2]) * transform.scale
  ];
}

function meshVolumeFromTriangles(triangles: RawTriangle[]): number {
  let signedVolume = 0;
  for (const triangle of triangles) {
    const cross = cross3(triangle.b, triangle.c);
    signedVolume += dot3(triangle.a, cross);
  }
  return Math.abs(signedVolume / 6);
}

export function normalizePropGeometry(
  root: THREE.Object3D,
  propId: string
): NormalizedProp {
  const raw = extractRawGeometry(root);
  if (raw.points.length <= 0 || raw.triangles.length <= 0) {
    const emptyTransform: NormalizationTransform = {
      offset: [0, 0, 0],
      scale: 1
    };
    return {
      propId,
      sourceBounds: {
        width: 0,
        height: 0,
        depth: 0,
        longestAxis: 0
      },
      transform: emptyTransform,
      bbox: {
        min: [0, 0, 0],
        max: [0, 0, 0],
        size: [0, 0, 0],
        center: [0, 0, 0],
        volume: 0
      },
      points: [],
      triangles: [],
      triangleCount: 0,
      pointCount: 0,
      meshVolume: 0,
      sampleSignature: `${propId}:empty`
    };
  }

  const sourceBounds = bboxFromPoints(raw.points);
  const transform = computeNormalizationTransform(raw.points);
  const normalizedPoints = raw.points.map((point) => applyTransformToPoint(point, transform));

  const normalizedRawTriangles: RawTriangle[] = raw.triangles.map((triangle) => ({
    a: applyTransformToPoint(triangle.a, transform),
    b: applyTransformToPoint(triangle.b, transform),
    c: applyTransformToPoint(triangle.c, transform)
  }));

  const normalizedTriangles = normalizedRawTriangles.map((triangle) => {
    const ab = sub3(triangle.b, triangle.a);
    const ac = sub3(triangle.c, triangle.a);
    const cross = cross3(ab, ac);
    const area = Math.max(0, 0.5 * Math.sqrt(dot3(cross, cross)));
    const normal = normalize3(cross);
    const centroid: Vec3Tuple = scale3(
      [
        triangle.a[0] + triangle.b[0] + triangle.c[0],
        triangle.a[1] + triangle.b[1] + triangle.c[1],
        triangle.a[2] + triangle.b[2] + triangle.c[2]
      ],
      1 / 3
    );
    return {
      ...triangle,
      normal,
      centroid,
      area
    };
  });

  const normalizedBounds = bboxFromPoints(normalizedPoints);
  const meshVolume = meshVolumeFromTriangles(normalizedRawTriangles);

  return {
    propId,
    sourceBounds: {
      width: sourceBounds.size[0],
      height: sourceBounds.size[1],
      depth: sourceBounds.size[2],
      longestAxis: Math.max(sourceBounds.size[0], sourceBounds.size[1], sourceBounds.size[2])
    },
    transform,
    bbox: normalizedBounds,
    points: normalizedPoints,
    triangles: normalizedTriangles,
    triangleCount: normalizedRawTriangles.length,
    pointCount: normalizedPoints.length,
    meshVolume,
    sampleSignature: [
      propId,
      normalizedRawTriangles.length,
      normalizedPoints.length,
      toFixedNumber(normalizedBounds.size[0], 4),
      toFixedNumber(normalizedBounds.size[1], 4),
      toFixedNumber(normalizedBounds.size[2], 4),
      toFixedNumber(meshVolume, 5)
    ].join(":")
  };
}

export function applyNormalizationTransform(
  root: THREE.Object3D,
  transform: NormalizationTransform
): void {
  root.position.set(
    root.position.x - transform.offset[0],
    root.position.y - transform.offset[1],
    root.position.z - transform.offset[2]
  );
  root.scale.multiplyScalar(transform.scale);
  root.updateMatrixWorld(true);
}

