/**
 * Per-island spatial labels + colors for AI prompting.
 *
 * Each detected UV island corresponds to a connected face region on the
 * mesh. To help the image-gen model produce spatially coherent textures
 * (e.g. "the top is dusty, the front has a logo"), we tag each island
 * with:
 *
 *   - `axis`     : the dominant world-space normal direction (±X/±Y/±Z)
 *   - `label`    : a human term — front/back/top/bottom/left/right/face
 *   - `color`    : an outline colour from a stable distinct palette
 *
 * Pure data — no DOM, no THREE. Inputs are the same buffers we already
 * pass through `prepare.ts`.
 */
import type { DetectedIsland } from "./island-detect";

/** Distinct, easy-to-name hues. Picked to be visually separable on the
 *  template's mid-grey background and on a mid-grey 3D reference. */
const PALETTE: number[] = [
  0xff5050, // red
  0x40c8ff, // cyan
  0xffd23f, // amber
  0x7bd16f, // green
  0xc46cff, // violet
  0xff9933, // orange
  0x4a7cff, // blue
  0xff5fa8, // pink
  0xa0d04a, // lime
  0x4fd9c6, // teal
  0xb38a3e, // tan
  0xb8b8b8, // pale grey (neutral fallback)
];

export type IslandSpatialContext = {
  /** Dominant world-space normal axis as a unit vector. */
  normal: [number, number, number];
  /** Six-axis tag — '+x' | '-x' | '+y' | '-y' | '+z' | '-z'. */
  axis: "+x" | "-x" | "+y" | "-y" | "+z" | "-z";
  /** Human-readable directional label (front/top/etc). */
  label: string;
  /** Hex 0xRRGGBB colour for outlining + 3D reference tinting. */
  color: number;
  /** "+X" / "-Z" etc — used in prompt text. */
  axisName: string;
  /** True when this face is back-facing under the canonical iso camera and
   *  therefore renders to ZERO lowpixels. Painting onto a hidden island
   *  changes the atlas but the mesh stays unchanged — the editor should
   *  warn the user. */
  hiddenFromCamera: boolean;
};

/** Map an axis tag to a directional label.
 *  Convention: iso camera sits at (+X, +Y, +Z) corner looking at origin,
 *  so +X and +Z faces are visible; -X and -Z face away.
 *    +Y → top, -Y → bottom
 *    +X → right, -X → left
 *    +Z → front, -Z → back
 */
const AXIS_LABEL: Record<IslandSpatialContext["axis"], string> = {
  "+x": "right",
  "-x": "left",
  "+y": "top",
  "-y": "bottom",
  "+z": "front",
  "-z": "back",
};

const AXIS_NAME: Record<IslandSpatialContext["axis"], string> = {
  "+x": "+X",
  "-x": "-X",
  "+y": "+Y",
  "-y": "-Y",
  "+z": "+Z",
  "-z": "-Z",
};

export function computeIslandSpatialContext(
  positions: Float32Array,
  indexBuffer: Uint32Array | Uint16Array,
  islands: ReadonlyArray<DetectedIsland>
): IslandSpatialContext[] {
  return islands.map((isl, idx) => {
    const normal = averageFaceNormal(positions, indexBuffer, isl);
    const axis = dominantAxis(normal);
    // Iso camera sits at (+X, +Y, +Z) corner looking at origin. A face is
    // visible iff its normal has a non-trivial positive component along
    // any of the camera-facing axes. With only axis-aligned faces (the
    // common case here), that reduces to: the dominant axis sign is +.
    const hiddenFromCamera = axis === "-x" || axis === "-y" || axis === "-z";
    return {
      normal,
      axis,
      label: AXIS_LABEL[axis],
      color: PALETTE[idx % PALETTE.length],
      axisName: AXIS_NAME[axis],
      hiddenFromCamera,
    };
  });
}

/** Sum (area-weighted) of triangle normals across the island, then normalise. */
function averageFaceNormal(
  positions: Float32Array,
  indexBuffer: Uint32Array | Uint16Array,
  island: DetectedIsland
): [number, number, number] {
  let nx = 0, ny = 0, nz = 0;
  for (const triIdx of island.triangleIndices) {
    const i0 = indexBuffer[triIdx * 3];
    const i1 = indexBuffer[triIdx * 3 + 1];
    const i2 = indexBuffer[triIdx * 3 + 2];
    const ax = positions[i1 * 3] - positions[i0 * 3];
    const ay = positions[i1 * 3 + 1] - positions[i0 * 3 + 1];
    const az = positions[i1 * 3 + 2] - positions[i0 * 3 + 2];
    const bx = positions[i2 * 3] - positions[i0 * 3];
    const by = positions[i2 * 3 + 1] - positions[i0 * 3 + 1];
    const bz = positions[i2 * 3 + 2] - positions[i0 * 3 + 2];
    // Cross product = 2× area × unit normal — area-weighted automatically.
    nx += ay * bz - az * by;
    ny += az * bx - ax * bz;
    nz += ax * by - ay * bx;
  }
  const len = Math.hypot(nx, ny, nz) || 1;
  return [nx / len, ny / len, nz / len];
}

function dominantAxis(n: [number, number, number]): IslandSpatialContext["axis"] {
  const ax = Math.abs(n[0]);
  const ay = Math.abs(n[1]);
  const az = Math.abs(n[2]);
  if (ay >= ax && ay >= az) return n[1] >= 0 ? "+y" : "-y";
  if (ax >= az) return n[0] >= 0 ? "+x" : "-x";
  return n[2] >= 0 ? "+z" : "-z";
}
