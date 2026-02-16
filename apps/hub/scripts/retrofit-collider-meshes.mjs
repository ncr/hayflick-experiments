#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { NodeIO } from "@gltf-transform/core";
import { MeshoptSimplifier } from "meshoptimizer";

const DEFAULT_TARGET_FACES = 96;
const MIN_TARGET_FACES = 24;
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
    if (!(await fileExists(modelPath))) {
      continue;
    }

    try {
      const doc = await io.read(modelPath);
      const sourceFaces = countDocFaces(doc);
      if (sourceFaces <= 0) {
        await fs.copyFile(modelPath, colliderPath);
        console.log(`${propId}: no triangles found, copied model.glb`);
        processed += 1;
        continue;
      }

      const targetFaces = Math.min(
        sourceFaces,
        Math.max(MIN_TARGET_FACES, args.targetFaces)
      );
      const ratio = Math.min(1, Math.max(0, targetFaces / sourceFaces));
      const buffer = doc.getRoot().listBuffers()[0] ?? doc.createBuffer();

      for (const mesh of doc.getRoot().listMeshes()) {
        for (const primitive of mesh.listPrimitives()) {
          simplifyPrimitive(doc, primitive, ratio, buffer);
        }
      }

      const colliderFaces = countDocFaces(doc);
      await fs.mkdir(path.dirname(colliderPath), { recursive: true });
      await io.write(colliderPath, doc);
      console.log(
        `${propId}: ${sourceFaces} -> ${colliderFaces} faces (target ${targetFaces})`
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
