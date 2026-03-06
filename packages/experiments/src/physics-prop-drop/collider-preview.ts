import * as THREE from "three";
import { ConvexGeometry } from "three/examples/jsm/geometries/ConvexGeometry.js";

import type {
  Physics3dBoxPart,
  Physics3dConvexHullPart
} from "../prop-physics-3d/game-physics-3d";

function colorForIndex(index: number): THREE.Color {
  const hue = ((index * 137.508) % 360) / 360;
  return new THREE.Color().setHSL(hue, 0.68, 0.56);
}

function createHullFillMaterial(color: THREE.Color): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({
    color,
    roughness: 0.58,
    metalness: 0.06,
    transparent: true,
    opacity: 0.48,
    side: THREE.DoubleSide,
    depthWrite: false
  });
}

function createEdgeMaterial(): THREE.LineBasicMaterial {
  return new THREE.LineBasicMaterial({
    color: 0xffffff,
    transparent: true,
    opacity: 0.65
  });
}

function createBoxMaterial(): THREE.MeshBasicMaterial {
  return new THREE.MeshBasicMaterial({
    color: 0x31d7ff,
    wireframe: true,
    transparent: true,
    opacity: 0.42,
    depthWrite: false,
    depthTest: false,
    toneMapped: false
  });
}

export function createCompoundConvexHullPreview(
  parts: Physics3dConvexHullPart[]
): THREE.Group {
  const group = new THREE.Group();
  group.name = "collider-preview-compound-convex-hulls";

  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index];
    const points: THREE.Vector3[] = [];
    for (let i = 0; i < part.vertices.length; i += 3) {
      points.push(
        new THREE.Vector3(
          part.vertices[i],
          part.vertices[i + 1],
          part.vertices[i + 2]
        )
      );
    }
    if (points.length < 4) {
      continue;
    }

    const geometry = new ConvexGeometry(points);
    const mesh = new THREE.Mesh(geometry, createHullFillMaterial(colorForIndex(index)));
    mesh.name = `collider-preview-hull-fill-${index + 1}`;
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    mesh.renderOrder = 1000;

    const edges = new THREE.LineSegments(
      new THREE.EdgesGeometry(geometry, 25),
      createEdgeMaterial()
    );
    edges.name = `collider-preview-hull-edges-${index + 1}`;
    edges.renderOrder = 1001;

    const partGroup = new THREE.Group();
    partGroup.name = `collider-preview-hull-part-${index + 1}`;
    partGroup.position.set(
      part.translation.x,
      part.translation.y,
      part.translation.z
    );
    partGroup.add(mesh, edges);
    group.add(partGroup);
  }

  return group;
}

export function createCompoundBoxPreview(parts: Physics3dBoxPart[]): THREE.Group {
  const group = new THREE.Group();
  group.name = "collider-preview-compound-boxes";

  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index];
    const geometry = new THREE.BoxGeometry(
      Math.max(part.halfExtents.x, 0.0001) * 2,
      Math.max(part.halfExtents.y, 0.0001) * 2,
      Math.max(part.halfExtents.z, 0.0001) * 2
    );
    const mesh = new THREE.Mesh(geometry, createBoxMaterial());
    mesh.name = `collider-preview-box-part-${index + 1}`;
    mesh.position.set(part.translation.x, part.translation.y, part.translation.z);
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    mesh.renderOrder = 1000;
    group.add(mesh);
  }

  return group;
}
