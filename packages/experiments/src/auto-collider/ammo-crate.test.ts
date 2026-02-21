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

function isContained(
  inner: { position: [number, number, number]; halfExtents: [number, number, number] },
  outer: { position: [number, number, number]; halfExtents: [number, number, number] }
): boolean {
  const epsilon = 0.0015;
  const innerMinX = inner.position[0] - inner.halfExtents[0];
  const innerMinY = inner.position[1] - inner.halfExtents[1];
  const innerMinZ = inner.position[2] - inner.halfExtents[2];
  const innerMaxX = inner.position[0] + inner.halfExtents[0];
  const innerMaxY = inner.position[1] + inner.halfExtents[1];
  const innerMaxZ = inner.position[2] + inner.halfExtents[2];

  const outerMinX = outer.position[0] - outer.halfExtents[0];
  const outerMinY = outer.position[1] - outer.halfExtents[1];
  const outerMinZ = outer.position[2] - outer.halfExtents[2];
  const outerMaxX = outer.position[0] + outer.halfExtents[0];
  const outerMaxY = outer.position[1] + outer.halfExtents[1];
  const outerMaxZ = outer.position[2] + outer.halfExtents[2];

  return (
    innerMinX >= outerMinX - epsilon &&
    innerMaxX <= outerMaxX + epsilon &&
    innerMinY >= outerMinY - epsilon &&
    innerMaxY <= outerMaxY + epsilon &&
    innerMinZ >= outerMinZ - epsilon &&
    innerMaxZ <= outerMaxZ + epsilon
  );
}

describe("auto-collider ammo-crate", () => {
  it("does not emit tiny boxes fully contained in the dominant body box", async () => {
    const group = await loadGlbAsGroup(
      "assets/forge/props/ammo-crate/processed/model.glb"
    );
    const result = generateColliderFromObject(group, {
      mode: "dynamic",
      budget: "strict",
      strategy: "concave-furniture"
    });

    expect(result.quality.selectedStrategy).toBe("concave-furniture");
    expect(result.rapier.type).toBe("compound");
    if (result.rapier.type !== "compound") {
      return;
    }

    expect(result.rapier.parts.length).toBeGreaterThanOrEqual(3);
    expect(result.rapier.parts.length).toBeLessThanOrEqual(8);

    for (let i = 0; i < result.rapier.parts.length; i += 1) {
      for (let j = 0; j < result.rapier.parts.length; j += 1) {
        if (i === j) {
          continue;
        }
        expect(isContained(result.rapier.parts[i], result.rapier.parts[j])).toBe(false);
      }
    }
  }, 20000);
});
