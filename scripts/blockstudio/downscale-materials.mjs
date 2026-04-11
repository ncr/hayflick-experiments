#!/usr/bin/env node

/**
 * Downscale every Polyhaven PBR map to a target pixel size using Lanczos.
 *
 * The game pixel budget is 32 game px per base cell (16 vertical). One UV
 * tile == one base cell, so a 1024-texel source oversupplies the budget by
 * ~32×. At that density the photographic high-frequency detail is crushed
 * by downsampling into visual noise. Downscaling with a proper filter
 * before the render pipeline sees the maps preserves large-scale tonal
 * variation and kills the noise.
 *
 * Writes new `_<size>.jpg` siblings next to the existing `_1k.jpg` files
 * and updates materials/registry.json to reference the smaller files. The
 * 1K originals stay on disk so the change is reversible.
 *
 * Usage:
 *   node scripts/downscale-materials.mjs            # default 256
 *   node scripts/downscale-materials.mjs --size 128
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

function flagValue(argv, name, fallback) {
  const index = argv.indexOf(name);
  if (index === -1 || index + 1 >= argv.length) return fallback;
  return argv[index + 1];
}

function main() {
  const argv = process.argv.slice(2);
  const size = Number(flagValue(argv, "--size", "256"));
  if (!Number.isFinite(size) || size < 16) {
    console.error(`[downscale] invalid size: ${size}`);
    process.exit(1);
  }
  const suffix = `${size}`;

  if (!fs.existsSync(POLYHAVEN_DIR)) {
    console.error(`[downscale] no polyhaven dir at ${POLYHAVEN_DIR}`);
    process.exit(1);
  }
  const materialIds = fs
    .readdirSync(POLYHAVEN_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);

  const registry = JSON.parse(fs.readFileSync(REGISTRY_PATH, "utf-8"));
  registry.materials = registry.materials || {};

  for (const materialId of materialIds) {
    const dir = path.join(POLYHAVEN_DIR, materialId);
    const files = fs.readdirSync(dir).filter((name) => name.endsWith("_1k.jpg"));
    if (files.length === 0) continue;

    const newMaps = {};
    for (const filename of files) {
      const source = path.join(dir, filename);
      // <materialId>_<suffixType>_1k.jpg → <materialId>_<suffixType>_<size>.jpg
      const downscaled = filename.replace(/_1k\.jpg$/, `_${suffix}.jpg`);
      const target = path.join(dir, downscaled);

      // Normal maps get special handling: downscale at slightly higher
      // quality (box filter over lanczos sometimes flattens gradients).
      // The difference is small at this resolution but noticeable at 2×
      // zoom. Stick with lanczos for everything for consistency.
      execFileSync(
        "magick",
        [source, "-resize", `${size}x${size}`, "-filter", "Lanczos", "-quality", "92", target],
        { stdio: "inherit" }
      );

      if (filename.includes("_diff_")) newMaps.baseColor = downscaled;
      else if (filename.includes("_nor_gl_")) newMaps.normal = downscaled;
      else if (filename.includes("_arm_")) newMaps.arm = downscaled;
    }

    // Rewrite the registry entry to point at the downscaled files.
    const entry = registry.materials[materialId] || {
      source: "polyhaven",
      sourceId: materialId,
      category: "unknown",
      defaults: { roughnessFactor: 0.5, metallicFactor: 0.0 },
      physicalScaleM: 1.0
    };
    entry.maps = { ...(entry.maps || {}), ...newMaps };
    entry.resolution = `${size}`;
    registry.materials[materialId] = entry;
    console.log(`[downscale] ${materialId}: ${Object.keys(newMaps).join(", ")}`);
  }

  fs.writeFileSync(REGISTRY_PATH, JSON.stringify(registry, null, 2) + "\n");
  console.log(`[downscale] registry updated → resolution=${size}`);
}

main();
