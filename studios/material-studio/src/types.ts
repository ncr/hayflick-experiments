import type { Island, RgbaBuffer } from "./uv-template/template";
import type { UvRemapEntry } from "./uv-template/repack";
import type { IslandSpatialContext } from "./uv-template/spatial-context";

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
  /** Vertex positions in world units (length = vertexCount * 3). Used to
   *  size each UV island's atlas cells from its actual iso-projected
   *  screen extent, not from UV bbox aspect — the latter doesn't account
   *  for non-square faces or per-face screen density under iso 2:1. */
  positionBuffer: Float32Array;
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
  /** Per-island role / colour / camera-visibility, in the same order as
   *  `islands`. The paint editor uses this to label each region (front /
   *  top / back-hidden / …) so the user can tell which atlas patch maps
   *  to which face on the mesh. */
  spatial: IslandSpatialContext[];
};

/**
 * Atlas: the per-surface pixel buffer that drives the live texture and
 * survives across paint strokes and AI regenerations. One atlas pixel ==
 * one template grid cell == one mesh-surface texel. The mask flags which
 * pixels the user has painted (so they're preserved by AI fills).
 *
 * Buffers are explicitly `ArrayBuffer`-backed (not the broader
 * `ArrayBufferLike`) so the rgba can be passed straight to `new ImageData`.
 */
export type Atlas = {
  rgba: Uint8ClampedArray<ArrayBuffer>;
  /** Length = width × height. 0 = empty / AI-fillable; 1 = user-painted (preserved). */
  mask: Uint8Array<ArrayBuffer>;
  width: number;
  height: number;
};

/**
 * One step in a surface's edit history. Snapshots are full atlas copies —
 * cheap at 256² (~262 KB) and far simpler than operation-based replay.
 */
export type AtlasSnapshot = {
  rgba: Uint8ClampedArray<ArrayBuffer>;
  mask: Uint8Array<ArrayBuffer>;
  /** What produced this snapshot — for telemetry / future-UI labels. */
  tag: "init" | "paint" | "generate" | "clear-mask";
};

/** Wrap an Atlas's rgba buffer as ImageData — same buffer, no copy. */
export function atlasToImageData(atlas: Atlas): ImageData {
  return new ImageData(atlas.rgba, atlas.width, atlas.height);
}

/** Output of `generateBaseColorFromTemplate` — the new generation primitive. */
export type GeneratedFromTemplate = {
  /** Post-generation atlas. After Phase 4 wiring, painted pixels (mask=1)
   *  in the input atlas survive into this output unchanged. */
  atlas: Atlas;
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

/**
 * Per-PBR-surface live preview tweaks. Mirrors glTF's `normalScale`,
 * `occlusionStrength`, `roughnessFactor`, `metallicFactor` — so the values
 * survive 1:1 from the studio preview into the baked artifact GLB.
 */
export type PbrTweakParams = {
  normalScale: number;
  aoStrength: number;
  roughnessFactor: number;
  metallicFactor: number;
};

/** Per-surface authoring state for the current entry. */
export type SurfaceState = {
  surface: Surface;
  /** Prompt text — seeded from material-description table when a role is first visited. */
  prompt: string;
  /** Source-of-truth pixel buffer for paint + AI fill. Initialized at
   *  mesh-load time by `prepareSurface` for PBR surfaces; null for synthetic. */
  atlas: Atlas | null;
  /** Layout that maps atlas pixels to mesh UVs. Stable across regenerates
   *  for a given mesh; persisted so the bake step can replay the UV remap. */
  islandLayout: IslandLayout | null;
  /** Latest generated PBR maps (baseColor mirrors atlas.rgba). Null until first paint or Generate. */
  maps: GeneratedMaps | null;
  /** Per-surface undo stack of pre-action snapshots. Capped at MAX_HISTORY. */
  editHistory: AtlasSnapshot[];
  /** Per-surface redo stack — populated when user undoes. Cleared on any new commit. */
  editFuture: AtlasSnapshot[];
  /** Template image sent to the AI for the latest generation — for the QA preview. */
  templateSent: RgbaBuffer | null;
  /** Raw AI output for the latest generation — for the QA preview. */
  aiRaw: RgbaBuffer | null;
  /** In-memory prompt history for this surface in the current session. Newest first, deduped. */
  promptHistory: string[];
  /** Becomes true when the user clicks "Approve". Synthetic surfaces start approved. */
  approved: boolean;
  /** Only set when surface.kind === "synthetic". */
  glassParams?: GlassParams;
  /** Only set when surface.kind === "pbr". Drives live preview factors and
   *  is forwarded into the baked GLB material on save. */
  pbrTweak?: PbrTweakParams;
};

export const MAX_EDIT_HISTORY = 30;

export const DEFAULT_PBR_PARAMS: PbrParams = {
  strength: 1.5,
  baseRoughness: 0.75,
  roughnessRange: 0.15,
  aoFloor: 0.55,
  aoMultiplier: 1.5
};

export const DEFAULT_PBR_TWEAK: PbrTweakParams = {
  normalScale: 1.0,
  aoStrength: 1.0,
  roughnessFactor: 0.85,
  metallicFactor: 0.0
};
