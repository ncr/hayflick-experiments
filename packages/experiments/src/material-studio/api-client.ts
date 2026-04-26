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
  type Island
} from "../uv-template-probe/uv-template";
import { detectIslands } from "./uv-template/island-detect";
import { repackIslands } from "./uv-template/repack";
import { recomposeIslandsAsAtlas } from "./uv-template/recompose";
import { remapUvs } from "./uv-template/remap-uvs";
import type {
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
const DEFAULT_CELL_PX_TARGET = 16;

// Atlas = the final pixel-dense texture stored in the GLB and the cache.
// One atlas pixel = one logical pixel-art cell. 256² has plenty of room for
// dozens of typical mesh islands while keeping baked PNGs ~10× smaller than
// the template would have been. Bump to 512² via opts if a mesh has more
// islands than will pack.
const DEFAULT_ATLAS_W = 256;
const DEFAULT_ATLAS_H = 256;
const ATLAS_CELL_PX = 1;
const ATLAS_OUTLINE_PADDING_PX = 3; // matches the recompose seam-bleed default

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

  // Two independent packings, same logical island count + cellsX×cellsY:
  //   * templatePack — chunky cells (cellPx=16) on a 1024² canvas, just for
  //     gpt-image-2 to paint legibly. Transient.
  //   * atlasPack — one cell per atlas pixel on a 256² canvas. This is what
  //     the GLB samples at runtime and what the cache stores.
  const templatePack = repackIslands(detected, {
    templateWidth,
    templateHeight,
    cellPx: templateCellPx,
    cellPxTarget
  });
  const atlasPack = repackIslands(detected, {
    templateWidth: atlasWidth,
    templateHeight: atlasHeight,
    cellPx: ATLAS_CELL_PX,
    cellPxTarget,
    outlinePaddingPx: ATLAS_OUTLINE_PADDING_PX
  });

  const newUvBuffer = remapUvs(
    req.uvData.uvBuffer,
    detected.vertexToIslandId,
    atlasPack.uvRemap,
    atlasWidth,
    atlasHeight
  );

  const templateOpts = {
    width: templateWidth,
    height: templateHeight,
    islands: templatePack.islands
  };
  const templateSent = buildIslandTemplate(templateOpts);
  const templateB64 = await rgbaBufferToBase64Png(templateSent);

  const fullPrompt = buildPrompt(req.prompt, templatePack.islands);

  const res = await fetch("/api/openai/edit-image", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      prompt: fullPrompt,
      imageBase64: templateB64,
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
    atlasPack.islands,
    islandPixelArt
  );

  const baseColor = new ImageData(
    new Uint8ClampedArray(recomposed.data),
    recomposed.width,
    recomposed.height
  );

  const islandLayout: IslandLayout = {
    templateWidth: atlasWidth,
    templateHeight: atlasHeight,
    islands: atlasPack.islands,
    uvRemap: atlasPack.uvRemap,
    vertexToIslandId: detected.vertexToIslandId,
    newUvBuffer
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
      newUv: Array.from(islandLayout.newUvBuffer)
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

  return { baseColor, aiRaw, templateSent, islandLayout };
}

function buildPrompt(userPrompt: string, islands: Island[]): string {
  const islandLines = islands.map((isl, idx) => {
    const name = isl.name ?? `Region ${idx + 1}`;
    return `- ${name} (${isl.cellsX}×${isl.cellsY} cells): ${userPrompt}`;
  });
  return [
    STYLE_PREAMBLE,
    `The provided image has a neutral mid-grey background with several rectangular regions outlined in bright magenta.`,
    `Inside each magenta-outlined region is a grid of square cells separated by thin black lines.`,
    `Paint pixel art INSIDE the cells of each outlined region, treating each cell as ONE pixel.`,
    `Each cell must be filled with a single FLAT solid colour from edge to edge — no gradients, no anti-aliasing, no shading inside any cell.`,
    `Do NOT paint anything outside the outlined regions; the grey background must remain UNTOUCHED.`,
    `Do NOT redraw the magenta outlines or the black grid lines.`,
    `Each region depicts the same material; paint each region according to the subject below:`,
    ...islandLines
  ].join(" ");
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
