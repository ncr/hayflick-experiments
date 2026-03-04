import * as THREE from "three";
import { Brush, Evaluator, SUBTRACTION } from "three-bvh-csg";
import type { MeshData, CsgSubtraction, PieceConfig } from "../model/types";
import { generatePieceGeometryDescriptors, mergeMeshData } from "../model/geometry";

/**
 * Convert plain MeshData into a Three.js BufferGeometry.
 */
export function meshDataToGeometry(data: MeshData): THREE.BufferGeometry {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(data.positions, 3));
  geo.setAttribute("normal", new THREE.BufferAttribute(data.normals, 3));
  geo.setAttribute("uv", new THREE.BufferAttribute(data.uvs, 2));
  geo.setIndex(new THREE.BufferAttribute(data.indices, 1));
  return geo;
}

/**
 * Create a CSG subtraction brush from a CsgSubtraction descriptor.
 */
function createSubtractionBrush(sub: CsgSubtraction): Brush {
  const geo = new THREE.BoxGeometry(sub.size[0], sub.size[1], sub.size[2]);
  const brush = new Brush(geo, new THREE.MeshStandardMaterial());
  brush.position.set(sub.position[0], sub.position[1], sub.position[2]);
  brush.updateMatrixWorld(true);
  return brush;
}

/**
 * Build the complete piece mesh group from a PieceConfig and material.
 * This is the only file that performs actual CSG operations.
 */
export function buildPieceMesh(
  config: PieceConfig,
  material: THREE.Material,
): THREE.Group {
  const group = new THREE.Group();
  const descriptors = generatePieceGeometryDescriptors(config);

  // Build base geometry — merge all base boxes, then apply CSG subtractions
  const baseMerged = mergeMeshData(descriptors.baseBoxes);
  if (!baseMerged) return group;

  let baseGeo = meshDataToGeometry(baseMerged);
  let baseBrush = new Brush(baseGeo, material);
  baseBrush.updateMatrixWorld(true);

  // Apply CSG subtractions (openings)
  if (descriptors.subtractions.length > 0) {
    const evaluator = new Evaluator();

    for (const sub of descriptors.subtractions) {
      const subBrush = createSubtractionBrush(sub);
      const result = evaluator.evaluate(baseBrush, subBrush, SUBTRACTION);
      // Clean up old brush geometry
      baseBrush.geometry.dispose();
      subBrush.geometry.dispose();
      baseBrush = result as unknown as Brush;
    }
  }

  // Main wall mesh
  const wallMesh = new THREE.Mesh(baseBrush.geometry, material);
  wallMesh.castShadow = true;
  wallMesh.receiveShadow = true;
  group.add(wallMesh);

  // Trim meshes
  for (const trimData of descriptors.trimMeshes) {
    const trimGeo = meshDataToGeometry(trimData);
    const trimMesh = new THREE.Mesh(trimGeo, material);
    trimMesh.castShadow = true;
    group.add(trimMesh);
  }

  // Opening frame
  if (descriptors.openingFrame) {
    const frameGeo = meshDataToGeometry(descriptors.openingFrame);
    const frameMesh = new THREE.Mesh(frameGeo, material);
    group.add(frameMesh);
  }

  return group;
}

/**
 * Dispose all geometries and materials in a group.
 */
export function disposePieceGroup(group: THREE.Group) {
  group.traverse((obj) => {
    if (obj instanceof THREE.Mesh) {
      obj.geometry.dispose();
      if (Array.isArray(obj.material)) {
        obj.material.forEach((m) => m.dispose());
      } else {
        obj.material.dispose();
      }
    }
  });
  group.clear();
}
