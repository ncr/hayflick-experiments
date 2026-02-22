#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

function detectRepoRoot() {
  const cwd = process.cwd();
  const candidates = [
    cwd,
    path.resolve(cwd, "../..")
  ];
  for (const candidate of candidates) {
    const packageJsonPath = path.join(candidate, "package.json");
    const assetsForgePath = path.join(candidate, "assets", "forge", "props");
    if (fs.existsSync(packageJsonPath) && fs.existsSync(assetsForgePath)) {
      return candidate;
    }
  }
  return cwd;
}

const repoRoot = detectRepoRoot();
const v1PropsRoot = path.join(repoRoot, "assets/forge/props");
const v2Root = path.join(repoRoot, "assets/forge-v2");
const v2PropsRoot = path.join(v2Root, "props");

const args = new Set(process.argv.slice(2));
const overwrite = args.has("--overwrite");
const verbose = args.has("--verbose");

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function readText(filePath) {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return null;
  }
}

function parseStoredPromptText(rawText) {
  if (typeof rawText !== "string") {
    return "";
  }
  const trimmed = rawText.trim();
  if (!trimmed) {
    return "";
  }
  try {
    const parsed = JSON.parse(trimmed);
    if (typeof parsed === "string") {
      return parsed;
    }
  } catch {
    // Plain text prompt file; use as-is.
  }
  return rawText;
}

function copyIfPresent(src, dst) {
  if (!fs.existsSync(src)) {
    return false;
  }
  ensureDir(path.dirname(dst));
  fs.copyFileSync(src, dst);
  return true;
}

function nowIso() {
  return new Date().toISOString();
}

function defaultPixelPreview() {
  return {
    testEnvironmentVersion: 1,
    cameraSyncState: {
      target: [0, 0, 0],
      yawTurns: 0,
      zoomLevel: 2
    },
    views: [
      { angle: "north", visible: true },
      { angle: "east", visible: true },
      { angle: "south", visible: true },
      { angle: "west", visible: true }
    ]
  };
}

function defaultProcessingTransform() {
  return {
    unitScaleMetersPerUnit: 1.28,
    targetDimension: {
      method: "max",
      value: 1
    },
    scale: [1, 1, 1],
    provisionalPivot: {
      preset: "bottom-center",
      offset: [0, 0, 0],
      basis: "mesh"
    }
  };
}

function inferLifecycle({ hasConcept, hasRawGlb }) {
  if (hasConcept && hasRawGlb) {
    return "mesh-ready";
  }
  if (hasConcept) {
    return "image-ready";
  }
  return "draft";
}

function buildV2Meta(propId, v1Meta, promptText, copied) {
  const createdAt =
    (typeof v1Meta?.created === "string" && v1Meta.created) ||
    nowIso();
  const lifecycleStatus = inferLifecycle(copied);
  const gen2d = v1Meta?.gen2d ?? {};
  const gen3d = v1Meta?.gen3d ?? {};
  const description =
    (typeof v1Meta?.description === "string" && v1Meta.description.trim()) ||
    propId.replace(/-/g, " ");

  return {
    version: 1,
    id: propId,
    description,
    createdAt,
    updatedAt: nowIso(),
    lifecycle: {
      status: lifecycleStatus
    },
    styleGuide: {
      name: typeof v1Meta?.styleGuide === "string" ? v1Meta.styleGuide : "",
      prompt: "",
      negativePrompt: "",
      imageSize:
        typeof gen2d.size === "string" && gen2d.size.trim()
          ? gen2d.size
          : "1024x1024"
    },
    generation: {
      image: {
        provider: "openai",
        model:
          typeof gen2d.model === "string" && gen2d.model.trim()
            ? gen2d.model
            : "gpt-image-1",
        prompt:
          (typeof promptText === "string" && promptText.trim()) ||
          (typeof gen2d.prompt === "string" ? gen2d.prompt : ""),
        size:
          typeof gen2d.size === "string" && gen2d.size.trim()
            ? gen2d.size
            : "1024x1024",
        generatedAt: copied.hasConcept ? createdAt : undefined,
        revision: copied.hasConcept ? 1 : 0
      },
      mesh: {
        provider: "tripo",
        faceLimit:
          typeof gen3d.faceLimit === "number" && Number.isFinite(gen3d.faceLimit)
            ? Math.max(500, Math.floor(gen3d.faceLimit))
            : 20000,
        pbr: gen3d.pbr !== false,
        tripoTaskId:
          typeof gen3d.tripoTaskId === "string" ? gen3d.tripoTaskId : "",
        generatedAt: copied.hasRawGlb ? createdAt : undefined,
        revision: copied.hasRawGlb ? 1 : 0
      }
    },
    processing: {
      mesh: {
        originalFaces: 0,
        processedFaces: 0,
        simplificationRatio: 1,
        textureResolution: 0
      },
      transform: defaultProcessingTransform()
    },
    pixelPreview: defaultPixelPreview()
  };
}

