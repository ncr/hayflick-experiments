#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { NodeIO } from "@gltf-transform/core";
import { MeshoptSimplifier } from "meshoptimizer";

const DEFAULT_TARGET_FACES = 96;
const MIN_TARGET_FACES = 24;
const MIN_BOX_EDGE = 0.01;
const MAX_SAMPLE_POINTS = 6000;
const MAX_CONVEX_POINTS = 192;
const KMEANS_ITERATIONS = 8;
const TRIANGLES_MODE = 4;
const SIMPLIFY_ERRORS = [0.05, 0.1, 0.2, 0.5, 1];

function parseArgs(argv) {
  let targetFaces = DEFAULT_TARGET_FACES;
  let onlyPropId = null;

  for (const arg of argv) {
    if (arg === "--help" || arg === "-h") {
      return { help: true, targetFaces, onlyPropId };
    }
    if (arg.startsWith("--target-faces=")) {
      const value = Number(arg.slice("--target-faces=".length));
      if (Number.isFinite(value) && value > 0) {
        targetFaces = Math.round(value);
      }
      continue;
    }
    if (arg.startsWith("--prop=")) {
      const value = arg.slice("--prop=".length).trim();
      onlyPropId = value.length > 0 ? value : null;
    }
  }

  return { help: false, targetFaces, onlyPropId };
}

function printHelp() {
  console.log(
    [
      "Usage: node apps/hub/scripts/retrofit-collider-meshes.mjs [options]",
      "",
      "Options:",
      "  --target-faces=<n>   Target collider triangle budget per prop (default: 96)",
      "  --prop=<id>          Process only one prop id",
      "  -h, --help           Show this help message"
    ].join("\n")
  );
}

function toFloat32Array(values) {
  if (values instanceof Float32Array) {
    return values;
  }
  return Float32Array.from(values);
}

function readPrimitiveIndices(primitive, vertexCount) {
  const indicesAccessor = primitive.getIndices();
  if (indicesAccessor) {
    const array = indicesAccessor.getArray();
    if (array && array.length > 0) {
      return Uint32Array.from(array);
    }
  }

  const indices = new Uint32Array(vertexCount);
  for (let i = 0; i < vertexCount; i += 1) {
    indices[i] = i;
  }
  return indices;
}

function trimIndicesToTriangles(indices) {
  const usable = indices.length - (indices.length % 3);
  if (usable <= 0 || usable === indices.length) {
    return indices;
  }
  return indices.slice(0, usable);
}

function compactIndexedMesh(positions, indices) {
  const vertexCount = Math.floor(positions.length / 3);
  if (vertexCount <= 0 || indices.length < 3) {
    return null;
  }

  const remap = new Int32Array(vertexCount);
  remap.fill(-1);
  const compactPositions = [];
  const compactIndices = new Uint32Array(indices.length);
  let nextIndex = 0;

  for (let i = 0; i < indices.length; i += 1) {
    const sourceIndex = indices[i];
    if (sourceIndex >= vertexCount) {
      compactIndices[i] = 0;
      continue;
    }

    let mapped = remap[sourceIndex];
    if (mapped === -1) {
      mapped = nextIndex;
      remap[sourceIndex] = mapped;
      nextIndex += 1;

      const base = sourceIndex * 3;
      compactPositions.push(
        positions[base],
        positions[base + 1],
        positions[base + 2]
      );
    }

    compactIndices[i] = mapped;
  }

  if (compactPositions.length < 9) {
    return null;
  }

  const compactVertexCount = compactPositions.length / 3;
  const typedIndices =
    compactVertexCount > 65535
      ? compactIndices
      : new Uint16Array(compactIndices);

  return {
    positions: new Float32Array(compactPositions),
    indices: typedIndices
  };
}

function weldIndexedMeshByPosition(positions, indices) {
  const vertexCount = Math.floor(positions.length / 3);
  if (vertexCount <= 0 || indices.length < 3) {
    return null;
  }

  const positionToIndex = new Map();
  const weldedPositions = [];
  const weldedIndices = new Uint32Array(indices.length);

  for (let i = 0; i < indices.length; i += 1) {
    const sourceIndex = indices[i];
    if (sourceIndex >= vertexCount) {
      weldedIndices[i] = 0;
      continue;
    }
    const base = sourceIndex * 3;
    const x = positions[base];
    const y = positions[base + 1];
    const z = positions[base + 2];
    const key = `${x.toFixed(6)}|${y.toFixed(6)}|${z.toFixed(6)}`;

    let mapped = positionToIndex.get(key);
    if (mapped === undefined) {
      mapped = weldedPositions.length / 3;
      positionToIndex.set(key, mapped);
      weldedPositions.push(x, y, z);
    }
    weldedIndices[i] = mapped;
  }

  return {
    positions: new Float32Array(weldedPositions),
    indices: weldedIndices
  };
}

