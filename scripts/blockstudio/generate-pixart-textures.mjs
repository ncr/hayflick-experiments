#!/usr/bin/env node

/**
 * Generate pixel-art tileable baseColor textures via OpenAI gpt-image-1.
 *
 * For each material in registry.json, generates a tileable pixel-art
 * texture with large flat-colour shapes that read cleanly at the game's
 * pixel budget (32px/cell). The result replaces the old baseColor entry
 * so Blender embeds it in the GLB on the next `pnpm run rebuild`.
 *
 * Normal and ARM maps stay at their source resolution — only the diffuse
 * (baseColor) gets the pixel-art treatment.
 *
 * Usage:
 *   node scripts/blockstudio/generate-pixart-textures.mjs
 *   node scripts/blockstudio/generate-pixart-textures.mjs --only cobblestone_floor_04
 *   node scripts/blockstudio/generate-pixart-textures.mjs --size 64
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..");
const MATERIALS_DIR = path.join(REPO_ROOT, "assets/materials");
const REGISTRY_PATH = path.join(MATERIALS_DIR, "registry.json");
const POLYHAVEN_DIR = path.join(MATERIALS_DIR, "polyhaven");
const DEV_SERVER = process.env.DEV_SERVER || "http://localhost:5173";

// Target pixel-art texture size. 64×64 gives 1:1 texel-to-game-pixel
// mapping at the standard texturePixelsPerGamePixel=2 density.
const DEFAULT_TARGET_SIZE = 64;

// ---------------------------------------------------------------------------
// Style guide — Year 2200 Isometric Architecture
//
// Clean white mineral surfaces (carved Greek sandstone / dense ceramic).
// Monolithic, rectilinear, pristine. Single accent: burnt amber #B8430E.
// No clutter, no ornament, no micro-detail. Calm, sterile, structured.
// ---------------------------------------------------------------------------

const STYLE_PREAMBLE = [
  "Year 2200 sci-fi architectural surface.",
  "Material looks carved from dense white mineral or architectural ceramic.",
  "Pristine, clean, no damage, no grime, no decay, no texture clutter.",
  "Flat, non-dramatic, even lighting baked into the albedo (no shadows, no specular highlights — PBR handles that at runtime).",
  "Top-down view, perfectly flat, no perspective, no 3D shading.",
  "Crisp pixel art with large flat-colour blocks, no anti-aliasing, no gradients, no dithering.",
].join(" ");

const MATERIAL_DESCRIPTIONS = {
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

function flag(name, fallback) {
  const i = process.argv.indexOf(name);
  return i !== -1 && i + 1 < process.argv.length ? process.argv[i + 1] : fallback;
}

async function generateTexture(materialId, desc, palette, targetSize) {
  const prompt = [
    STYLE_PREAMBLE,
    `Seamless tileable ${targetSize}x${targetSize} pixel art texture of: ${desc}.`,
    `Each distinct visual element must be at least 6-8 pixels wide so it reads clearly at small sizes.`,
    `Limited palette: ${palette}.`,
    `The texture must tile perfectly — edges wrap seamlessly in both X and Y.`,
    `Output as a crisp ${targetSize}x${targetSize} pixel grid with no smoothing or interpolation.`
  ].join(" ");

  console.error(`[gen] ${materialId}: generating...`);

  const res = await fetch(`${DEV_SERVER}/api/openai/generate-image`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt, size: "1024x1024", quality: "high" })
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`API error for ${materialId}: ${err}`);
  }

  const data = await res.json();
  const b64 = data.data?.[0]?.b64_json;
  if (!b64) throw new Error(`No image data for ${materialId}`);

  return Buffer.from(b64, "base64");
}

async function main() {
  const only = flag("--only", null);
  const targetSize = Number(flag("--size", String(DEFAULT_TARGET_SIZE)));
  const registry = JSON.parse(fs.readFileSync(REGISTRY_PATH, "utf-8"));
  const materialIds = only
    ? [only]
    : Object.keys(registry.materials);

  let generated = 0;

  for (const id of materialIds) {
    const entry = registry.materials[id];
    if (!entry) {
      console.error(`[gen] ${id}: not in registry, skipping`);
      continue;
    }
    const info = MATERIAL_DESCRIPTIONS[id];
    if (!info) {
      console.error(`[gen] ${id}: no description configured, skipping`);
      continue;
    }

    try {
      const pngBuffer = await generateTexture(id, info.desc, info.palette, targetSize);

      // Save the raw 1024×1024 generation
      const dir = path.join(POLYHAVEN_DIR, id);
      fs.mkdirSync(dir, { recursive: true });
      const rawName = `${id}_diff_pixart_raw.png`;
      fs.writeFileSync(path.join(dir, rawName), pngBuffer);

      // Downscale to target size with nearest-neighbour (preserve pixel art)
      const targetName = `${id}_diff_pixart.png`;
      const targetPath = path.join(dir, targetName);
      const { execFileSync } = await import("node:child_process");
      execFileSync("magick", [
        path.join(dir, rawName),
        "-filter", "Point",
        "-resize", `${targetSize}x${targetSize}`,
        targetPath
      ]);

      // Update registry
      entry.maps.baseColor = targetName;
      entry.style = {
        kind: "pixel_art_generated",
        targetSize,
        generator: "gpt-image-1",
        generatedAt: new Date().toISOString()
      };
      generated += 1;
      console.error(`[gen] ${id}: saved ${targetName} (${targetSize}×${targetSize})`);
    } catch (err) {
      console.error(`[gen] ${id}: FAILED — ${err.message}`);
    }
  }

  fs.writeFileSync(REGISTRY_PATH, JSON.stringify(registry, null, 2) + "\n");
  console.log(`[gen] done: ${generated} textures generated, registry updated`);
}

main();
