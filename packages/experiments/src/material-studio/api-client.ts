/**
 * Prompt + image-generation primitives for Material Studio.
 *
 * Catalog calls live in ./api/catalog-client.ts; bake calls live in
 * ./api/bake-client.ts. This module is the prompt seeds, the UV-template
 * generation pipeline (the only generator surface in material-studio),
 * and PNG <-> ImageData helpers.
 */

import { saveEntry } from "@common/core/imagegen-cache";
import {
  buildIslandTemplate,
  extractIslandPixelArt,
  paintCellsIntoTemplate,
  type Island
} from "../uv-template-probe/uv-template";
import { detectIslands } from "./uv-template/island-detect";
import { repackIslands } from "./uv-template/repack";
import { recomposeIslandsAsAtlas } from "./uv-template/recompose";
import {
  ATLAS_CELL_PX,
  ATLAS_OUTLINE_PADDING_PX,
  DEFAULT_ATLAS_H,
  DEFAULT_ATLAS_W,
  DEFAULT_CELL_PX_TARGET,
  computeCellsPerIsland
} from "./uv-template/prepare";
import { remapUvs } from "./uv-template/remap-uvs";
import {
  computeIslandSpatialContext,
  type IslandSpatialContext
} from "./uv-template/spatial-context";
import { renderColorCodedReference } from "./uv-template/reference-render";
import type {
  Atlas,
  GeneratedFromTemplate,
  IslandLayout,
  SubmeshUvData
} from "./types";

export const MATERIAL_STUDIO_CACHE_SOURCE = "material-studio.uv-template";

// ---------------------------------------------------------------------------
// Year 2200 style preamble — shared across prompts
// ---------------------------------------------------------------------------

const STYLE_PREAMBLE = [
  "Year 2200 sci-fi architectural surface.",
  "Material looks carved from dense white mineral or architectural ceramic.",
  "Pristine, clean, no damage, no grime, no decay, no texture clutter.",
  "Flat, non-dramatic, even lighting baked into the albedo (no shadows, no specular highlights — PBR handles that at runtime).",
  "Crisp pixel art with large flat-colour blocks, no anti-aliasing, no gradients, no dithering."
].join(" ");

// ---------------------------------------------------------------------------
// Per-role prompt seeds — keyed by textureRole, not by material id
// ---------------------------------------------------------------------------

export const ROLE_PROMPT_SEEDS: Record<string, string> = {
  wall: "dense white architectural ceramic with fine structural joints, monolithic and heavy. Limited palette: warm white, faint cream, very subtle warm grey joint lines.",
  trim: "burnt industrial amber accent on a dark structural substrate, functional marker stripe at an architectural datum, not decorative. Limited palette: burnt amber #B8430E, dark amber #8A3000, near-black structural dark #1a1a1a.",
  floor_tile: "smooth architectural floor tile in pale mineral composite with subtle rectilinear joints, infrastructure-grade, pristine. Limited palette: light grey, near-white, faint cool grey joint lines."
};

export function defaultPromptForRole(role: string): string {
  return ROLE_PROMPT_SEEDS[role] ?? role.replace(/_/g, " ");
}

// ---------------------------------------------------------------------------
// UV-template generation pipeline
// ---------------------------------------------------------------------------

export type GenerateBaseColorRequest = {
  uvData: SubmeshUvData;
  prompt: string;
  /** Current atlas state (rgba + paint mask). When provided, painted cells
   *  (mask=1) are baked into the template before sending and preserved in
   *  the merged output. Pass a fresh-with-no-paint atlas on the first call. */
  atlas?: Atlas;
  /** The surface's *existing* island layout, exactly as `prepareSurface`
   *  produced it at mesh-load time. The atlas-side packing — island
   *  positions, uvRemap (with orientation flips!), and `newUvBuffer` —
   *  must be reused verbatim across regenerates so:
   *    1. Painted cells stay registered to the same atlas pixels.
   *    2. The mesh's sampled orientation doesn't flip back to GLB-raw.
   *  When omitted, a fresh atlasPack is computed (initial generate
   *  before a layout exists). */
  existingLayout?: IslandLayout;
  /** Template resolution sent to gpt-image-2 (must be 1024² / 1024×1536 / 1536×1024). */
  templateWidth?: number;
  templateHeight?: number;
  /** Cells along longest island side. */
  cellPxTarget?: number;
  /** Cell size in *template* pixels (chunky for AI legibility). */
  cellPx?: number;
  /** Final stored atlas size — keep small. Defaults to 256². */
  atlasWidth?: number;
  atlasHeight?: number;
  /** gpt-image-2 quality tier. */
  quality?: "low" | "medium" | "high";
  /** Tags attached to the cache entry that records this generation. */
  cacheTags?: Record<string, string>;
};

