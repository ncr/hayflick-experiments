import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { prepareImportedObjectShadows } from "./shadow-utils";

describe("physics-prop-drop shadow utils", () => {
  it("preserves authored material sides for shadow casting", () => {
    const material = new THREE.MeshStandardMaterial({ side: THREE.DoubleSide });
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), material);

    prepareImportedObjectShadows(mesh);

    expect(mesh.castShadow).toBe(true);
    expect(mesh.receiveShadow).toBe(true);
    expect(material.side).toBe(THREE.DoubleSide);
    expect(material.shadowSide).toBe(THREE.DoubleSide);
  });

  it("preserves unlit materials instead of replacing them", () => {
    const material = new THREE.MeshBasicMaterial({
      color: 0x336699,
      transparent: true,
      opacity: 0.45,
      side: THREE.FrontSide,
      alphaTest: 0.2
    });
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), material);

    prepareImportedObjectShadows(mesh);

    expect(mesh.material).toBe(material);
    if (!(mesh.material instanceof THREE.MeshBasicMaterial)) {
      throw new Error("expected MeshBasicMaterial");
    }
    expect(mesh.material.color.getHex()).toBe(0x336699);
    expect(mesh.material.transparent).toBe(true);
    expect(mesh.material.opacity).toBeCloseTo(0.45);
    expect(mesh.material.alphaTest).toBeCloseTo(0.2);
    expect(mesh.material.side).toBe(THREE.FrontSide);
    expect(mesh.material.shadowSide).toBe(THREE.FrontSide);
  });

  it("generates normals for imported meshes that do not include them", () => {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute(
      "position",
      new THREE.Float32BufferAttribute(
        [
          0, 0, 0,
          1, 0, 0,
          0, 1, 0,
          1, 0, 0,
          1, 1, 0,
          0, 1, 0
        ],
        3
      )
    );
    const mesh = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial());

    prepareImportedObjectShadows(mesh);

    expect(mesh.geometry.getAttribute("normal")).toBeDefined();
    expect(mesh.geometry.boundingSphere).not.toBeNull();
  });
});