function migrateOneProp(propId) {
  const srcBase = path.join(v1PropsRoot, propId);
  const dstBase = path.join(v2PropsRoot, propId);
  const srcRaw = path.join(srcBase, "raw");
  const dstRaw = path.join(dstBase, "raw");
  const dstMetaPath = path.join(dstBase, "meta.json");

  if (!overwrite && fs.existsSync(dstMetaPath)) {
    return { status: "skipped", reason: "meta-exists", propId };
  }

  const conceptCandidates = ["concept.png", "concept.jpg", "concept.jpeg"];
  const conceptSrc = conceptCandidates
    .map((name) => path.join(srcRaw, name))
    .find((file) => fs.existsSync(file));
  const promptSrc = path.join(srcRaw, "prompt.txt");
  const rawGlbSrc = path.join(srcRaw, "tripo-output.glb");

  const hasConcept = Boolean(conceptSrc);
  const hasPrompt = fs.existsSync(promptSrc);
  const hasRawGlb = fs.existsSync(rawGlbSrc);

  if (!hasConcept && !hasPrompt && !hasRawGlb) {
    return { status: "skipped", reason: "no-raw-assets", propId };
  }

  ensureDir(dstRaw);

  let copiedConcept = false;
  if (conceptSrc) {
    const ext = path.extname(conceptSrc).toLowerCase() || ".png";
    copiedConcept = copyIfPresent(conceptSrc, path.join(dstRaw, `concept${ext}`));
  }
  const copiedPrompt = copyIfPresent(promptSrc, path.join(dstRaw, "prompt.txt"));
  const copiedRawGlb = copyIfPresent(rawGlbSrc, path.join(dstRaw, "tripo-output.glb"));

  const v1Meta = readJson(path.join(srcBase, "meta.json"));
  const promptTextRaw = readText(promptSrc);
  const promptText = parseStoredPromptText(promptTextRaw);
  const v2Meta = buildV2Meta(propId, v1Meta, promptText, {
    hasConcept: copiedConcept,
    hasRawGlb: copiedRawGlb
  });

  ensureDir(dstBase);
  fs.writeFileSync(dstMetaPath, `${JSON.stringify(v2Meta, null, 2)}\n`, "utf8");

  if (verbose) {
    console.log(
      `[migrate] ${propId}: concept=${copiedConcept} prompt=${copiedPrompt} rawGlb=${copiedRawGlb} status=${v2Meta.lifecycle.status}`
    );
  }

  return {
    status: "migrated",
    propId,
    concept: copiedConcept,
    prompt: copiedPrompt,
    rawGlb: copiedRawGlb,
    lifecycle: v2Meta.lifecycle.status
  };
}

function main() {
  if (!fs.existsSync(v1PropsRoot)) {
    console.error(`V1 props root not found: ${v1PropsRoot}`);
    process.exit(1);
  }
  ensureDir(v2Root);
  ensureDir(v2PropsRoot);

  const propIds = fs
    .readdirSync(v1PropsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b));

  const results = propIds.map(migrateOneProp);
  const migrated = results.filter((r) => r.status === "migrated");
  const skipped = results.filter((r) => r.status === "skipped");

  const statusCounts = migrated.reduce((acc, r) => {
    acc[r.lifecycle] = (acc[r.lifecycle] ?? 0) + 1;
    return acc;
  }, {});

  console.log(
    `[forge-v2-migrate] props=${propIds.length} migrated=${migrated.length} skipped=${skipped.length}`
  );
  console.log(`[forge-v2-migrate] lifecycle=${JSON.stringify(statusCounts)}`);
  if (skipped.length > 0) {
    console.log(
      `[forge-v2-migrate] skipped: ${skipped
        .map((r) => `${r.propId}:${r.reason}`)
        .join(", ")}`
    );
  }
}

main();
