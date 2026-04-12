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

// Material descriptions for the image generation prompt.
// These describe what the pixel-art texture should depict.
const MATERIAL_DESCRIPTIONS = {
  white_plaster_02: {
    desc: "white plaster wall, smooth stucco surface with subtle cracks and stains",
    palette: "white, off-white, light grey, faint yellow-grey"
  },
  blue_painted_planks: {
    desc: "blue painted wooden planks, horizontal wood grain, peeling paint",
    palette: "cobalt blue, dark blue, navy, light blue highlights"
  },
  sandstone_cracks: {
    desc: "sandstone wall surface with natural cracks and weathering",
    palette: "warm tan, sandy beige, ochre, brown crack lines"
  },
  weathered_brown_planks: {
    desc: "weathered brown wooden planks, aged wood grain, horizontal boards",
    palette: "dark brown, warm brown, tan, dark grain lines"
  },
  cobblestone_floor_04: {
    desc: "cobblestone floor, large rounded stones fitted together with dark mortar gaps",
    palette: "grey, warm grey, dark grey mortar, slight brown and blue-grey variation"
  },
  asphalt_04: {
    desc: "dark asphalt road surface, slightly rough, small aggregate pebbles",
    palette: "dark charcoal, grey, dark grey, subtle warm spots"
  },
  concrete_wall_004: {
    desc: "concrete wall, poured concrete with form marks and subtle staining",
    palette: "neutral grey, light grey, slight blue-grey, faint stain spots"
  },
  forrest_ground_01: {
    desc: "forest floor with leaves, twigs, and earth patches",
    palette: "dark green, brown, dark brown, olive, tan leaf spots"
  },
  aerial_grass_rock: {
    desc: "grass and rock ground, patches of green grass between exposed stone",
    palette: "green, dark green, grey rock, brown earth"
  },
  beige_wall_001: {
    desc: "beige plastered wall, smooth interior wall finish",
    palette: "beige, cream, warm grey, faint warm spots"
  },
  rusty_metal_02: {
    desc: "rusty metal surface, corroded steel with rust patches and bare metal",
    palette: "rust orange, dark brown, dark grey metal, bright rust spots"
  }
};

function flag(name, fallback) {
  const i = process.argv.indexOf(name);
  return i !== -1 && i + 1 < process.argv.length ? process.argv[i + 1] : fallback;
}

async function generateTexture(materialId, desc, palette, targetSize) {
  const prompt = [
    `Seamless tileable ${targetSize}x${targetSize} pixel art texture of: ${desc}.`,
    `Style: chunky pixel art with large flat-colour blocks, no anti-aliasing, no gradients, no dithering.`,
    `Each distinct visual element (stone, plank, crack) must be at least 6-8 pixels wide so it reads clearly at small sizes.`,
    `Limited palette: ${palette}.`,
    `The texture must tile perfectly — edges wrap seamlessly in both X and Y.`,
    `Top-down view, flat, no perspective, no 3D shading (lighting comes from PBR normal maps at runtime).`,
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