function simplifyPrimitive(doc, primitive, ratio, buffer) {
  if (primitive.getMode() !== TRIANGLES_MODE) {
    return;
  }

  const positionAccessor = primitive.getAttribute("POSITION");
  if (!positionAccessor) {
    return;
  }
  const positionArrayRaw = positionAccessor.getArray();
  if (!positionArrayRaw || positionArrayRaw.length < 9) {
    return;
  }

  const positions = toFloat32Array(positionArrayRaw);
  const vertexCount = positionAccessor.getCount();
  const indices = trimIndicesToTriangles(
    readPrimitiveIndices(primitive, vertexCount)
  );
  if (indices.length < 3) {
    return;
  }

  const welded = weldIndexedMeshByPosition(positions, indices);
  if (!welded) {
    return;
  }

  const basePositions = welded.positions;
  const baseIndices = trimIndicesToTriangles(welded.indices);
  const rawTarget = Math.floor(baseIndices.length * ratio);
  const targetIndexCount = Math.max(3, rawTarget - (rawTarget % 3));

  let simplifiedIndices = baseIndices;
  if (targetIndexCount < baseIndices.length) {
    simplifiedIndices = null;
    for (const error of SIMPLIFY_ERRORS) {
      try {
        const [result] = MeshoptSimplifier.simplify(
          baseIndices,
          basePositions,
          3,
          targetIndexCount,
          error
        );
        const candidate = trimIndicesToTriangles(new Uint32Array(result));
        simplifiedIndices = candidate;
        if (candidate.length <= targetIndexCount) {
          break;
        }
      } catch {
        // Try a looser error tolerance before falling back.
      }
    }
    if (!simplifiedIndices) {
      simplifiedIndices = baseIndices;
    }
  }
  if (simplifiedIndices.length < 3) {
    simplifiedIndices = baseIndices;
  }

  const compacted = compactIndexedMesh(basePositions, simplifiedIndices);
  if (!compacted) {
    return;
  }

  const semantics = [...primitive.listSemantics()];
  for (const semantic of semantics) {
    if (semantic !== "POSITION") {
      primitive.setAttribute(semantic, null);
    }
  }
  for (const target of [...primitive.listTargets()]) {
    primitive.removeTarget(target);
  }

  const nextPosition = doc
    .createAccessor()
    .setType("VEC3")
    .setArray(compacted.positions)
    .setBuffer(buffer);
  const nextIndices = doc
    .createAccessor()
    .setType("SCALAR")
    .setArray(compacted.indices)
    .setBuffer(buffer);

  primitive.setAttribute("POSITION", nextPosition);
  primitive.setIndices(nextIndices);
  primitive.setMaterial(null);
}

function countDocFaces(doc) {
  let total = 0;
  for (const mesh of doc.getRoot().listMeshes()) {
    for (const primitive of mesh.listPrimitives()) {
      if (primitive.getMode() !== TRIANGLES_MODE) {
        continue;
      }
      const indices = primitive.getIndices();
      if (indices) {
        const array = indices.getArray();
        if (array) {
          total += Math.floor(array.length / 3);
          continue;
        }
      }
      const position = primitive.getAttribute("POSITION");
      if (position) {
        total += Math.floor(position.getCount() / 3);
      }
    }
  }
  return total;
}

function emptyBounds() {
  return {
    minX: Number.POSITIVE_INFINITY,
    minY: Number.POSITIVE_INFINITY,
    minZ: Number.POSITIVE_INFINITY,
    maxX: Number.NEGATIVE_INFINITY,
    maxY: Number.NEGATIVE_INFINITY,
    maxZ: Number.NEGATIVE_INFINITY
  };
}

function boundsIsEmpty(bounds) {
  return !Number.isFinite(bounds.minX);
}

function expandBounds(bounds, point) {
  if (point.x < bounds.minX) bounds.minX = point.x;
  if (point.y < bounds.minY) bounds.minY = point.y;
  if (point.z < bounds.minZ) bounds.minZ = point.z;
  if (point.x > bounds.maxX) bounds.maxX = point.x;
  if (point.y > bounds.maxY) bounds.maxY = point.y;
  if (point.z > bounds.maxZ) bounds.maxZ = point.z;
}

