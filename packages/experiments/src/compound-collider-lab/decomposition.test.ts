import { describe, expect, it } from "vitest";
import {
  fitCompoundBoxesHybrid,
  fitCompoundBoxesGlobal,
  type BoxPart,
  type Point3
} from "./decomposition";

function sampleFilledBox(
  min: Point3,
  max: Point3,
  step: number
): Point3[] {
  const points: Point3[] = [];
  for (let x = min.x; x <= max.x + 1e-6; x += step) {
    for (let y = min.y; y <= max.y + 1e-6; y += step) {
      for (let z = min.z; z <= max.z + 1e-6; z += step) {
        points.push({ x, y, z });
      }
    }
  }
  return points;
}

function makeSyntheticDeskPoints(): Point3[] {
  const top = sampleFilledBox(
    { x: -0.8, y: 0.72, z: -0.45 },
    { x: 0.8, y: 0.82, z: 0.45 },
    0.08
  );
  const leftLeg = sampleFilledBox(
    { x: -0.8, y: 0, z: -0.45 },
    { x: -0.62, y: 0.72, z: 0.45 },
    0.08
  );
  const rightLeg = sampleFilledBox(
    { x: 0.62, y: 0, z: -0.45 },
    { x: 0.8, y: 0.72, z: 0.45 },
    0.08
  );
  return [...top, ...leftLeg, ...rightLeg];
}

function sampleFilledBoxFromPose(
  center: [number, number, number],
  size: [number, number, number],
  step: number
): Point3[] {
  const halfX = size[0] * 0.5;
  const halfY = size[1] * 0.5;
  const halfZ = size[2] * 0.5;
  return sampleFilledBox(
    { x: center[0] - halfX, y: center[1] - halfY, z: center[2] - halfZ },
    { x: center[0] + halfX, y: center[1] + halfY, z: center[2] + halfZ },
    step
  );
}

function sampleSlopedPrism(step: number): Point3[] {
  const points: Point3[] = [];
  const minX = -0.14;
  const maxX = 0.14;
  const minZ = -0.22;
  const maxZ = 0.22;
  const minY = 0;
  const topAt = (z: number): number => {
    const t = (z - minZ) / (maxZ - minZ);
    return 0.55 + t * 0.36;
  };

  for (let x = minX; x <= maxX + 1e-6; x += step) {
    for (let z = minZ; z <= maxZ + 1e-6; z += step) {
      const top = topAt(z);
      for (let y = minY; y <= top + 1e-6; y += step) {
        points.push({ x, y, z });
      }
    }
  }
  return points;
}

function toFixed3(value: number): number {
  return Number(value.toFixed(3));
}

function expectNear(value: number, expected: number, tolerance: number): void {
  expect(Math.abs(value - expected)).toBeLessThanOrEqual(tolerance);
}

function mergeParts(parts: readonly BoxPart[], label: string): BoxPart | null {
  if (parts.length === 0) {
    return null;
  }

  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let minZ = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  let maxZ = Number.NEGATIVE_INFINITY;

  for (const part of parts) {
    minX = Math.min(minX, part.position[0] - part.halfExtents[0]);
    minY = Math.min(minY, part.position[1] - part.halfExtents[1]);
    minZ = Math.min(minZ, part.position[2] - part.halfExtents[2]);
    maxX = Math.max(maxX, part.position[0] + part.halfExtents[0]);
    maxY = Math.max(maxY, part.position[1] + part.halfExtents[1]);
    maxZ = Math.max(maxZ, part.position[2] + part.halfExtents[2]);
  }

  return {
    label,
    position: [(minX + maxX) * 0.5, (minY + maxY) * 0.5, (minZ + maxZ) * 0.5],
    halfExtents: [(maxX - minX) * 0.5, (maxY - minY) * 0.5, (maxZ - minZ) * 0.5]
  };
}

