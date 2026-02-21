import * as THREE from "three";
import { describe, expect, it } from "vitest";
import {
  deserializeVhacdResult,
  disposeVhacdResult,
  extractVhacdSourceData,
  runVhacdFromSourceData,
  serializeVhacdResult
} from "./vhacd";

describe("vhacd api", () => {
  it("returns fallback output for invalid source data", async () => {
    const result = await runVhacdFromSourceData({
      positions: new Float32Array()
    });

    expect(result.hulls).toEqual([]);
    expect(result.signature).toBe("empty");
    disposeVhacdResult(result);
  });

  it("serializes and deserializes fallback output", async () => {
    const fallback = await runVhacdFromSourceData({
      positions: new Float32Array()
    });
    const serialized = serializeVhacdResult(fallback);
    const deserialized = deserializeVhacdResult(serialized);

    expect(deserialized.signature).toBe("empty");
    expect(deserialized.stats.sourceTriangleCount).toBe(0);
    disposeVhacdResult(fallback);
    disposeVhacdResult(deserialized);
  });

  it("extracts source triangles from object meshes", () => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial());
    const root = new THREE.Group();
    root.add(mesh);

    const data = extractVhacdSourceData(root);
    expect(data).not.toBeNull();
    expect((data?.positions.length ?? 0) % 9).toBe(0);

    mesh.geometry.dispose();
    if (Array.isArray(mesh.material)) {
      for (const material of mesh.material) {
        material.dispose();
      }
    } else {
      mesh.material.dispose();
    }
  });
});