// Template = the chunky image we send to gpt-image-2. The AI requires 1024² /
// 1024×1536 / 1536×1024 inputs, so this stays large. It is transient and never
// stored; only the small atlas below is.
const DEFAULT_TEMPLATE_W = 1024;
const DEFAULT_TEMPLATE_H = 1024;
const DEFAULT_TEMPLATE_CELL_PX = 16;

// Atlas dimensions / cell sizing live in `uv-template/prepare.ts` so they
// can be reused at mesh-load time when seeding a blank starter atlas.

const DEFAULT_QUALITY: "low" | "medium" | "high" = "medium";

export async function generateBaseColorFromTemplate(
  req: GenerateBaseColorRequest
): Promise<GeneratedFromTemplate> {
  const templateWidth = req.templateWidth ?? DEFAULT_TEMPLATE_W;
  const templateHeight = req.templateHeight ?? DEFAULT_TEMPLATE_H;
  const templateCellPx = req.cellPx ?? DEFAULT_TEMPLATE_CELL_PX;
  const cellPxTarget = req.cellPxTarget ?? DEFAULT_CELL_PX_TARGET;
  const atlasWidth = req.atlasWidth ?? DEFAULT_ATLAS_W;
  const atlasHeight = req.atlasHeight ?? DEFAULT_ATLAS_H;

  const detected = detectIslands(req.uvData.indexBuffer, req.uvData.uvBuffer);
  if (detected.islands.length === 0) {
    throw new Error("No UV islands detected on this submesh.");
  }

  // Per-island spatial labels (front/back/top/...) + distinct colours.
  // Used both as outline colours on the template and as the face tint on
  // the 3D iso reference image. Same colour in both → AI can match
  // "outlined region X in unwrap" to "face X on the mesh" by colour alone.
  const spatial = computeIslandSpatialContext(
    req.uvData.positionBuffer,
    req.uvData.indexBuffer,
    detected.islands
  );

  // The atlas-side packing must come from the surface's already-prepared
  // layout (where prepareSurface applied the orientation flips that align
  // atlas axes with screen axes). If we re-pack here we drop those flips
  // and the mesh ends up sampling the texture mirrored. cellsX × cellsY
  // per island is taken from the existing layout so the templatePack
  // matches it exactly — extractIslandPixelArt + recompose require it.
  const atlasIslands = req.existingLayout?.islands ?? null;
  const cellsPerIsland: ReadonlyArray<{ cellsX: number; cellsY: number }> = atlasIslands
    ? atlasIslands.map((isl) => ({ cellsX: isl.cellsX, cellsY: isl.cellsY }))
    : computeCellsPerIsland(
        req.uvData.positionBuffer,
        req.uvData.uvBuffer,
        req.uvData.indexBuffer,
        detected.islands
      );
  // First-generate has no existingLayout, so we have to fresh-pack the
  // atlas now (we need its positions to scale into the template).
  const atlasPackForScale = req.existingLayout
    ? null
    : repackIslands(detected, {
        templateWidth: atlasWidth,
        templateHeight: atlasHeight,
        cellPx: ATLAS_CELL_PX,
        cellPxTarget,
        cellsPerIsland,
        outlinePaddingPx: ATLAS_OUTLINE_PADDING_PX,
      });
  const sourceAtlasIslands: Island[] =
    req.existingLayout?.islands ?? atlasPackForScale!.islands;
  // Build the AI template by scaling up the atlas's shelf-pack 1:1.
  // This guarantees the user sees the SAME layout in both views (paint
  // editor's atlas and the AI-template QA preview), eliminating the
  // "why are top/bottom in different places?" confusion. Pick the
  // largest integer scale where all islands still fit; cellPx falls out
  // of the same scale so the AI gets nice chunky cells.
  const templatePack = packTemplateAsScaledAtlas(
    sourceAtlasIslands,
    atlasWidth,
    atlasHeight,
    templateWidth,
    templateHeight
  );
  const atlasIslandsFinal: Island[] = sourceAtlasIslands;
  const atlasUvRemap = req.existingLayout?.uvRemap ?? atlasPackForScale!.uvRemap;
  const newUvBuffer = req.existingLayout?.newUvBuffer
    ? new Float32Array(req.existingLayout.newUvBuffer)
    : remapUvs(
        req.uvData.uvBuffer,
        detected.vertexToIslandId,
        atlasUvRemap,
        atlasWidth,
        atlasHeight
      );

  // Use the per-island spatial colours as outline colours so each region
  // is uniquely identifiable, and the AI can cross-reference with the 3D
  // ref image which uses the exact same palette.
  const outlineColors = spatial.map((s) => s.color);
  const templateLineThickness = Math.max(
    1,
    Math.floor((templatePack.islands[0]?.cellPx ?? 16) / 4)
  );
  const templateOpts = {
    width: templateWidth,
    height: templateHeight,
    islands: templatePack.islands,
    outlineColors,
    lineThicknessPx: templateLineThickness
  };
  const templateSent = buildIslandTemplate(templateOpts);

  // If the user has painted any cells, bake them into the template at
  // template-cell scale. The AI still sees magenta outlines + grid lines
  // so the painted cells read as "preserve me" rather than "this image
  // already exists, copy it".
  const hasPainted = !!req.atlas && hasAnyPaintedCell(req.atlas.mask);
  if (req.atlas && hasPainted) {
    const cellsPerIsland = atlasIslandsFinal.map((isl) => extractIslandCellsFromAtlas(req.atlas!, isl));
    paintCellsIntoTemplate(templateSent, templatePack.islands, cellsPerIsland, {
      lineThicknessPx: templateLineThickness,
    });
  }

  const templateB64 = await rgbaBufferToBase64Png(templateSent);

  // 3D iso reference image: same submesh, same camera as the renderer,
  // each face flat-tinted with its island colour. Sent as a second
  // input_image so the model sees the spatial relationships of the
  // unwrap regions on the actual mesh (front/top/side, depth, where
  // edges meet).
  const referenceBuffer = renderColorCodedReference({
    positions: req.uvData.positionBuffer,
    indexBuffer: req.uvData.indexBuffer,
    islands: detected.islands,
    vertexToIslandId: detected.vertexToIslandId,
    spatial,
    size: templateWidth
  });
  const referenceB64 = await rgbaBufferToBase64Png(referenceBuffer);

  const fullPrompt = buildPrompt(req.prompt, templatePack.islands, spatial, hasPainted);

  const res = await fetch("/api/openai/edit-image", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      prompt: fullPrompt,
      imageBase64: templateB64,
      referenceImageBase64: referenceB64,
      size: `${templateWidth}x${templateHeight}`,
      quality: req.quality ?? DEFAULT_QUALITY
    })
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`gpt-image-2 edit failed (${res.status}): ${text}`);
  }

  const json = (await res.json()) as { data?: Array<{ b64_json?: string }> };
  const b64 = json.data?.[0]?.b64_json;
  if (!b64) throw new Error("API response missing b64_json");

  const aiRaw = await base64PngToRgbaBuffer(b64);
  // Extract from the AI output using the *template* layout (positions + cellPx
  // = 16 in 1024² space), then paint into the *atlas* layout (cellPx = 1 in
  // 256² space). cellsX × cellsY is identical across the two packings, so the
  // pixel-art buffers slot in 1:1.
  const islandPixelArt = extractIslandPixelArt(aiRaw, templatePack.islands);
  const recomposed = recomposeIslandsAsAtlas(
    atlasWidth,
    atlasHeight,
    atlasIslandsFinal,
    islandPixelArt
  );

  // Merge: where the user has painted (mask=1 in the input atlas), keep
  // the painted RGBA; everywhere else, accept the AI fill. The output
  // mask preserves the input mask so painted bits survive future
  // regenerates without re-painting.
  const atlasRgba = new Uint8ClampedArray(recomposed.data);
  const outputMask = new Uint8Array(recomposed.width * recomposed.height);
  if (req.atlas && hasPainted) {
    for (let p = 0; p < req.atlas.mask.length; p++) {
      if (req.atlas.mask[p] === 0) continue;
      outputMask[p] = 1;
      const di = p * 4;
      atlasRgba[di] = req.atlas.rgba[di];
      atlasRgba[di + 1] = req.atlas.rgba[di + 1];
      atlasRgba[di + 2] = req.atlas.rgba[di + 2];
      atlasRgba[di + 3] = 255;
    }
  }

  const atlas: Atlas = {
    rgba: atlasRgba,
    mask: outputMask,
    width: recomposed.width,
    height: recomposed.height
  };

  const islandLayout: IslandLayout = {
    templateWidth: atlasWidth,
    templateHeight: atlasHeight,
    islands: atlasIslandsFinal,
    uvRemap: atlasUvRemap,
    vertexToIslandId: detected.vertexToIslandId,
    newUvBuffer,
    spatial
  };

  // Store ONLY what we need to restore the surface: the small final atlas
  // (as outputB64 — also serves as the thumbnail) and the islandLayout (in
  // contextJson). The 1024² template + AI raw are transient debug data —
  // they live in SurfaceState for the current generation but aren't worth
  // 2 MB of IndexedDB per entry. Re-Apply uses just the atlas.
  const finalAtlasB64 = await rgbaBufferToBase64Png(recomposed);
  const contextJson = JSON.stringify({
    islandLayout: {
      templateWidth: islandLayout.templateWidth,
      templateHeight: islandLayout.templateHeight,
      islands: islandLayout.islands,
      uvRemap: islandLayout.uvRemap,
      vertexToIslandId: islandLayout.vertexToIslandId,
      newUv: Array.from(islandLayout.newUvBuffer),
      spatial: islandLayout.spatial
    }
  });
  saveEntry({
    source: MATERIAL_STUDIO_CACHE_SOURCE,
    prompt: req.prompt,
    tags: req.cacheTags ?? {},
    outputB64: finalAtlasB64,
    outputMimeType: "image/png",
    contextJson
  }).catch((err) => console.warn("[imagegen-cache] save failed:", err));

  return { atlas, aiRaw, templateSent, islandLayout };
}