function makeSafeBounds(bounds) {
  if (boundsIsEmpty(bounds)) {
    return {
      minX: -0.1,
      minY: 0,
      minZ: -0.1,
      maxX: 0.1,
      maxY: 0.2,
      maxZ: 0.1
    };
  }
  const centerX = (bounds.minX + bounds.maxX) * 0.5;
  const centerY = (bounds.minY + bounds.maxY) * 0.5;
  const centerZ = (bounds.minZ + bounds.maxZ) * 0.5;
  const halfX = Math.max((bounds.maxX - bounds.minX) * 0.5, MIN_BOX_EDGE * 0.5);
  const halfY = Math.max((bounds.maxY - bounds.minY) * 0.5, MIN_BOX_EDGE * 0.5);
  const halfZ = Math.max((bounds.maxZ - bounds.minZ) * 0.5, MIN_BOX_EDGE * 0.5);
  return {
    minX: centerX - halfX,
    minY: centerY - halfY,
    minZ: centerZ - halfZ,
    maxX: centerX + halfX,
    maxY: centerY + halfY,
    maxZ: centerZ + halfZ
  };
}

function boundsSize(bounds) {
  return {
    x: bounds.maxX - bounds.minX,
    y: bounds.maxY - bounds.minY,
    z: bounds.maxZ - bounds.minZ
  };
}

function boundsCenter(bounds) {
  return {
    x: (bounds.minX + bounds.maxX) * 0.5,
    y: (bounds.minY + bounds.maxY) * 0.5,
    z: (bounds.minZ + bounds.maxZ) * 0.5
  };
}

function distanceSq(a, b) {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const dz = a.z - b.z;
  return dx * dx + dy * dy + dz * dz;
}

function collectDocSamplePoints(doc, maxSamples = MAX_SAMPLE_POINTS) {
  const primitives = [];
  let totalVertices = 0;

  for (const mesh of doc.getRoot().listMeshes()) {
    for (const primitive of mesh.listPrimitives()) {
      if (primitive.getMode() !== TRIANGLES_MODE) {
        continue;
      }
      const position = primitive.getAttribute("POSITION");
      if (!position) {
        continue;
      }
      const array = position.getArray();
      if (!array || array.length < 9) {
        continue;
      }
      const count = position.getCount();
      if (count <= 0) {
        continue;
      }
      primitives.push({ array, count });
      totalVertices += count;
    }
  }

  if (primitives.length === 0 || totalVertices <= 0) {
    return [];
  }

  const points = [];
  for (const primitive of primitives) {
    const desired = Math.max(
      24,
      Math.floor((primitive.count / totalVertices) * maxSamples)
    );
    const step = Math.max(1, Math.floor(primitive.count / desired));

    for (let i = 0; i < primitive.count; i += step) {
      const base = i * 3;
      points.push({
        x: primitive.array[base],
        y: primitive.array[base + 1],
        z: primitive.array[base + 2]
      });
      if (points.length >= maxSamples) {
        return points;
      }
    }
  }
  return points;
}

function computeBoundsFromPoints(points) {
  const bounds = emptyBounds();
  for (const point of points) {
    expandBounds(bounds, point);
  }
  return bounds;
}

function chooseDesiredPartCount(sourceFaces, targetFaces, bounds, pointCount) {
  const maxPartsFromFaceBudget = Math.max(1, Math.floor(targetFaces / 12));
  const size = boundsSize(bounds);
  const maxDim = Math.max(size.x, size.y, size.z);
  const minDim = Math.max(1e-4, Math.min(size.x, size.y, size.z));
  const aspect = maxDim / minDim;

  const faceComplexity = sourceFaces <= 0 ? 0 : Math.min(1, sourceFaces / 2500);
  const sampleComplexity = Math.min(1, pointCount / 2500);
  const aspectComplexity = Math.min(1, Math.max(0, aspect - 1) / 3);

  const desired =
    1 +
    Math.round(faceComplexity * 2 + sampleComplexity * 2 + aspectComplexity * 2);
  return Math.min(maxPartsFromFaceBudget, Math.max(1, desired));
}