function classifyDeskLikeParts(parts: readonly BoxPart[]): {
  top: BoxPart | null;
  left: BoxPart | null;
  right: BoxPart | null;
  axis: "x" | "z" | null;
} {
  if (parts.length < 3) {
    return { top: null, left: null, right: null, axis: null };
  }

  const maxTopY = parts.reduce(
    (best, part) => Math.max(best, part.position[1] + part.halfExtents[1]),
    Number.NEGATIVE_INFINITY
  );
  const topParts = parts.filter(
    (part) => part.position[1] + part.halfExtents[1] >= maxTopY - 0.08
  );
  const top = mergeParts(topParts, "top");
  if (!top) {
    return { top: null, left: null, right: null, axis: null };
  }

  const topSet = new Set(topParts);
  const remainder = parts.filter((part) => !topSet.has(part));
  let bestI = 0;
  let bestJ = 1;
  let bestScore = -1;
  let bestAxis: "x" | "z" = "x";

  for (let i = 0; i < remainder.length; i += 1) {
    for (let j = i + 1; j < remainder.length; j += 1) {
      const dx = Math.abs(remainder[i].position[0] - remainder[j].position[0]);
      const dz = Math.abs(remainder[i].position[2] - remainder[j].position[2]);
      const axis = dx >= dz ? "x" : "z";
      const score = Math.max(dx, dz);
      if (score > bestScore) {
        bestScore = score;
        bestI = i;
        bestJ = j;
        bestAxis = axis;
      }
    }
  }

  const anchorA = remainder[bestI];
  const anchorB = remainder[bestJ];
  if (!anchorA || !anchorB) {
    return { top, left: null, right: null, axis: null };
  }

  const anchorValueA = bestAxis === "x" ? anchorA.position[0] : anchorA.position[2];
  const anchorValueB = bestAxis === "x" ? anchorB.position[0] : anchorB.position[2];
  const groupA: BoxPart[] = [];
  const groupB: BoxPart[] = [];
  for (const part of remainder) {
    const value = bestAxis === "x" ? part.position[0] : part.position[2];
    const distA = Math.abs(value - anchorValueA);
    const distB = Math.abs(value - anchorValueB);
    if (distA <= distB) {
      groupA.push(part);
    } else {
      groupB.push(part);
    }
  }

  const mergedA = mergeParts(groupA, "left");
  const mergedB = mergeParts(groupB, "right");
  if (!mergedA || !mergedB) {
    return { top, left: null, right: null, axis: bestAxis };
  }

  const mergedLeft =
    bestAxis === "x"
      ? mergedA.position[0] <= mergedB.position[0]
        ? mergedA
        : mergedB
      : mergedA.position[2] <= mergedB.position[2]
        ? mergedA
        : mergedB;
  const mergedRight = mergedLeft === mergedA ? mergedB : mergedA;
  return { top, left: mergedLeft, right: mergedRight, axis: bestAxis };
}

