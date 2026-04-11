#!/usr/bin/env node

/**
 * Stylize every Polyhaven baseColor map so the GLB materials embed small
 * palette-PNG pixel-art textures instead of photographic JPGs.
 *
 * Only the diffuse (baseColor) map is touched. Normal and ARM maps stay
 * at their source resolution so the engine's PBR lighting pipeline —
 * shadows, specular, metallic shimmer, normal-driven bumps — continues
 * to work at full fidelity. The diffuse gets the pixel-art treatment;
 * lighting layers stay realistic.
 *
 * Workflow:
 *   1. Read <material>_diff_<N>.jpg (seeded by scripts/downscale-materials.mjs).
 *   2. Downscale to --diff-size (default 128) with Lanczos via ImageMagick.
 *   3. Boost contrast + saturation (modulate).
 *   4. Palette-quantize to --palette colours (default 24, no dither).
 *   5. Write <material>_diff_pix.png.
 *   6. Rewrite materials/registry.json so `maps.baseColor` points at the PNG.
 *
 * Reversible: re-run scripts/downscale-materials.mjs to reseed the diffuse
 * from the 1K original and reset the registry's baseColor pointer.
 *
 * Usage:
 *   node scripts/stylize-material-textures.mjs                        # defaults
 *   node scripts/stylize-material-textures.mjs --palette 16 --diff-size 96
 */

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..");
const MATERIALS_DIR = path.join(REPO_ROOT, "assets/materials");
const REGISTRY_PATH = path.join(MATERIALS_DIR, "registry.json");
const POLYHAVEN_DIR = path.join(MATERIALS_DIR, "polyhaven");

function flag(argv, name, fallback) {
  const index = argv.indexOf(name);
  if (index === -1 || index + 1 >= argv.length) return fallback;
  return argv[index + 1];
}

function main() {
  const argv = process.argv.slice(2);
  const palette = Number(flag(argv, "--palette", "24"));
  const contrast = Number(flag(argv, "--contrast", "1.08"));
  const saturation = Number(flag(argv, "--saturation", "1.15"));
  const diffSize = Number(flag(argv, "--diff-size", "128"));

  if (!fs.existsSync(POLYHAVEN_DIR)) {
    console.error(`[stylize] no polyhaven dir at ${POLYHAVEN_DIR}`);
    process.exit(1);
  }
  const registry = JSON.parse(fs.readFileSync(REGISTRY_PATH, "utf-8"));
  registry.materials = registry.materials || {};

  const materialIds = fs
    .readdirSync(POLYHAVEN_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);

  // ImageMagick's -modulate takes saturation and brightness in percentage.
  // Contrast is expressed via -brightness-contrast (delta around 100).
  const modulateArg = `100,${Math.round(saturation * 100)},100`;
  const contrastDelta = Math.round((contrast - 1) * 100);

  let stylized = 0;
  for (const id of materialIds) {
    const dir = path.join(POLYHAVEN_DIR, id);
    const files = fs.readdirSync(dir);
    // Prefer whatever downscaled diffuse the registry currently points at
    // (e.g. _diff_256.jpg). Falls back to the 1K master if nothing else
    // is available.
    const downscaled = files.find((f) => /_diff_\d+\.jpg$/.test(f) && !/_diff_1k\.jpg$/.test(f));
    const sourceDiff = downscaled || files.find((f) => /_diff_1k\.jpg$/.test(f));
    if (!sourceDiff) {
      console.warn(`[stylize] ${id}: no source diffuse jpg to stylize`);
      continue;
    }
    const sourcePath = path.join(dir, sourceDiff);
    const targetName = `${id}_diff_pix.png`;
    const targetPath = path.join(dir, targetName);

    execFileSync(
      "magick",
      [
        sourcePath,
        "-filter", "Lanczos",
        "-resize", `${diffSize}x${diffSize}`,
        "-modulate", modulateArg,
        "-brightness-contrast", `0x${contrastDelta}`,
        "+dither",
        "-colors", String(palette),
        "PNG8:" + targetPath,
      ],
      { stdio: ["ignore", "inherit", "inherit"] }
    );

    // Rewrite the registry entry so the Blender pipeline picks up the new
    // PNG. Only the baseColor slot changes; normal + arm stay at their
    // original filenames so PBR lighting is untouched.
    const entry = registry.materials[id] || {
      source: "polyhaven",
      sourceId: id,
      category: "unknown",
      maps: {},
      defaults: { roughnessFactor: 0.5, metallicFactor: 0.0 },
      physicalScaleM: 1.0,
    };
    entry.maps = { ...(entry.maps || {}), baseColor: targetName };
    entry.style = {
      kind: "pixel_art_diffuse",
      diffSize,
      paletteSize: palette,
      contrast,
      saturation,
    };
    registry.materials[id] = entry;
    stylized += 1;
  }

  fs.writeFileSync(REGISTRY_PATH, JSON.stringify(registry, null, 2) + "\n");
  console.log(
    `[stylize] stylized ${stylized} diffuse maps @ ${diffSize}x${diffSize} palette=${palette}, registry updated`
  );
}

main();
