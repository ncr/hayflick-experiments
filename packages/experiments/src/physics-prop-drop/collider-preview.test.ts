import { describe, expect, it } from "vitest";
import * as THREE from "three";

import {
  createCompoundBoxPreview,
  createCompoundConvexHullPreview
} from "./collider-preview";

describe("physics-prop-drop collider preview", () => {
  it("builds colored convex hull preview groups per part", () => {
    const preview = createCompoundConvexHullPreview([
      {
        translation: { x: 1, y: 2, z: 3 },
        vertices: new Float32Array([
          -1, 0, 0,
          1, 0, 0,
          0, 1, 0,
          0, 0, 1
        ])
      }
    ]);

    expect(preview.children).toHaveLength(1);
    const partGroup = preview.children[0] as THREE.Group;
    expect(partGroup.position.toArray()).toEqual([1, 2, 3]);
    expect(partGroup.children).toHaveLength(2);
    expect(partGroup.getObjectByName("collider-preview-hull-fill-1")).toBeTruthy();
    expect(partGroup.getObjectByName("collider-preview-hull-edges-1")).toBeTruthy();
  });

  it("builds wireframe box preview meshes per part", () => {
    const preview = createCompoundBoxPreview([
      {
        translation: { x: 0, y: 0.5, z: 0 },
        halfExtents: { x: 1, y: 2, z: 3 }
      },
      {
        translation: { x: 4, y: 5, z: 6 },
        halfExtents: { x: 0.5, y: 0.5, z: 0.5 }
      }
    ]);

    expect(preview.children).toHaveLength(2);
    const first = preview.children[0] as THREE.Mesh;
    expect(first.position.toArray()).toEqual([0, 0.5, 0]);
    expect(first.name).toBe("collider-preview-box-part-1");
  });
});
