import * as THREE from "three";
import type { Object3D } from "three";
import type { StyleGuide } from "../../forge-core/StyleGuidePanel";

export function slugifyPropId(description: string): string {
  return description
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

export function buildComposedPrompt(styleGuide: StyleGuide, description: string): string {
  return [
    styleGuide.prompt,
    description,
    "3/4 view, product shot, centered object, plain mid-gray background."
  ]
    .filter(Boolean)
    .join(" ");
}

export async function exportObjectToGlb(object: Object3D | Object3D[]): Promise<ArrayBuffer> {
  const { GLTFExporter } = await import("three/examples/jsm/exporters/GLTFExporter.js");
  const exporter = new GLTFExporter();

  const items = Array.isArray(object) ? object : [object];
  const baked = items.map((item) => bakeWorldTransforms(item));
  const exportTarget = baked.length === 1 ? baked[0] : baked;

  return new Promise<ArrayBuffer>((resolve, reject) => {
    exporter.parse(
      exportTarget,
      (result) => resolve(result as ArrayBuffer),
      reject,
      { binary: true }
    );
  });
}

function bakeWorldTransforms(root: Object3D): Object3D {
  const clone = root.clone(true);
  clone.updateMatrixWorld(true);

  clone.traverse((node) => {
    if (
      (node instanceof THREE.Mesh ||
        node instanceof THREE.Line ||
        node instanceof THREE.LineSegments) &&
      node.geometry
    ) {
      const geometry = node.geometry.clone();
      geometry.applyMatrix4(node.matrixWorld);
      node.geometry = geometry;
    }
  });

  clone.traverse((node) => {
    node.position.set(0, 0, 0);
    node.rotation.set(0, 0, 0);
    node.scale.set(1, 1, 1);
    node.updateMatrix();
  });
  clone.updateMatrixWorld(true);

  return clone;
}
