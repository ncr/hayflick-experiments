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
import { computeIslandSpatialContext } from "./spatial-context";

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
// Iso projection — calibrated against the *actual* IsoGameView defaults:
// pitch = π/6 (30°), yaw = π/4, baseOrthoHeight = 4.8·√2, referenceLowHeight = 240.
// ---------------------------------------------------------------------------
//
// Going backwards from "1 large pixel in 3D = 1 lowpixel in the renderer's
// pixelation grid" (the user's framing), we want each atlas cell to map to
// exactly one rendered lowpixel. So we project each face's world vertices
// through the renderer's actual camera basis and size cells from the
// resulting screen bbox.
//
// At the canonical reference resolution (240 lowpixels tall, baseOrthoHeight
// = 4.8·√2), the screen-per-world ratio R = 240 / (4.8·√2) = 25·√2.
// With yaw=π/4 and pitch=π/6:
//   cam_right = (cos π/4, 0, -sin π/4) = (√2/2, 0, -√2/2)
//   cam_up    = (cos π/4 · sin π/6, cos π/6, sin π/4 · sin π/6)
//             = (√2/4,  √3/2,  √2/4)
// 1 world unit projects:
//   X  → ( cos(π/4)·R,         -cos(π/4)·sin(π/6)·R) = ( 25, -12.5)
//   Z  → (-sin(π/4)·R,         -sin(π/4)·sin(π/6)·R) = (-25, -12.5)
//   Y  → ( 0,                  -cos(π/6)·R)          = (  0, -25·√6/2 ≈ -30.62)
//
// Mesh GLBs store positions in cm with the parent node scaling by 1/128.
// So one cm of mesh-local position = one cm of world space (1/128 unit).
// The per-cm projection ratios are the world-unit ratios divided by 128.
const ISO_R = (240 / (4.8 * Math.SQRT2)); // 25·√2
const ISO_PX_PER_CM_X_HORIZ = (Math.SQRT2 / 2) * ISO_R / 128;
const ISO_PX_PER_CM_X_VERT = -((Math.SQRT2 / 2) * (1 / 2) * ISO_R) / 128;
const ISO_PX_PER_CM_Z_HORIZ = -((Math.SQRT2 / 2) * ISO_R) / 128;
const ISO_PX_PER_CM_Z_VERT = -((Math.SQRT2 / 2) * (1 / 2) * ISO_R) / 128;
const ISO_PX_PER_CM_Y_VERT = -((Math.sqrt(3) / 2) * ISO_R) / 128;

/** Project a world position to iso-screen lowpixel coordinates at the
 *  renderer's reference resolution. World inputs are in centimetres
 *  (this project's GLB convention). */
export function projectWorldToIsoScreen(
  worldX: number,
  worldY: number,
  worldZ: number
): { sx: number; sy: number } {
  const sx = worldX * ISO_PX_PER_CM_X_HORIZ + worldZ * ISO_PX_PER_CM_Z_HORIZ;
  const sy =
    worldX * ISO_PX_PER_CM_X_VERT +
    worldZ * ISO_PX_PER_CM_Z_VERT +
    worldY * ISO_PX_PER_CM_Y_VERT;
  return { sx, sy };
}

/** Compute (cellsX, cellsY) per detected island from the iso-screen length
 *  of each UV axis on the face. cellsX = how many lowpixels you traverse
 *  walking from u_min to u_max along the face's U direction; cellsY same
 *  for V.
 *
 *  Critical for consistent unwraps: faces sharing a 3D edge use the same
 *  axis in world space, so they get identical cell counts along that
 *  shared edge — wall-front top edge (X) and wall-top long edge (X) both
 *  reduce to "128 cm of X axis projected" → identical cell count. Earlier
 *  screen-bbox sizing inflated cell counts with the parallelogram slant
 *  (depth axis contributing to sy), making shared edges differ between
 *  faces and yielding visibly mis-shaped islands.
 *
 *  Exported so the AI-template repack in `api-client.ts` can use the same
 *  per-island cell counts — otherwise the AI's template islands wouldn't
 *  line up with the atlas islands and pixel-art extraction would be
 *  off-by-one. */
