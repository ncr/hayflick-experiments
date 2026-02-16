import type { ColliderParams } from "./processing/colliders";
import type { ScaleMode, PivotPreset, BBox } from "./processing/dimensions";

export type PropStatus =
  | "draft"
  | "generating-image"
  | "image-ready"
  | "generating-3d"
  | "3d-ready"
  | "exported";

export interface PropItem {
  id: string;
  description: string;
  status: PropStatus;
  conceptImage: string | null;
  imageError: string | null;
  rawGlb: ArrayBuffer | null;
  modelProgress: number;
  modelError: string | null;
  // Processing state (per-prop)
  originalFaces: number;
  simplifiedFaces: number;
  simplificationRatio: number;
  scale: number;
  scaleMode: ScaleMode;
  targetDimension: number;
  pivot: PivotPreset;
  pivotOffset: [number, number, number];
  collider: ColliderParams | null;
  textureResolution: number;
  bbox: BBox | null;
}
