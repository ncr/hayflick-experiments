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
const MIN_HULL_AXIS_SPAN = 1e-5;

function parseArgs(argv) {
  let input = null;
  let presetId = "balanced";
  let outputJson = null;
  let outputGlb = null;

  for (const arg of argv) {
    if (arg === "-h" || arg === "--help") {
      return { help: true, input, presetId, outputJson, outputGlb };
    }
    if (arg.startsWith("--input=")) {
      input = arg.slice("--input=".length).trim() || null;
      continue;
    }
    if (arg.startsWith("--preset-id=")) {
      presetId = arg.slice("--preset-id=".length).trim() || presetId;
      continue;
    }
    if (arg.startsWith("--output-json=")) {
      outputJson = arg.slice("--output-json=".length).trim() || null;
      continue;
    }
    if (arg.startsWith("--output-glb=")) {
      outputGlb = arg.slice("--output-glb=".length).trim() || null;
    }
  }

  return { help: false, input, presetId, outputJson, outputGlb };
}

function printHelp() {
  console.log(
    [
      "Usage: node apps/hub/scripts/precompute-static-asset-collider.mjs [options]",
      "",
      "Options:",
      "  --input=<path>         GLB path relative to repo root",
      "  --preset-id=<id>       Preset id from assets/forge-v2/collider-presets.json",
      "  --output-json=<path>   Output JSON path relative to repo root",
      "  --output-glb=<path>    Optional debug GLB output path relative to repo root",
      "  -h, --help             Show this help"
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

        const ax =
          matrix[0] * Number(positionArray[aBase]) +
          matrix[4] * Number(positionArray[aBase + 1]) +
          matrix[8] * Number(positionArray[aBase + 2]) +
          matrix[12];
        const ay =
          matrix[1] * Number(positionArray[aBase]) +
          matrix[5] * Number(positionArray[aBase + 1]) +
          matrix[9] * Number(positionArray[aBase + 2]) +
          matrix[13];
        const az =
          matrix[2] * Number(positionArray[aBase]) +
          matrix[6] * Number(positionArray[aBase + 1]) +
          matrix[10] * Number(positionArray[aBase + 2]) +
          matrix[14];

        const bx =
          matrix[0] * Number(positionArray[bBase]) +
          matrix[4] * Number(positionArray[bBase + 1]) +
          matrix[8] * Number(positionArray[bBase + 2]) +
          matrix[12];
        const by =
          matrix[1] * Number(positionArray[bBase]) +
          matrix[5] * Number(positionArray[bBase + 1]) +
          matrix[9] * Number(positionArray[bBase + 2]) +
          matrix[13];
        const bz =
          matrix[2] * Number(positionArray[bBase]) +
          matrix[6] * Number(positionArray[bBase + 1]) +
          matrix[10] * Number(positionArray[bBase + 2]) +
          matrix[14];

        const cx =
          matrix[0] * Number(positionArray[cBase]) +
          matrix[4] * Number(positionArray[cBase + 1]) +
          matrix[8] * Number(positionArray[cBase + 2]) +
          matrix[12];
        const cy =
          matrix[1] * Number(positionArray[cBase]) +
          matrix[5] * Number(positionArray[cBase + 1]) +
          matrix[9] * Number(positionArray[cBase + 2]) +
          matrix[13];
        const cz =
          matrix[2] * Number(positionArray[cBase]) +
          matrix[6] * Number(positionArray[cBase + 1]) +
          matrix[10] * Number(positionArray[cBase + 2]) +
          matrix[14];

        if (
          !isFiniteNumber(ax) ||
          !isFiniteNumber(ay) ||
          !isFiniteNumber(az) ||
          !isFiniteNumber(bx) ||
          !isFiniteNumber(by) ||
          !isFiniteNumber(bz) ||
          !isFiniteNumber(cx) ||
          !isFiniteNumber(cy) ||
          !isFiniteNumber(cz)
        ) {
          return;
        }

        out.push(ax, ay, az, bx, by, bz, cx, cy, cz);
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

function convertResultToParts(result) {
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

  return parts;
}

async function readJson(filePath) {
  const text = await fs.readFile(filePath, "utf8");
  return JSON.parse(text);
}

async function writeJson(filePath, data) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(data, null, 2)}\n`);
}

async function run() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }
  if (!args.input || !args.outputJson) {
    throw new Error("--input and --output-json are required.");
  }

  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  const repoRoot = path.resolve(scriptDir, "../../..");
  const inputPath = path.join(repoRoot, args.input);
  const outputJsonPath = path.join(repoRoot, args.outputJson);
  const outputGlbPath = args.outputGlb ? path.join(repoRoot, args.outputGlb) : null;
  const presetFile = await readJson(path.join(repoRoot, PRESET_FILE));
  const presets = Array.isArray(presetFile?.presets) ? presetFile.presets : [];
  const preset = presets.find((entry) => entry?.id === args.presetId);
  if (!preset) {
    throw new Error(`Preset '${args.presetId}' not found in ${PRESET_FILE}.`);
  }

  const io = new NodeIO();
  const doc = await io.read(inputPath);
  const positions = collectSourcePositions(doc);
  if (!positions) {
    throw new Error("No triangle positions found in source GLB.");
  }

  const options = normalizeVhacdOptions(preset.options);
  let vhacdResult = null;
  try {
    vhacdResult = await runVhacdFromSourceData(
      { positions },
      options,
      (progress) => {
        const percent = Math.round(progress.propProgress * 100);
        console.log(`${preset.name}: ${progress.message} (${percent}%)`);
      }
    );

    const parts = convertResultToParts(vhacdResult);
    if (parts.length <= 0) {
      throw new Error("VHACD returned no usable hull parts.");
    }

    const payload = {
      version: 1,
      sourceAsset: args.input,
      presetId: preset.id,
      presetName: preset.name,
      generatedAt: new Date().toISOString(),
      generation: {
        method: "vhacd-unity-v1",
        presetName: preset.name,
        options,
        stats: { ...vhacdResult.stats },
        signature: vhacdResult.signature,
        generatedAt: new Date().toISOString(),
        hullCount: parts.length
      },
      collider: {
        type: "compound-convex-hulls",
        position: [0, 0, 0],
        params: { parts }
      }
    };

    await writeJson(outputJsonPath, payload);
    console.log(`Wrote collider JSON: ${args.outputJson}`);

    if (outputGlbPath) {
      const colliderDoc = buildColliderGlb(parts);
      const glb = await io.writeBinary(colliderDoc);
      await fs.mkdir(path.dirname(outputGlbPath), { recursive: true });
      await fs.writeFile(outputGlbPath, glb);
      console.log(`Wrote collider GLB: ${args.outputGlb}`);
    }
  } finally {
    if (vhacdResult) {
      disposeVhacdResult(vhacdResult);
    }
  }
}

void run().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
