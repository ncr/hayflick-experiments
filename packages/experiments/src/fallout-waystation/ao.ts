// Wall-contact AO baked into vertex colors. Cheap, pixel-art-friendly:
// pre-compute a darkening factor per vertex based on its distance to the
// nearest wall line, then multiply the vertex color. No shader work, no
// post-pass. The wall segments below mirror the building geometry; if the
// floorplan changes, update both `building.ts` and this list.

export type WallSegment = readonly [number, number, number, number];

export const BUILDING_WALL_SEGMENTS: readonly WallSegment[] = [
  // Exterior — used for ground AO so the dirt darkens against the outer
  // walls, plus floor AO so each room has dark wall-contact bands.
  [-3, -2, -3, 2], // West (-X)
  [3, -2, 3, 2], // East (+X)
  [-3, -2, 3, -2], // North (-Z) — full length even though Room C portion is rubble
  [-3, 2, 3, 2], // South (+Z)
  // Interior dividers
  [-3, 0, 1, 0], // Z=0 between Rooms A and B
  [1, -2, 1, 2] // X=+1 between Rooms A,B and Room C
];

function pointSegmentDistance(
  px: number,
  pz: number,
  x1: number,
  z1: number,
  x2: number,
  z2: number
): number {
  const dx = x2 - x1;
  const dz = z2 - z1;
  const len2 = dx * dx + dz * dz;
  if (len2 < 1e-9) {
    const ex = px - x1;
    const ez = pz - z1;
    return Math.sqrt(ex * ex + ez * ez);
  }
  const tRaw = ((px - x1) * dx + (pz - z1) * dz) / len2;
  const t = Math.max(0, Math.min(1, tRaw));
  const cx = x1 + t * dx;
  const cz = z1 + t * dz;
  const ex = px - cx;
  const ez = pz - cz;
  return Math.sqrt(ex * ex + ez * ez);
}

/**
 * Returns a multiplier in (1 - strength, 1] depending on how close (px, pz)
 * is to any wall in `walls`. Right at a wall: `1 - strength`. At distance
 * `radius` or beyond: 1.0.
 *
 * The falloff curve is sqrt(distance / radius): hard contact (sharp dark
 * pixel adjacent to the wall) blending to soft bleed at the AO radius.
 * That's the pixel-art convention for hand-painted contact lines.
 */
export function wallContactAO(
  px: number,
  pz: number,
  walls: readonly WallSegment[],
  radius: number,
  strength: number
): number {
  let minDist = Infinity;
  for (const w of walls) {
    const d = pointSegmentDistance(px, pz, w[0], w[1], w[2], w[3]);
    if (d < minDist) {
      minDist = d;
      if (minDist <= 1e-3) break;
    }
  }
  if (minDist >= radius) return 1.0;
  const t = Math.sqrt(minDist / radius);
  return 1.0 - (1.0 - t) * strength;
}
