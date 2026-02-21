#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Document, NodeIO } from "@gltf-transform/core";
import * as THREE from "three";
import { ConvexGeometry } from "three/examples/jsm/geometries/ConvexGeometry.js";
import {
  disposeVhacdResult,
  runVhacdFromSourceData
} from "../../../packages/common-collider-vhacd/dist/vhacd.js";

const PRESET_FILE = "assets/forge/vhacd-presets.json";
const PROPS_ROOT = "assets/forge/props";
const MIN_HULL_AXIS_SPAN = 1e-5;

function parseArgs(argv) {
  let preset = "Balanced";
  let onlyPropId = null;

  for (const arg of argv) {
    if (arg === "-h" || arg === "--help") {
      return { help: true, preset, onlyPropId };
    }
    if (arg.startsWith("--preset=")) {
      const value = arg.slice("--preset=".length).trim();
      if (value.length > 0) {
        preset = value;
      }
      continue;
    }
    if (arg.startsWith("--prop=")) {
      const value = arg.slice("--prop=".length).trim();
      if (value.length > 0) {
        onlyPropId = value;
      }
    }
  }

  return { help: false, preset, onlyPropId };
}

function printHelp() {
  console.log(
    [
      "Usage: node apps/hub/scripts/precompute-vhacd-colliders.mjs [options]",
      "",
      "Options:",
      "  --preset=<name>   Preset name from assets/forge/vhacd-presets.json (default: Balanced)",
      "  --prop=<id>       Process only one prop id",
      "  -h, --help        Show this help"
    ].join("\n")
  );
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function clampInt(value, min, max) {
  return Math.floor(clamp(value, min, max));
}

function normalizeVhacdOptions(input) {
  return {
    resolution: clampInt(input?.resolution ?? 128, 10, 256),
    concavity: clamp(input?.concavity ?? 0.002, 0, 1),
    alpha: clamp(input?.alpha ?? 0.05, 0, 1),
    beta: clamp(input?.beta ?? 0.05, 0, 1),
    sliverPenalty: clamp(input?.sliverPenalty ?? 0.35, 0, 3),
    planeDownsampling: clampInt(input?.planeDownsampling ?? 1, 1, 12),
    convexHullDownsampling: clampInt(input?.convexHullDownsampling ?? 1, 1, 12),
    maxConvexHulls: clampInt(input?.maxConvexHulls ?? 24, 1, 64),
    minVoxelCountPerPart: clampInt(input?.minVoxelCountPerPart ?? 24, 4, 200),
    maxHullPointSamples: clampInt(input?.maxHullPointSamples ?? 1800, 64, 9000),
    projectHullVertices: input?.projectHullVertices ?? true,
    projectHullMaxDistance: clamp(input?.projectHullMaxDistance ?? 0.18, 0, 2),
    precomputeBothHullVariants: input?.precomputeBothHullVariants ?? true,
    maxGridCells: clampInt(input?.maxGridCells ?? 20_000_000, 250_000, 20_000_000),
    voxelizationTriangleSampleCount: clampInt(
      input?.voxelizationTriangleSampleCount ?? 12_000,
      1000,
      120_000
    )
  };
}

function isFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function transformPoint(matrix, x, y, z) {
  return [
    matrix[0] * x + matrix[4] * y + matrix[8] * z + matrix[12],
    matrix[1] * x + matrix[5] * y + matrix[9] * z + matrix[13],
    matrix[2] * x + matrix[6] * y + matrix[10] * z + matrix[14]
  ];
}

function collectSourcePositions(doc) {
  const out = [];
  const root = doc.getRoot();

  for (const node of root.listNodes()) {
    const mesh = node.getMesh();
    if (!mesh) {
      continue;
    }

    const matrix = node.getWorldMatrix();

    for (const primitive of mesh.listPrimitives()) {
      if (primitive.getMode() !== 4) {
        continue;
      }

      const positionAccessor = primitive.getAttribute("POSITION");
      if (!positionAccessor) {
        continue;
      }
      const positionArray = positionAccessor.getArray();
      if (!positionArray || positionArray.length < 9) {
        continue;
      }

      const vertexCount = positionAccessor.getCount();
      const indicesAccessor = primitive.getIndices();
      const indicesArray = indicesAccessor?.getArray() ?? null;

      const pushTriangle = (aIndex, bIndex, cIndex) => {
        if (
          aIndex < 0 ||
          bIndex < 0 ||
          cIndex < 0 ||
          aIndex >= vertexCount ||
          bIndex >= vertexCount ||
          cIndex >= vertexCount
        ) {
          return;
        }

        const aBase = aIndex * 3;
        const bBase = bIndex * 3;
        const cBase = cIndex * 3;

        const a = transformPoint(
          matrix,
          Number(positionArray[aBase]),
          Number(positionArray[aBase + 1]),
          Number(positionArray[aBase + 2])
        );
        const b = transformPoint(
          matrix,
          Number(positionArray[bBase]),
          Number(positionArray[bBase + 1]),
          Number(positionArray[bBase + 2])
        );
        const c = transformPoint(
          matrix,
          Number(positionArray[cBase]),
          Number(positionArray[cBase + 1]),
          Number(positionArray[cBase + 2])
        );

        if (
          !isFiniteNumber(a[0]) ||
          !isFiniteNumber(a[1]) ||
          !isFiniteNumber(a[2]) ||
          !isFiniteNumber(b[0]) ||
          !isFiniteNumber(b[1]) ||
          !isFiniteNumber(b[2]) ||
          !isFiniteNumber(c[0]) ||
          !isFiniteNumber(c[1]) ||
          !isFiniteNumber(c[2])
        ) {
          return;
        }

        out.push(a[0], a[1], a[2]);
        out.push(b[0], b[1], b[2]);
        out.push(c[0], c[1], c[2]);
      };

      if (indicesArray && indicesArray.length >= 3) {
        const usable = indicesArray.length - (indicesArray.length % 3);
        for (let i = 0; i < usable; i += 3) {
          pushTriangle(
            Number(indicesArray[i]),
            Number(indicesArray[i + 1]),
            Number(indicesArray[i + 2])
          );
        }
        continue;
      }

      const usable = vertexCount - (vertexCount % 3);
      for (let i = 0; i < usable; i += 3) {
        pushTriangle(i, i + 1, i + 2);
      }
    }
  }

  return out.length >= 9 ? new Float32Array(out) : null;
}

function asRecord(value) {
  if (!value || typeof value !== "object") {
    return null;
  }
  return value;
}

function boxHullPartFromBounds(bounds) {
  const center = [
    (bounds.minX + bounds.maxX) * 0.5,
    (bounds.minY + bounds.maxY) * 0.5,
    (bounds.minZ + bounds.maxZ) * 0.5
  ];
  const corners = [
    [bounds.minX, bounds.minY, bounds.minZ],
    [bounds.minX, bounds.minY, bounds.maxZ],
    [bounds.minX, bounds.maxY, bounds.minZ],
    [bounds.minX, bounds.maxY, bounds.maxZ],
    [bounds.maxX, bounds.minY, bounds.minZ],
    [bounds.maxX, bounds.minY, bounds.maxZ],
    [bounds.maxX, bounds.maxY, bounds.minZ],
    [bounds.maxX, bounds.maxY, bounds.maxZ]
  ];

  return {
    position: center,
    points: corners.map((corner) => [
      corner[0] - center[0],
      corner[1] - center[1],
      corner[2] - center[2]
    ])
  };
}

function fallbackPartFromMeta(meta) {
  const processing = asRecord(meta?.processing);
  const bbox = asRecord(processing?.bbox);
  const width = Number(bbox?.width);
  const height = Number(bbox?.height);
  const depth = Number(bbox?.depth);

  if (
    isFiniteNumber(width) &&
    isFiniteNumber(height) &&
    isFiniteNumber(depth) &&
    width > 0 &&
    height > 0 &&
    depth > 0
  ) {
    return boxHullPartFromBounds({
      minX: -width * 0.5,
      maxX: width * 0.5,
      minY: 0,
      maxY: height,
      minZ: -depth * 0.5,
      maxZ: depth * 0.5
    });
  }

  return boxHullPartFromBounds({
    minX: -0.1,
    maxX: 0.1,
    minY: -0.1,
    maxY: 0.1,
    minZ: -0.1,
    maxZ: 0.1
  });
}

function readScaleFromMeta(meta) {
  const processing = asRecord(meta?.processing);
  const raw = processing?.scale;
  if (Array.isArray(raw) && raw.length >= 3) {
    const sx = Number(raw[0]);
    const sy = Number(raw[1]);
    const sz = Number(raw[2]);
    if (isFiniteNumber(sx) && isFiniteNumber(sy) && isFiniteNumber(sz)) {
      return [sx, sy, sz];
    }
  }
  if (isFiniteNumber(raw)) {
    return [raw, raw, raw];
  }
  return [1, 1, 1];
}

function normalizeRawSourceForForge(positions, meta) {
  if (!(positions instanceof Float32Array) || positions.length < 3) {
    return {
      positions,
      offset: [0, 0, 0],
      scale: [1, 1, 1]
    };
  }

  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let minZ = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  let maxZ = Number.NEGATIVE_INFINITY;
  for (let i = 0; i < positions.length; i += 3) {
    const x = positions[i];
    const y = positions[i + 1];
    const z = positions[i + 2];
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (z < minZ) minZ = z;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
    if (z > maxZ) maxZ = z;
  }

  const centerX = (minX + maxX) * 0.5;
  const centerZ = (minZ + maxZ) * 0.5;
  const offset = [-centerX, -minY, -centerZ];
  const scale = readScaleFromMeta(meta);

  const transformed = new Float32Array(positions.length);
  for (let i = 0; i < positions.length; i += 3) {
    transformed[i] = (positions[i] + offset[0]) * scale[0];
    transformed[i + 1] = (positions[i + 1] + offset[1]) * scale[1];
    transformed[i + 2] = (positions[i + 2] + offset[2]) * scale[2];
  }

  return {
    positions: transformed,
    offset,
    scale
  };
}

function dedupeGeometryPoints(geometry) {
  const position = geometry.getAttribute("position");
  if (!(position instanceof THREE.BufferAttribute) || position.count <= 0) {
    return [];
  }

  const points = [];
  const seen = new Set();
  for (let i = 0; i < position.count; i += 1) {
    const x = position.getX(i);
    const y = position.getY(i);
    const z = position.getZ(i);
    const key = `${x.toFixed(6)}|${y.toFixed(6)}|${z.toFixed(6)}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    points.push([x, y, z]);
  }
  return points;
}

function spansForPoints(points) {
  if (points.length <= 0) {
    return [0, 0, 0];
  }

  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let minZ = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  let maxZ = Number.NEGATIVE_INFINITY;

  for (const point of points) {
    if (point[0] < minX) minX = point[0];
    if (point[1] < minY) minY = point[1];
    if (point[2] < minZ) minZ = point[2];
    if (point[0] > maxX) maxX = point[0];
    if (point[1] > maxY) maxY = point[1];
    if (point[2] > maxZ) maxZ = point[2];
  }

  return [maxX - minX, maxY - minY, maxZ - minZ];
}

function convertResultToParts(result, meta) {
  const parts = [];

  for (const hull of result.hulls) {
    const worldPoints = dedupeGeometryPoints(hull.geometry);
    if (worldPoints.length < 4) {
      continue;
    }
    const [spanX, spanY, spanZ] = spansForPoints(worldPoints);
    if (
      spanX < MIN_HULL_AXIS_SPAN ||
      spanY < MIN_HULL_AXIS_SPAN ||
      spanZ < MIN_HULL_AXIS_SPAN
    ) {
      continue;
    }

    const center = [hull.centroid[0], hull.centroid[1], hull.centroid[2]];
    parts.push({
      position: center,
      points: worldPoints.map((point) => [
        point[0] - center[0],
        point[1] - center[1],
        point[2] - center[2]
      ])
    });
  }

  if (parts.length > 0) {
    return parts;
  }

  return [fallbackPartFromMeta(meta)];
}

function toFloat32Array(input) {
  if (input instanceof Float32Array) {
    return input;
  }
  return Float32Array.from(input);
}

function buildColliderGlb(parts) {
  const doc = new Document();
  const buffer = doc.createBuffer("buffer");
  const scene = doc.createScene("Collider");
  doc.getRoot().setDefaultScene(scene);

  const material = doc
    .createMaterial("ColliderMaterial")
    .setBaseColorFactor([1, 1, 1, 1])
    .setRoughnessFactor(0.85)
    .setMetallicFactor(0.02);

  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index];
    const vectors = part.points.map((point) => new THREE.Vector3(point[0], point[1], point[2]));
    if (vectors.length < 4) {
      continue;
    }

    const geometry = new ConvexGeometry(vectors);
    try {
      const position = geometry.getAttribute("position");
      if (!(position instanceof THREE.BufferAttribute) || position.count < 3) {
        continue;
      }

      const primitive = doc.createPrimitive();
      primitive.setMaterial(material);

      const positionAccessor = doc
        .createAccessor(`hull-${index + 1}-position`)
        .setType("VEC3")
        .setArray(toFloat32Array(position.array))
        .setBuffer(buffer);
      primitive.setAttribute("POSITION", positionAccessor);

      const normal = geometry.getAttribute("normal");
      if (normal instanceof THREE.BufferAttribute && normal.count === position.count) {
        const normalAccessor = doc
          .createAccessor(`hull-${index + 1}-normal`)
          .setType("VEC3")
          .setArray(toFloat32Array(normal.array))
          .setBuffer(buffer);
        primitive.setAttribute("NORMAL", normalAccessor);
      }

      const mesh = doc.createMesh(`hull-${index + 1}`).addPrimitive(primitive);
      const node = doc
        .createNode(`hull-${index + 1}`)
        .setMesh(mesh)
        .setTranslation(part.position);
      scene.addChild(node);
    } finally {
      geometry.dispose();
    }
  }

  return doc;
}

async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function readJson(filePath) {
  const text = await fs.readFile(filePath, "utf8");
  return JSON.parse(text);
}

async function writeJson(filePath, data) {
  await fs.writeFile(filePath, JSON.stringify(data));
}

function pickPreset(presetFile, preferredName) {
  const presets = Array.isArray(presetFile?.presets) ? presetFile.presets : [];
  if (presets.length <= 0) {
    throw new Error("No presets found in vhacd-presets.json");
  }

  const preferred = presets.find((preset) => {
    return (
      typeof preset?.name === "string" &&
      preset.name.trim().toLowerCase() === preferredName.trim().toLowerCase()
    );
  });
  if (preferred) {
    return preferred;
  }

  const defaultName =
    typeof presetFile?.defaultPreset === "string" ? presetFile.defaultPreset : "";
  const defaultPreset = presets.find((preset) => preset?.name === defaultName);
  return defaultPreset ?? presets[0];
}

function createFallbackMetadata(presetName, options) {
  return {
    method: "vhacd-unity-v1",
    presetName,
    options,
    stats: {
      sourceTriangleCount: 0,
      voxelCount: 0,
      voxelPreviewCount: 0,
      voxelSize: 0,
      rootVolume: 0,
      rootHullVolume: 0,
      rootConcavity: 0,
      splitCount: 0,
      mergeCount: 0,
      candidatePlaneCount: 0,
      iterationCount: 0,
      generatedBeforeMerge: 0,
      splitEvaluationMode: "sequential",
      splitWorkerCount: 1
    },
    signature: "fallback",
    generatedAt: new Date().toISOString(),
    hullCount: 1
  };
}

async function listPropIds(propsRoot) {
  const entries = await fs.readdir(propsRoot, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b));
}

async function run() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }

  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  const repoRoot = path.resolve(scriptDir, "../../..");
  const propsRoot = path.join(repoRoot, PROPS_ROOT);
  const presetPath = path.join(repoRoot, PRESET_FILE);

  const presetFile = await readJson(presetPath);
  const preset = pickPreset(presetFile, args.preset);
  const options = normalizeVhacdOptions(preset.options);

  const io = new NodeIO();
  const propIds = await listPropIds(propsRoot);
  const filteredIds = args.onlyPropId
    ? propIds.filter((propId) => propId === args.onlyPropId)
    : propIds;

  if (filteredIds.length <= 0) {
    console.log("No matching props found.");
    return;
  }

  console.log(
    `Precomputing VHACD colliders for ${filteredIds.length} prop(s) with preset \"${preset.name}\"...`
  );

  let completed = 0;
  let failed = 0;
  let skipped = 0;

  for (let index = 0; index < filteredIds.length; index += 1) {
    const propId = filteredIds[index];
    const progressPrefix = `[${index + 1}/${filteredIds.length}] ${propId}`;

    const propRoot = path.join(propsRoot, propId);
    const modelPathProcessed = path.join(propRoot, "processed/model.glb");
    const modelPathRaw = path.join(propRoot, "raw/tripo-output.glb");
    const metaPath = path.join(propRoot, "meta.json");
    const colliderPath = path.join(propRoot, "processed/collider.glb");

    const modelCandidates = [
      { path: modelPathProcessed, label: "processed/model.glb" },
      { path: modelPathRaw, label: "raw/tripo-output.glb" }
    ];

    const availableCandidates = [];
    for (const candidate of modelCandidates) {
      if (await fileExists(candidate.path)) {
        availableCandidates.push(candidate);
      }
    }

    if (availableCandidates.length <= 0) {
      skipped += 1;
      console.log(`${progressPrefix}: skipped (no source model)`);
      continue;
    }

    try {
      const meta = (await fileExists(metaPath)) ? await readJson(metaPath) : {};

      let sourcePositions = null;
      let sourceLabel = null;
      const candidateIssues = [];
      for (const candidate of availableCandidates) {
        const modelDoc = await io.read(candidate.path);
        const candidatePositions = collectSourcePositions(modelDoc);
        if (candidatePositions && candidatePositions.length >= 9) {
          sourcePositions = candidatePositions;
          sourceLabel = candidate.label;
          break;
        }
        candidateIssues.push(`${candidate.label}: no mesh triangles`);
      }

      if (sourceLabel === "raw/tripo-output.glb") {
        const normalized = normalizeRawSourceForForge(sourcePositions, meta);
        sourcePositions = normalized.positions;
        console.log(
          `${progressPrefix}: using normalized raw source (processed model is empty, scale ${normalized.scale
            .map((value) => value.toFixed(4))
            .join("/")})`
        );
      }

      let collider;
      let metadata;

      if (!sourcePositions) {
        if (candidateIssues.length > 0) {
          console.log(`${progressPrefix}: fallback collider (${candidateIssues.join("; ")})`);
        }
        const fallbackPart = fallbackPartFromMeta(meta);
        collider = {
          type: "compound-convex-hulls",
          position: [0, 0, 0],
          params: {
            parts: [fallbackPart]
          }
        };
        metadata = createFallbackMetadata(preset.name, options);
      } else {
        let vhacdResult = null;
        let lastProgressLog = 0;
        let lastProgressMessage = "";
        try {
          vhacdResult = await runVhacdFromSourceData(
            { positions: sourcePositions },
            options,
            (progress) => {
              const percent = Math.round(progress.propProgress * 100);
              const message = `${progress.phase}:${percent}`;
              const now = Date.now();
              if (
                message !== lastProgressMessage &&
                (now - lastProgressLog > 900 || percent === 100)
              ) {
                console.log(`${progressPrefix}: ${progress.message} (${percent}%)`);
                lastProgressLog = now;
                lastProgressMessage = message;
              }
            }
          );

          const parts = convertResultToParts(vhacdResult, meta);
          collider = {
            type: "compound-convex-hulls",
            position: [0, 0, 0],
            params: {
              parts
            }
          };
          metadata = {
            method: "vhacd-unity-v1",
            presetName: preset.name,
            options,
            stats: { ...vhacdResult.stats },
            signature: vhacdResult.signature,
            generatedAt: new Date().toISOString(),
            hullCount: parts.length
          };
        } finally {
          if (vhacdResult) {
            disposeVhacdResult(vhacdResult);
          }
        }
      }

      const colliderDoc = buildColliderGlb(collider.params.parts);
      const colliderBinary = await io.writeBinary(colliderDoc);
      await fs.mkdir(path.dirname(colliderPath), { recursive: true });
      await fs.writeFile(colliderPath, colliderBinary);

      const metaRecord = asRecord(meta) ?? {};
      const processing = asRecord(metaRecord.processing) ?? {};
      metaRecord.processing = {
        ...processing,
        colliderFaces: metadata.hullCount * 12,
        colliderFaceTarget: Math.max(0, metadata.options.maxConvexHulls * 12)
      };
      metaRecord.collider = collider;
      metaRecord.colliderGeneration = metadata;
      await writeJson(metaPath, metaRecord);

      completed += 1;
      console.log(`${progressPrefix}: done (${metadata.hullCount} hulls)`);
    } catch (error) {
      failed += 1;
      const message = error instanceof Error ? error.message : String(error);
      console.error(`${progressPrefix}: failed (${message})`);
    }
  }

  console.log(
    `Finished. completed=${completed}, failed=${failed}, skipped=${skipped}, total=${filteredIds.length}`
  );
}

void run().catch((error) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  console.error(message);
  process.exitCode = 1;
});