function buildPrompt(
  userPrompt: string,
  islands: Island[],
  spatial: ReadonlyArray<IslandSpatialContext>,
  hasPainted: boolean
): string {
  const islandLines = islands.map((isl, idx) => {
    const sp = spatial[idx];
    const colorTag = sp ? hexTag(sp.color) : "";
    const role = sp ? `${sp.label} face (normal ${sp.axisName})` : "face";
    return `- Region ${idx + 1} — outlined in ${colorTag}, ${role}, ${isl.cellsX}×${isl.cellsY} cells: ${userPrompt}`;
  });
  const lines: string[] = [
    STYLE_PREAMBLE,
    `You receive TWO images. Image 1 is the UV unwrap to PAINT INTO. Image 2 is a 3D iso reference of the SAME mesh: each face is flat-shaded in the SAME colour used to outline that face's region in image 1.`,
    `Use image 2 only as spatial context — the mapping between an outlined region in the unwrap and a physical face on the mesh is encoded purely by its outline colour.`,
    `Image 1 has a neutral mid-grey background with several rectangular regions, each surrounded by a uniquely coloured outline.`,
    `Inside each outlined region is a grid of square cells separated by thin black lines.`,
    `Paint pixel art INSIDE the cells of each outlined region, treating each cell as ONE pixel.`,
    `Each cell must be filled with a single FLAT solid colour from edge to edge — no gradients, no anti-aliasing, no shading inside any cell.`,
    `Adjacent regions on the mesh share edges; visible motifs (joints, panel breaks, datum stripes) should align across regions that share a 3D edge — use image 2 to identify which regions are neighbours and which axis is up.`,
    `Do NOT paint anything outside the outlined regions; the grey background must remain UNTOUCHED.`,
    `Do NOT redraw the coloured outlines or the black grid lines.`,
    `Do NOT paint into image 2; output only the modified image 1.`,
  ];
  if (hasPainted) {
    lines.push(
      `Some cells have ALREADY been filled with specific colours by the artist. Those non-white cells must remain EXACTLY as-is — do not change their colour, brightness, or hue. Only paint the remaining white cells.`
    );
  }
  lines.push(
    `Each region depicts the same material on a different face of the mesh; paint each region with placement appropriate to its face role:`,
    ...islandLines
  );
  return lines.join(" ");
}

