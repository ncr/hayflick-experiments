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

const PRESET_FILE = "assets/forge-v2/collider-presets.json";
const PHYSICS_FILE = "assets/forge-v2/physics-kinds.json";
const PROPS_ROOT = "assets/forge-v2/props";
const MIN_HULL_AXIS_SPAN = 1e-5;
const DEFAULT_SIM_CHECK = {
  durationSeconds: 0,
  maxLinearSpeed: 0,
  maxAngularSpeed: 0,
  settled: false
};
const VALID_MATERIALS = new Set([
  "default",
  "metal",
  "rubber",
  "glass",
  "wood",
  "concrete"
]);

function parseArgs(argv) {
  let onlyPropId = null;
  let missingOnly = false;

  for (const arg of argv) {
    if (arg === "-h" || arg === "--help") {
      return { help: true, onlyPropId, missingOnly };
    }
    if (arg === "--missing-only") {
      missingOnly = true;
      continue;
    }
    if (arg.startsWith("--prop=")) {
      const value = arg.slice("--prop=".length).trim();
      if (value.length > 0) {
        onlyPropId = value;
      }
    }
  }

  return { help: false, onlyPropId, missingOnly };
}

function printHelp() {
  console.log(
    [
      "Usage: node apps/hub/scripts/precompute-vhacd-colliders-v2.mjs [options]",
      "",
      "Options:",
      "  --missing-only   Process only props that still need physics approval (matches UI 'Phy missing')",
      "  --prop=<id>      Process only one prop id",
      "  -h, --help       Show this help"
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

function needsPhysicsApproval(meta) {
  return meta?.lifecycle?.status !== "physics-approved";
}

function isFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function asRecord(value) {
  if (!value || typeof value !== "object") {
    return null;
  }
  return value;
}

function asTuple3(value) {
  if (!Array.isArray(value) || value.length !== 3) {
    return null;
  }
  const x = Number(value[0]);
  const y = Number(value[1]);
  const z = Number(value[2]);
  if (!isFiniteNumber(x) || !isFiniteNumber(y) || !isFiniteNumber(z)) {
    return null;
  }
  return [x, y, z];
}

function createBoundsAccumulator() {
  return {
    minX: Number.POSITIVE_INFINITY,
    minY: Number.POSITIVE_INFINITY,
    minZ: Number.POSITIVE_INFINITY,
    maxX: Number.NEGATIVE_INFINITY,
    maxY: Number.NEGATIVE_INFINITY,
    maxZ: Number.NEGATIVE_INFINITY
  };
}

function expandBounds(bounds, x, y, z) {
  if (x < bounds.minX) bounds.minX = x;
  if (y < bounds.minY) bounds.minY = y;
  if (z < bounds.minZ) bounds.minZ = z;
  if (x > bounds.maxX) bounds.maxX = x;
  if (y > bounds.maxY) bounds.maxY = y;
  if (z > bounds.maxZ) bounds.maxZ = z;
}

function finalizeBounds(bounds) {
  if (!isFiniteNumber(bounds.minX) || !isFiniteNumber(bounds.maxX)) {
    return null;
  }
  return {
    minX: bounds.minX,
    minY: bounds.minY,
    minZ: bounds.minZ,
    maxX: bounds.maxX,
    maxY: bounds.maxY,
    maxZ: bounds.maxZ
  };
}

function boundsToBoxJson(bounds) {
  if (!bounds) {
    return null;
  }
  return {
    width: Math.max(0, bounds.maxX - bounds.minX),
    height: Math.max(0, bounds.maxY - bounds.minY),
    depth: Math.max(0, bounds.maxZ - bounds.minZ)
  };
}

function computeBoundsFromPositions(positions) {
  if (!(positions instanceof Float32Array) || positions.length < 3) {
    return null;
  }
  const bounds = createBoundsAccumulator();
  for (let i = 0; i < positions.length; i += 3) {
    expandBounds(bounds, positions[i], positions[i + 1], positions[i + 2]);
  }
  return finalizeBounds(bounds);
}

function transformPoint(matrix, x, y, z) {
  return [
    matrix[0] * x + matrix[4] * y + matrix[8] * z + matrix[12],
    matrix[1] * x + matrix[5] * y + matrix[9] * z + matrix[13],
    matrix[2] * x + matrix[6] * y + matrix[10] * z + matrix[14]
  ];
}

function collectSourceData(doc) {
  const out = [];
  let triangleCount = 0;
  const bounds = createBoundsAccumulator();
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
        expandBounds(bounds, a[0], a[1], a[2]);
        expandBounds(bounds, b[0], b[1], b[2]);
        expandBounds(bounds, c[0], c[1], c[2]);
        triangleCount += 1;
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

  return {
    positions: out.length >= 9 ? new Float32Array(out) : null,
    triangleCount,
    bounds: finalizeBounds(bounds)
  };
}

function readScaleFromMeta(meta) {
  const processing = asRecord(meta?.processing);
  const transform = asRecord(processing?.transform);
  const scaleRaw = transform?.scale;
  if (Array.isArray(scaleRaw) && scaleRaw.length >= 3) {
    const sx = Number(scaleRaw[0]);
    const sy = Number(scaleRaw[1]);
    const sz = Number(scaleRaw[2]);
    if (isFiniteNumber(sx) && isFiniteNumber(sy) && isFiniteNumber(sz)) {
      return [sx, sy, sz];
    }
  }
  if (isFiniteNumber(scaleRaw)) {
    return [scaleRaw, scaleRaw, scaleRaw];
  }
  return [1, 1, 1];
}

function normalizeRawSourceForForgeV2(summary, meta) {
  if (!(summary?.positions instanceof Float32Array) || !summary.bounds) {
    return summary;
  }

  const bounds = summary.bounds;
  const centerX = (bounds.minX + bounds.maxX) * 0.5;
  const centerZ = (bounds.minZ + bounds.maxZ) * 0.5;
  const offset = [-centerX, -bounds.minY, -centerZ];
  const scale = readScaleFromMeta(meta);
  const transformed = new Float32Array(summary.positions.length);

  for (let i = 0; i < summary.positions.length; i += 3) {
    transformed[i] = (summary.positions[i] + offset[0]) * scale[0];
    transformed[i + 1] = (summary.positions[i + 1] + offset[1]) * scale[1];
    transformed[i + 2] = (summary.positions[i + 2] + offset[2]) * scale[2];
  }

  return {
    positions: transformed,
    triangleCount: summary.triangleCount,
    bounds: computeBoundsFromPositions(transformed)
  };
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
  const mesh = asRecord(processing?.mesh);
  const bboxCandidates = [mesh?.bboxProcessed, mesh?.bboxRaw, processing?.bbox];
  for (const candidate of bboxCandidates) {
    const bbox = asRecord(candidate);
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

async function writeJson(filePath, data, pretty = false) {
  const next = pretty ? JSON.stringify(data, null, 2) : JSON.stringify(data);
  await fs.writeFile(filePath, next + (pretty ? "\n" : ""));
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

function pickDefaultPresetId(presetFile) {
  const defaultPresetId =
    typeof presetFile?.defaultPresetId === "string" ? presetFile.defaultPresetId : null;
  const presets = Array.isArray(presetFile?.presets) ? presetFile.presets : [];
  if (defaultPresetId && presets.some((preset) => preset.id === defaultPresetId)) {
    return defaultPresetId;
  }
  return presets[0]?.id ?? null;
}

function pickDefaultPhysicsKind(physicsFile, requestedKindId = null) {
  const kinds = Array.isArray(physicsFile?.kinds) ? physicsFile.kinds : [];
  if (kinds.length <= 0) {
    throw new Error("No forge-v2 physics kinds found.");
  }
  if (requestedKindId) {
    const requested = kinds.find((kind) => kind.id === requestedKindId);
    if (requested) {
      return requested;
    }
  }
  const defaultKindId =
    typeof physicsFile?.defaultKindId === "string" ? physicsFile.defaultKindId : null;
  return kinds.find((kind) => kind.id === defaultKindId) ?? kinds[0];
}

function normalizeResolvedPhysics(settings) {
  const material = VALID_MATERIALS.has(settings?.material) ? settings.material : "default";
  return {
    mobility:
      settings?.mobility === "fixed" || settings?.mobility === "dynamic"
        ? settings.mobility
        : "auto",
    material,
    massMode: settings?.massMode === "manual" ? "manual" : "auto",
    massScale: clamp(Number(settings?.massScale) || 1, 0.1, 10),
    manualMass: clamp(Number(settings?.manualMass) || 0.65, 0.01, 250),
    friction: clamp(Number(settings?.friction) || 0.78, 0, 2),
    restitution: clamp(Number(settings?.restitution) || 0.03, 0, 1),
    linearDamping: clamp(Number(settings?.linearDamping) || 0.24, 0, 20),
    angularDamping: clamp(Number(settings?.angularDamping) || 0.34, 0, 20),
    activationDelayMs: clampInt(Number(settings?.activationDelayMs) || 500, 0, 120_000)
  };
}

function computeColliderBounds(parts) {
  const bounds = createBoundsAccumulator();
  for (const part of parts) {
    const position = asTuple3(part?.position);
    const points = Array.isArray(part?.points) ? part.points : [];
    if (!position || points.length < 4) {
      continue;
    }
    for (const point of points) {
      const tuple = asTuple3(point);
      if (!tuple) {
        continue;
      }
      expandBounds(
        bounds,
        position[0] + tuple[0],
        position[1] + tuple[1],
        position[2] + tuple[2]
      );
    }
  }
  return finalizeBounds(bounds);
}

function computeFinalPivotFromCollider(parts) {
  const bounds = computeColliderBounds(parts);
  if (!bounds) {
    return [0, 0, 0];
  }
  const centerX = (bounds.minX + bounds.maxX) * 0.5;
  const centerZ = (bounds.minZ + bounds.maxZ) * 0.5;
  return [-centerX, -bounds.minY, -centerZ];
}

function makeSimulationChecks(simulationChecks) {
  const existing = asRecord(simulationChecks) ?? {};
  return {
    floorDrop: {
      scenario: "floorDrop",
      ...DEFAULT_SIM_CHECK,
      ...(asRecord(existing.floorDrop) ?? {})
    },
    slope30Drop: {
      scenario: "slope30Drop",
      ...DEFAULT_SIM_CHECK,
      ...(asRecord(existing.slope30Drop) ?? {})
    },
    edgeDrop: {
      scenario: "edgeDrop",
      ...DEFAULT_SIM_CHECK,
      ...(asRecord(existing.edgeDrop) ?? {})
    }
  };
}

async function listPropIds(propsRoot) {
  const entries = await fs.readdir(propsRoot, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b));
}

async function readModelSummary(io, filePath) {
  const doc = await io.read(filePath);
  return collectSourceData(doc);
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
  const physicsPath = path.join(repoRoot, PHYSICS_FILE);

  const [presetFile, physicsFile] = await Promise.all([
    readJson(presetPath),
    readJson(physicsPath)
  ]);
  const presets = Array.isArray(presetFile?.presets) ? presetFile.presets : [];
  if (presets.length <= 0) {
    throw new Error("No forge-v2 collider presets found.");
  }
  const defaultPresetId = pickDefaultPresetId(presetFile);
  if (!defaultPresetId) {
    throw new Error("No default forge-v2 collider preset id resolved.");
  }

  const io = new NodeIO();
  const propIds = await listPropIds(propsRoot);
  let filteredIds = args.onlyPropId
    ? propIds.filter((propId) => propId === args.onlyPropId)
    : propIds;

  if (args.missingOnly) {
    const missingIds = [];
    for (const propId of filteredIds) {
      const metaPath = path.join(propsRoot, propId, "meta.json");
      const meta = await readJson(metaPath);
      if (needsPhysicsApproval(meta)) {
        missingIds.push(propId);
      }
    }
    filteredIds = missingIds;
  }

  if (filteredIds.length <= 0) {
    console.log("No matching forge-v2 props found.");
    return;
  }

  console.log(
    `Computing forge-v2 colliders for ${filteredIds.length} prop(s) across ${presets.length} preset(s)...`
  );

  let completed = 0;
  let failed = 0;
  let skipped = 0;

  for (let index = 0; index < filteredIds.length; index += 1) {
    const propId = filteredIds[index];
    const progressPrefix = `[${index + 1}/${filteredIds.length}] ${propId}`;
    const propRoot = path.join(propsRoot, propId);
    const metaPath = path.join(propRoot, "meta.json");
    const processedPath = path.join(propRoot, "processed/model.glb");
    const rawPath = path.join(propRoot, "raw/tripo-output.glb");

    try {
      const meta = await readJson(metaPath);
      const processedExists = await fileExists(processedPath);
      const rawExists = await fileExists(rawPath);

      if (!processedExists && !rawExists) {
        skipped += 1;
        console.log(`${progressPrefix}: skipped (no processed or raw GLB found)`);
        continue;
      }

      const processedSummary = processedExists ? await readModelSummary(io, processedPath) : null;
      const rawSummary = rawExists ? await readModelSummary(io, rawPath) : null;

      let sourceSummary =
        processedSummary?.positions && processedSummary.positions.length >= 9
          ? processedSummary
          : rawSummary?.positions && rawSummary.positions.length >= 9
            ? normalizeRawSourceForForgeV2(rawSummary, meta)
            : null;

      const entries = [];
      if (!sourceSummary?.positions) {
        const fallbackPart = fallbackPartFromMeta(meta);
        for (const preset of presets) {
          const options = normalizeVhacdOptions(preset.options);
          const metadata = createFallbackMetadata(preset.name, options);
          const collider = {
            type: "compound-convex-hulls",
            position: [0, 0, 0],
            params: {
              parts: [fallbackPart]
            }
          };
          const colliderDoc = buildColliderGlb(collider.params.parts);
          const colliderBinary = await io.writeBinary(colliderDoc);
          const rel = `processed/colliders/${preset.id}.glb`;
          await fs.mkdir(path.join(propRoot, "processed/colliders"), { recursive: true });
          await fs.writeFile(path.join(propRoot, rel), colliderBinary);
          entries.push({
            presetId: preset.id,
            presetName: preset.name,
            enabled: true,
            file: rel,
            collider,
            generation: metadata
          });
        }
        console.log(`${progressPrefix}: used fallback collider geometry`);
      } else {
        for (let presetIndex = 0; presetIndex < presets.length; presetIndex += 1) {
          const preset = presets[presetIndex];
          const options = normalizeVhacdOptions(preset.options);
          let vhacdResult = null;
          let lastProgressLog = 0;
          let lastProgressMessage = "";
          try {
            vhacdResult = await runVhacdFromSourceData(
              { positions: sourceSummary.positions },
              options,
              (progress) => {
                const percent = Math.round(progress.propProgress * 100);
                const message = `${preset.id}:${progress.phase}:${percent}`;
                const now = Date.now();
                if (
                  message !== lastProgressMessage &&
                  (now - lastProgressLog > 900 || percent === 100)
                ) {
                  console.log(
                    `${progressPrefix}: ${preset.name} ${progress.message} (${percent}%)`
                  );
                  lastProgressLog = now;
                  lastProgressMessage = message;
                }
              }
            );

            const parts = convertResultToParts(vhacdResult, meta);
            const collider = {
              type: "compound-convex-hulls",
              position: [0, 0, 0],
              params: {
                parts
              }
            };
            const metadata = {
              method: "vhacd-unity-v1",
              presetName: preset.name,
              options,
              stats: { ...vhacdResult.stats },
              signature: vhacdResult.signature,
              generatedAt: new Date().toISOString(),
              hullCount: parts.length
            };
            const colliderDoc = buildColliderGlb(parts);
            const colliderBinary = await io.writeBinary(colliderDoc);
            const rel = `processed/colliders/${preset.id}.glb`;
            await fs.mkdir(path.join(propRoot, "processed/colliders"), { recursive: true });
            await fs.writeFile(path.join(propRoot, rel), colliderBinary);
            entries.push({
              presetId: preset.id,
              presetName: preset.name,
              enabled: true,
              file: rel,
              collider,
              generation: metadata
            });
            console.log(`${progressPrefix}: ${preset.name} done (${parts.length} hulls)`);
          } finally {
            if (vhacdResult) {
              disposeVhacdResult(vhacdResult);
            }
          }
        }
      }

      const selectedEntry =
        entries.find((entry) => entry.presetId === defaultPresetId) ?? entries[0] ?? null;
      if (!selectedEntry) {
        throw new Error("No collider entries were generated.");
      }

      const defaultKind = pickDefaultPhysicsKind(
        physicsFile,
        typeof meta?.physics?.kind === "string" ? meta.physics.kind : null
      );
      const existingResolved = asRecord(meta?.physics?.resolved);
      const resolvedPhysics = normalizeResolvedPhysics(existingResolved ?? defaultKind);
      const nowIso = new Date().toISOString();
      const finalPivotOffset = computeFinalPivotFromCollider(
        selectedEntry.collider.params.parts
      );
      const processing = asRecord(meta.processing) ?? {};
      const mesh = asRecord(processing.mesh) ?? {};
      const processedBounds = processedSummary?.bounds ?? sourceSummary?.bounds ?? null;
      const rawBounds = rawSummary?.bounds ?? null;
      const nextProcessedFaces =
        Number(mesh.processedFaces) > 0
          ? Number(mesh.processedFaces)
          : Math.max(0, processedSummary?.triangleCount ?? sourceSummary?.triangleCount ?? 0);
      const nextOriginalFaces =
        Number(mesh.originalFaces) > 0
          ? Number(mesh.originalFaces)
          : Math.max(0, rawSummary?.triangleCount ?? nextProcessedFaces);

      meta.processing = {
        ...processing,
        mesh: {
          ...mesh,
          originalFaces: nextOriginalFaces,
          processedFaces: nextProcessedFaces,
          simplificationRatio:
            nextOriginalFaces > 0 ? nextProcessedFaces / nextOriginalFaces : 1,
          ...(mesh.bboxRaw ? {} : rawBounds ? { bboxRaw: boundsToBoxJson(rawBounds) } : {}),
          ...(mesh.bboxProcessed
            ? {}
            : processedBounds
              ? { bboxProcessed: boundsToBoxJson(processedBounds) }
              : {})
        },
        transform: {
          ...(asRecord(processing.transform) ?? {}),
          finalPivot: {
            preset: "bottom-center",
            offset: finalPivotOffset,
            basis: "collider",
            colliderPresetId: selectedEntry.presetId
          }
        }
      };
      meta.colliders = {
        selectedPresetId: selectedEntry.presetId,
        presets: entries
      };
      meta.physics = {
        kind: defaultKind.id,
        overrides: asRecord(meta?.physics?.overrides) ?? {},
        resolved: resolvedPhysics,
        simulationChecks: makeSimulationChecks(meta?.physics?.simulationChecks)
      };
      meta.lifecycle = {
        ...(asRecord(meta.lifecycle) ?? {}),
        status: "physics-approved",
        physicsApprovedAt: nowIso
      };
      meta.updatedAt = nowIso;

      await writeJson(metaPath, meta, false);
      completed += 1;
      console.log(`${progressPrefix}: approved with ${entries.length} preset(s)`);
    } catch (error) {
      failed += 1;
      const message = error instanceof Error ? error.message : String(error);
      console.error(`${progressPrefix}: failed (${message})`);
    }
  }

  console.log(
    `Finished forge-v2 collider batch. completed=${completed}, failed=${failed}, skipped=${skipped}, total=${filteredIds.length}`
  );
}

void run().catch((error) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  console.error(message);
  process.exitCode = 1;
});
