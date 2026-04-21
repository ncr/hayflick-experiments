#!/usr/bin/env node
/**
 * Extract embedded textures from existing tileset GLBs and write them to the
 * polyhaven-style asset folders. Needed because corner.glb normals were baked
 * inverted (now fixed at source), but regenerating via `pnpm run rebuild:all`
 * requires the pixelated texture PNGs to be present on disk. They were lost
 * when the repo was cloned fresh — this pulls them back out of the GLBs.
 *
 * Writes to assets/materials/polyhaven/<material>/<filename>.png based on the
 * embedded image names (e.g. white_plaster_02_diff_pixart.png → folder
 * white_plaster_02).
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const MATERIALS_DIR = path.join(REPO_ROOT, "assets/materials/polyhaven");

function parseGLB(buf) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  if (dv.getUint32(0, true) !== 0x46546c67) throw new Error("not a GLB");
  const length = dv.getUint32(8, true);
  let offset = 12, json = null, bin = null;
  while (offset < length) {
    const chunkLen = dv.getUint32(offset, true);
    const chunkType = dv.getUint32(offset + 4, true);
    offset += 8;
    if (chunkType === 0x4e4f534a) json = JSON.parse(new TextDecoder().decode(buf.subarray(offset, offset + chunkLen)));
    else if (chunkType === 0x004e4942) bin = buf.subarray(offset, offset + chunkLen);
    offset += chunkLen;
  }
  return { json, bin };
}

function materialFolderFromFilename(filename) {
  // white_plaster_02_diff_pixart.png → white_plaster_02
  // blue_painted_planks_nor_pixart.png → blue_painted_planks
  const stripped = filename.replace(/\.(png|jpg|jpeg)$/i, "");
  const m = stripped.match(/^(.+?)_(diff|nor|nor_gl|arm|metallic|roughness|ao|displacement|height)(?:_pixart)?$/);
  return m ? m[1] : stripped;
}

function extractFromGlb(glbPath) {
  const buf = fs.readFileSync(glbPath);
  let parsed;
  try {
    parsed = parseGLB(buf);
  } catch (err) {
    console.warn(`[extract] skip ${glbPath}: ${err.message}`);
    return [];
  }
  const { json, bin } = parsed;
  if (!json?.images || !bin) return [];

  const extracted = [];
  for (const img of json.images) {
    if (img.bufferView == null || !img.name) continue;
    const bv = json.bufferViews[img.bufferView];
    const offset = bv.byteOffset || 0;
    const length = bv.byteLength;
    const imgBuf = bin.subarray(offset, offset + length);
    extracted.push({ name: img.name, mime: img.mimeType || "image/png", bytes: imgBuf });
  }
  return extracted;
}

function main() {
  const glbPaths = [];
  const tilesetsDir = path.join(REPO_ROOT, "assets/tilesets");
  for (const tileset of fs.readdirSync(tilesetsDir)) {
    const tilesDir = path.join(tilesetsDir, tileset, "artifacts/tiles");
    if (!fs.existsSync(tilesDir)) continue;
    for (const tile of fs.readdirSync(tilesDir)) {
      const glb = path.join(tilesDir, tile, `${tile}.glb`);
      if (fs.existsSync(glb)) glbPaths.push(glb);
    }
  }

  const seenByPath = new Map();
  for (const glb of glbPaths) {
    for (const img of extractFromGlb(glb)) {
      const ext = img.mime === "image/jpeg" ? "jpg" : "png";
      const filename = img.name.endsWith(`.${ext}`) ? img.name : `${img.name}.${ext}`;
      const material = materialFolderFromFilename(filename);
      const targetDir = path.join(MATERIALS_DIR, material);
      const targetPath = path.join(targetDir, filename);
      if (seenByPath.has(targetPath)) continue;
      seenByPath.set(targetPath, img.bytes.length);
      fs.mkdirSync(targetDir, { recursive: true });
      fs.writeFileSync(targetPath, img.bytes);
      console.log(`[extract] ${glb.replace(REPO_ROOT + "/", "")} → ${targetPath.replace(REPO_ROOT + "/", "")} (${img.bytes.length}B)`);
    }
  }
  console.log(`[extract] wrote ${seenByPath.size} unique texture(s)`);
}

main();
