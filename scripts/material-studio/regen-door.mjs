/**
 * Regenerate assets/meshes/door.glb with all rectangular faces aligned to
 * 8 cm (one "large pixel" under iso 2:1).
 *
 * Reads the existing door.glb, rescales each part's vertex positions and
 * tweaks parent-node translations so:
 *   - door slot stays 128 × 280 × 32 cm
 *   - leaf is 96 × 224 × 8 (vs. 90 × 220 × 5 before)
 *   - header is 96 × 56 × 32 (vs. 90 × 60 × 32 before)
 *   - side frames are 16 × 280 × 32 each (vs. 19 × 280 × 32)
 *
 * UVs and triangle indexing are preserved so the existing material-studio
 * pipeline (island detection, atlas remap, NEAREST sampling) continues to
 * work without re-unwrapping.
 *
 * Run with: node scripts/material-studio/regen-door.mjs
 */

import { NodeIO } from "@gltf-transform/core";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..");
const DOOR_PATH = path.join(REPO_ROOT, "assets", "meshes", "door.glb");

// Target dimensions in cm. All multiples of 8.
const SLOT_W = 128;
const SLOT_H = 280;
const WALL_DEPTH = 32;
const LEAF_W = 96;
const LEAF_H = 224;
const LEAF_DEPTH = 8;
const HEADER_H = SLOT_H - LEAF_H; // 56
const FRAME_W = (SLOT_W - LEAF_W) / 2; // 16
const LEAF_INSET_Z = 8; // leaf parent translation Z, 1 cell front of wall centre

/** Linearly remap each vertex inside an axis-aligned box to a new bbox. */
function rescalePositions(positions, oldBbox, newBbox) {
  const out = new Float32Array(positions.length);
  for (let i = 0; i < positions.length; i += 3) {
    for (let a = 0; a < 3; a++) {
      const oldMin = oldBbox.min[a];
      const oldMax = oldBbox.max[a];
      const newMin = newBbox.min[a];
      const newMax = newBbox.max[a];
      const oldRange = oldMax - oldMin;
      const newRange = newMax - newMin;
      const t = oldRange === 0 ? 0 : (positions[i + a] - oldMin) / oldRange;
      out[i + a] = newMin + t * newRange;
    }
  }
  return out;
}

function bboxOf(positions) {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < positions.length; i += 3) {
    for (let a = 0; a < 3; a++) {
      const v = positions[i + a];
      if (v < min[a]) min[a] = v;
      if (v > max[a]) max[a] = v;
    }
  }
  return { min, max };
}

const PART_TARGETS = {
  door_header_mesh: {
    bbox: { min: [-LEAF_W / 2, 0, -WALL_DEPTH / 2], max: [LEAF_W / 2, HEADER_H, WALL_DEPTH / 2] },
    parentName: "door_header",
    parentTranslation: [0, LEAF_H, 0],
  },
  door_leaf_body_mesh: {
    bbox: { min: [0, 0, -LEAF_DEPTH / 2], max: [LEAF_W, LEAF_H, LEAF_DEPTH / 2] },
    parentName: "door_leaf",
    parentTranslation: [-LEAF_W / 2, 0, LEAF_INSET_Z],
  },
  door_left_mesh: {
    bbox: { min: [-FRAME_W / 2, 0, -WALL_DEPTH / 2], max: [FRAME_W / 2, SLOT_H, WALL_DEPTH / 2] },
    parentName: "door_left",
    parentTranslation: [-(SLOT_W / 2 - FRAME_W / 2), 0, 0], // -56
  },
  door_right_mesh: {
    bbox: { min: [-FRAME_W / 2, 0, -WALL_DEPTH / 2], max: [FRAME_W / 2, SLOT_H, WALL_DEPTH / 2] },
    parentName: "door_right",
    parentTranslation: [SLOT_W / 2 - FRAME_W / 2, 0, 0], // +56
  },
};

const io = new NodeIO();
const doc = await io.read(DOOR_PATH);

const meshByName = new Map();
for (const mesh of doc.getRoot().listMeshes()) {
  meshByName.set(mesh.getName(), mesh);
}

for (const [meshName, target] of Object.entries(PART_TARGETS)) {
  const mesh = meshByName.get(meshName);
  if (!mesh) {
    console.warn(`[skip] mesh ${meshName} not found`);
    continue;
  }
  for (const prim of mesh.listPrimitives()) {
    const posAttr = prim.getAttribute("POSITION");
    const positions = posAttr.getArray();
    const oldBbox = bboxOf(positions);
    const newPositions = rescalePositions(positions, oldBbox, target.bbox);
    posAttr.setArray(newPositions);
    console.log(
      `  ${meshName}: ${oldBbox.min.map((v) => v.toFixed(0)).join(",")} → ${oldBbox.max
        .map((v) => v.toFixed(0))
        .join(",")} ⇒ ${target.bbox.min.join(",")} → ${target.bbox.max.join(",")}`
    );
  }
}

// Update parent node translations.
for (const node of doc.getRoot().listNodes()) {
  for (const target of Object.values(PART_TARGETS)) {
    if (node.getName() === target.parentName) {
      const old = node.getTranslation();
      node.setTranslation(target.parentTranslation);
      console.log(
        `  node ${node.getName()} t: [${old.join(",")}] → [${target.parentTranslation.join(",")}]`
      );
    }
  }
}

await io.write(DOOR_PATH, doc);
console.log(`\nWrote ${DOOR_PATH}`);
