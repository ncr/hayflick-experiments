import * as THREE from "three";
import type { BBox } from "./dimensions";

export type ColliderType = "box" | "capsule" | "sphere" | "cylinder" | "convex-hull";

export interface ColliderParams {
  type: ColliderType;
  position: [number, number, number];
  params: Record<string, number>;
}

export function autoFitCollider(
  type: ColliderType,
  bbox: BBox
): ColliderParams {
  const cx = bbox.center.x;
  const cy = bbox.center.y;
  const cz = bbox.center.z;

  switch (type) {
    case "box":
      return {
        type: "box",
        position: [cx, cy, cz],
        params: {
          halfWidth: bbox.width / 2,
          halfHeight: bbox.height / 2,
          halfDepth: bbox.depth / 2,
        },
      };
    case "capsule": {
      const radius = Math.min(bbox.width, bbox.depth) / 2;
      const halfHeight = Math.max(0, bbox.height / 2 - radius);
      return {
        type: "capsule",
        position: [cx, cy, cz],
        params: { halfHeight, radius },
      };
    }
    case "sphere": {
      const r = Math.max(bbox.width, bbox.height, bbox.depth) / 2;
      return {
        type: "sphere",
        position: [cx, cy, cz],
        params: { radius: r },
      };
    }
    case "cylinder": {
      const rad = Math.max(bbox.width, bbox.depth) / 2;
      return {
        type: "cylinder",
        position: [cx, cy, cz],
        params: { halfHeight: bbox.height / 2, radius: rad },
      };
    }
    case "convex-hull":
      return {
        type: "convex-hull",
        position: [0, 0, 0],
        params: {},
      };
  }
}

export function createColliderHelper(
  collider: ColliderParams
): THREE.Object3D {
  const material = new THREE.MeshBasicMaterial({
    color: 0x44aaff,
    wireframe: true,
    transparent: true,
    opacity: 0.4,
  });

  let geometry: THREE.BufferGeometry;

  switch (collider.type) {
    case "box":
      geometry = new THREE.BoxGeometry(
        collider.params.halfWidth * 2,
        collider.params.halfHeight * 2,
        collider.params.halfDepth * 2
      );
      break;
    case "capsule":
      geometry = new THREE.CapsuleGeometry(
        collider.params.radius,
        collider.params.halfHeight * 2,
        8,
        16
      );
      break;
    case "sphere":
      geometry = new THREE.SphereGeometry(collider.params.radius, 16, 12);
      break;
    case "cylinder":
      geometry = new THREE.CylinderGeometry(
        collider.params.radius,
        collider.params.radius,
        collider.params.halfHeight * 2,
        16
      );
      break;
    case "convex-hull":
      // Convex hull uses mesh geometry directly; show nothing extra
      geometry = new THREE.BufferGeometry();
      break;
  }

  const mesh = new THREE.Mesh(geometry, material);
  mesh.position.set(
    collider.position[0],
    collider.position[1],
    collider.position[2]
  );
  mesh.name = "collider-helper";
  return mesh;
}