function hexTag(hex: number): string {
  return "#" + hex.toString(16).padStart(6, "0");
}

/** Build the AI template's island layout by SCALING the atlas's existing
 *  shelf-pack instead of running an independent pack. Each template
 *  island sits at (atlasIsland.x * scale, atlasIsland.y * scale) with
 *  cellPx = scale. The largest integer scale where every island still
 *  fits inside the template canvas wins, with a floor of 4 (any smaller
 *  and the cell interior collapses to <2 px and the AI can't tell cells
 *  apart). The atlas's compact 256² layout means scales of 4–6 are
 *  typical, giving the AI 4–6 px cells.
 *
 *  Why not just shelf-pack the template independently?
 *    Independent packs put islands in different relative positions
 *    (different cellPx + canvas size → different shelf wraps). The user
 *    paints in the atlas's layout, sees the AI template in a different
 *    layout, and reasonably concludes "the bake is wrong" even though
 *    extraction is correct via [i] indexing. Forcing the same layout
 *    removes the perceived mismatch entirely. */
function packTemplateAsScaledAtlas(
  atlasIslands: Island[],
  atlasWidth: number,
  atlasHeight: number,
  templateWidth: number,
  templateHeight: number
): { islands: Island[] } {
  const MIN_SCALE = 4;
  const maxScaleW = Math.floor(templateWidth / atlasWidth);
  const maxScaleH = Math.floor(templateHeight / atlasHeight);
  const scaleByDim = Math.max(MIN_SCALE, Math.min(maxScaleW, maxScaleH));
  // Even if the atlas canvas is large, only the *used* region needs to
  // fit. Compute the right/bottom extents of every island to allow a
  // larger scale when the atlas has unused tail.
  let usedRight = 0;
  let usedBottom = 0;
  for (const isl of atlasIslands) {
    const r = isl.x + isl.cellsX * isl.cellPx;
    const b = isl.y + isl.cellsY * isl.cellPx;
    if (r > usedRight) usedRight = r;
    if (b > usedBottom) usedBottom = b;
  }
  const scaleByUsedW = Math.floor(templateWidth / Math.max(1, usedRight));
  const scaleByUsedH = Math.floor(templateHeight / Math.max(1, usedBottom));
  const scale = Math.max(MIN_SCALE, Math.min(scaleByUsedW, scaleByUsedH, 16));
  const islands: Island[] = atlasIslands.map((src, idx) => ({
    x: src.x * scale,
    y: src.y * scale,
    cellsX: src.cellsX,
    cellsY: src.cellsY,
    cellPx: scale,
    name: src.name ?? `isl${idx}`,
  }));
  // Sanity: every island must lie inside the template canvas.
  for (const isl of islands) {
    if (
      isl.x + isl.cellsX * isl.cellPx > templateWidth ||
      isl.y + isl.cellsY * isl.cellPx > templateHeight
    ) {
      throw new Error(
        `packTemplateAsScaledAtlas: island spills outside ${templateWidth}×${templateHeight} at scale=${scale}`
      );
    }
  }
  return { islands };
}

