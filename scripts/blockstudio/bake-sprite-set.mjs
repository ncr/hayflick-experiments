#!/usr/bin/env node

/**
 * Bake every tile in a Blockstudio tileset into a pixel-perfect sprite at the
 * game pixel budget. Writes PNGs under tilesets/<id>/artifacts/sprites/ and a
 * sprites.manifest.json that indexes them.
 *
 * Runs the existing Blender baker (scripts/bake-tile-sprite.py) once per
 * tile GLB. Each call launches Blender in background mode — that's
 * comparatively slow but it keeps the baker simple and stateless.
 *
 * Usage:
 *   node scripts/bake-sprite-set.mjs <tileset-id>
 *   node scripts/bake-sprite-set.mjs greek_island_white
 */

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..");
const BLENDER = process.env.BLENDER_BIN || "/opt/homebrew/bin/blender";
const PYTHON = process.env.BLOCKSTUDIO_PYTHON || "python3";
const BAKER = path.join(REPO_ROOT, "scripts/blockstudio/bake-tile-sprite.py");
const PIXEL_ART_PASS = path.join(REPO_ROOT, "scripts/blockstudio/pixel-art-pass.py");

// Pixel-art stylization defaults. Tuned on greek_island_white + ground_tiles;
// callers can override by setting BLOCKSTUDIO_PIXEL_ART_STYLE=off to skip the
// pass and keep the raw EEVEE render.
const PIXEL_ART_STYLE_DEFAULTS = {
  paletteSize: "16",
  contrast: "1.2",
  saturation: "1.35",
  outlineDarken: "0.45",
};

function fatal(msg) {
  process.stderr.write(`[bake-sprite-set] ${msg}\n`);
  process.exit(1);
}

export function bakeSpriteSet(tilesetId) {
  const tilesetDir = path.join(REPO_ROOT, "assets/tilesets", tilesetId);
  const tilesDir = path.join(tilesetDir, "artifacts", "tiles");
  const spritesDir = path.join(tilesetDir, "artifacts", "sprites");

  if (!fs.existsSync(tilesDir)) {
    fatal(`tiles directory missing: ${tilesDir}`);
  }
  fs.mkdirSync(spritesDir, { recursive: true });

  // Read the per-tile directory listing — each subdir contains <name>.glb.
  const tileNames = fs
    .readdirSync(tilesDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);

  if (tileNames.length === 0) {
    fatal(`no tile subdirectories in ${tilesDir}`);
  }

  const sprites = [];
  for (const name of tileNames) {
    const glbPath = path.join(tilesDir, name, `${name}.glb`);
    if (!fs.existsSync(glbPath)) {
      process.stderr.write(`[bake-sprite-set] skipping ${name}: no GLB\n`);
      continue;
    }
    const spritePath = path.join(spritesDir, `${name}.png`);
    const sidecarPath = path.join(spritesDir, `${name}.sprite.json`);

    process.stderr.write(`[bake-sprite-set] baking ${name}...\n`);
    execFileSync(
      BLENDER,
      [
        "--background",
        "--python", BAKER,
        "--",
        "--input", glbPath,
        "--output", spritePath,
      ],
      { stdio: ["ignore", "ignore", "inherit"] }
    );

    // Pixel-art stylization pass — median-cut quantize + silhouette
    // outline. In-place overwrite so the final sprite PNG is already
    // stylized. Skip if BLOCKSTUDIO_PIXEL_ART_STYLE=off.
    if (process.env.BLOCKSTUDIO_PIXEL_ART_STYLE !== "off") {
      try {
        execFileSync(
          PYTHON,
          [
            PIXEL_ART_PASS,
            "--input", spritePath,
            "--output", spritePath,
            "--palette-size", PIXEL_ART_STYLE_DEFAULTS.paletteSize,
            "--contrast", PIXEL_ART_STYLE_DEFAULTS.contrast,
            "--saturation", PIXEL_ART_STYLE_DEFAULTS.saturation,
            "--outline-darken", PIXEL_ART_STYLE_DEFAULTS.outlineDarken,
          ],
          { stdio: ["ignore", "ignore", "inherit"] }
        );
      } catch (err) {
        process.stderr.write(`[bake-sprite-set] pixel-art pass failed for ${name}: ${err.message}\n`);
      }
    }

    if (!fs.existsSync(sidecarPath)) {
      process.stderr.write(`[bake-sprite-set] warning: ${name} sidecar missing\n`);
      continue;
    }
    const sidecar = JSON.parse(fs.readFileSync(sidecarPath, "utf-8"));
    sprites.push({
      name,
      file: `sprites/${name}.png`,
      size: sidecar.size,
      anchorPx: sidecar.anchorPx,
      projection: sidecar.projection,
      style:
        process.env.BLOCKSTUDIO_PIXEL_ART_STYLE === "off"
          ? { kind: "raw_eevee" }
          : {
              kind: "pixel_art",
              paletteSize: Number(PIXEL_ART_STYLE_DEFAULTS.paletteSize),
              contrast: Number(PIXEL_ART_STYLE_DEFAULTS.contrast),
              saturation: Number(PIXEL_ART_STYLE_DEFAULTS.saturation),
              outlineDarken: Number(PIXEL_ART_STYLE_DEFAULTS.outlineDarken),
            },
    });
  }

  const manifest = {
    schema: "blockstudio/sprite-set@1",
    tilesetId,
    generatedAt: new Date().toISOString(),
    sprites,
  };
  const manifestPath = path.join(spritesDir, "sprites.manifest.json");
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
  process.stderr.write(`[bake-sprite-set] wrote ${sprites.length} sprites + manifest to ${spritesDir}\n`);
  return manifest;
}

// CLI entry point (only when invoked directly).
if (import.meta.url === `file://${process.argv[1]}`) {
  const tilesetId = process.argv[2];
  if (!tilesetId) fatal("usage: bake-sprite-set.mjs <tileset-id>");
  bakeSpriteSet(tilesetId);
}
