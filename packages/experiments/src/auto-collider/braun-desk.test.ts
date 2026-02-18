import { readFile } from "node:fs/promises";
import path from "node:path";
import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { generateColliderFromObject } from "./api";

async function loadGlbAsGroup(relativePathFromRepoRoot: string): Promise<THREE.Group> {
  const globalScope = globalThis as unknown as {
    self?: unknown;
    createImageBitmap?: typeof globalThis.createImageBitmap;
  };
  if (typeof globalScope.self === "undefined") {
    globalScope.self = globalThis;
  }
  if (typeof globalScope.createImageBitmap === "undefined") {
    globalScope.createImageBitmap = (async () =>
      ({
        width: 1,
        height: 1,
        close() {
          // no-op shim for Node test runtime
        }
      }) as unknown as ImageBitmap) as typeof globalThis.createImageBitmap;
  }

  const filePath = path.resolve(process.cwd(), "..", "..", relativePathFromRepoRoot);
  const raw = await readFile(filePath);
  const arrayBuffer = raw.buffer.slice(
    raw.byteOffset,
    raw.byteOffset + raw.byteLength
  ) as ArrayBuffer;

  const loader = new GLTFLoader();
  return await new Promise<THREE.Group>((resolve, reject) => {
    loader.parse(
      arrayBuffer,
      "",
      (gltf) => resolve((gltf.scene ?? new THREE.Group()) as THREE.Group),
      (error) => reject(error)
    );
  });
}

describe("auto-collider braun inspired desk", () => {
  it("keeps a compound desk-like collider with preserved leg void", async () => {
    const group = await loadGlbAsGroup(
      "assets/forge/props/braun-inspired-desk/processed/model.glb"
    );
    const result = generateColliderFromObject(group, {
      mode: "dynamic",
      budget: "strict"
    });

    expect(result.quality.selectedStrategy).toBe("concave-furniture");
    expect(result.rapier.type).toBe("compound");
    expect(result.quality.error.outsideRatio).toBeLessThan(0.04);
    expect(result.quality.partCount).toBe(5);
    if (result.rapier.type !== "compound") {
      return;
    }

    const parts = result.rapier.parts;
    const topCandidate = parts
      .filter((part) => part.halfExtents[1] <= 0.13)
      .sort(
        (a, b) =>
          b.halfExtents[0] * b.halfExtents[2] -
          (a.halfExtents[0] * a.halfExtents[2])
      )[0];
    const top =
      topCandidate ??
      [...parts].sort(
        (a, b) =>
          b.position[1] + b.halfExtents[1] - (a.position[1] + a.halfExtents[1])
      )[0];
    expect(top).toBeDefined();
    if (!top) {
      return;
    }

    expect(top.halfExtents[1]).toBeLessThan(0.12);
    expect(top.halfExtents[0]).toBeGreaterThan(0.3);
    expect(top.halfExtents[2]).toBeGreaterThan(0.45);

    const lowerParts = parts.filter((part) => part !== top);
    expect(lowerParts.length).toBe(4);
    const sideSpans = lowerParts.map((part) => part.halfExtents[0] * 2);
    expect(Math.max(...sideSpans)).toBeGreaterThan(0.55);
  });
});