function initializeCentroids(points, count) {
  if (count <= 0 || points.length === 0) {
    return [];
  }

  const bounds = computeBoundsFromPoints(points);
  const center = boundsCenter(bounds);

  const centroids = [];
  let farthestIndex = 0;
  let farthestDistance = -1;
  for (let i = 0; i < points.length; i += 1) {
    const d = distanceSq(points[i], center);
    if (d > farthestDistance) {
      farthestDistance = d;
      farthestIndex = i;
    }
  }
  centroids.push({ ...points[farthestIndex] });

  while (centroids.length < count) {
    let nextIndex = 0;
    let nextScore = -1;
    for (let i = 0; i < points.length; i += 1) {
      let minDistance = Number.POSITIVE_INFINITY;
      for (const centroid of centroids) {
        const d = distanceSq(points[i], centroid);
        if (d < minDistance) {
          minDistance = d;
        }
      }
      if (minDistance > nextScore) {
        nextScore = minDistance;
        nextIndex = i;
      }
    }
    centroids.push({ ...points[nextIndex] });
  }

  return centroids;
}

function assignPointsToCentroids(points, centroids) {
  const assignments = new Int32Array(points.length);
  for (let i = 0; i < points.length; i += 1) {
    let bestIndex = 0;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (let c = 0; c < centroids.length; c += 1) {
      const d = distanceSq(points[i], centroids[c]);
      if (d < bestDistance) {
        bestDistance = d;
        bestIndex = c;
      }
    }
    assignments[i] = bestIndex;
  }
  return assignments;
}

function partVolume(part) {
  return (
    part.halfExtents[0] *
    2 *
    part.halfExtents[1] *
    2 *
    part.halfExtents[2] *
    2
  );
}

function isPartContainedIn(inner, outer, epsilon = 0.006) {
  const [ix, iy, iz] = inner.position;
  const [ihx, ihy, ihz] = inner.halfExtents;
  const [ox, oy, oz] = outer.position;
  const [ohx, ohy, ohz] = outer.halfExtents;

  return (
    ix - ihx >= ox - ohx - epsilon &&
    ix + ihx <= ox + ohx + epsilon &&
    iy - ihy >= oy - ohy - epsilon &&
    iy + ihy <= oy + ohy + epsilon &&
    iz - ihz >= oz - ohz - epsilon &&
    iz + ihz <= oz + ohz + epsilon
  );
}

function buildBoxesFromClusters(points, assignments, clusterCount) {
  const mins = [];
  const maxes = [];
  const counts = new Int32Array(clusterCount);
  for (let c = 0; c < clusterCount; c += 1) {
    mins.push({
      x: Number.POSITIVE_INFINITY,
      y: Number.POSITIVE_INFINITY,
      z: Number.POSITIVE_INFINITY
    });
    maxes.push({
      x: Number.NEGATIVE_INFINITY,
      y: Number.NEGATIVE_INFINITY,
      z: Number.NEGATIVE_INFINITY
    });
  }

  for (let i = 0; i < points.length; i += 1) {
    const cluster = assignments[i];
    counts[cluster] += 1;
    const min = mins[cluster];
    const max = maxes[cluster];
    const point = points[i];
    if (point.x < min.x) min.x = point.x;
    if (point.y < min.y) min.y = point.y;
    if (point.z < min.z) min.z = point.z;
    if (point.x > max.x) max.x = point.x;
    if (point.y > max.y) max.y = point.y;
    if (point.z > max.z) max.z = point.z;
  }

  const parts = [];
  for (let c = 0; c < clusterCount; c += 1) {
    if (counts[c] <= 0) {
      continue;
    }
    const min = mins[c];
    const max = maxes[c];
    const cx = (min.x + max.x) * 0.5;
    const cy = (min.y + max.y) * 0.5;
    const cz = (min.z + max.z) * 0.5;
    const hx = Math.max((max.x - min.x) * 0.5, MIN_BOX_EDGE * 0.5);
    const hy = Math.max((max.y - min.y) * 0.5, MIN_BOX_EDGE * 0.5);
    const hz = Math.max((max.z - min.z) * 0.5, MIN_BOX_EDGE * 0.5);
    parts.push({
      position: [cx, cy, cz],
      halfExtents: [hx, hy, hz]
    });
  }

  parts.sort((a, b) => partVolume(b) - partVolume(a));

  const filtered = [];
  for (const part of parts) {
    if (filtered.some((existing) => isPartContainedIn(part, existing))) {
      continue;
    }
    filtered.push(part);
  }
  return filtered;
}

