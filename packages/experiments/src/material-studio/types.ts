import type { Island, RgbaBuffer } from "../uv-template-probe/uv-template";
import type { UvRemapEntry } from "./uv-template/repack";

/** Parameters for PBR map derivation from a baseColor image. */
export type PbrParams = {
  strength: number;
  baseRoughness: number;
  roughnessRange: number;
  aoFloor: number;
  aoMultiplier: number;
};

/** Derived PBR map set — 64×64 baseColor, normal, ARM. */
export type GeneratedMaps = {
  baseColor: ImageData;
  normal: ImageData;
  arm: ImageData;
};

/**
 * Per-submesh data needed to drive the UV-template generation pipeline.
 * Captured from the loaded GLB at scene-load time and stashed on the
 * AuthoringScene under the role key.
 */
export type SubmeshUvData = {
  /** Triangle index buffer copied from the BufferGeometry. */
  indexBuffer: Uint32Array | Uint16Array;
  /** Interleaved UV buffer (length = vertexCount * 2). Original mesh UVs. */
  uvBuffer: Float32Array;
  /** Number of vertices in the geometry. */
  vertexCount: number;
  /** Material name in the GLB (e.g. "blockstudio_wall"). */
  materialName: string;
};

/**
 * Output of the UV re-packing step. Stored on a SurfaceState so the bake
 * step can replay the remap into the artifact GLB.
 */
export type IslandLayout = {
  templateWidth: number;
  templateHeight: number;
  islands: Island[];
  uvRemap: UvRemapEntry[];
  vertexToIslandId: number[];
  /** New UV buffer (length = vertexCount * 2), [0,1] in atlas space. */
  newUvBuffer: Float32Array;
};

/** Output of `generateBaseColorFromTemplate` — the new generation primitive. */
export type GeneratedFromTemplate = {
  baseColor: ImageData;
  /** Raw AI output before extraction; useful for the dev preview. */
  aiRaw: RgbaBuffer;
  /** Template image we sent to the AI; useful for the dev preview. */
  templateSent: RgbaBuffer;
  islandLayout: IslandLayout;
};

/** A texturable surface within a base mesh. Matches the `textureRole` custom property on the GLB node. */
export type Surface = {
  /** Role key — also used as the `blockstudio_<role>` material name in the GLB. */
  role: string;
  /** PBR surfaces are authored via prompt; synthetic surfaces use a preset shader (e.g. glass). */
  kind: "pbr" | "synthetic";
  /** If kind === "synthetic", the preset id the bake script will use. */
  synthetic?: string;
};

/** A base mesh in the flat catalog. */
export type BaseMesh = {
  /** File stem — `assets/meshes/<id>.glb`. */
  id: string;
  /** Discovered by walking the loaded GLB for textureRole extras. */
  surfaces: Surface[];
};

export type GlassParams = {
  tint: string;
  roughness: number;
  ior: number;
  alpha: number;
};

/** Per-surface authoring state for the current entry. */
export type SurfaceState = {
  surface: Surface;
  /** Prompt text — seeded from material-description table when a role is first visited. */
  prompt: string;
  /** Latest generated maps. Null until the user has hit Generate for this surface. */
  maps: GeneratedMaps | null;
  /** Previous maps (for single-step Undo after a new Generate). */
  prevMaps: GeneratedMaps | null;
  /** Layout used to generate `maps`. Persisted so the bake step can replay the UV remap. */
  islandLayout?: IslandLayout | null;
  /** Layout that produced `prevMaps`, kept in lock-step for single-step Undo. */
  prevIslandLayout?: IslandLayout | null;
  /** Template image sent to the AI for the latest generation — for the QA preview. */
  templateSent?: RgbaBuffer | null;
  /** Raw AI output for the latest generation — for the QA preview. */
  aiRaw?: RgbaBuffer | null;
  /** In-memory prompt history for this surface in the current session. Newest first, deduped. */
  promptHistory: string[];
  /** Becomes true when the user clicks "Approve". Synthetic surfaces start approved. */
  approved: boolean;
  /** Only set when surface.kind === "synthetic". */
  glassParams?: GlassParams;
};

export const DEFAULT_PBR_PARAMS: PbrParams = {
  strength: 1.5,
  baseRoughness: 0.75,
  roughnessRange: 0.15,
  aoFloor: 0.55,
  aoMultiplier: 1.5
};
