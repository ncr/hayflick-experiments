import type { NormalizedProp, SampleTriangle, Vec3Tuple } from "./types";
import { cross3, dot3, normalize3, sub3 } from "./pipeline/math";

type Cuboid = {
  min: Vec3Tuple;
  max: Vec3Tuple;
};

function cubeTriangles(cuboid: Cuboid): {
  points: Vec3Tuple[];
  triangles: SampleTriangle[];
} {
  const [minX, minY, minZ] = cuboid.min;
  const [maxX, maxY, maxZ] = cuboid.max;
  const v: Vec3Tuple[] = [
    [minX, minY, minZ],
    [maxX, minY, minZ],
    [maxX, maxY, minZ],
    [minX, maxY, minZ],
    [minX, minY, maxZ],
    [maxX, minY, maxZ],
    [maxX, maxY, maxZ],
    [minX, maxY, maxZ]
  ];

  const faces: Array<[number, number, number]> = [
    [0, 1, 2],
    [0, 2, 3],
    [4, 6, 5],
    [4, 7, 6],
    [0, 4, 5],
    [0, 5, 1],
    [1, 5, 6],
    [1, 6, 2],
    [2, 6, 7],
    [2, 7, 3],
    [3, 7, 4],
    [3, 4, 0]
  ];

  const points: Vec3Tuple[] = [];
  const triangles: SampleTriangle[] = [];
  for (const [ia, ib, ic] of faces) {
    const a = v[ia];
    const b = v[ib];
    const c = v[ic];
    const ab = sub3(b, a);
    const ac = sub3(c, a);
    const cross = cross3(ab, ac);
    const area = 0.5 * Math.sqrt(dot3(cross, cross));
    const normal = normalize3(cross);
    const centroid: Vec3Tuple = [
      (a[0] + b[0] + c[0]) / 3,
      (a[1] + b[1] + c[1]) / 3,
      (a[2] + b[2] + c[2]) / 3
    ];
    triangles.push({
      a,
      b,
      c,
      normal,
      centroid,
      area
    });
    points.push(a, b, c);
  }

  return { points, triangles };
}

function volumeOfCuboid(cuboid: Cuboid): number {
  return Math.max(
    0,
    (cuboid.max[0] - cuboid.min[0]) *
      (cuboid.max[1] - cuboid.min[1]) *
      (cuboid.max[2] - cuboid.min[2])
  );
}

export function buildCuboidProp(
  propId: string,
  cuboids: Cuboid[],
  sourceLongestAxis = 1
): NormalizedProp {
  const points: Vec3Tuple[] = [];
  const triangles: SampleTriangle[] = [];
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let minZ = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  let maxZ = Number.NEGATIVE_INFINITY;
  let meshVolume = 0;

  for (const cuboid of cuboids) {
    const generated = cubeTriangles(cuboid);
    points.push(...generated.points);
    triangles.push(...generated.triangles);
    minX = Math.min(minX, cuboid.min[0]);
    minY = Math.min(minY, cuboid.min[1]);
    minZ = Math.min(minZ, cuboid.min[2]);
    maxX = Math.max(maxX, cuboid.max[0]);
    maxY = Math.max(maxY, cuboid.max[1]);
    maxZ = Math.max(maxZ, cuboid.max[2]);
    meshVolume += volumeOfCuboid(cuboid);
  }

  const width = maxX - minX;
  const height = maxY - minY;
  const depth = maxZ - minZ;
  return {
    propId,
    sourceBounds: {
      width,
      height,
      depth,
      longestAxis: sourceLongestAxis
    },
    transform: {
      offset: [0, 0, 0],
      scale: 1
    },
    bbox: {
      min: [minX, minY, minZ],
      max: [maxX, maxY, maxZ],
      size: [width, height, depth],
      center: [(minX + maxX) * 0.5, (minY + maxY) * 0.5, (minZ + maxZ) * 0.5],
      volume: width * height * depth
    },
    points,
    triangles,
    triangleCount: triangles.length,
    pointCount: points.length,
    meshVolume,
    sampleSignature: `${propId}:${triangles.length}:${points.length}`
  };
}

export function makeSimpleBoxProp(propId: string): NormalizedProp {
  return buildCuboidProp(propId, [
    {
      min: [-0.5, 0, -0.3],
      max: [0.5, 1, 0.3]
    }
  ]);
}

export function makeDeskLikeProp(propId: string): NormalizedProp {
  return buildCuboidProp(propId, [
    {
      min: [-0.55, 0.62, -0.35],
      max: [0.55, 0.75, 0.35]
    },
    {
      min: [-0.5, 0, -0.3],
      max: [-0.32, 0.62, 0.3]
    },
    {
      min: [0.32, 0, -0.3],
      max: [0.5, 0.62, 0.3]
    }
  ]);
}

export function makeTallLampLikeProp(propId: string): NormalizedProp {
  return buildCuboidProp(propId, [
    {
      min: [-0.08, 0, -0.08],
      max: [0.08, 1.4, 0.08]
    },
    {
      min: [-0.28, 1.3, -0.28],
      max: [0.28, 1.55, 0.28]
    }
  ]);
}