function decomposeToBoxParts(points, sourceFaces, targetFaces) {
  if (points.length === 0) {
    return [];
  }
  const bounds = makeSafeBounds(computeBoundsFromPoints(points));
  const desiredPartCount = chooseDesiredPartCount(
    sourceFaces,
    targetFaces,
    bounds,
    points.length
  );

  let centroids = initializeCentroids(points, desiredPartCount);
  if (centroids.length === 0) {
    const center = boundsCenter(bounds);
    centroids = [center];
  }

  let assignments = assignPointsToCentroids(points, centroids);
  for (let iteration = 0; iteration < KMEANS_ITERATIONS; iteration += 1) {
    const sums = centroids.map(() => ({ x: 0, y: 0, z: 0 }));
    const counts = new Int32Array(centroids.length);

    for (let i = 0; i < points.length; i += 1) {
      const cluster = assignments[i];
      sums[cluster].x += points[i].x;
      sums[cluster].y += points[i].y;
      sums[cluster].z += points[i].z;
      counts[cluster] += 1;
    }

    for (let c = 0; c < centroids.length; c += 1) {
      if (counts[c] <= 0) {
        continue;
      }
      centroids[c] = {
        x: sums[c].x / counts[c],
        y: sums[c].y / counts[c],
        z: sums[c].z / counts[c]
      };
    }
    assignments = assignPointsToCentroids(points, centroids);
  }

  let parts = buildBoxesFromClusters(points, assignments, centroids.length);
  if (parts.length === 0) {
    const center = boundsCenter(bounds);
    const size = boundsSize(bounds);
    parts = [
      {
        position: [center.x, center.y, center.z],
        halfExtents: [size.x * 0.5, size.y * 0.5, size.z * 0.5]
      }
    ];
  }

  const maxParts = Math.max(1, Math.floor(targetFaces / 12));
  if (parts.length > maxParts) {
    parts = parts.slice(0, maxParts);
  }
  return parts;
}

function buildBoxCollider(bounds) {
  const safe = makeSafeBounds(bounds);
  const center = boundsCenter(safe);
  const size = boundsSize(safe);
  return {
    type: "box",
    source: "aabb-v1",
    position: [center.x, center.y, center.z],
    halfExtents: [size.x * 0.5, size.y * 0.5, size.z * 0.5]
  };
}

function limitHullPoints(points, maxPoints) {
  if (points.length <= maxPoints) {
    return points.map((point) => ({ ...point }));
  }
  const result = [];
  const step = Math.max(1, Math.ceil(points.length / maxPoints));
  for (let i = 0; i < points.length && result.length < maxPoints; i += step) {
    result.push({ ...points[i] });
  }
  return result;
}

function buildBoundsCorners(bounds) {
  const safe = makeSafeBounds(bounds);
  return [
    { x: safe.minX, y: safe.minY, z: safe.minZ },
    { x: safe.minX, y: safe.minY, z: safe.maxZ },
    { x: safe.minX, y: safe.maxY, z: safe.minZ },
    { x: safe.minX, y: safe.maxY, z: safe.maxZ },
    { x: safe.maxX, y: safe.minY, z: safe.minZ },
    { x: safe.maxX, y: safe.minY, z: safe.maxZ },
    { x: safe.maxX, y: safe.maxY, z: safe.minZ },
    { x: safe.maxX, y: safe.maxY, z: safe.maxZ }
  ];
}

function buildConvexHullCollider(points, bounds) {
  const sourcePoints =
    points.length > 0
      ? limitHullPoints(points, MAX_CONVEX_POINTS)
      : buildBoundsCorners(bounds);
  const hullBounds = makeSafeBounds(computeBoundsFromPoints(sourcePoints));
  const center = boundsCenter(hullBounds);
  return {
    type: "convex-hull",
    source: "sampled-points-v1",
    points: sourcePoints.map((point) => [
      point.x - center.x,
      point.y - center.y,
      point.z - center.z
    ]),
    rootOffset: [-center.x, -center.y, -center.z]
  };
}

