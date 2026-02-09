import { describe, expect, it } from "vitest";
import * as THREE from "three";
import {
  CAMERA_DISTANCE,
  CAMERA_PITCH,
  CAMERA_YAW,
  FIXED_RENDER_HEIGHT,
  FIXED_RENDER_WIDTH,
  ORTHO_HEIGHT
} from "./config";

function projectToPixels(camera: THREE.OrthographicCamera, v: THREE.Vector3) {
  const p = v.clone().project(camera);
  const x = (p.x * 0.5 + 0.5) * FIXED_RENDER_WIDTH;
  const y = (1 - (p.y * 0.5 + 0.5)) * FIXED_RENDER_HEIGHT;
  return new THREE.Vector2(x, y);
}

function createCamera() {
  const aspect = FIXED_RENDER_WIDTH / FIXED_RENDER_HEIGHT;
  const halfHeight = ORTHO_HEIGHT * 0.5;
  const camera = new THREE.OrthographicCamera(
    -halfHeight * aspect,
    halfHeight * aspect,
    halfHeight,
    -halfHeight,
    0.1,
    200
  );

  const horizontal = Math.cos(CAMERA_PITCH);
  const dir = new THREE.Vector3(
    Math.sin(CAMERA_YAW) * horizontal,
    Math.sin(CAMERA_PITCH),
    Math.cos(CAMERA_YAW) * horizontal
  );
  const target = new THREE.Vector3(0, 0, 0);
  camera.position.copy(target).addScaledVector(dir, CAMERA_DISTANCE);
  camera.lookAt(target);
  camera.updateProjectionMatrix();
  camera.updateMatrixWorld();
  return camera;
}

function rasterizeLine(
  x0: number,
  y0: number,
  x1: number,
  y1: number
): Array<{ x: number; y: number }> {
  const points: Array<{ x: number; y: number }> = [];

  let px = x0;
  let py = y0;
  const dx = Math.abs(x1 - x0);
  const dy = Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1;
  const sy = y0 < y1 ? 1 : -1;
  let err = dx - dy;

  while (true) {
    points.push({ x: px, y: py });
    if (px === x1 && py === y1) {
      break;
    }

    const e2 = err * 2;
    if (e2 > -dy) {
      err -= dy;
      px += sx;
    }
    if (e2 < dx) {
      err += dx;
      py += sy;
    }
  }

  return points;
}

function assertTwoToOneStaircaseByRows(
  points: Array<{ x: number; y: number }>,
  minRows = 8
) {
  const rows = new Map<number, number[]>();
  for (const point of points) {
    const xs = rows.get(point.y);
    if (xs) {
      xs.push(point.x);
    } else {
      rows.set(point.y, [point.x]);
    }
  }

  const sorted = [...rows.entries()].sort((a, b) => a[0] - b[0]);
  expect(sorted.length).toBeGreaterThan(minRows);

  for (let i = 0; i < sorted.length; i += 1) {
    const xs = sorted[i][1].sort((a, b) => a - b);
    const isEndpointRow = i === 0 || i === sorted.length - 1;
    const expectedCount = isEndpointRow ? [1, 2] : [2];
    expect(expectedCount.includes(xs.length)).toBe(true);

    if (xs.length === 2) {
      expect(xs[1] - xs[0]).toBe(1);
    }
  }
}

type EdgeDef = {
  a: number;
  b: number;
  n1: THREE.Vector3;
  n2: THREE.Vector3;
};

const UNIT_CUBE_VERTICES = [
  new THREE.Vector3(-0.5, -0.5, -0.5),
  new THREE.Vector3(0.5, -0.5, -0.5),
  new THREE.Vector3(0.5, 0.5, -0.5),
  new THREE.Vector3(-0.5, 0.5, -0.5),
  new THREE.Vector3(-0.5, -0.5, 0.5),
  new THREE.Vector3(0.5, -0.5, 0.5),
  new THREE.Vector3(0.5, 0.5, 0.5),
  new THREE.Vector3(-0.5, 0.5, 0.5)
] as const;

const UNIT_CUBE_EDGES: EdgeDef[] = [
  { a: 0, b: 1, n1: new THREE.Vector3(0, -1, 0), n2: new THREE.Vector3(0, 0, -1) },
  { a: 1, b: 2, n1: new THREE.Vector3(1, 0, 0), n2: new THREE.Vector3(0, 0, -1) },
  { a: 2, b: 3, n1: new THREE.Vector3(0, 1, 0), n2: new THREE.Vector3(0, 0, -1) },
  { a: 3, b: 0, n1: new THREE.Vector3(-1, 0, 0), n2: new THREE.Vector3(0, 0, -1) },
  { a: 4, b: 5, n1: new THREE.Vector3(0, -1, 0), n2: new THREE.Vector3(0, 0, 1) },
  { a: 5, b: 6, n1: new THREE.Vector3(1, 0, 0), n2: new THREE.Vector3(0, 0, 1) },
  { a: 6, b: 7, n1: new THREE.Vector3(0, 1, 0), n2: new THREE.Vector3(0, 0, 1) },
  { a: 7, b: 4, n1: new THREE.Vector3(-1, 0, 0), n2: new THREE.Vector3(0, 0, 1) },
  { a: 0, b: 4, n1: new THREE.Vector3(-1, 0, 0), n2: new THREE.Vector3(0, -1, 0) },
  { a: 1, b: 5, n1: new THREE.Vector3(1, 0, 0), n2: new THREE.Vector3(0, -1, 0) },
  { a: 2, b: 6, n1: new THREE.Vector3(1, 0, 0), n2: new THREE.Vector3(0, 1, 0) },
  { a: 3, b: 7, n1: new THREE.Vector3(-1, 0, 0), n2: new THREE.Vector3(0, 1, 0) }
];