function hasAnyPaintedCell(mask: Uint8Array<ArrayBuffer>): boolean {
  for (let i = 0; i < mask.length; i++) if (mask[i] !== 0) return true;
  return false;
}

/**
 * Pull a `cellsX × cellsY` rectangle of RGBA + mask out of the atlas at
 * the island's atlas-space bbox (cellPx=1, so cells == pixels).
 */
function extractIslandCellsFromAtlas(
  atlas: Atlas,
  island: Island
): { rgba: Uint8ClampedArray; mask: Uint8Array } {
  const w = island.cellsX;
  const h = island.cellsY;
  const rgba = new Uint8ClampedArray(w * h * 4);
  const mask = new Uint8Array(w * h);
  for (let cy = 0; cy < h; cy++) {
    for (let cx = 0; cx < w; cx++) {
      const ax = island.x + cx;
      const ay = island.y + cy;
      if (ax < 0 || ax >= atlas.width || ay < 0 || ay >= atlas.height) continue;
      const aIdx = ay * atlas.width + ax;
      const ai = aIdx * 4;
      const ci = (cy * w + cx) * 4;
      rgba[ci] = atlas.rgba[ai];
      rgba[ci + 1] = atlas.rgba[ai + 1];
      rgba[ci + 2] = atlas.rgba[ai + 2];
      rgba[ci + 3] = 255;
      mask[cy * w + cx] = atlas.mask[aIdx];
    }
  }
  return { rgba, mask };
}