async function readMetaJson(metaPath) {
  try {
    const raw = await fs.readFile(metaPath, "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function boundsFromMeta(meta) {
  const bbox = meta?.processing?.bbox;
  if (!bbox) {
    return null;
  }
  const width =
    typeof bbox.width === "number" && Number.isFinite(bbox.width)
      ? Math.max(0, bbox.width)
      : 0;
  const height =
    typeof bbox.height === "number" && Number.isFinite(bbox.height)
      ? Math.max(0, bbox.height)
      : 0;
  const depth =
    typeof bbox.depth === "number" && Number.isFinite(bbox.depth)
      ? Math.max(0, bbox.depth)
      : 0;
  if (width <= 0 || height <= 0 || depth <= 0) {
    return null;
  }
  return {
    minX: -width * 0.5,
    maxX: width * 0.5,
    minY: 0,
    maxY: height,
    minZ: -depth * 0.5,
    maxZ: depth * 0.5
  };
}

async function listPropIds(propsRoot) {
  const entries = await fs.readdir(propsRoot, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b));
}

async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }

  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  const repoRoot = path.resolve(scriptDir, "../../..");
  const propsRoot = path.join(repoRoot, "assets/forge/props");

  await MeshoptSimplifier.ready;
  const io = new NodeIO();

  const propIds = await listPropIds(propsRoot);
  const filteredIds = args.onlyPropId
    ? propIds.filter((id) => id === args.onlyPropId)
    : propIds;

  if (filteredIds.length === 0) {
    console.log("No matching props found.");
    return;
  }

  let processed = 0;
  for (const propId of filteredIds) {
    const modelPath = path.join(propsRoot, propId, "processed/model.glb");
    const colliderPath = path.join(propsRoot, propId, "processed/collider.glb");
    const metaPath = path.join(propsRoot, propId, "meta.json");
    if (!(await fileExists(modelPath))) {
      continue;
    }

    try {
      const doc = await io.read(modelPath);
      const sourceFaces = countDocFaces(doc);
      const targetFaces = Math.min(
        Math.max(sourceFaces, 1),
        Math.max(MIN_TARGET_FACES, args.targetFaces)
      );
      if (sourceFaces > 0) {
        const ratio = Math.min(1, Math.max(0, targetFaces / sourceFaces));
        const buffer = doc.getRoot().listBuffers()[0] ?? doc.createBuffer();
        for (const mesh of doc.getRoot().listMeshes()) {
          for (const primitive of mesh.listPrimitives()) {
            simplifyPrimitive(doc, primitive, ratio, buffer);
          }
        }
      }

      const colliderFaces = countDocFaces(doc);
      await fs.mkdir(path.dirname(colliderPath), { recursive: true });
      if (sourceFaces > 0) {
        await io.write(colliderPath, doc);
      } else {
        await fs.copyFile(modelPath, colliderPath);
      }

      const samplePoints = collectDocSamplePoints(doc);
      let rawBounds = computeBoundsFromPoints(samplePoints);
      const meta = await readMetaJson(metaPath);
      if (boundsIsEmpty(rawBounds)) {
        const fromMeta = boundsFromMeta(meta);
        if (fromMeta) {
          rawBounds = fromMeta;
        }
      }
      const bounds = makeSafeBounds(rawBounds);

      const decompositionPoints =
        samplePoints.length > 0 ? samplePoints : buildBoundsCorners(bounds);
      let compoundParts = decomposeToBoxParts(
        decompositionPoints,
        sourceFaces,
        targetFaces
      );
      if (compoundParts.length <= 0) {
        const box = buildBoxCollider(bounds);
        compoundParts = [
          {
            position: [...box.position],
            halfExtents: [...box.halfExtents]
          }
        ];
      }
      const compoundCollider = {
        type: "compound-boxes",
        source: "auto-kmeans-v1",
        parts: compoundParts.map((part) => ({
          kind: "box",
          position: [...part.position],
          halfExtents: [...part.halfExtents]
        }))
      };
      const colliderVariants = {
        box: buildBoxCollider(bounds),
        convexHull: buildConvexHullCollider(samplePoints, bounds),
        compoundBoxes: compoundCollider
      };

      if (meta && typeof meta === "object") {
        if (!meta.processing || typeof meta.processing !== "object") {
          meta.processing = {};
        }
        meta.processing.colliderFaces = compoundCollider.parts.length * 12;
        meta.processing.colliderFaceTarget = targetFaces;
        meta.compoundCollider = compoundCollider;
        meta.colliderVariants = colliderVariants;
        await fs.writeFile(metaPath, JSON.stringify(meta, null, 2));
      }

      console.log(
        `${propId}: ${sourceFaces} -> ${colliderFaces} faces (target ${targetFaces}), variants: box/hull/compound(${compoundCollider.parts.length})`
      );
      processed += 1;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`${propId}: failed (${message})`);
    }
  }

  console.log(`Processed ${processed} prop(s).`);
}

void main();
