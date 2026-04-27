/**
 * Pre-flight: detect UV islands, repack into the small atlas, derive the
 * remapped UV buffer, and produce a blank starter atlas + paint mask.
 *
 * Run once per PBR surface at mesh-load time so the user has something to
 * paint into before the first AI generation. The same `IslandLayout` is
 * reused across Generate calls, keeping the atlas pixel layout stable —
 * which is what lets paint strokes survive a regenerate (the cell at
 * atlas-pixel (cx, cy) means the same thing every time).
 *
 * Per-island cell counts are sized from each island's *iso-projected*
 * screen extent (not the UV bbox aspect) so one atlas pixel maps to one
 * game pixel regardless of face orientation. A horizontal floor face and
 * a vertical wall face render at different pixel densities under iso 2:1;
 * sizing cells from the projected screen bbox keeps the 1:1 invariant.
 *
 * Pure data manipulation — no DOM, no THREE.
 */

import type { Atlas, IslandLayout, SubmeshUvData } from "../types";
import { detectIslands, type DetectedIsland } from "./island-detect";
import { repackIslands } from "./repack";
import { remapUvs } from "./remap-uvs";

/**
 * Atlas size — the number of logical pixel-art cells we can fit on a
 * surface, with one atlas pixel per cell. 256² gives plenty of room for
 * dozens of islands at the default texel density.
 */
export const DEFAULT_ATLAS_W = 256;
export const DEFAULT_ATLAS_H = 256;

/** Cells along the longest island side — fallback only, used when
 *  `cellsPerIsland` is not provided to `repackIslands`. */
export const DEFAULT_CELL_PX_TARGET = 16;

/** Atlas cell size (always 1 — one atlas pixel = one logical cell). */
export const ATLAS_CELL_PX = 1;

/** Padding between island bboxes so seam-bleed and outline overlays don't collide. */
export const ATLAS_OUTLINE_PADDING_PX = 3;

/** Inside-island starter colour — white reads cleanly under paint and is
 *  the baseline gpt-image-2 expects to see in empty cells. */
const INSIDE_ISLAND_RGB = 0xffffff;

/** Outside-island background — neutral mid-grey, matches recompose default. */
const OUTSIDE_ISLAND_RGB = 0x808080;

// ---------------------------------------------------------------------------
// Iso projection — calibrated against the "1 world tile edge (128cm) =
// 32 game pixels horizontal, 16 vertical" invariant in CLAUDE.md.
// ---------------------------------------------------------------------------
//
// In iso 2:1 (yaw π/4, pitch atan(½)):
//   - 128 cm of world X →  (16 horizontal,  8 vertical) screen pixels
//   - 128 cm of world Z →  (16 horizontal, -8 vertical)
//   - 128 cm of world Y →  ( 0 horizontal, 16 vertical)  (Y up = vertical extent)
//
// The base mesh GLBs in this project store positions in *centimetres*
// (a 1-tile cube measures 128 along an axis), so the per-cm constants
// are the ratios above:
const ISO_PX_PER_CM_X_HORIZ = 16 / 128;
const ISO_PX_PER_CM_X_VERT = 8 / 128;
const ISO_PX_PER_CM_Z_HORIZ = 16 / 128;
const ISO_PX_PER_CM_Z_VERT = -8 / 128;
const ISO_PX_PER_CM_Y_VERT = 16 / 128; // absolute extent (Y up = negative screen-y)

/** Project a world position to iso screen coordinates (game pixels at zoom=1).
 *  World inputs are in centimetres (this project's GLB convention). */
export function projectWorldToIsoScreen(
  worldX: number,
  worldY: number,
  worldZ: number
): { sx: number; sy: number } {
  const sx = worldX * ISO_PX_PER_CM_X_HORIZ + worldZ * ISO_PX_PER_CM_Z_HORIZ;
  const sy =
    worldX * ISO_PX_PER_CM_X_VERT + worldZ * ISO_PX_PER_CM_Z_VERT - worldY * ISO_PX_PER_CM_Y_VERT;
  return { sx, sy };
}

/** Compute (cellsX, cellsY) per detected island from its world-space
 *  vertices, projected to iso screen. Exported so the AI-template repack
 *  in `api-client.ts` can use the same per-island cell counts (otherwise
 *  the AI's template islands wouldn't line up with the atlas islands and
 *  pixel-art extraction would be off-by-one). */