export function computeCellsPerIsland(
  positions: Float32Array,
  uvs: Float32Array,
  indexBuffer: Uint32Array | Uint16Array,
  islands: ReadonlyArray<DetectedIsland>
): Array<{ cellsX: number; cellsY: number }> {
  return islands.map((isl) => islandCellsFromAxisProjection(positions, uvs, indexBuffer, isl));
}

function islandCellsFromAxisProjection(
  positions: Float32Array,
  uvs: Float32Array,
  indexBuffer: Uint32Array | Uint16Array,
  island: DetectedIsland
): { cellsX: number; cellsY: number } {
  const triIdx = island.triangleIndices[0];
  if (triIdx === undefined) return { cellsX: 2, cellsY: 2 };
  const i0 = indexBuffer[triIdx * 3];
  const i1 = indexBuffer[triIdx * 3 + 1];
  const i2 = indexBuffer[triIdx * 3 + 2];
  const u0 = uvs[i0 * 2], v0 = uvs[i0 * 2 + 1];
  const u1 = uvs[i1 * 2], v1 = uvs[i1 * 2 + 1];
  const u2 = uvs[i2 * 2], v2 = uvs[i2 * 2 + 1];
  const du1 = u1 - u0, dv1 = v1 - v0;
  const du2 = u2 - u0, dv2 = v2 - v0;
  const det = du1 * dv2 - dv1 * du2;
  const bbW = Math.abs(island.bboxUv.u1 - island.bboxUv.u0);
  const bbH = Math.abs(island.bboxUv.v1 - island.bboxUv.v0);
  if (Math.abs(det) < 1e-9) return { cellsX: 2, cellsY: 2 };
  const dpx1 = positions[i1 * 3] - positions[i0 * 3];
  const dpy1 = positions[i1 * 3 + 1] - positions[i0 * 3 + 1];
  const dpz1 = positions[i1 * 3 + 2] - positions[i0 * 3 + 2];
  const dpx2 = positions[i2 * 3] - positions[i0 * 3];
  const dpy2 = positions[i2 * 3 + 1] - positions[i0 * 3 + 1];
  const dpz2 = positions[i2 * 3 + 2] - positions[i0 * 3 + 2];
  // J columns: ∂pos/∂u and ∂pos/∂v in world cm.
  const dpu_x = (dpx1 * dv2 - dpx2 * dv1) / det;
  const dpu_y = (dpy1 * dv2 - dpy2 * dv1) / det;
  const dpu_z = (dpz1 * dv2 - dpz2 * dv1) / det;
  const dpv_x = (dpx2 * du1 - dpx1 * du2) / det;
  const dpv_y = (dpy2 * du1 - dpy1 * du2) / det;
  const dpv_z = (dpz2 * du1 - dpz1 * du2) / det;
  // Project ∂pos/∂u and ∂pos/∂v onto iso screen.
  const su_x = dpu_x * ISO_PX_PER_CM_X_HORIZ + dpu_z * ISO_PX_PER_CM_Z_HORIZ;
  const su_y = dpu_x * ISO_PX_PER_CM_X_VERT + dpu_z * ISO_PX_PER_CM_Z_VERT + dpu_y * ISO_PX_PER_CM_Y_VERT;
  const sv_x = dpv_x * ISO_PX_PER_CM_X_HORIZ + dpv_z * ISO_PX_PER_CM_Z_HORIZ;
  const sv_y = dpv_x * ISO_PX_PER_CM_X_VERT + dpv_z * ISO_PX_PER_CM_Z_VERT + dpv_y * ISO_PX_PER_CM_Y_VERT;
  // Use the dominant SCREEN-AXIS extent (max of |sx|, |sy|), not the
  // Euclidean length of the slanted projection. Reason: NEAREST sampling
  // along a horizontal scanline samples 25 distinct cells across a 25-px
  // parallelogram width, but the slanted axis length is sqrt(25² + 12.5²)
  // ≈ 28 — using 28 cells means 3 atlas columns get sampled by zero
  // fragments and never render (the "column 9 disappears" bug).
  const lenU_screen = Math.max(Math.abs(su_x), Math.abs(su_y));
  const lenV_screen = Math.max(Math.abs(sv_x), Math.abs(sv_y));
  return {
    cellsX: Math.max(2, Math.round(lenU_screen * bbW)),
    cellsY: Math.max(2, Math.round(lenV_screen * bbH)),
  };
}

