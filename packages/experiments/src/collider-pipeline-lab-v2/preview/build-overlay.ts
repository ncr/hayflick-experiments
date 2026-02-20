import * as THREE from "three";
import type { ColliderPart } from "../types";

export function buildColliderOverlay(
  parts: ColliderPart[],
  color = 0x3bd1ff
): THREE.Group {
  const group = new THREE.Group();
  group.name = "collider-overlay";

  const fillMaterial = new THREE.MeshStandardMaterial({
    color,
    transparent: true,
    opacity: 0.14,
    roughness: 0.35,
    metalness: 0.02,
    depthWrite: false
  });
  const lineMaterial = new THREE.LineBasicMaterial({
    color,
    transparent: true,
    opacity: 0.95
  });

  for (let i = 0; i < parts.length; i += 1) {
    const part = parts[i];
    const geometry = new THREE.BoxGeometry(1, 1, 1);
    const mesh = new THREE.Mesh(geometry, fillMaterial.clone());
    mesh.name = `collider-part-fill-${i + 1}`;
    mesh.position.set(part.position[0], part.position[1], part.position[2]);
    mesh.quaternion.set(
      part.rotation[0],
      part.rotation[1],
      part.rotation[2],
      part.rotation[3]
    );
    mesh.scale.set(
      part.halfExtents[0] * 2,
      part.halfExtents[1] * 2,
      part.halfExtents[2] * 2
    );
    mesh.renderOrder = 20;
    group.add(mesh);

    const wireframe = new THREE.LineSegments(
      new THREE.EdgesGeometry(geometry),
      lineMaterial.clone()
    );
    wireframe.name = `collider-part-wire-${i + 1}`;
    wireframe.position.copy(mesh.position);
    wireframe.quaternion.copy(mesh.quaternion);
    wireframe.scale.copy(mesh.scale);
    wireframe.renderOrder = 21;
    group.add(wireframe);
  }

  return group;
}

export function disposeOverlay(root: THREE.Object3D): void {
  root.traverse((node) => {
    if (node instanceof THREE.Mesh || node instanceof THREE.LineSegments) {
      node.geometry.dispose();
      const material = node.material;
      if (Array.isArray(material)) {
        for (const entry of material) {
          entry.dispose();
        }
      } else {
        material.dispose();
      }
    }
  });
}

