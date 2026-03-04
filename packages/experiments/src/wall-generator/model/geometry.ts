import type { MeshData, CsgSubtraction, PieceConfig, Vec3, WallDimensions, OpeningDesc, TrimProfile } from "./types";
import { hasOpening, isCorner } from "./piece-catalog";

/**
 * Generate an axis-aligned box mesh centered at (cx, cy, cz).
 */
export function generateBox(
  w: number, h: number, d: number,
  cx = 0, cy = 0, cz = 0,
): MeshData {
  const hw = w / 2, hh = h / 2, hd = d / 2;

  // 24 vertices (4 per face × 6 faces), unique normals
  const positions = new Float32Array([
    // +Z face
    cx - hw, cy - hh, cz + hd,  cx + hw, cy - hh, cz + hd,  cx + hw, cy + hh, cz + hd,  cx - hw, cy + hh, cz + hd,
    // -Z face
    cx + hw, cy - hh, cz - hd,  cx - hw, cy - hh, cz - hd,  cx - hw, cy + hh, cz - hd,  cx + hw, cy + hh, cz - hd,
    // +X face
    cx + hw, cy - hh, cz + hd,  cx + hw, cy - hh, cz - hd,  cx + hw, cy + hh, cz - hd,  cx + hw, cy + hh, cz + hd,
    // -X face
    cx - hw, cy - hh, cz - hd,  cx - hw, cy - hh, cz + hd,  cx - hw, cy + hh, cz + hd,  cx - hw, cy + hh, cz - hd,
    // +Y face
    cx - hw, cy + hh, cz + hd,  cx + hw, cy + hh, cz + hd,  cx + hw, cy + hh, cz - hd,  cx - hw, cy + hh, cz - hd,
    // -Y face
    cx - hw, cy - hh, cz - hd,  cx + hw, cy - hh, cz - hd,  cx + hw, cy - hh, cz + hd,  cx - hw, cy - hh, cz + hd,
  ]);

  const normals = new Float32Array([
    0,0,1, 0,0,1, 0,0,1, 0,0,1,
    0,0,-1, 0,0,-1, 0,0,-1, 0,0,-1,
    1,0,0, 1,0,0, 1,0,0, 1,0,0,
    -1,0,0, -1,0,0, -1,0,0, -1,0,0,
    0,1,0, 0,1,0, 0,1,0, 0,1,0,
    0,-1,0, 0,-1,0, 0,-1,0, 0,-1,0,
  ]);

  // UV: map each face to 0-1 based on face dimensions
  const uvs = new Float32Array([
    // +Z: w×h
    0, 0, w, 0, w, h, 0, h,
    // -Z
    0, 0, w, 0, w, h, 0, h,
    // +X: d×h
    0, 0, d, 0, d, h, 0, h,
    // -X
    0, 0, d, 0, d, h, 0, h,
    // +Y: w×d
    0, 0, w, 0, w, d, 0, d,
    // -Y
    0, 0, w, 0, w, d, 0, d,
  ]);

  const indices = new Uint32Array([
    0,1,2, 0,2,3,       // +Z
    4,5,6, 4,6,7,       // -Z
    8,9,10, 8,10,11,    // +X
    12,13,14, 12,14,15, // -X
    16,17,18, 16,18,19, // +Y
    20,21,22, 20,22,23, // -Y
  ]);

  return { positions, normals, uvs, indices };
}

/**
 * Compute CSG subtraction boxes for openings (windows, doors).
 * Wall is assumed centered at origin, bottom at y=0, front face at z=+thickness/2.
 */
export function computeSubtractions(
  kind: PieceConfig["kind"],
  dims: WallDimensions,
  opening: OpeningDesc,
): CsgSubtraction[] {
  if (!hasOpening(kind)) return [];

  // Opening cut-through — slightly oversized in Z to ensure clean CSG
  const cutDepth = dims.thickness + 0.02;
  const position: Vec3 = [opening.offsetX, opening.offsetY + opening.height / 2, 0];
  const size: Vec3 = [opening.width, opening.height, cutDepth];

  return [{ type: "box", position, size }];
}

/**
 * Generate trim geometry strips (thin boxes along edges).
 */
