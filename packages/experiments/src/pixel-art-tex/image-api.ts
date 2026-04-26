import {
  buildGridPng,
  buildSyntheticTestPattern,
  extractPixelArt,
  renderPatternThroughGrid,
  type RgbaBuffer
} from "./pixel-grid";

/**
 * Browser-side helpers for the AI grid round-trip.
 *
 * Splits cleanly from `pixel-grid.ts` so the latter stays DOM-free and
 * unit-testable.
 */

export type GenerateRequest = {
  /** Target texel grid dimensions. */
  cellsX: number;
  cellsY: number;
  /** Source-image cell size (px). The grid PNG is `cellsX*cellPx × cellsY*cellPx`. */
  cellPx: number;
  /** User-authored prompt describing the texture content. */
  userPrompt: string;
};

export type GenerateResult = {
  /** The grid PNG sent to the API (so the UI can show what was sent). */
  gridSent: RgbaBuffer;
  /** The raw pixel buffer returned by the API, decoded at native size. */
  aiRaw: RgbaBuffer;
  /** Post-processed pixel art — `cellsX × cellsY`. */
  pixelArt: RgbaBuffer;
};

const SIZE_FOR_DIM: Record<string, string> = {
  "1024x1024": "1024x1024",
  "1024x1536": "1024x1536",
  "1536x1024": "1536x1024"
};

/**
 * Round-trip a prompt through the grid → AI → post-process pipeline.
 *
 * Throws if the grid PNG dimensions don't match a supported OpenAI image
 * size — pick (cellsX·cellPx, cellsY·cellPx) ∈ {(1024,1024), (1024,1536),
 * (1536,1024)} when configuring the experiment.
 */
export async function generateFromGrid(req: GenerateRequest): Promise<GenerateResult> {
  const grid = buildGridPng({
    cellsX: req.cellsX,
    cellsY: req.cellsY,
    cellPx: req.cellPx,
    // 4-px lines are robust across all quality tiers; 2-px got denoised
    // away at gpt-image-1 low/medium. Still sampled cleanly because the
    // cell-centre sampler skips the outer 25% of each cell.
    lineThicknessPx: 4,
    // Send the outer frame too — without it, gpt-image-2 "completes" the
    // missing border anyway (the model reads the grid as a closed pattern
    // and synthesises the missing edge). Sending the frame keeps input
    // and output structurally identical, which improves the model's
    // adherence to the cell layout.
    drawOuterFrame: true
  });
  const sizeKey = `${grid.width}x${grid.height}`;
  const apiSize = SIZE_FOR_DIM[sizeKey];
  if (!apiSize) {
    throw new Error(
      `Grid size ${sizeKey} not supported by gpt-image-2 edits endpoint. ` +
        `Choose cellsX·cellPx × cellsY·cellPx ∈ {1024×1024, 1024×1536, 1536×1024}.`
    );
  }

  const gridPngBase64 = await bufferToPngBase64(grid);

  const fullPrompt = buildPrompt(req);

  const res = await fetch("/api/openai/edit-image", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      prompt: fullPrompt,
      imageBase64: gridPngBase64,
      size: apiSize,
      // gpt-image-2's "low" tier is much higher quality than v1's, so the
      // grid trick survives even at the fastest setting (~15-30s).
      quality: "low"
    })
  });

  if (!res.ok) {
    const errBody = await res.text();
    throw new Error(`gpt-image-2 edit failed (${res.status}): ${errBody}`);
  }

  const data = (await res.json()) as { data?: Array<{ b64_json?: string }> };
  const b64 = data.data?.[0]?.b64_json;
  if (!b64) throw new Error("API response missing b64_json");

  const aiRaw = await pngBase64ToBuffer(b64);

  const pixelArt = extractPixelArt(aiRaw, {
    cellsX: req.cellsX,
    cellsY: req.cellsY,
    cellPx: req.cellPx
  });

  return { gridSent: grid, aiRaw, pixelArt };
}

function buildPrompt(req: GenerateRequest): string {
  return [
    `The provided image is a ${req.cellsX}-by-${req.cellsY} grid of ${req.cellsX * req.cellsY} square cells separated by thin grid lines.`,
    `Paint pixel art INSIDE the cells of this grid, treating each cell as ONE pixel.`,
    `Each cell must be filled with a single FLAT solid colour from edge to edge of the cell — no gradients, no anti-aliasing, no shading inside any cell, no detail smaller than one cell.`,
    `Adjacent cells should differ in colour where the artwork demands it; do not blend colours across cell boundaries.`,
    `Do not redraw the grid lines; the post-processor reads only cell interiors.`,
    `Subject: ${req.userPrompt}`,
    `Style: bright saturated pixel art with the deliberate, chunky look of a 16-bit-era game.`
  ].join(" ");
}

/**
 * Browser-only: convert an RgbaBuffer to a PNG base64 string via canvas.
 */
export async function bufferToPngBase64(buf: RgbaBuffer): Promise<string> {
  const canvas = document.createElement("canvas");
  canvas.width = buf.width;
  canvas.height = buf.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas 2D unavailable");
  const imageData = new ImageData(
    new Uint8ClampedArray(buf.data),
    buf.width,
    buf.height
  );
  ctx.putImageData(imageData, 0, 0);
  return new Promise((resolve, reject) => {
    canvas.toBlob(async (blob) => {
      if (!blob) {
        reject(new Error("toBlob failed"));
        return;
      }
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

/**
 * Browser-only: decode a base64 PNG into an RgbaBuffer at native resolution.
 */
export async function pngBase64ToBuffer(b64: string): Promise<RgbaBuffer> {
  const img = await new Promise<HTMLImageElement>((resolve, reject) => {
    const el = new Image();
    el.onload = () => resolve(el);
    el.onerror = () => reject(new Error("PNG decode failed"));
    el.src = `data:image/png;base64,${b64}`;
  });
  const canvas = document.createElement("canvas");
  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas 2D unavailable");
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(img, 0, 0);
  const id = ctx.getImageData(0, 0, canvas.width, canvas.height);
  return { data: id.data, width: id.width, height: id.height };
}

/**
 * Local "synthetic" mode: build the deterministic test pattern at the texel
 * resolution and synthesise the in-grid PNG as if the AI returned it. Used
 * for the e2e pixel-verification test and as a no-API fallback in the UI.
 */
export function syntheticArtifacts(req: GenerateRequest): GenerateResult {
  const grid = buildGridPng({
    cellsX: req.cellsX,
    cellsY: req.cellsY,
    cellPx: req.cellPx
  });
  const pixelArt = buildSyntheticTestPattern(req.cellsX, req.cellsY);
  const aiRaw = renderPatternThroughGrid(pixelArt, {
    cellsX: req.cellsX,
    cellsY: req.cellsY,
    cellPx: req.cellPx
  });
  return { gridSent: grid, aiRaw, pixelArt };
}