export function computeCellsPerIsland(
  positions: Float32Array,
  islands: ReadonlyArray<DetectedIsland>
): Array<{ cellsX: number; cellsY: number }> {
  return islands.map((isl) => islandCellsFromScreenBbox(positions, isl));
}

/** Compute (cellsX, cellsY) for an island as the iso-screen extent of its
 *  world-space vertices. One atlas cell ≈ one game pixel by construction. */
function islandCellsFromScreenBbox(
  positions: Float32Array,
  island: DetectedIsland
): { cellsX: number; cellsY: number } {
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const v of island.vertexIndices) {
    const { sx, sy } = projectWorldToIsoScreen(
      positions[v * 3],
      positions[v * 3 + 1],
      positions[v * 3 + 2]
    );
    if (sx < minX) minX = sx;
    if (sx > maxX) maxX = sx;
    if (sy < minY) minY = sy;
    if (sy > maxY) maxY = sy;
  }
  const w = Math.max(0, maxX - minX);
  const h = Math.max(0, maxY - minY);
  return { cellsX: Math.max(2, Math.ceil(w)), cellsY: Math.max(2, Math.ceil(h)) };
}

export type PrepareSurfaceOptions = {
  atlasWidth?: number;
  atlasHeight?: number;
};

export type PreparedSurface = {
  islandLayout: IslandLayout;
  atlas: Atlas;
};

export function prepareSurface(
  uvData: SubmeshUvData,
  opts: PrepareSurfaceOptions = {}
): PreparedSurface {
  const atlasWidth = opts.atlasWidth ?? DEFAULT_ATLAS_W;
  const atlasHeight = opts.atlasHeight ?? DEFAULT_ATLAS_H;

  const detected = detectIslands(uvData.indexBuffer, uvData.uvBuffer);
  if (detected.islands.length === 0) {
    throw new Error("prepareSurface: no UV islands detected on this submesh.");
  }

  // Size each island's atlas cells from its iso-projected screen extent so
  // one atlas pixel maps to one game pixel regardless of face orientation.
  const cellsPerIsland = computeCellsPerIsland(uvData.positionBuffer, detected.islands);

  const atlasPack = repackIslands(detected, {
    templateWidth: atlasWidth,
    templateHeight: atlasHeight,
    cellPx: ATLAS_CELL_PX,
    cellPxTarget: DEFAULT_CELL_PX_TARGET, // ignored — overridden by cellsPerIsland
    cellsPerIsland,
    outlinePaddingPx: ATLAS_OUTLINE_PADDING_PX
  });

  const newUvBuffer = remapUvs(
    uvData.uvBuffer,
    detected.vertexToIslandId,
    atlasPack.uvRemap,
    atlasWidth,
    atlasHeight
  );

  const islandLayout: IslandLayout = {
    templateWidth: atlasWidth,
    templateHeight: atlasHeight,
    islands: atlasPack.islands,
    uvRemap: atlasPack.uvRemap,
    vertexToIslandId: detected.vertexToIslandId,
    newUvBuffer
  };

  const rgba = new Uint8ClampedArray(atlasWidth * atlasHeight * 4);
  const bgR = (OUTSIDE_ISLAND_RGB >> 16) & 0xff;
  const bgG = (OUTSIDE_ISLAND_RGB >> 8) & 0xff;
  const bgB = OUTSIDE_ISLAND_RGB & 0xff;
  for (let i = 0; i < rgba.length; i += 4) {
    rgba[i] = bgR;
    rgba[i + 1] = bgG;
    rgba[i + 2] = bgB;
    rgba[i + 3] = 255;
  }
  const inR = (INSIDE_ISLAND_RGB >> 16) & 0xff;
  const inG = (INSIDE_ISLAND_RGB >> 8) & 0xff;
  const inB = INSIDE_ISLAND_RGB & 0xff;
  for (const isl of atlasPack.islands) {
    const x1 = isl.x + isl.cellsX * isl.cellPx;
    const y1 = isl.y + isl.cellsY * isl.cellPx;
    for (let y = isl.y; y < y1; y++) {
      if (y < 0 || y >= atlasHeight) continue;
      for (let x = isl.x; x < x1; x++) {
        if (x < 0 || x >= atlasWidth) continue;
        const i = (y * atlasWidth + x) * 4;
        rgba[i] = inR;
        rgba[i + 1] = inG;
        rgba[i + 2] = inB;
      }
    }
  }

  const mask = new Uint8Array(atlasWidth * atlasHeight);

  return {
    islandLayout,
    atlas: { rgba, mask, width: atlasWidth, height: atlasHeight }
  };
}