export function generateTrimGeometry(
  dims: WallDimensions,
  trim: TrimProfile,
  opening: OpeningDesc | null,
  kind: PieceConfig["kind"],
): MeshData[] {
  if (!trim.enabled) return [];

  const meshes: MeshData[] = [];
  const { width, height, thickness } = dims;
  const frontZ = thickness / 2 + trim.depth / 2;

  // Bottom trim — runs along bottom edge of front face
  if (trim.bottomEnabled) {
    meshes.push(generateBox(
      width, trim.width, trim.depth,
      0, trim.width / 2, frontZ,
    ));
  }

  // Top trim
  if (trim.topEnabled) {
    meshes.push(generateBox(
      width, trim.width, trim.depth,
      0, height - trim.width / 2, frontZ,
    ));
  }

  // Opening trim — frame around window/door opening
  if (trim.openingEnabled && hasOpening(kind) && opening) {
    const ox = opening.offsetX;
    const oy = opening.offsetY;
    const ow = opening.width;
    const oh = opening.height;

    // Left vertical
    meshes.push(generateBox(
      trim.width, oh, trim.depth,
      ox - ow / 2 - trim.width / 2, oy + oh / 2, frontZ,
    ));
    // Right vertical
    meshes.push(generateBox(
      trim.width, oh, trim.depth,
      ox + ow / 2 + trim.width / 2, oy + oh / 2, frontZ,
    ));
    // Top horizontal (lintel)
    meshes.push(generateBox(
      ow + trim.width * 2, trim.width, trim.depth,
      ox, oy + oh + trim.width / 2, frontZ,
    ));
    // Bottom horizontal (sill) — only for windows
    if (kind === "wall-window") {
      meshes.push(generateBox(
        ow + trim.width * 2, trim.width, trim.depth,
        ox, oy - trim.width / 2, frontZ,
      ));
    }
  }

  return meshes;
}

/**
 * Generate a thin frame mesh around an opening (for recessed reveal).
 */
export function generateOpeningFrame(
  opening: OpeningDesc,
  dims: WallDimensions,
): MeshData | null {
  // Frame is a thin box along the inside edge of the opening
  const frameDepth = dims.thickness;
  const frameWidth = 0.02; // 2cm reveal

  const meshes: MeshData[] = [];
  const ox = opening.offsetX;
  const oy = opening.offsetY;
  const ow = opening.width;
  const oh = opening.height;

  // Left reveal
  meshes.push(generateBox(frameWidth, oh, frameDepth, ox - ow / 2 + frameWidth / 2, oy + oh / 2, 0));
  // Right reveal
  meshes.push(generateBox(frameWidth, oh, frameDepth, ox + ow / 2 - frameWidth / 2, oy + oh / 2, 0));
  // Top reveal
  meshes.push(generateBox(ow, frameWidth, frameDepth, ox, oy + oh - frameWidth / 2, 0));

  return mergeMeshData(meshes);
}

/**
 * Top-level: produce all geometry descriptors for a piece.
 */
export function generatePieceGeometryDescriptors(config: PieceConfig): {
  baseBoxes: MeshData[];
  subtractions: CsgSubtraction[];
  trimMeshes: MeshData[];
  openingFrame: MeshData | null;
} {
  const { kind, dimensions, opening, trim } = config;
  const { width, height, thickness } = dimensions;

  const baseBoxes: MeshData[] = [];

  if (isCorner(kind)) {
    // L-shape: two boxes at 90°
    // First segment along +X
    baseBoxes.push(generateBox(width, height, thickness, width / 2 - thickness / 2, height / 2, 0));
    // Second segment along +Z
    baseBoxes.push(generateBox(thickness, height, width, 0, height / 2, width / 2 - thickness / 2));
  } else if (kind === "wall-end-cap") {
    // Main wall + end cap (thickened end)
    baseBoxes.push(generateBox(width, height, thickness, 0, height / 2, 0));
    // Small cap on the right end
    baseBoxes.push(generateBox(thickness, height, thickness * 0.5, width / 2 + thickness * 0.25, height / 2, 0));
  } else {
    // Standard single box — bottom at y=0
    baseBoxes.push(generateBox(width, height, thickness, 0, height / 2, 0));
  }

  const subtractions = computeSubtractions(kind, dimensions, opening);
  const trimMeshes = generateTrimGeometry(dimensions, trim, hasOpening(kind) ? opening : null, kind);
  const openingFrame = hasOpening(kind) ? generateOpeningFrame(opening, dimensions) : null;

  return { baseBoxes, subtractions, trimMeshes, openingFrame };
}

/**
 * Merge multiple MeshData into one.
 */
export function mergeMeshData(meshes: MeshData[]): MeshData | null {
  if (meshes.length === 0) return null;
  if (meshes.length === 1) return meshes[0];

  let totalVerts = 0;
  let totalIndices = 0;
  for (const m of meshes) {
    totalVerts += m.positions.length / 3;
    totalIndices += m.indices.length;
  }

  const positions = new Float32Array(totalVerts * 3);
  const normals = new Float32Array(totalVerts * 3);
  const uvs = new Float32Array(totalVerts * 2);
  const indices = new Uint32Array(totalIndices);

  let vOffset = 0;
  let iOffset = 0;
  let vertCount = 0;

  for (const m of meshes) {
    const nv = m.positions.length / 3;
    positions.set(m.positions, vOffset * 3);
    normals.set(m.normals, vOffset * 3);
    uvs.set(m.uvs, vOffset * 2);
    for (let i = 0; i < m.indices.length; i++) {
      indices[iOffset + i] = m.indices[i] + vertCount;
    }
    vOffset += nv;
    iOffset += m.indices.length;
    vertCount += nv;
  }

  return { positions, normals, uvs, indices };
}
