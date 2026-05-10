#!/usr/bin/env node

/**
 * Geometry planner CLI.
 *
 * Reads a kit spec JSON (+ optional shared rules) and outputs a deterministic
 * scene plan with precise coordinates, pivots, and UVs.
 *
 * Usage:
 *   node src/planner/plan-kit.js --spec <path>                  # catalog scene plan
 *   node src/planner/plan-kit.js --spec <path> --room           # example room scene plan
 *   node src/planner/plan-kit.js --spec <path> --validate       # validate only, no scene plan
 *   echo '{"wallSpan":128}' | node src/planner/plan-kit.js      # read spec from stdin
 *
 * The spec JSON is the same format accepted by normalizeModularKitSpec().
 * Output is written to stdout as JSON.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { normalizeModularKitSpec, validateModularKitSpec } from "../shared/kit.js";
import { createModularKitDefinition } from "../shared/kit.js";
import { buildWallKitCatalogScene, buildWallExampleRoomScene, buildGroundKitCatalogScene } from "../shared/scene-plan.js";
import { lintKitTileability } from "../shared/tileability-lint.js";
import { normalizeGameRenderContract } from "../shared/texel-density.js";
import { stableStringify } from "../shared/utils.js";

const args = process.argv.slice(2);

const specPath = flagValue(args, "--spec");
const rulesPath = flagValue(args, "--rules");
const outputPath = flagValue(args, "--output");
const mode = args.includes("--room")
  ? "room"
  : args.includes("--validate")
    ? "validate"
    : "catalog";

async function main() {
  let rawSpec = specPath
    ? JSON.parse(readFileSync(resolve(specPath), "utf8"))
    : await readStdin();

  // Flatten tileset.json envelope: merge geometry + kitSpec into a flat spec.
  // The `textures.authoring` block becomes the kit's textureProfile — this is
  // what drives the PBR material pipeline (wallMaterial, trimMaterial, etc.).
  // Top-level fields like `kind` and `name` carry over so kit normalization
  // knows which dispatch branch to take.
  if (rawSpec.kitSpec && typeof rawSpec.kitSpec === "object") {
    const { kitSpec, geometry, render, anchors, textures, kind, name } = rawSpec;
    rawSpec = {
      kind,
      name,
      ...geometry,
      ...kitSpec,
      renderContract: render,
      anchorPolicy: anchors,
      textureProfile: textures?.authoring || {}
    };
  }

  let rules = null;
  if (rulesPath) {
    rules = JSON.parse(readFileSync(resolve(rulesPath), "utf8"));
  }

  if (rules?.render) {
    rawSpec.renderContract = normalizeGameRenderContract(rules.render);
  }
  if (rules?.defaults) {
    for (const [key, value] of Object.entries(rules.defaults)) {
      if (rawSpec[key] === undefined) {
        rawSpec[key] = value;
      }
    }
  }
  if (rules?.units) {
    if (rawSpec.baseUnit === undefined) rawSpec.baseUnit = rules.units.baseUnitCm;
    if (rawSpec.authoringUnitsPerBaseUnit === undefined) {
      rawSpec.authoringUnitsPerBaseUnit = rules.units.authoringUnitsPerBaseUnit;
    }
  }
  if (rules?.anchors && rawSpec.anchorPolicy === undefined) {
    rawSpec.anchorPolicy = rules.anchors;
  }

  const spec = normalizeModularKitSpec(rawSpec);
  const specIssues = validateModularKitSpec(spec);

  const kit = createModularKitDefinition({ spec });
  const lintIssues = lintKitTileability(kit);

  const issues = [...specIssues, ...lintIssues];

  if (mode === "validate") {
    const output = { valid: issues.length === 0, issues, spec };
    write(output);
    process.exit(issues.length === 0 ? 0 : 1);
  }

  if (issues.length > 0) {
    process.stderr.write(`[plan-kit] Validation issues:\n${issues.map((i) => `  - ${i}`).join("\n")}\n`);
  }

  if (mode === "room") {
    if (kit.kind === "ground") {
      process.stderr.write("[plan-kit] Ground kits do not support room mode.\n");
      process.exit(1);
    }
    const room = buildWallExampleRoomScene({ kit, layout: rawSpec.roomLayout || {} });
    write({
      mode: "room",
      kit,
      scenePlan: room.scenePlan,
      exampleRoom: room.exampleRoom,
      issues
    });
  } else {
    const buildScene = kit.kind === "ground" ? buildGroundKitCatalogScene : buildWallKitCatalogScene;
    const catalog = buildScene({ kit });
    write({
      mode: "catalog",
      kit,
      scenePlan: catalog.scenePlan,
      manifest: catalog.manifest,
      issues
    });
  }
}

function write(data) {
  const json = stableStringify(data) + "\n";
  if (outputPath) {
    writeFileSync(resolve(outputPath), json, "utf8");
  } else {
    process.stdout.write(json);
  }
}

function flagValue(argv, flag) {
  const index = argv.indexOf(flag);
  return index !== -1 && index + 1 < argv.length ? argv[index + 1] : null;
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

main().catch((error) => {
  process.stderr.write(`[plan-kit] ${error.message}\n`);
  process.exit(1);
});
