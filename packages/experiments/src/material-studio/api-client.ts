/**
 * Prompt + image-generation primitives for Material Studio.
 *
 * Catalog calls live in ./api/catalog-client.ts; bake calls live in
 * ./api/bake-client.ts. This module is just the things both sides need:
 * prompt seeds, the OpenAI-backed baseColor generator, and PNG <-> ImageData
 * helpers.
 */

// ---------------------------------------------------------------------------
// Year 2200 style preamble — shared across prompts
// ---------------------------------------------------------------------------

const STYLE_PREAMBLE = [
  "Year 2200 sci-fi architectural surface.",
  "Material looks carved from dense white mineral or architectural ceramic.",
  "Pristine, clean, no damage, no grime, no decay, no texture clutter.",
  "Flat, non-dramatic, even lighting baked into the albedo (no shadows, no specular highlights — PBR handles that at runtime).",
  "Top-down view, perfectly flat, no perspective, no 3D shading.",
  "Crisp pixel art with large flat-colour blocks, no anti-aliasing, no gradients, no dithering.",
].join(" ");

const TARGET_SIZE = 64;

// ---------------------------------------------------------------------------
// Per-role prompt seeds — keyed by textureRole, not by material id
// ---------------------------------------------------------------------------

export const ROLE_PROMPT_SEEDS: Record<string, string> = {
  wall: "exterior wall panel, dense white architectural ceramic with fine structural joints forming a clean rectangular grid, very minimal surface variation, monolithic and heavy. Limited palette: warm white, faint cream, very subtle warm grey joint lines.",
  trim: "accent trim strip, clean horizontal bands of burnt industrial amber on a dark structural substrate, functional marker stripe at an architectural datum, not decorative. Limited palette: burnt amber #B8430E, dark amber #8A3000, near-black structural dark #1a1a1a.",
  grass: "exterior ground, pale mineral aggregate with sparse subdued vegetation breaking through joints, muted and calm, passive aging only. Limited palette: pale grey, muted sage green, faint warm stone.",
  sandstone: "exterior pavers, warm mineral stone with subtle rectilinear grid, clean and well-maintained. Limited palette: warm beige, cream, soft grey joint lines.",
  asphalt: "utility floor surface, dark neutral composite, subtle rectilinear grid embossed into the surface, clean and well-maintained, infrastructure-grade. Limited palette: dark charcoal #2a2a2a, slightly lighter grey grid lines, very dark neutral.",
  concrete_walk: "exterior paving tile, pale mineral composite with clean rectilinear joints, infrastructure-grade, pristine. Limited palette: light grey, near-white, faint cool grey joint lines.",
};

export function defaultPromptForRole(role: string): string {
  return ROLE_PROMPT_SEEDS[role] ?? role.replace(/_/g, " ");
}

// ---------------------------------------------------------------------------
// Image generation
// ---------------------------------------------------------------------------

/**
 * Generate a pixel-art baseColor texture via OpenAI.
 * Returns a 64×64 ImageData after nearest-neighbour downscale.
 */
export async function generateBaseColor(prompt: string): Promise<ImageData> {
  const fullPrompt = [
    STYLE_PREAMBLE,
    `Seamless tileable ${TARGET_SIZE}x${TARGET_SIZE} pixel art texture of: ${prompt}.`,
    `Each distinct visual element must be at least 6-8 pixels wide so it reads clearly at small sizes.`,
    `The texture must tile perfectly — edges wrap seamlessly in both X and Y.`,
    `Output as a crisp ${TARGET_SIZE}x${TARGET_SIZE} pixel grid with no smoothing or interpolation.`
  ].join(" ");

  const res = await fetch("/api/openai/generate-image", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt: fullPrompt, size: "1024x1024", quality: "high" })
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Image generation failed: ${err}`);
  }

  const data = await res.json();
  const b64: string | undefined = data.data?.[0]?.b64_json;
  if (!b64) throw new Error("No image data in response");

  const img = await decodeB64Png(b64);
  return nearestDownsample(img, TARGET_SIZE);
}

// ---------------------------------------------------------------------------
// PNG <-> ImageData
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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function decodeB64Png(b64: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("Failed to decode base64 PNG"));
    img.src = `data:image/png;base64,${b64}`;
  });
}

/**
 * Decode a base64 PNG into ImageData at its native size — used for the edit
 * round-trip. The bytes-on-disk are top-down (the same orientation as
 * `generateBaseColor` produces), so no flipping happens here; the flip is
 * applied downstream by `createTextureSet`.
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

function nearestDownsample(img: HTMLImageElement, size: number): ImageData {
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(img, 0, 0, size, size);
  return ctx.getImageData(0, 0, size, size);
}