/**
 * Per-island UV→face-local Jacobian sign. Used to flip atlas U/V axes so
 * the painted atlas always reads in the same orientation as that face
 * when viewed from OUTSIDE — regardless of where the camera currently
 * is. atlas-left ↔ face-localRight=0, atlas-top ↔ face-localDown=0.
 *
 * Earlier this was canonical-screen-aligned: front + visible side + top
 * looked correct under the default iso view, but rotating the camera
 * 180° to see the back / hidden faces showed those textures mirrored
 * (the GLB winds front and back UVs in opposite directions; the screen
 * convention only happened to match the camera-facing side). Per-face
 * local axes give every face a consistent "atlas TL = face's
 * top-left when looking at it from its outward normal" mapping, which
 * is what the user actually wants when they rotate around the model.
 *
 * Local axis convention (right-hand-rule, viewer looking AT the face):
 *   - localRight = cross(worldUp=+Y, faceNormal). Falls back to +X for
 *     horizontal faces where worldUp ‖ normal.
 *   - localDown  = -worldUp for non-horizontal faces. For horizontal
 *     faces (top / bottom) it's chosen so localRight × localDown = -n.
 *
 * For each island we take its first triangle, recover the face normal
 * via cross of edges, derive localRight/localDown, then test whether
 * the UV axes (∂pos/∂u, ∂pos/∂v) point along those local axes:
 *   flipU iff dpu's projection onto localRight is negative
 *   flipV iff dpv's projection onto localDown is negative
 */
