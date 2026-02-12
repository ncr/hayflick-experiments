#!/usr/bin/env node

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { NodeIO } from "@gltf-transform/core";
import { normals } from "@gltf-transform/functions";

const ROOT = process.cwd();
const MODELS = [
  {
    raw: "assets/models/raw/chair 3d model.glb",
    optimized: "assets/models/optimized/chair-optimized.glb"
  },
  {
    raw: "assets/models/raw/futuristic lab device 3d model.glb",
    optimized: "assets/models/optimized/futuristic-lab-device-optimized.glb"
  },
  {
    raw: "assets/models/raw/compact hydroponic planter 3d model.glb",
    optimized: "assets/models/optimized/compact-hydroponic-planter-optimized.glb"
  },
  {
    raw: "assets/models/raw/futuristic storage chest 3d model.glb",
    optimized: "assets/models/optimized/futuristic-storage-chest-optimized.glb"
  }
];

function run(cmd, args) {
  const result = spawnSync(cmd, args, {
    cwd: ROOT,
    stdio: "inherit",
    env: process.env
  });
  if (result.status !== 0) {
    throw new Error(`${cmd} ${args.join(" ")} failed with status ${String(result.status)}`);
  }
}

async function main() {
  const io = new NodeIO();
  const tempDir = mkdtempSync(path.join(tmpdir(), "prop-optimize-"));
  try {
    for (const model of MODELS) {
      const rawPath = path.join(ROOT, model.raw);
      const optimizedPath = path.join(ROOT, model.optimized);
      const normalizedPath = path.join(
        tempDir,
        `${path.basename(model.optimized, ".glb")}-with-normals.glb`
      );

      const doc = await io.read(rawPath);
      await doc.transform(normals());
      await io.write(normalizedPath, doc);

      run("pnpm", [
        "dlx",
        "@gltf-transform/cli@3.10.1",
        "optimize",
        normalizedPath,
        optimizedPath,
        "--compress",
        "draco",
        "--texture-compress",
        "webp"
      ]);
    }
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

void main();
