import {
  buildIslandTemplate,
  extractIslandPixelArt,
  renderPatternsThroughTemplate,
  type Island,
  type IslandTemplateOptions,
  type RgbaBuffer
} from "./uv-template";

/**
 * Browser-side helpers for the multi-island UV-template probe.
 *
 * Reuses the `/api/openai/edit-image` endpoint plumbed for `pixel-art-tex`
 * (Responses API → gpt-image-2 image_generation tool).
 */

export type GenerateRequest = {
  template: IslandTemplateOptions;
  /** Per-island subject hints — one per island, same order as template.islands. */
  islandPrompts: string[];
  /** Quality tier for gpt-image-2. Default "low". */
  quality?: "low" | "medium" | "high";
};

export type GenerateResult = {
  /** What we sent to the model. */
  templateSent: RgbaBuffer;
  /** Raw model output, decoded at native resolution. */
  aiRaw: RgbaBuffer;
  /** One pixel-art buffer per island, in the same order as template.islands. */
  islandPixelArt: RgbaBuffer[];
};

const SUPPORTED_SIZES: Record<string, true> = {
  "1024x1024": true,
  "1024x1536": true,
  "1536x1024": true
};

export async function generateFromTemplate(req: GenerateRequest): Promise<GenerateResult> {
  if (req.islandPrompts.length !== req.template.islands.length) {
    throw new Error(
      `${req.islandPrompts.length} island prompts but ${req.template.islands.length} islands`
    );
  }
  const sizeKey = `${req.template.width}x${req.template.height}`;
  if (!SUPPORTED_SIZES[sizeKey]) {
    throw new Error(
      `Template size ${sizeKey} not supported by gpt-image-2 (need 1024×1024, 1024×1536, or 1536×1024).`
    );
  }

  const templateSent = buildIslandTemplate(req.template);
  const templateB64 = await bufferToPngBase64(templateSent);

  const fullPrompt = buildPrompt(req);

  const res = await fetch("/api/openai/edit-image", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      prompt: fullPrompt,
      imageBase64: templateB64,
      size: sizeKey,
      quality: req.quality ?? "low"
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
  const islandPixelArt = extractIslandPixelArt(aiRaw, req.template.islands);

  return { templateSent, aiRaw, islandPixelArt };
}

function buildPrompt(req: GenerateRequest): string {
  const { template, islandPrompts } = req;
  const islandLines = template.islands.map((isl, idx) => {
    const name = isl.name ?? `Region ${idx + 1}`;
    return `- ${name} (${isl.cellsX}×${isl.cellsY} cells): ${islandPrompts[idx]}`;
  });
  return [
    `The provided image has a neutral mid-grey background with several rectangular regions outlined in bright magenta.`,
    `Inside each magenta-outlined region is a grid of square cells separated by thin black lines.`,
    `Paint pixel art INSIDE the cells of each outlined region, treating each cell as ONE pixel.`,
    `Each cell must be filled with a single FLAT solid colour from edge to edge — no gradients, no anti-aliasing, no shading inside any cell.`,
    `Do NOT paint anything outside the outlined regions; the grey background must remain UNTOUCHED.`,
    `Do NOT redraw the magenta outlines or the black grid lines.`,
    `Each region depicts a different subject, listed below — paint each region according to its own subject:`,
    ...islandLines,
    `Style: bright saturated pixel art with the deliberate chunky look of a 16-bit-era game.`
  ].join(" ");
}

/**
 * Local "no API" mode: synthesise per-island patterns and paint them through
 * the template as if the AI returned them. Useful for UI/UX iteration and
 * for the round-trip extraction unit test.
 */
export function syntheticArtifacts(req: GenerateRequest): GenerateResult {
  const templateSent = buildIslandTemplate(req.template);
  const islandPixelArt = req.template.islands.map((isl, idx) =>
    buildSyntheticIslandPattern(isl, idx)
  );
  const aiRaw = renderPatternsThroughTemplate(islandPixelArt, req.template);
  return { templateSent, aiRaw, islandPixelArt };
}

function buildSyntheticIslandPattern(island: Island, islandIdx: number): RgbaBuffer {
  const data = new Uint8ClampedArray(island.cellsX * island.cellsY * 4);
  const palettes: Array<Array<[number, number, number]>> = [
    [
      [255, 0, 0],
      [255, 128, 0],
      [255, 200, 0]
    ],
    [
      [0, 80, 200],
      [0, 160, 220],
      [120, 220, 255]
    ],
    [
      [50, 150, 50],
      [120, 200, 80],
      [200, 240, 120]
    ],
    [
      [180, 60, 200],
      [220, 100, 240],
      [255, 180, 240]
    ]
  ];
  const palette = palettes[islandIdx % palettes.length];
  for (let y = 0; y < island.cellsY; y++) {
    for (let x = 0; x < island.cellsX; x++) {
      const idx = (x + y * 3 + islandIdx) % palette.length;
      const [r, g, b] = palette[idx];
      const i = (y * island.cellsX + x) * 4;
      data[i] = r;
      data[i + 1] = g;
      data[i + 2] = b;
      data[i + 3] = 255;
    }
  }
  return { data, width: island.cellsX, height: island.cellsY };
}

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
