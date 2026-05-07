/**
 * Iso-2:1 view contract. **The cornerstone of the game's visual identity.**
 *
 * These constants are hardcoded and must not be made configurable on the
 * game-render path. The 2:1 staircase, atlas-texel sizing, and
 * world-to-screen contract all derive from these. Changing any of them
 * cascades through:
 *   - the entire material-studio atlas pipeline (cm-per-texel)
 *   - shipped textured-mesh artefacts (atlases sized to old R)
 *   - all `e2e/render-invariants/*` golden images
 *   - root `CLAUDE.md` invariant #3
 *
 * The math:
 *   yaw   = π/4 (cardinal-isometric symmetry; rotated by yawIndex * π/2)
 *   pitch = π/6  (sin = 1/2, exact; gives the 2:1 H:V staircase along world-X/Z)
 *   R     = lowpixels per world unit at the canonical reference resolution
 *         = referenceLowHeight / baseOrthoHeight
 *         = 32 * √2
 * which yields:
 *   1 world unit (= 1 tile = 1.28 m) -> 32 px H × 16 px V (foreshortened)
 *   1 world-X/Z cm                   -> 32/128 = 0.25 px (4 cm per atlas texel)
 *   1 world-Y wu                     -> 16·√6 ≈ 39.19 V px (irrational; cos π/6 = √3/2)
 *
 * Tools that need a different framing (forge prop preview, tileset
 * inspector) construct {@link PixelPerfectPane} directly with a custom
 * (FRH, BOH) pair. They are not "game render" and are exempt from the
 * lock.
 */

const ISO_PITCH = Math.PI / 6;
const ISO_BASE_YAW = Math.PI / 4;
const ISO_R = 32 * Math.SQRT2;

// One of infinitely many (referenceLowHeight, baseOrthoHeight) pairs that
// give R = 32·√2. This pair is picked because both numbers minimise
// irrational decimals in source: 256 = 2^8, 4·√2 is the simplest 2:1-iso
// form. The actual rendered low-resolution height is set by the canvas
// + zoom + DPR; this pair is just the calibration anchor.
const ISO_REFERENCE_LOW_HEIGHT = 256;
const ISO_BASE_ORTHO_HEIGHT = 4 * Math.SQRT2;

export const ISO_VIEW_CONTRACT = Object.freeze({
  pitch: ISO_PITCH,
  baseYaw: ISO_BASE_YAW,
  R: ISO_R,
  pxPerTileH: 32,
  pxPerTileV: 16,
  pxPerTileY: 16 * Math.sqrt(6),  // ≈ 39.19; irrational, cos(π/6) = √3/2
  cmPerTexelXZ: 4,                // 128 / 32 — exact
  // 128 / (R · √3/2) = 8/√6 — irrational. ~3.27 cm.
  cmPerTexelY: 128 / (ISO_R * (Math.sqrt(3) / 2)),
  worldUnitsPerTexelXZ: 1 / 32,   // 0.03125 wu = 4 cm
  referenceLowHeight: ISO_REFERENCE_LOW_HEIGHT,
  baseOrthoHeight: ISO_BASE_ORTHO_HEIGHT
});

/**
 * Top-down view (`pitch ≈ π/2`). World-X/Z project directly to screen
 * with no foreshortening — tiles are squares. R chosen so 1 tile = 32 px
 * matches iso's H-per-tile, keeping a consistent apparent scale across
 * view modes.
 */
export const TOPDOWN_VIEW_CONTRACT = Object.freeze({
  pitch: Math.PI / 2 - 1e-3,
  baseYaw: 0,
  R: 32,
  pxPerTileH: 32,
  pxPerTileV: 32,
  cmPerTexelXZ: 4,
  worldUnitsPerTexelXZ: 1 / 32,
  referenceLowHeight: 256,
  baseOrthoHeight: 8
});

/**
 * Side view (`pitch = 0`, yaw snaps to cardinals). World-X/Z (whichever is
 * on-axis) projects to screen-H; world-Y projects directly to screen-V.
 */
export const SIDE_VIEW_CONTRACT = Object.freeze({
  pitch: 0,
  baseYaw: 0,
  R: 32,
  pxPerTileH: 32,
  pxPerTileV: 32,
  cmPerTexelXZ: 4,
  cmPerTexelY: 4,
  worldUnitsPerTexelXZ: 1 / 32,
  referenceLowHeight: 256,
  baseOrthoHeight: 8
});