export function computeIslandOrientations(
  positions: Float32Array,
  uvs: Float32Array,
  indexBuffer: Uint32Array | Uint16Array,
  islands: ReadonlyArray<DetectedIsland>
): Array<{ flipU: boolean; flipV: boolean }> {
  return islands.map((isl) => {
    const triIdx = isl.triangleIndices[0];
    if (triIdx === undefined) return { flipU: false, flipV: false };
    const i0 = indexBuffer[triIdx * 3];
    const i1 = indexBuffer[triIdx * 3 + 1];
    const i2 = indexBuffer[triIdx * 3 + 2];
    const u0 = uvs[i0 * 2], v0 = uvs[i0 * 2 + 1];
    const u1 = uvs[i1 * 2], v1 = uvs[i1 * 2 + 1];
    const u2 = uvs[i2 * 2], v2 = uvs[i2 * 2 + 1];
    const p0x = positions[i0 * 3], p0y = positions[i0 * 3 + 1], p0z = positions[i0 * 3 + 2];
    const p1x = positions[i1 * 3], p1y = positions[i1 * 3 + 1], p1z = positions[i1 * 3 + 2];
    const p2x = positions[i2 * 3], p2y = positions[i2 * 3 + 1], p2z = positions[i2 * 3 + 2];
    const du1 = u1 - u0, dv1 = v1 - v0;
    const du2 = u2 - u0, dv2 = v2 - v0;
    const det = du1 * dv2 - dv1 * du2;
    if (Math.abs(det) < 1e-9) return { flipU: false, flipV: false };
    const dpx1 = p1x - p0x, dpy1 = p1y - p0y, dpz1 = p1z - p0z;
    const dpx2 = p2x - p0x, dpy2 = p2y - p0y, dpz2 = p2z - p0z;
    // J columns: ∂pos/∂u and ∂pos/∂v in world cm.
    const dpu_x = (dpx1 * dv2 - dpx2 * dv1) / det;
    const dpu_y = (dpy1 * dv2 - dpy2 * dv1) / det;
    const dpu_z = (dpz1 * dv2 - dpz2 * dv1) / det;
    const dpv_x = (dpx2 * du1 - dpx1 * du2) / det;
    const dpv_y = (dpy2 * du1 - dpy1 * du2) / det;
    const dpv_z = (dpz2 * du1 - dpz1 * du2) / det;
    // Face normal from edge cross product (winding order matches GLB).
    const nx = dpy1 * dpz2 - dpz1 * dpy2;
    const ny = dpz1 * dpx2 - dpx1 * dpz2;
    const nz = dpx1 * dpy2 - dpy1 * dpx2;
    const nLen = Math.hypot(nx, ny, nz) || 1;
    const fnx = nx / nLen, fny = ny / nLen, fnz = nz / nLen;
    // localRight = cross(+Y, n) = (n.z, 0, -n.x). Falls back to +X
    // when face is horizontal (|n.y| ≈ 1).
    let rx: number, ry: number, rz: number;
    let dx: number, dy: number, dz: number;
    if (Math.abs(fny) > 0.9) {
      // Top / bottom: localRight = +X, localDown chosen so
      // localRight × localDown = -n. For top (+Y): down = +Z.
      // For bottom (-Y): down = -Z.
      rx = 1; ry = 0; rz = 0;
      const downSign = fny > 0 ? 1 : -1;
      dx = 0; dy = 0; dz = downSign;
    } else {
      const cx = fnz, cy = 0, cz = -fnx;
      const cLen = Math.hypot(cx, cy, cz) || 1;
      rx = cx / cLen; ry = cy / cLen; rz = cz / cLen;
      // localDown = -worldUp = -Y for vertical / near-vertical faces.
      dx = 0; dy = -1; dz = 0;
    }
    // Project ∂pos/∂u onto localRight; project ∂pos/∂v onto localDown.
    const u_along_right = dpu_x * rx + dpu_y * ry + dpu_z * rz;
    const u_along_down = dpu_x * dx + dpu_y * dy + dpu_z * dz;
    const v_along_right = dpv_x * rx + dpv_y * ry + dpv_z * rz;
    const v_along_down = dpv_x * dx + dpv_y * dy + dpv_z * dz;
    // Dominant axis check: U should align with localRight (mostly),
    // V with localDown (mostly). Fall back to the other axis if the
    // primary projection is near zero.
    const flipU =
      Math.abs(u_along_right) >= Math.abs(u_along_down)
        ? u_along_right < 0
        : u_along_down < 0;
    const flipV =
      Math.abs(v_along_down) >= Math.abs(v_along_right)
        ? v_along_down < 0
        : v_along_right < 0;
    return { flipU, flipV };
  });
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

  // Size each island's atlas cells in world-space extent so one atlas cell
  // = WORLD_CM_PER_CELL of mesh surface along its UV axis. For meshes whose
  // rectangular faces are multiples of 8 cm this gives clean integer cells
  // and one atlas pixel = one game pixel under iso 2:1.
  const cellsPerIsland = computeCellsPerIsland(
    uvData.positionBuffer,
    uvData.uvBuffer,
    uvData.indexBuffer,
    detected.islands
  );

  const atlasPack = repackIslands(detected, {
    templateWidth: atlasWidth,
    templateHeight: atlasHeight,
    cellPx: ATLAS_CELL_PX,
    cellPxTarget: DEFAULT_CELL_PX_TARGET, // ignored — overridden by cellsPerIsland
    cellsPerIsland,
    outlinePaddingPx: ATLAS_OUTLINE_PADDING_PX
  });

  // Flip per-island U/V so atlas axes match iso-screen axes under the
  // canonical view. This is what makes "paint atlas pixel (0,0) → top-left
  // of the visible mesh face" a stable invariant.
  const orientations = computeIslandOrientations(
    uvData.positionBuffer,
    uvData.uvBuffer,
    uvData.indexBuffer,
    detected.islands
  );
  for (let i = 0; i < atlasPack.uvRemap.length; i++) {
    const entry = atlasPack.uvRemap[i];
    const orient = orientations[i];
    if (orient.flipU) {
      entry.scaleU = -entry.scaleU;
      entry.offsetX = entry.offsetX + entry.pixelW;
    }
    if (orient.flipV) {
      entry.scaleV = -entry.scaleV;
      entry.offsetY = entry.offsetY + entry.pixelH;
    }
  }

  const newUvBuffer = remapUvs(
    uvData.uvBuffer,
    detected.vertexToIslandId,
    atlasPack.uvRemap,
    atlasWidth,
    atlasHeight
  );

  const spatial = computeIslandSpatialContext(
    uvData.positionBuffer,
    uvData.indexBuffer,
    detected.islands
  );

  const islandLayout: IslandLayout = {
    templateWidth: atlasWidth,
    templateHeight: atlasHeight,
    islands: atlasPack.islands,
    uvRemap: atlasPack.uvRemap,
    vertexToIslandId: detected.vertexToIslandId,
    newUvBuffer,
    spatial
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
