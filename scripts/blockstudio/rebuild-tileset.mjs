#!/usr/bin/env node

/**
 * End-to-end standalone rebuild: planner → Blender → decorated artifacts.
 *
 * Runs entirely outside the MCP / HTTP-bridge pipeline. Useful for
 * regenerating an existing tileset when the bridge is busy (e.g. another
 * editor on port 3721) or for bulk re-exports after exporter fixes.
 *
 * Usage:
 *   node scripts/rebuild-tileset.mjs <tileset-id>
 *   node scripts/rebuild-tileset.mjs desert_sandstone
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { buildBlenderMaterialMap } from "../../packages/blockstudio/src/server/pbr-library.js";
import { writeTilesetGameMetadata } from "../../packages/blockstudio/src/server/tileset-files.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..");
const RULES_FILE = path.join(REPO_ROOT, "assets/tilesets/_rules/general.tileset-rules.json");
const BLENDER = process.env.BLENDER_BIN || "/opt/homebrew/bin/blender";
const DRIVER = path.join(REPO_ROOT, "scripts/blockstudio/blender-rebuild-kit.py");

function fatal(msg) {
  process.stderr.write(`[rebuild-tileset] ${msg}\n`);
  process.exit(1);
}

function main() {
  const tilesetId = process.argv[2];
  if (!tilesetId) fatal("usage: rebuild-tileset.mjs <tileset-id>");

  const tilesetDir = path.join(REPO_ROOT, "assets/tilesets", tilesetId);
  const tilesetFile = path.join(tilesetDir, "tileset.json");
  if (!fs.existsSync(tilesetFile)) fatal(`tileset not found: ${tilesetFile}`);

  const tileset = JSON.parse(fs.readFileSync(tilesetFile, "utf-8"));

  // 1. Run the planner
  process.stderr.write(`[rebuild-tileset] Planning ${tilesetId}...\n`);
  const planJson = execFileSync(
    "node",
    [path.join(REPO_ROOT, "packages/blockstudio/src/planner/plan-kit.js"), "--spec", tilesetFile, "--rules", RULES_FILE],
    { encoding: "utf-8", maxBuffer: 16 * 1024 * 1024 }
  );
  const plan = JSON.parse(planJson);
  if (plan.issues && plan.issues.length > 0) {
    process.stderr.write(`[rebuild-tileset] Planner issues:\n`);
    for (const issue of plan.issues) process.stderr.write(`  - ${issue}\n`);
  }

  // 2. Build the material map from the kit's texture profile
  const profile = plan.kit?.spec?.textureProfile || {};
  const materials = buildBlenderMaterialMap(profile);
  const matRoles = Object.keys(materials);
  process.stderr.write(
    `[rebuild-tileset] Resolved ${matRoles.length} PBR material(s): ${matRoles.join(", ") || "(none)"}\n`
  );

  // 3. Write the job JSON to a tmp file
  const jobPath = path.join(os.tmpdir(), `blockstudio-rebuild-${tilesetId}-${Date.now()}.json`);
  fs.writeFileSync(jobPath, JSON.stringify({ plan, materials }));

  // 4. Invoke Blender in background mode
  const outputDir = path.join(tilesetDir, "artifacts");
  process.stderr.write(`[rebuild-tileset] Running Blender → ${outputDir}\n`);
  try {
    execFileSync(
      BLENDER,
      [
        "--background",
        "--python", DRIVER,
        "--",
        "--job", jobPath,
        "--mode", "kit",
        "--output-dir", outputDir,
        "--file-stem", tilesetId,
      ],
      { stdio: "inherit" }
    );
  } finally {
    try { fs.unlinkSync(jobPath); } catch {}
  }

  // 4b. For wall kits, run a second pass to export an example room as a
  //     project/example_room.glb. This proves the kit composes end-to-end
  //     and gives reviewers a visual reference. Stays out of artifacts/
  //     because example rooms are authoring/debug output, not game content.
  if (tileset.kind !== "ground") {
    rebuildExampleRoom({ tilesetId, tilesetFile, tilesetDir, materials });
  }

  // 5. Regenerate tileset.game.json so downstream consumers see the new
  //    schema and export sizes.
  const savedFiles = collectSavedFiles(outputDir, tilesetId, plan);
  const gameMeta = writeTilesetGameMetadata({
    repoRoot: REPO_ROOT,
    exportRoot: outputDir,
    exportResult: {
      saved: savedFiles,
      exportRoot: outputDir,
      kitDir: path.join(outputDir, "kit"),
      tilesDir: path.join(outputDir, "tiles"),
      tiles: buildTilesArray(path.join(outputDir, "tiles"), plan.manifest.parts),
    },
    format: "glb",
  });
  if (gameMeta) {
    process.stderr.write(`[rebuild-tileset] Wrote game metadata: ${gameMeta.file}\n`);
  }

  process.stderr.write(`[rebuild-tileset] Done: ${tilesetId}\n`);
}

function rebuildExampleRoom({ tilesetId, tilesetFile, tilesetDir, materials }) {
  process.stderr.write(`[rebuild-tileset] Planning example room ${tilesetId}...\n`);
  let roomJson;
  try {
    roomJson = execFileSync(
      "node",
      [
        path.join(REPO_ROOT, "packages/blockstudio/src/planner/plan-kit.js"),
        "--spec", tilesetFile,
        "--rules", RULES_FILE,
        "--room",
      ],
      { encoding: "utf-8", maxBuffer: 16 * 1024 * 1024 }
    );
  } catch (err) {
    process.stderr.write(`[rebuild-tileset] Example room planning failed: ${err.message}\n`);
    return;
  }
  const roomPlan = JSON.parse(roomJson);
  const roomJobPath = path.join(os.tmpdir(), `blockstudio-room-${tilesetId}-${Date.now()}.json`);
  fs.writeFileSync(
    roomJobPath,
    JSON.stringify({
      plan: {
        scenePlan: roomPlan.scenePlan,
        kit: roomPlan.kit,
      },
      materials,
    })
  );

  const projectDir = path.join(tilesetDir, "project");
  fs.mkdirSync(projectDir, { recursive: true });
  const roomOutputPath = path.join(projectDir, "example_room.glb");

  process.stderr.write(`[rebuild-tileset] Running Blender → ${roomOutputPath}\n`);
  try {
    execFileSync(
      BLENDER,
      [
        "--background",
        "--python", DRIVER,
        "--",
        "--job", roomJobPath,
        "--mode", "room",
        "--output-path", roomOutputPath,
      ],
      { stdio: "inherit" }
    );
  } catch (err) {
    process.stderr.write(`[rebuild-tileset] Example room export failed: ${err.message}\n`);
  } finally {
    try { fs.unlinkSync(roomJobPath); } catch {}
  }
}

function collectSavedFiles(outputDir, fileStem, plan) {
  const kitDir = path.join(outputDir, "kit");
  const tilesDir = path.join(outputDir, "tiles");
  const saved = [
    { path: path.join(kitDir, `${fileStem}.glb`), format: "glb" },
    { path: path.join(kitDir, `${fileStem}.manifest.json`), format: "manifest" },
  ];
  for (const part of plan.manifest.parts || []) {
    const partDir = path.join(tilesDir, part.name);
    saved.push({ path: path.join(partDir, `${part.name}.glb`), format: "glb" });
    saved.push({ path: path.join(partDir, `${part.name}.manifest.json`), format: "manifest" });
  }
  saved.push({ path: path.join(tilesDir, "tiles.manifest.json"), format: "manifest" });
  return saved;
}

function buildTilesArray(tilesDir, parts) {
  return (parts || []).map((part) => {
    const dir = path.join(tilesDir, part.name);
    return {
      name: part.name,
      kind: part.kind,
      directory: dir,
      files: [
        { path: path.join(dir, `${part.name}.glb`), format: "glb" },
        { path: path.join(dir, `${part.name}.manifest.json`), format: "manifest" },
      ],
      anchor: part.anchorLocal || [0, 0, 0],
      anchorClass: part.anchorClass,
      anchorPolicy: part.anchorPolicy,
    };
  });
}

main();
