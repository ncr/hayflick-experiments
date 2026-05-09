/**
 * Re-pack detected UV islands into a fixed-size template via simple shelf
 * (skyline) bin-packing.
 *
 * Each island gets a `cellsX × cellsY` grid sized so the longest UV side
 * has `cellPxTarget` cells; the shorter side is scaled proportionally and
 * clamped to a minimum of 2 cells. The output also includes the affine
 * transform that maps each island's old UV (in its own bbox) into the
 * island's pixel rectangle inside the template.
 *
 * Pure data manipulation — no DOM, no THREE.
 */

import type { Island } from "./template";
import type { DetectedIslands } from "./island-detect";

export type RepackOptions = {
  /** Template canvas width — pick a gpt-image-2 supported size (1024, 1536). */
  templateWidth: number;
  /** Template canvas height. */
  templateHeight: number;
  /** Cell-pixel size; one "cell" is one pixel of the final pixel-art atlas. */
  cellPx: number;
  /** Cells along the longer side of an island, used when `cellsPerIsland`
   *  isn't provided. Shorter side scales by UV-bbox aspect. */
  cellPxTarget: number;
  /** Optional override: explicit (cellsX, cellsY) per detected island, in
   *  the same order as `detected.islands`. When provided, this fully
   *  bypasses the `cellPxTarget` + UV-aspect heuristic — cells are taken
   *  verbatim. Used by `prepareSurface` to size cells from the island's
   *  iso-projected screen extent so atlas pixels map 1:1 to game pixels. */
  cellsPerIsland?: ReadonlyArray<{ cellsX: number; cellsY: number }>;
  /** Gap between packed islands, in template pixels. Default 0. */
  paddingPx?: number;
  /** Reserved room for outline magenta around each island, in template pixels. Default 8. */
  outlinePaddingPx?: number;
  /** Optional name prefix for islands; used in template labels. Default "isl". */
  namePrefix?: string;
};

export type UvRemapEntry = {
  /** Pre-bbox uv → template-pixel scale: u_px = scaleU * (u_uv - bbox.u0). */
  scaleU: number;
  scaleV: number;
  /** Island top-left in template pixels (NOT including outline padding). */
  offsetX: number;
  offsetY: number;
  /** Bbox U min — subtracted before scaling. */
  bboxU0: number;
  bboxV0: number;
  /** Island pixel size: cellsX*cellPx, cellsY*cellPx. */
  pixelW: number;
  pixelH: number;
};

export type RepackResult = {
  islands: Island[];
  uvRemap: UvRemapEntry[];
};

const DEFAULT_PADDING_PX = 0;
const DEFAULT_OUTLINE_PX = 8;
const MIN_CELLS = 2;

export function repackIslands(
  detected: DetectedIslands,
  opts: RepackOptions
): RepackResult {
  const padding = opts.paddingPx ?? DEFAULT_PADDING_PX;
  const outlinePadding = opts.outlinePaddingPx ?? DEFAULT_OUTLINE_PX;
  const namePrefix = opts.namePrefix ?? "isl";

  type Sized = {
    detectedIdx: number;
    cellsX: number;
    cellsY: number;
    pixelW: number;
    pixelH: number;
    boxW: number; // pixelW + 2*outlinePadding
    boxH: number;
  };

  if (opts.cellsPerIsland && opts.cellsPerIsland.length !== detected.islands.length) {
    throw new Error(
      `repackIslands: cellsPerIsland length ${opts.cellsPerIsland.length} != island count ${detected.islands.length}`
    );
  }

  const sized: Sized[] = detected.islands.map((isl, idx) => {
    let cellsX: number;
    let cellsY: number;
    if (opts.cellsPerIsland) {
      const explicit = opts.cellsPerIsland[idx];
      cellsX = Math.max(MIN_CELLS, explicit.cellsX);
      cellsY = Math.max(MIN_CELLS, explicit.cellsY);
    } else {
      const wUv = Math.max(1e-9, isl.bboxUv.u1 - isl.bboxUv.u0);
      const hUv = Math.max(1e-9, isl.bboxUv.v1 - isl.bboxUv.v0);
      const longest = Math.max(wUv, hUv);
      const cellsLong = opts.cellPxTarget;
      cellsX = wUv >= hUv ? cellsLong : Math.max(MIN_CELLS, Math.round((wUv / longest) * cellsLong));
      cellsY = hUv >= wUv ? cellsLong : Math.max(MIN_CELLS, Math.round((hUv / longest) * cellsLong));
    }
    const pixelW = cellsX * opts.cellPx;
    const pixelH = cellsY * opts.cellPx;
    return {
      detectedIdx: idx,
      cellsX,
      cellsY,
      pixelW,
      pixelH,
      boxW: pixelW + outlinePadding * 2,
      boxH: pixelH + outlinePadding * 2
    };
  });

  // Skyline shelf-pack: sort by box height descending, place left-to-right.
  const placement = new Array<{ x: number; y: number }>(sized.length);
  const order = sized
    .map((s, i) => ({ i, h: s.boxH }))
    .sort((a, b) => b.h - a.h)
    .map((e) => e.i);

  let shelfX = outlinePadding;
  let shelfY = outlinePadding;
  let shelfH = 0;
  for (const i of order) {
    const s = sized[i];
    if (shelfX + s.boxW > opts.templateWidth - outlinePadding) {
      shelfX = outlinePadding;
      shelfY += shelfH + padding;
      shelfH = 0;
    }
    if (shelfY + s.boxH > opts.templateHeight - outlinePadding) {
      throw new Error(
        `repackIslands: islands do not fit in ${opts.templateWidth}×${opts.templateHeight} template (cellPx=${opts.cellPx}, cellPxTarget=${opts.cellPxTarget})`
      );
    }
    placement[i] = { x: shelfX + outlinePadding, y: shelfY + outlinePadding };
    shelfX += s.boxW + padding;
    if (s.boxH > shelfH) shelfH = s.boxH;
  }

  const islands: Island[] = new Array(sized.length);
  const uvRemap: UvRemapEntry[] = new Array(sized.length);
  for (let i = 0; i < sized.length; i++) {
    const s = sized[i];
    const p = placement[i];
    const det = detected.islands[s.detectedIdx];
    islands[i] = {
      x: p.x,
      y: p.y,
      cellsX: s.cellsX,
      cellsY: s.cellsY,
      cellPx: opts.cellPx,
      name: `${namePrefix}${i}`
    };
    uvRemap[i] = {
      scaleU: s.pixelW / Math.max(1e-9, det.bboxUv.u1 - det.bboxUv.u0),
      scaleV: s.pixelH / Math.max(1e-9, det.bboxUv.v1 - det.bboxUv.v0),
      offsetX: p.x,
      offsetY: p.y,
      bboxU0: det.bboxUv.u0,
      bboxV0: det.bboxUv.v0,
      pixelW: s.pixelW,
      pixelH: s.pixelH
    };
  }

  return { islands, uvRemap };
}