function isVerticalWorldEdge(a: THREE.Vector3, b: THREE.Vector3) {
  const d = b.clone().sub(a);
  return Math.abs(d.x) < 1e-9 && Math.abs(d.z) < 1e-9 && Math.abs(d.y) > 0;
}

function silhouetteEdgesForUnitCube(center: THREE.Vector3, viewDir: THREE.Vector3): Array<{ a: THREE.Vector3; b: THREE.Vector3 }> {
  const vertices = UNIT_CUBE_VERTICES.map((v) => v.clone().add(center));
  const eps = 1e-9;
  const edges: Array<{ a: THREE.Vector3; b: THREE.Vector3 }> = [];

  for (const edge of UNIT_CUBE_EDGES) {
    const d1 = edge.n1.dot(viewDir);
    const d2 = edge.n2.dot(viewDir);
    const isSilhouette = (d1 > eps && d2 < -eps) || (d1 < -eps && d2 > eps);
    if (!isSilhouette) {
      continue;
    }

    const a = vertices[edge.a];
    const b = vertices[edge.b];
    if (isVerticalWorldEdge(a, b)) {
      continue;
    }

    edges.push({ a, b });
  }

  return edges;
}

describe("pixel-perfect-2to1", () => {
  it("projects unit steps to a 2:1 pixel ratio with integer steps", () => {
    const camera = createCamera();

    const origin = projectToPixels(camera, new THREE.Vector3(0, 0, 0));
    const stepX = projectToPixels(camera, new THREE.Vector3(1, 0, 0));
    const stepZ = projectToPixels(camera, new THREE.Vector3(0, 0, 1));

    const dx = stepX.clone().sub(origin);
    const dz = stepZ.clone().sub(origin);

    const ratioX = Math.abs(dx.x / dx.y);
    const ratioZ = Math.abs(dz.x / dz.y);

    expect(ratioX).toBeCloseTo(2, 6);
    expect(ratioZ).toBeCloseTo(2, 6);

    const absDx = Math.abs(dx.x);
    const absDy = Math.abs(dx.y);
    expect(absDx).toBeCloseTo(Math.round(absDx), 6);
    expect(absDy).toBeCloseTo(Math.round(absDy), 6);

    expect(absDx).toBeCloseTo(32, 6);
    expect(absDy).toBeCloseTo(16, 6);
  });

  it("keeps long perpendicular world-axis lines as strict 2:1 staircases in pixel space", () => {
    const camera = createCamera();
    const lines = [
      {
        start: projectToPixels(camera, new THREE.Vector3(-7, 0, 0)),
        end: projectToPixels(camera, new THREE.Vector3(7, 0, 0))
      },
      {
        start: projectToPixels(camera, new THREE.Vector3(0, 0, -7)),
        end: projectToPixels(camera, new THREE.Vector3(0, 0, 7))
      }
    ];

    for (const line of lines) {
      const screenSpan = Math.abs(line.end.x - line.start.x);
      expect(screenSpan).toBeGreaterThan(FIXED_RENDER_WIDTH * 0.9);

      const rasterized = rasterizeLine(
        Math.round(line.start.x),
        Math.round(line.start.y),
        Math.round(line.end.x),
        Math.round(line.end.y)
      );

      for (let i = 1; i < rasterized.length; i += 1) {
        const dx = Math.abs(rasterized[i].x - rasterized[i - 1].x);
        const dy = Math.abs(rasterized[i].y - rasterized[i - 1].y);
        expect(dx <= 1 && dy <= 1 && (dx !== 0 || dy !== 0)).toBe(true);
      }

      assertTwoToOneStaircaseByRows(rasterized, 20);
    }
  });

  it("keeps non-vertical silhouette edges of 1x1x1 cubes on a 2:1 staircase", () => {
    const camera = createCamera();
    const viewDir = camera.getWorldDirection(new THREE.Vector3()).clone().normalize();
    const cubeCenters = [
      new THREE.Vector3(-3, 0.5, -2),
      new THREE.Vector3(-1, 0.5, 2),
      new THREE.Vector3(2, 0.5, -1),
      new THREE.Vector3(3, 0.5, 3)
    ];

    let checkedEdges = 0;
    for (const center of cubeCenters) {
      const silhouetteEdges = silhouetteEdgesForUnitCube(center, viewDir);
      expect(silhouetteEdges.length).toBeGreaterThan(0);

      for (const edge of silhouetteEdges) {
        const start = projectToPixels(camera, edge.a);
        const end = projectToPixels(camera, edge.b);
        const rasterized = rasterizeLine(
          Math.round(start.x),
          Math.round(start.y),
          Math.round(end.x),
          Math.round(end.y)
        );

        expect(Math.abs(end.y - start.y)).toBeGreaterThan(8);
        assertTwoToOneStaircaseByRows(rasterized, 10);
        checkedEdges += 1;
      }
    }

    expect(checkedEdges).toBeGreaterThan(8);
  });
});
