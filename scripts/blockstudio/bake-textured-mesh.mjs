#!/usr/bin/env node

/**
 * Node wrapper: bake textures onto a base mesh GLB via Blender.
 *
 * Invokes scripts/blockstudio/bake-textured-mesh.py in background Blender.
 * Pulls the job spec from a JSON file written ahead of time by the caller.
 *
 * Usage:
 *   node scripts/blockstudio/bake-textured-mesh.mjs --job /path/to/job.json
 *
 * The job JSON shape is defined in bake-textured-mesh.py.
 */

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..");
const BLENDER = process.env.BLENDER_BIN || "/opt/homebrew/bin/blender";
const DRIVER = path.join(REPO_ROOT, "scripts/blockstudio/bake-textured-mesh.py");

function fatal(msg) {
  process.stderr.write(`[bake-textured-mesh] ${msg}\n`);
  process.exit(1);
}

/** Programmatic entry point — used by the api-proxy middleware. */
export function bakeTexturedMesh(jobPath) {
  if (!fs.existsSync(jobPath)) fatal(`job not found: ${jobPath}`);
  if (!fs.existsSync(BLENDER)) fatal(`Blender not found at ${BLENDER} (set BLENDER_BIN)`);

  execFileSync(
    BLENDER,
    [
      "--background",
      "--python", DRIVER,
      "--",
      "--job", jobPath,
    ],
    { stdio: "inherit" }
  );
}

function main() {
  const args = process.argv.slice(2);
  const jobIdx = args.indexOf("--job");
  if (jobIdx === -1 || !args[jobIdx + 1]) fatal("usage: bake-textured-mesh.mjs --job <path>");
  bakeTexturedMesh(args[jobIdx + 1]);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