// ---------------------------------------------------------------------------
// PNG <-> ImageData / RgbaBuffer
// ---------------------------------------------------------------------------

/** Convert ImageData to base64 PNG (for POSTing to the bake endpoint). */
export async function imageDataToBase64Png(imageData: ImageData): Promise<string> {
  const canvas = document.createElement("canvas");
  canvas.width = imageData.width;
  canvas.height = imageData.height;
  const ctx = canvas.getContext("2d")!;
  ctx.putImageData(imageData, 0, 0);
  return new Promise((resolve, reject) => {
    canvas.toBlob(async (blob) => {
      if (!blob) return reject(new Error("Failed to encode PNG"));
      const buf = await blob.arrayBuffer();
      const bytes = new Uint8Array(buf);
      let bin = "";
      const chunk = 0x8000;
      for (let i = 0; i < bytes.length; i += chunk) {
        bin += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + chunk)) as number[]);
      }
      resolve(btoa(bin));
    }, "image/png");
  });
}

async function rgbaBufferToBase64Png(buf: { data: Uint8ClampedArray; width: number; height: number }): Promise<string> {
  const canvas = document.createElement("canvas");
  canvas.width = buf.width;
  canvas.height = buf.height;
  const ctx = canvas.getContext("2d")!;
  const imageData = new ImageData(new Uint8ClampedArray(buf.data), buf.width, buf.height);
  ctx.putImageData(imageData, 0, 0);
  return new Promise((resolve, reject) => {
    canvas.toBlob(async (blob) => {
      if (!blob) return reject(new Error("Failed to encode PNG"));
      const arr = new Uint8Array(await blob.arrayBuffer());
      let bin = "";
      const chunk = 0x8000;
      for (let i = 0; i < arr.length; i += chunk) {
        bin += String.fromCharCode(...Array.from(arr.subarray(i, i + chunk)));
      }
      resolve(btoa(bin));
    }, "image/png");
  });
}

export async function base64PngToRgbaBuffer(b64: string): Promise<{ data: Uint8ClampedArray; width: number; height: number }> {
  const img = await decodeB64Png(b64);
  const canvas = document.createElement("canvas");
  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;
  const ctx = canvas.getContext("2d")!;
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(img, 0, 0);
  const id = ctx.getImageData(0, 0, canvas.width, canvas.height);
  return { data: id.data, width: id.width, height: id.height };
}

function decodeB64Png(b64: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("Failed to decode base64 PNG"));
    img.src = `data:image/png;base64,${b64}`;
  });
}

/**
 * Decode a base64 PNG into ImageData at its native size — used by the
 * library hydration path when re-loading a previously-baked entry.
 */
export async function base64PngToImageData(b64: string): Promise<ImageData> {
  const img = await decodeB64Png(b64);
  const canvas = document.createElement("canvas");
  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;
  const ctx = canvas.getContext("2d")!;
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(img, 0, 0);
  return ctx.getImageData(0, 0, canvas.width, canvas.height);
}
