/**
 * API wrappers for the texture workshop.
 *
 * - generateBaseColor: prompt → 1024×1024 via OpenAI → nearest-downsample to 64×64
 * - loadMaterialRegistry: GET registry.json
 * - saveTexturesToAssets: write 3 PNGs + patch registry
 */

// ---------------------------------------------------------------------------
// Year 2200 style preamble — same as the former generate-pixart-textures.mjs
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
// Material descriptions (embedded from generate-pixart-textures.mjs)
// ---------------------------------------------------------------------------

export const MATERIAL_DESCRIPTIONS: Record<string, { desc: string; palette: string }> = {
  white_plaster_02: {
    desc: "interior wall panel surface, dense white mineral ceramic, very subtle rectilinear panel seams forming a large modular grid, almost flat white with barely visible hairline joints",
    palette: "pure white, off-white, very faint cool grey for panel seams"
  },
  blue_painted_planks: {
    desc: "accent trim strip, clean horizontal bands of burnt industrial amber on a dark structural substrate, functional marker stripe at an architectural datum, not decorative",
    palette: "burnt amber #B8430E, dark amber #8A3000, near-black structural dark #1a1a1a"
  },
  sandstone_cracks: {
    desc: "exterior wall panel, dense white architectural ceramic with fine structural joints forming a clean rectangular grid, very minimal surface variation, monolithic and heavy",
    palette: "warm white, faint cream, very subtle warm grey joint lines"
  },
  weathered_brown_planks: {
    desc: "accent structural panel, clean amber-tinted horizontal bands, functional infrastructure marking, subtle grain-like linear texture within each band",
    palette: "burnt amber #B8430E, dark amber, very dark brown structural base"
  },
  cobblestone_floor_04: {
    desc: "modular floor tile, clean white mineral ceramic, precise square grid pattern with thin recessed joints, each tile perfectly flat and uniform, no variation between tiles except the joint lines",
    palette: "light warm grey, white, thin dark grey joint lines"
  },
  asphalt_04: {
    desc: "utility floor surface, dark neutral composite, subtle rectilinear grid embossed into the surface, clean and well-maintained, infrastructure-grade",
    palette: "dark charcoal #2a2a2a, slightly lighter grey grid lines, very dark neutral"
  },
  concrete_wall_004: {
    desc: "interior wall surface, white mineral panel with very faint formwork marks, large flat areas with minimal texture, clean and pristine, monolithic feel",
    palette: "white, off-white, barely visible cool grey marks"
  },
  forrest_ground_01: {
    desc: "exterior ground surface, pale mineral aggregate with sparse subdued vegetation breaking through joints, muted and calm, passive aging only",
    palette: "pale grey, muted sage green, faint warm stone"
  },
  aerial_grass_rock: {
    desc: "exterior terrain, white mineral pavers with sparse muted ground cover between joints, depopulated and well-maintained but slightly overgrown, calm and structured",
    palette: "light grey stone, muted olive green, warm sand"
  },
  beige_wall_001: {
    desc: "interior wall panel, warm-toned mineral ceramic, smooth and pristine with barely visible modular panel seams, monolithic and heavy",
    palette: "warm white, faint cream, very subtle warm grey seams"
  },
  rusty_metal_02: {
    desc: "structural utility panel, dark metal composite with amber indicator markings, recessed control surface with clean geometric cutouts, functional not decorative",
    palette: "dark gunmetal grey, amber #B8430E indicator lines, near-black"
  }
};

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

  // Decode b64 PNG → Image → nearest-downsample to 64×64
  const img = await decodeB64Png(b64);
  return nearestDownsample(img, TARGET_SIZE);
}

/** Build the full prompt for a material, including style preamble + description + palette. */
export function buildPromptForMaterial(materialId: string, customPrompt?: string): string {
  const info = MATERIAL_DESCRIPTIONS[materialId];
  if (customPrompt) return customPrompt;
  if (!info) return materialId.replace(/_/g, " ");
  return `${info.desc}. Limited palette: ${info.palette}.`;
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

export type MaterialRegistryEntry = {
  source: string;
  sourceId: string;
  category: string;
  maps: { baseColor: string; normal: string; arm: string };
  defaults: { roughnessFactor: number; metallicFactor: number };
  physicalScaleM: number;
  resolution: string;
  style?: {
    kind: string;
    targetSize: number;
    generator: string;
    generatedAt: string;
  };
};

export type MaterialRegistry = {
  materials: Record<string, MaterialRegistryEntry>;
};

export async function loadMaterialRegistry(): Promise<MaterialRegistry> {
  const res = await fetch("/api/assets/read?path=materials/registry.json");
  if (!res.ok) throw new Error(`Failed to load registry: ${res.status}`);
  const json = await res.json();
  const content = typeof json.content === "string" ? JSON.parse(json.content) : json;
  return content as MaterialRegistry;
}

// ---------------------------------------------------------------------------
// Save
// ---------------------------------------------------------------------------

/**
 * Save generated textures to assets and update the registry.
 *
 * Writes 3 PNGs (baseColor, normal, arm) under polyhaven/<materialId>/
 * and patches registry.json with updated maps + style metadata.
 */
export async function saveTexturesToAssets(
  materialId: string,
  maps: { baseColor: ImageData; normal: ImageData; arm: ImageData }
): Promise<void> {
  const dir = `materials/polyhaven/${materialId}`;

  // Write each map as PNG
  const writes = [
    { key: "baseColor" as const, suffix: "diff_pixart" },
    { key: "normal" as const, suffix: "nor_pixart" },
    { key: "arm" as const, suffix: "arm_pixart" }
  ];

  for (const { key, suffix } of writes) {
    const arrayBuf = await imageDataToPngArrayBuffer(maps[key]);
    const filename = `${materialId}_${suffix}.png`;
    const writePath = `${dir}/${filename}`;
    const res = await fetch(`/api/assets/write?path=${encodeURIComponent(writePath)}`, {
      method: "POST",
      headers: { "Content-Type": "image/png" },
      body: arrayBuf
    });
    if (!res.ok) throw new Error(`Failed to write ${writePath}: ${res.status}`);
  }

  // Patch registry
  const registry = await loadMaterialRegistry();
  const entry = registry.materials[materialId];
  if (entry) {
    entry.maps.baseColor = `${materialId}_diff_pixart.png`;
    entry.maps.normal = `${materialId}_nor_pixart.png`;
    entry.maps.arm = `${materialId}_arm_pixart.png`;
    entry.resolution = "64";
    entry.style = {
      kind: "pixel_art_generated",
      targetSize: TARGET_SIZE,
      generator: "gpt-image-1",
      generatedAt: new Date().toISOString()
    };

    const regJson = JSON.stringify(registry, null, 2) + "\n";
    const res = await fetch("/api/assets/write?path=materials/registry.json", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: regJson
    });
    if (!res.ok) throw new Error(`Failed to update registry: ${res.status}`);
  }
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

function nearestDownsample(img: HTMLImageElement, size: number): ImageData {
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(img, 0, 0, size, size);
  return ctx.getImageData(0, 0, size, size);
}

function imageDataToPngArrayBuffer(imageData: ImageData): Promise<ArrayBuffer> {
  const canvas = document.createElement("canvas");
  canvas.width = imageData.width;
  canvas.height = imageData.height;
  const ctx = canvas.getContext("2d")!;
  ctx.putImageData(imageData, 0, 0);
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) blob.arrayBuffer().then(resolve, reject);
      else reject(new Error("Failed to encode PNG"));
    }, "image/png");
  });
}
