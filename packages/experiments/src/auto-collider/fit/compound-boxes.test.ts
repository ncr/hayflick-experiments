import { describe, expect, it } from "vitest";
import { fitCompoundBoxesHybrid, type BoxPart, type Point3 } from "./compound-boxes";

function sampleFilledBox(min: Point3, max: Point3, step: number): Point3[] {
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

function mergedBounds(parts: readonly BoxPart[]) {
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

  return { minX, minY, minZ, maxX, maxY, maxZ };
}

describe("auto-collider compound-box fitter", () => {
  it("fits a simple filled cuboid without losing coverage", () => {
    const sourceMin = { x: -0.6, y: 0.1, z: -0.3 };
    const sourceMax = { x: 0.6, y: 0.9, z: 0.3 };
    const points = sampleFilledBox(sourceMin, sourceMax, 0.08);

    const fit = fitCompoundBoxesHybrid(points);

    expect(fit.parts.length).toBeGreaterThan(0);
    expect(fit.parts.length).toBeLessThanOrEqual(10);
    for (const part of fit.parts) {
      expect(part.halfExtents[0]).toBeGreaterThan(0);
      expect(part.halfExtents[1]).toBeGreaterThan(0);
      expect(part.halfExtents[2]).toBeGreaterThan(0);
    }

    const bounds = mergedBounds(fit.parts);
    expect(Math.abs(bounds.minX - sourceMin.x)).toBeLessThanOrEqual(0.12);
    expect(Math.abs(bounds.minY - sourceMin.y)).toBeLessThanOrEqual(0.12);
    expect(Math.abs(bounds.minZ - sourceMin.z)).toBeLessThanOrEqual(0.12);
    expect(Math.abs(bounds.maxX - sourceMax.x)).toBeLessThanOrEqual(0.12);
    expect(Math.abs(bounds.maxY - sourceMax.y)).toBeLessThanOrEqual(0.12);
    expect(Math.abs(bounds.maxZ - sourceMax.z)).toBeLessThanOrEqual(0.12);
  });
});
