import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { generateCollider } from "./api";
import type { RapierCompoundPart } from "./types";

function geometryToNonIndexedPositions(geometry: THREE.BufferGeometry): number[] {
  const nonIndexed = geometry.toNonIndexed();
  const position = nonIndexed.getAttribute("position");
  if (!(position instanceof THREE.BufferAttribute)) {
    return [];
  }

  const values: number[] = [];
  for (let i = 0; i < position.count; i += 1) {
    values.push(position.getX(i), position.getY(i), position.getZ(i));
  }
  return values;
}

function buildCompositeGeometry(parts: Array<{
  size: [number, number, number];
  position: [number, number, number];
}>): THREE.BufferGeometry {
  const values: number[] = [];

  for (const part of parts) {
    const box = new THREE.BoxGeometry(part.size[0], part.size[1], part.size[2]);
    box.translate(part.position[0], part.position[1], part.position[2]);
    values.push(...geometryToNonIndexedPositions(box));
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(values, 3));
  return geometry;
}

function buildDeskGeometry(): THREE.BufferGeometry {
  return buildCompositeGeometry([
    {
      size: [1.6, 0.1, 0.9],
      position: [0, 0.77, 0]
    },
    {
      size: [0.18, 0.72, 0.9],
      position: [-0.71, 0.36, 0]
    },
    {
      size: [0.18, 0.72, 0.9],
      position: [0.71, 0.36, 0]
    }
  ]);
}

function mergeParts(parts: readonly RapierCompoundPart[]): RapierCompoundPart | null {
  if (parts.length <= 0) {
    return null;
  }

  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let minZ = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  let maxZ = Number.NEGATIVE_INFINITY;

  for (const part of parts) {
    const [px, py, pz] = part.position;
    const [hx, hy, hz] = part.halfExtents;
    minX = Math.min(minX, px - hx);
    minY = Math.min(minY, py - hy);
    minZ = Math.min(minZ, pz - hz);
    maxX = Math.max(maxX, px + hx);
    maxY = Math.max(maxY, py + hy);
    maxZ = Math.max(maxZ, pz + hz);
  }

  return {
    kind: "box",
    position: [(minX + maxX) * 0.5, (minY + maxY) * 0.5, (minZ + maxZ) * 0.5],
    halfExtents: [(maxX - minX) * 0.5, (maxY - minY) * 0.5, (maxZ - minZ) * 0.5]
  };
}

function classifyDeskParts(parts: readonly RapierCompoundPart[]): {
  top: RapierCompoundPart | null;
  left: RapierCompoundPart | null;
  right: RapierCompoundPart | null;
  axis: "x" | "z" | null;
} {
  if (parts.length < 3) {
    return { top: null, left: null, right: null, axis: null };
  }

  const top = [...parts].sort(
    (a, b) =>
      b.position[1] + b.halfExtents[1] - (a.position[1] + a.halfExtents[1])
  )[0];
  const remainder = parts.filter((part) => part !== top);
  if (!top || remainder.length < 2) {
    return { top: null, left: null, right: null, axis: null };
  }

  let bestAxis: "x" | "z" = "x";
  let bestSpread = Number.NEGATIVE_INFINITY;
  for (const axis of ["x", "z"] as const) {
    const values = remainder.map((part) => (axis === "x" ? part.position[0] : part.position[2]));
    const spread = Math.max(...values) - Math.min(...values);
    if (spread > bestSpread) {
      bestSpread = spread;
      bestAxis = axis;
    }
  }

  const sorted = [...remainder].sort((a, b) =>
    bestAxis === "x" ? a.position[0] - b.position[0] : a.position[2] - b.position[2]
  );
  const left = mergeParts(sorted.slice(0, Math.floor(sorted.length * 0.5)));
  const right = mergeParts(sorted.slice(Math.floor(sorted.length * 0.5)));
  return {
    top,
    left,
    right,
    axis: left && right ? bestAxis : null
  };
}

describe("auto-collider generateCollider", () => {
  it("is deterministic for identical geometry and options", () => {
    const geometry = buildDeskGeometry();

    const first = generateCollider(geometry, {
      mode: "dynamic",
      budget: "strict"
    });
    const second = generateCollider(geometry, {
      mode: "dynamic",
      budget: "strict"
    });

    expect(first.quality.signature).toBe(second.quality.signature);
    expect(first.quality.selectedStrategy).toBe(second.quality.selectedStrategy);
  });

  it("keeps desk-like concavity as a dynamic-safe compound collider", () => {
    const geometry = buildDeskGeometry();
    const result = generateCollider(geometry, {
      mode: "dynamic",
      budget: "strict"
    });

    expect(result.rapier.type).toBe("compound");
    if (result.rapier.type !== "compound") {
      return;
    }

    expect(result.rapier.parts.length).toBe(3);
    const desk = classifyDeskParts(result.rapier.parts);
    expect(desk.axis).toBe("x");
    expect(desk.top).toBeDefined();
    expect(desk.left).toBeDefined();
    expect(desk.right).toBeDefined();
    if (!desk.top || !desk.left || !desk.right) {
      return;
    }

    expect(desk.top.halfExtents[0]).toBeGreaterThan(0.65);
    expect(desk.top.halfExtents[2]).toBeGreaterThan(0.3);
    expect(desk.top.halfExtents[1]).toBeLessThan(0.12);
    expect(desk.left.position[0]).toBeLessThan(-0.2);
    expect(desk.right.position[0]).toBeGreaterThan(0.2);
    expect(Math.min(desk.left.halfExtents[1], desk.right.halfExtents[1])).toBeGreaterThan(0.2);
    expect(result.metrics.planarity).toBeGreaterThan(0.4);
    expect(result.quality.error.outsideRatio).toBeLessThan(0.2);
  });

  it("emits primitive colliders for near-spherical meshes", () => {
    const geometry = new THREE.SphereGeometry(0.45, 20, 16);
    const result = generateCollider(geometry, {
      mode: "dynamic",
      budget: "strict"
    });

    expect(result.rapier.type).not.toBe("trimesh");
    expect(result.quality.error.outsideRatio).toBeLessThan(0.15);
    expect(result.quality.partCount).toBeLessThanOrEqual(2);
  });
});
