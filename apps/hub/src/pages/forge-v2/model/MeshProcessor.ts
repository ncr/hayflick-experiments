/**
 * MeshProcessor — pure mesh transform pipeline.
 *
 * All functions are stateless: they take inputs, return outputs, and have no
 * side effects. This makes them independently testable without React, DOM, or
 * Three.js rendering context.
 */
import * as THREE from "three";
import {
  applyPivotOffset,
  applyScale,
  computeBBox,
  computePivotOffset,
  normalizeTransforms,
  type BBox,
  type PivotPreset,
  type ScaleMode,
} from "../../forge/processing/dimensions";
import { downsampleMeshTextures } from "../../forge/processing/textures";
import { countTotalFaces } from "../../forge/processing/simplify";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ScaleModeV2 = ScaleMode | "depth";

export interface MeshProcessingParams {
  textureResolution: number;
  pivot: PivotPreset;
  scaleMode: ScaleModeV2;
  targetDimension: number;
}

export interface MeshProcessingResult {
  model: THREE.Group;
  pixelModel: THREE.Group;
  bbox: { width: number; height: number; depth: number } | null;
  scale: number;
  pivotOffset: [number, number, number];
  originalFaces: number;
  processedFaces: number;
  simplificationRatio: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const UNIT_SCALE_METERS_PER_UNIT = 1.28;

// ---------------------------------------------------------------------------
// Core functions
// ---------------------------------------------------------------------------

/** Deep-clone a Three.js group, also cloning all materials so mutations are isolated. */
export function deepCloneWithMaterials(group: THREE.Group): THREE.Group {
  const clone = group.clone(true);
  clone.traverse((child) => {
    if (child instanceof THREE.Mesh) {
      if (Array.isArray(child.material)) {
        child.material = child.material.map((m: THREE.Material) => m.clone());
      } else {
        child.material = child.material.clone();
      }
    }
  });
  return clone;
}

/** Compute uniform scale factor to make the model's target dimension match `targetValue`. */
export function computeScaleForDraft(bbox: BBox, mode: ScaleModeV2, targetValue: number): number {
  const safeTarget = Math.max(0.01, targetValue);
  if (mode === "depth") {
    return bbox.depth > 0 ? safeTarget / bbox.depth : 1;
  }
  switch (mode) {
    case "height":
      return bbox.height > 0 ? safeTarget / bbox.height : 1;
    case "width":
      return bbox.width > 0 ? safeTarget / bbox.width : 1;
    case "max": {
      const maxDim = Math.max(bbox.width, bbox.height, bbox.depth);
      return maxDim > 0 ? safeTarget / maxDim : 1;
    }
    case "manual":
      return safeTarget;
  }
}

/** Convert a BBox to a plain JSON-safe object (or null). */
export function bboxToJson(bbox: BBox | null): { width: number; height: number; depth: number } | null {
  if (!bbox) return null;
  return { width: bbox.width, height: bbox.height, depth: bbox.depth };
}

/** Build a test environment group with floor, grid, and reference boxes around a processed model. */
export function buildPixelTestEnvironmentGroup(processedModel: THREE.Group): THREE.Group {
  const root = new THREE.Group();
  root.add(processedModel);
  const refs = new THREE.Group();
  refs.name = "pixel-test-environment";
  addPixelPreviewGroundEnvironment(refs);
  const unitBox = new THREE.Mesh(
    new THREE.BoxGeometry(1, 1, 1),
    new THREE.MeshStandardMaterial({ color: 0x7ec6a2, roughness: 0.85, metalness: 0.04 })
  );
  unitBox.position.set(2.25, 0.5, 0);
  refs.add(unitBox);
  const tallBox = new THREE.Mesh(
    new THREE.BoxGeometry(1, 2, 1),
    new THREE.MeshStandardMaterial({ color: 0xe7b375, roughness: 0.84, metalness: 0.03 })
  );
  tallBox.position.set(4.0, 1, 0);
  refs.add(tallBox);
  root.add(refs);
  return root;
}

function addPixelPreviewGroundEnvironment(root: THREE.Group): void {
  const gridSize = 12;
  const darkGridColor = 0x6b8fb5;
  const brightCenterGridColor = 0xa7d2ff;
  const floor = new THREE.Mesh(
    new THREE.BoxGeometry(14, 0.1, 14),
    new THREE.MeshStandardMaterial({ color: 0x5d748b, roughness: 0.95, metalness: 0.02 })
  );
  floor.position.set(0, -0.05, 0);
  floor.receiveShadow = true;
  root.add(floor);
  const grid = new THREE.GridHelper(gridSize, 12, brightCenterGridColor, darkGridColor);
  grid.position.y = 0.002;
  root.add(grid);
}

/**
 * Full mesh processing pipeline — pure function.
 *
 * Takes a base (raw) model and processing params, returns the fully processed
 * model, pixel test environment group, computed bbox, scale, pivot offset, and
 * face counts. No side effects.
 */
export function processMesh(
  baseModel: THREE.Group,
  params: MeshProcessingParams
): MeshProcessingResult {
  const model = deepCloneWithMaterials(baseModel);

  if (params.textureResolution > 0) {
    downsampleMeshTextures(model, params.textureResolution);
  }

  const unitBBox = computeBBox(model);
  const pivotOffset = computePivotOffset(unitBBox, params.pivot);
  applyPivotOffset(model, pivotOffset);
  const postPivotBBox = computeBBox(model);
  const scale = computeScaleForDraft(postPivotBBox, params.scaleMode, params.targetDimension);
  applyScale(model, scale);
  const finalBBox = computeBBox(model);

  const originalFaces = countTotalFaces(baseModel);
  const processedFaces = countTotalFaces(model);

  const pixelModel = buildPixelTestEnvironmentGroup(deepCloneWithMaterials(model));

  return {
    model,
    pixelModel,
    bbox: bboxToJson(finalBBox),
    scale,
    pivotOffset: [pivotOffset.x, pivotOffset.y, pivotOffset.z],
    originalFaces,
    processedFaces,
    simplificationRatio: originalFaces > 0 ? processedFaces / originalFaces : 1,
  };
}

// Re-export normalizeTransforms for convenience
export { normalizeTransforms };
