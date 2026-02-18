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

describe("auto-collider professional-workbench-chair", () => {
  it("avoids oversized bridge boxes over the seating bay", async () => {
    const group = await loadGlbAsGroup(
      "assets/forge/props/professional-workbench-chair/processed/model.glb"
    );
    const result = generateColliderFromObject(group, {
      mode: "dynamic",
      budget: "strict"
    });

    expect(result.rapier.type).toBe("compound");
    expect(result.quality.selectedStrategy).toBe("concave-furniture");
    expect(result.quality.error.overfillRatio).toBeLessThan(0.24);

    if (result.rapier.type !== "compound") {
      return;
    }

    expect(result.rapier.parts.length).toBeGreaterThanOrEqual(7);
    const hasSeatBridge = result.rapier.parts.some(
      (part) =>
        part.halfExtents[0] > 0.25 &&
        part.halfExtents[2] > 0.25 &&
        part.halfExtents[1] > 0.1 &&
        part.position[1] > 0.35 &&
        part.position[1] < 0.65
    );
    expect(hasSeatBridge).toBe(false);
  }, 20000);
});