describe("compound-collider-lab desk decomposition", () => {
  it("extracts top slab plus two side legs for a desk-like point cloud", () => {
    const points = makeSyntheticDeskPoints();
    const result = fitCompoundBoxesHybrid(points);
    const deskView = classifyDeskLikeParts(result.parts);

    expect(result.parts.length).toBeGreaterThanOrEqual(3);
    expect(result.parts.length).toBeLessThanOrEqual(8);
    expect(deskView.axis).toBe("x");

    const top = deskView.top;
    const left = deskView.left;
    const right = deskView.right;

    expect(top).toBeDefined();
    expect(left).toBeDefined();
    expect(right).toBeDefined();

    if (!top || !left || !right) {
      return;
    }

    expect(top.halfExtents[0]).toBeGreaterThan(0.72);
    expect(top.halfExtents[2]).toBeGreaterThan(0.36);
    expect(top.position[1]).toBeGreaterThan(0.7);

    expect(left.position[0]).toBeLessThan(0);
    expect(right.position[0]).toBeGreaterThan(0);
    expect(right.position[0] - left.position[0]).toBeGreaterThan(0.6);
    expect(left.halfExtents[1]).toBeGreaterThan(0.28);
    expect(right.halfExtents[1]).toBeGreaterThan(0.28);
  });

  it("matches target desk collider profile close to the verified manual fit", () => {
    const targetTop = {
      pos: [0, 0.771, 0] as [number, number, number],
      size: [1.01, 0.171, 2.0] as [number, number, number]
    };
    const targetLeft = {
      pos: [0, 0.343, -0.944] as [number, number, number],
      size: [1.01, 0.686, 0.112] as [number, number, number]
    };
    const targetRight = {
      pos: [0, 0.343, 0.944] as [number, number, number],
      size: [1.01, 0.686, 0.112] as [number, number, number]
    };

    const points = [
      ...sampleFilledBoxFromPose(targetTop.pos, targetTop.size, 0.028),
      ...sampleFilledBoxFromPose(targetLeft.pos, targetLeft.size, 0.028),
      ...sampleFilledBoxFromPose(targetRight.pos, targetRight.size, 0.028)
    ];
    const result = fitCompoundBoxesHybrid(points);
    const deskView = classifyDeskLikeParts(result.parts);

    expect(result.parts.length).toBeGreaterThanOrEqual(3);
    expect(result.parts.length).toBeLessThanOrEqual(8);
    expect(deskView.axis).toBe("z");

    const top = deskView.top;
    const left = deskView.left;
    const right = deskView.right;
    expect(top).toBeDefined();
    expect(left).toBeDefined();
    expect(right).toBeDefined();
    if (!top || !left || !right) {
      return;
    }

    const topSize = top.halfExtents.map((value) => toFixed3(value * 2));
    const leftSize = left.halfExtents.map((value) => toFixed3(value * 2));
    const rightSize = right.halfExtents.map((value) => toFixed3(value * 2));

    expectNear(top.position[0], targetTop.pos[0], 0.06);
    expectNear(top.position[1], targetTop.pos[1], 0.08);
    expectNear(top.position[2], targetTop.pos[2], 0.06);
    expectNear(topSize[0], targetTop.size[0], 0.1);
    expectNear(topSize[1], targetTop.size[1], 0.09);
    expectNear(topSize[2], targetTop.size[2], 0.1);

    expectNear(left.position[2], targetLeft.pos[2], 0.08);
    expectNear(right.position[2], targetRight.pos[2], 0.08);
    expectNear(left.position[1], targetLeft.pos[1], 0.08);
    expectNear(right.position[1], targetRight.pos[1], 0.08);
    expectNear(leftSize[0], targetLeft.size[0], 0.1);
    expectNear(rightSize[0], targetRight.size[0], 0.1);
    expectNear(leftSize[1], targetLeft.size[1], 0.1);
    expectNear(rightSize[1], targetRight.size[1], 0.1);
    expectNear(leftSize[2], targetLeft.size[2], 0.06);
    expectNear(rightSize[2], targetRight.size[2], 0.06);
  });

  it("uses sloped corner-adjusted parts for wedge-like shapes", () => {
    const points = sampleSlopedPrism(0.025);
    const result = fitCompoundBoxesHybrid(points);

    expect(result.parts.length).toBeGreaterThanOrEqual(1);
    expect(result.parts.length).toBeLessThanOrEqual(6);
    expect(result.parts.some((part) => Array.isArray(part.corners))).toBe(true);
  });

  it("global beam search stays competitive with hybrid objective cost", () => {
    const points = sampleSlopedPrism(0.025);
    const hybrid = fitCompoundBoxesHybrid(points);
    const global = fitCompoundBoxesGlobal(points);

    expect(global.parts.length).toBeGreaterThanOrEqual(1);
    expect(global.parts.length).toBeLessThanOrEqual(8);
    expect(global.auto.finalCost).toBeLessThanOrEqual(hybrid.auto.finalCost + 6);
  });

  it("global frontier selection avoids over-splitting a desk profile", () => {
    const targetTop = {
      pos: [0, 0.771, 0] as [number, number, number],
      size: [1.01, 0.171, 2.0] as [number, number, number]
    };
    const targetLeft = {
      pos: [0, 0.343, -0.944] as [number, number, number],
      size: [1.01, 0.686, 0.112] as [number, number, number]
    };
    const targetRight = {
      pos: [0, 0.343, 0.944] as [number, number, number],
      size: [1.01, 0.686, 0.112] as [number, number, number]
    };

    const points = [
      ...sampleFilledBoxFromPose(targetTop.pos, targetTop.size, 0.028),
      ...sampleFilledBoxFromPose(targetLeft.pos, targetLeft.size, 0.028),
      ...sampleFilledBoxFromPose(targetRight.pos, targetRight.size, 0.028)
    ];
    const global = fitCompoundBoxesGlobal(points);
    const selectedCount = global.auto.selectedBoxCount ?? global.parts.length;

    expect(selectedCount).toBeGreaterThanOrEqual(3);
    expect(selectedCount).toBeLessThanOrEqual(6);
  });
});
