import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { generateCollider } from "./api";

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

    expect(result.rapier.parts.length).toBeGreaterThanOrEqual(3);
    expect(result.rapier.parts.length).toBeLessThanOrEqual(8);

    const maxHorizontalSpan = Math.max(
      ...result.rapier.parts.map((part) => Math.max(part.halfExtents[0], part.halfExtents[2]) * 2)
    );
    const tallSupports = result.rapier.parts.filter((part) => part.halfExtents[1] * 2 > 0.3);
    const spreadX =
      Math.max(...result.rapier.parts.map((part) => part.position[0])) -
      Math.min(...result.rapier.parts.map((part) => part.position[0]));
    const spreadZ =
      Math.max(...result.rapier.parts.map((part) => part.position[2])) -
      Math.min(...result.rapier.parts.map((part) => part.position[2]));

    expect(maxHorizontalSpan).toBeGreaterThan(0.7);
    expect(tallSupports.length).toBeGreaterThanOrEqual(2);
    expect(Math.max(spreadX, spreadZ)).toBeGreaterThan(0.45);
    expect(result.metrics.planarity).toBeGreaterThan(0.4);
    expect(result.quality.error.outsideRatio).toBeLessThan(0.2);
  });

  it("keeps near-spherical meshes on the furniture strategy path", () => {
    const geometry = new THREE.SphereGeometry(0.45, 20, 16);
    const result = generateCollider(geometry, {
      mode: "dynamic",
      budget: "strict"
    });

    expect(result.rapier.type).toBe("compound");
    expect(
      result.quality.selectedStrategy === "boxy-furniture" ||
        result.quality.selectedStrategy === "concave-furniture"
    ).toBe(true);
    expect(
      result.quality.attemptedStrategies.every(
        (kind) => kind === "boxy-furniture" || kind === "concave-furniture"
      )
    ).toBe(true);
    expect(result.quality.error.outsideRatio).toBeLessThan(0.35);
    expect(result.quality.partCount).toBeGreaterThanOrEqual(1);
  });
});
