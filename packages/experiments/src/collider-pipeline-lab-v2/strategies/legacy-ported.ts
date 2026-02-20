import * as THREE from "three";
import { generateColliderFromObject } from "../../auto-collider/api";
import { segmentIntoConvexHulls } from "../../compound-collider-lab/convex-segmentation";
import { clamp } from "../pipeline/math";
import type {
  ColliderPart,
  NormalizedProp,
  StrategyGenerator,
  Vec3Tuple
} from "../types";
import { axisAlignedPartFromBounds, compactPartCount, sanitizeParts } from "./common";

const geometryCache = new Map<string, THREE.BufferGeometry>();

function fallbackPart(prop: NormalizedProp, inflate: number): ColliderPart[] {
  return [axisAlignedPartFromBounds(prop.bbox.min, prop.bbox.max, inflate)];
}

function geometryForNormalizedProp(prop: NormalizedProp): THREE.BufferGeometry {
  const cached = geometryCache.get(prop.sampleSignature);
  if (cached) {
    return cached;
  }

  const positionData = new Float32Array(Math.max(0, prop.triangles.length * 9));
  let writeIndex = 0;
  for (const triangle of prop.triangles) {
    positionData[writeIndex++] = triangle.a[0];
    positionData[writeIndex++] = triangle.a[1];
    positionData[writeIndex++] = triangle.a[2];
    positionData[writeIndex++] = triangle.b[0];
    positionData[writeIndex++] = triangle.b[1];
    positionData[writeIndex++] = triangle.b[2];
    positionData[writeIndex++] = triangle.c[0];
    positionData[writeIndex++] = triangle.c[1];
    positionData[writeIndex++] = triangle.c[2];
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positionData, 3));
  geometry.computeBoundingBox();
  geometry.computeVertexNormals();
  geometryCache.set(prop.sampleSignature, geometry);
  return geometry;
}

function buildLegacyRoot(prop: NormalizedProp): THREE.Group {
  const group = new THREE.Group();
  const mesh = new THREE.Mesh(geometryForNormalizedProp(prop));
  mesh.position.set(0, 0, 0);
  mesh.rotation.set(0, 0, 0);
  mesh.scale.set(1, 1, 1);
  group.add(mesh);
  group.updateMatrixWorld(true);
  return group;
}

function partFromCenterHalfExtents(
  position: Vec3Tuple,
  halfExtents: Vec3Tuple,
  inflate: number
): ColliderPart {
  const min: Vec3Tuple = [
    position[0] - halfExtents[0],
    position[1] - halfExtents[1],
    position[2] - halfExtents[2]
  ];
  const max: Vec3Tuple = [
    position[0] + halfExtents[0],
    position[1] + halfExtents[1],
    position[2] + halfExtents[2]
  ];
  return axisAlignedPartFromBounds(min, max, inflate);
}

function disposeOverlay(overlay: THREE.Object3D): void {
  overlay.traverse((node) => {
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

function toMode(value: number): "dynamic" | "static" {
  return value >= 0.5 ? "dynamic" : "static";
}

function toBudget(value: number): "balanced" | "strict" {
  return value >= 0.5 ? "balanced" : "strict";
}

function partsFromLegacyRapier(
  parts: Array<{
    position: Vec3Tuple;
    halfExtents: Vec3Tuple;
  }>,
  inflate: number
): ColliderPart[] {
  return parts.map((part) =>
    partFromCenterHalfExtents(part.position, part.halfExtents, inflate)
  );
}

export const generateConvexLegacyCollider: StrategyGenerator<"convex"> = (
  prop,
  params
) => {
  const root = buildLegacyRoot(prop);
  const targetParts = Math.floor(clamp(params.targetParts, 1, 8));
  const result = segmentIntoConvexHulls(root, {
    targetParts,
    maxSamplePoints: Math.floor(clamp(params.maxSamplePoints, 300, 7000)),
    maxHullPoints: Math.floor(clamp(params.maxHullPoints, 24, 500)),
    minClusterPoints: Math.floor(clamp(params.minClusterPoints, 8, 180))
  });

  const parts: ColliderPart[] = [];
  for (const segment of result.parts) {
    if (segment.vertices.length <= 0) {
      continue;
    }
    let minX = Number.POSITIVE_INFINITY;
    let minY = Number.POSITIVE_INFINITY;
    let minZ = Number.POSITIVE_INFINITY;
    let maxX = Number.NEGATIVE_INFINITY;
    let maxY = Number.NEGATIVE_INFINITY;
    let maxZ = Number.NEGATIVE_INFINITY;

    for (const vertex of segment.vertices) {
      minX = Math.min(minX, vertex[0]);
      minY = Math.min(minY, vertex[1]);
      minZ = Math.min(minZ, vertex[2]);
      maxX = Math.max(maxX, vertex[0]);
      maxY = Math.max(maxY, vertex[1]);
      maxZ = Math.max(maxZ, vertex[2]);
    }

    parts.push(
      axisAlignedPartFromBounds(
        [minX, minY, minZ],
        [maxX, maxY, maxZ],
        params.inflate
      )
    );
  }
  disposeOverlay(result.overlay);

  if (parts.length <= 0) {
    return fallbackPart(prop, params.inflate);
  }
  return compactPartCount(sanitizeParts(parts), targetParts);
};

export const generateBoxyFurnitureLegacyCollider: StrategyGenerator<"boxy-furniture"> = (
  prop,
  params
) => {
  const root = buildLegacyRoot(prop);
  const result = generateColliderFromObject(root, {
    strategy: "boxy-furniture",
    mode: toMode(params.mode),
    budget: toBudget(params.budget),
    debug: false
  });

  const parts = partsFromLegacyRapier(result.rapier.parts, params.inflate);
  if (parts.length <= 0) {
    return fallbackPart(prop, params.inflate);
  }
  return compactPartCount(
    sanitizeParts(parts),
    Math.max(1, Math.floor(params.maxParts))
  );
};

export const generateConcaveFurnitureLegacyCollider: StrategyGenerator<"concave-furniture"> = (
  prop,
  params
) => {
  const root = buildLegacyRoot(prop);
  const result = generateColliderFromObject(root, {
    strategy: "concave-furniture",
    mode: toMode(params.mode),
    budget: toBudget(params.budget),
    debug: false
  });

  const parts = partsFromLegacyRapier(result.rapier.parts, params.inflate);
  if (parts.length <= 0) {
    return fallbackPart(prop, params.inflate);
  }
  return compactPartCount(
    sanitizeParts(parts),
    Math.max(1, Math.floor(params.maxParts))
  );
};
