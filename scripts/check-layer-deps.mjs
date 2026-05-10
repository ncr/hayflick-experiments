#!/usr/bin/env node
// Validate that every workspace package's `dependencies` respects the
// engine / studios / experiments layer rules.
//
// Layer rules:
//   engine    -> engine, runtime
//   studio    -> engine, runtime
//   strict    -> engine, runtime              (mode: "strict" experiments)
//   free      -> engine, runtime, studio, free, app-allowed-libs (the playground)
//   app       -> engine, runtime, studio, free, strict
//   runtime   -> nothing internal             (leaf type-only package)
//
// "engine" packages live under packages/common-*.
// "studio" packages live under studios/*.
// "experiment" packages live under experiments/* (besides _runtime).
//   Mode is read from each experiment's src/meta.ts (a "mode" property
//   string literal). Default: "free" if not declared.
// "runtime" is the single experiments/_runtime package.
// "app" packages live under apps/*.
//
// Mechanism: walk each workspace package's package.json, look at its
// dependencies (and devDependencies), and check none cross a layer
// boundary. External deps (npm packages) are ignored.
//
// Run:  node scripts/check-layer-deps.mjs
// Exit: 0 on success, 1 on any violation (with a printed report).

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, "..");

const LAYERS = {
  engine: { allow: ["engine", "runtime"] },
  studio: { allow: ["engine", "runtime"] },
  "experiment-strict": { allow: ["engine", "runtime"] },
  "experiment-free": { allow: ["engine", "runtime", "studio", "experiment-free", "experiment-strict"] },
  app: { allow: ["engine", "runtime", "studio", "experiment-free", "experiment-strict"] },
  runtime: { allow: [] }
};

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

function listPackages() {
  const dirs = [
    ...fs.readdirSync(path.join(REPO_ROOT, "packages")).map((d) => `packages/${d}`),
    ...fs.readdirSync(path.join(REPO_ROOT, "studios")).filter((d) => d !== ".gitkeep").map((d) => `studios/${d}`),
    ...fs.readdirSync(path.join(REPO_ROOT, "experiments")).filter((d) => d !== ".gitkeep").map((d) => `experiments/${d}`),
    ...fs.readdirSync(path.join(REPO_ROOT, "apps")).map((d) => `apps/${d}`)
  ];

  const packages = [];
  for (const rel of dirs) {
    const pkgPath = path.join(REPO_ROOT, rel, "package.json");
    if (!fs.existsSync(pkgPath)) continue;
    packages.push({ rel, pkgPath, pkg: readJson(pkgPath) });
  }
  return packages;
}

function readExperimentMode(rel) {
  const metaPath = path.join(REPO_ROOT, rel, "src", "meta.ts");
  if (!fs.existsSync(metaPath)) return "free";
  const text = fs.readFileSync(metaPath, "utf8");
  const m = text.match(/mode\s*:\s*"(strict|free)"/);
  return m ? m[1] : "free";
}

function classifyByPath(rel) {
  if (rel === "experiments/_runtime") return "runtime";
  if (rel.startsWith("packages/common-")) return "engine";
  if (rel.startsWith("studios/")) return "studio";
  if (rel.startsWith("apps/")) return "app";
  if (rel.startsWith("experiments/")) {
    const mode = readExperimentMode(rel);
    return mode === "strict" ? "experiment-strict" : "experiment-free";
  }
  return null;
}

function classifyDep(depName, byPkgName) {
  if (!depName.startsWith("@")) return "external";
  const found = byPkgName.get(depName);
  if (!found) return "external";
  return found.layer;
}

function main() {
  const packages = listPackages().map((p) => ({ ...p, layer: classifyByPath(p.rel) }));
  const byPkgName = new Map(
    packages.filter((p) => p.pkg.name).map((p) => [p.pkg.name, p])
  );

  const violations = [];

  for (const p of packages) {
    if (!p.layer) continue;
    const deps = { ...(p.pkg.dependencies || {}), ...(p.pkg.devDependencies || {}) };
    for (const depName of Object.keys(deps)) {
      const depLayer = classifyDep(depName, byPkgName);
      if (depLayer === "external") continue;
      const allowed = LAYERS[p.layer]?.allow || [];
      if (!allowed.includes(depLayer)) {
        violations.push({
          from: p.pkg.name,
          fromLayer: p.layer,
          to: depName,
          toLayer: depLayer,
          allowed
        });
      }
    }
  }

  if (violations.length === 0) {
    console.log("[check-layer-deps] OK -- " + packages.length + " packages, no layer violations.");
    return;
  }

  console.error("[check-layer-deps] FAIL -- layer violations:\n");
  for (const v of violations) {
    console.error(
      "  " + v.from + " (" + v.fromLayer + ") -> " + v.to + " (" + v.toLayer + ")\n" +
      "    allowed: " + (v.allowed.length ? v.allowed.join(", ") : "(none)") + "\n"
    );
  }
  process.exit(1);
}

main();
