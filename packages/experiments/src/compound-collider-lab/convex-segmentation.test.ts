import { readFile } from "node:fs/promises";
import path from "node:path";
import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { segmentIntoConvexHulls } from "./convex-segmentation";

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

function disposeResultMeshes(result: ReturnType<typeof segmentIntoConvexHulls>): void {
  result.overlay.traverse((node) => {
    if (node instanceof THREE.Mesh) {
      node.geometry.dispose();
      node.material.dispose();
    }
  });
}

const PET_OPTIONS = {
  targetParts: 3,
  iterations: 10,
  maxSamplePoints: 5200,
  maxHullPoints: 420,
  minSplitImprovement: 0,
  minSplitImprovementAfterBase: 0,
  minClusterPoints: 32
} as const;

const PET_EXPECTED_SIGNATURE =
  "{\"cuts\":[0.1641,0.2578],\"parts\":[{\"centroid\":[-0.0468,0.3694,0.001],\"pointCount\":14640,\"hullPointCount\":420,\"vertices\":123,\"concavity\":0.5435},{\"centroid\":[-0.0602,0.2264,0.0036],\"pointCount\":17430,\"hullPointCount\":420,\"vertices\":77,\"concavity\":0.4583},{\"centroid\":[0.0658,0.0871,0.0124],\"pointCount\":30024,\"hullPointCount\":420,\"vertices\":119,\"concavity\":0.3715}]}";

describe("convex segmentation commodore PET regression", () => {
  it("keeps the current perfect 3-segment split for max-fit preset", async () => {
    const group = await loadGlbAsGroup(
      "assets/forge/props/commodore-pet-inspired-computer/processed/model.glb"
    );
    const resultA = segmentIntoConvexHulls(group, PET_OPTIONS);
    const resultB = segmentIntoConvexHulls(group, PET_OPTIONS);

    expect(resultA.parts.length).toBe(3);
    expect(resultA.sampledPoints).toBe(5200);
    expect(resultA.cutHeights.map((value) => Number(value.toFixed(4)))).toEqual([
      0.1641,
      0.2578
    ]);
    expect(resultA.signature).toBe(PET_EXPECTED_SIGNATURE);

    const sortedByLowY = resultA.parts.slice().sort((a, b) => a.yMin - b.yMin);
    const [bottom, middle, top] = sortedByLowY;
    expect(Math.abs(bottom.yMax - middle.yMin)).toBeLessThan(0.001);
    expect(Math.abs(middle.yMax - top.yMin)).toBeLessThan(0.001);
    expect(bottom.yMin).toBeLessThan(middle.yMin);
    expect(middle.yMin).toBeLessThan(top.yMin);

    // Determinism guard: same input/options must produce the same signature.
    expect(resultB.signature).toBe(resultA.signature);

    disposeResultMeshes(resultA);
    disposeResultMeshes(resultB);
  }, 20000);
});
