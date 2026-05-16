import { ISO_VIEW_CONTRACT } from "../iso-contract";

/**
 * Iso-2:1 geometry alignment guard.
 *
 * # Why this exists
 *
 * The iso 2:1 projection maps each world-X (or world-Z) unit to **32 horizontal
 * pixels and 16 vertical pixels** on screen. A clean silhouette staircase
 * (the cornerstone visual: alternating 2-wide-1-down treads with no mixed
 * 3-wide treads) only happens when every edge's projected length is a
 * multiple of **one whole stair step** = 2 H px + 1 V px = `0.0625 wu`.
 *
 * If a box is sized `0.8 wu` it projects to `25.6 × 12.8` px. The rasterizer
 * can only produce integer pixel runs, so the silhouette comes out as some
 * mix of 2- and 3-wide treads to approximate the 2:1 angle. To the eye it
 * looks like the staircase has random "fat steps" — a visible 2:1 violation
 * even though every snap-cell rasterization is bit-identical (the cornerstone
 * still holds; the *shape* is what's broken).
 *
 * The pixel-snap + input-mapping fixes can't repair this — it's a property
 * of the *geometry's projection alignment*, not of its motion. The only fix
 * is to size primitives so XZ dimensions × 32 lands on integer pixels, and
 * for clean stairs, on multiples of 2 (= the stair-step unit).
 *
 * # The contract
 *
 * For every primitive's XZ dimension `d` (in world units):
 *   strict (clean 2:1 stairs): `d * 32` must be an even integer
 *                              ⇒ `d` must be a multiple of `0.0625 wu`
 *   loose (integer pixel edges, possibly irregular stair pattern):
 *                              `d * 32` must be an integer
 *                              ⇒ `d` must be a multiple of `0.03125 wu`
 *
 * The default validator uses the strict rule. Tools / debug primitives that
 * intentionally want sub-stair sizes can opt out by not passing a validator.
 *
 * Y is unconstrained — the pitch=π/6 projection makes Y irrational
 * (`cos π/6 = √3/2`), so no Y size lands on integer pixels. The cube's
 * vertical edges project purely vertical regardless and don't affect the
 * stair pattern, so Y misalignment is invisible.
 */

const PX_PER_WU = ISO_VIEW_CONTRACT.pxPerTileH;       // 32
const STAIR_STEP_PX = 2;                              // 2 H + 1 V = one iso 2:1 stair
const PIXEL_STEP_WU = 1 / PX_PER_WU;                  // 0.03125 wu = 1 H px
const STAIR_STEP_WU = STAIR_STEP_PX / PX_PER_WU;      // 0.0625 wu = one stair step

const TOLERANCE = 1e-6;

/**
 * Thrown when geometry is constructed with XZ dimensions that don't align to
 * the iso 2:1 stair grid (or pixel grid in loose mode). Always thrown at
 * construction time so the bad call site is in the stack trace, not at
 * render time when the symptom appears.
 */
export class IsoGeometryViolation extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IsoGeometryViolation";
  }
}

/**
 * `true` when `wu` aligns to the iso 2:1 stair grid (multiples of `0.0625 wu`).
 * Use to gate optional warnings; the default validator already throws.
 */
export function isIsoStairAlignedWu(wu: number): boolean {
  return isMultipleOf(wu, STAIR_STEP_WU);
}

/**
 * `true` when `wu` aligns to the iso pixel grid (multiples of `0.03125 wu`).
 * Looser than {@link isIsoStairAlignedWu} — edges are integer pixel length
 * but the stair pattern may mix 2- and 3-wide treads.
 */
export function isIsoPixelAlignedWu(wu: number): boolean {
  return isMultipleOf(wu, PIXEL_STEP_WU);
}

/**
 * Nearest world-unit value that aligns to the iso 2:1 stair grid. Useful in
 * error messages to suggest the closest valid size.
 */
export function nearestIsoStairAlignedWu(wu: number): number {
  return roundToStep(wu, STAIR_STEP_WU);
}

export type IsoGeometryRole = "box" | "floor" | "grid";

export type IsoGeometryDescriptor = {
  /** Source primitive — used to build error messages. */
  role: IsoGeometryRole;
  /** Optional human-readable label for error context (e.g. the entity name). */
  identifier?: string;
  /** XZ dimensions in world units. */
  xz: { x: number; z: number };
};

/**
 * Validator signature consumed by {@link CreateThreeSceneOptions.validateGeometry}.
 * Throw an {@link IsoGeometryViolation} (or any Error) to abort construction.
 */
export type GeometryValidator = (descriptor: IsoGeometryDescriptor) => void;

/**
 * Default validator — strict iso 2:1 stair alignment. Throws on the first
 * misaligned XZ dimension with a message that names the bad value and
 * suggests the nearest valid sizes.
 *
 * Usage:
 * ```ts
 * createThreeScene(root, {
 *   validateGeometry: isoCleanGeometryValidator
 * });
 * ```
 */
export const isoCleanGeometryValidator: GeometryValidator = (descriptor) => {
  const issues: string[] = [];
  if (!isIsoStairAlignedWu(descriptor.xz.x)) {
    issues.push(formatIssue("x", descriptor.xz.x));
  }
  if (!isIsoStairAlignedWu(descriptor.xz.z)) {
    issues.push(formatIssue("z", descriptor.xz.z));
  }
  if (issues.length === 0) return;
  const label = descriptor.identifier ? ` (${descriptor.identifier})` : "";
  throw new IsoGeometryViolation(
    `iso 2:1 geometry violation: ${descriptor.role}${label} XZ dimensions ` +
      `don't align to the stair grid. ` +
      `Sizes (in world units) must be multiples of ${STAIR_STEP_WU} ` +
      `(= 2 horizontal screen pixels = one iso 2:1 stair step). ` +
      `Misaligned: ${issues.join("; ")}. ` +
      `Non-stair sizes rasterize to irregular silhouette outlines ` +
      `(mixed 2-wide and 3-wide treads). ` +
      `See docs/AGENT_LEARNINGS.md → "iso 2:1 geometry alignment".`
  );
};

function formatIssue(axis: "x" | "z", wu: number): string {
  const px = wu * PX_PER_WU;
  const nearest = nearestIsoStairAlignedWu(wu);
  return `${axis}=${wu} wu (= ${px.toFixed(2)} px) — nearest clean size: ${nearest} wu`;
}

function isMultipleOf(value: number, step: number): boolean {
  const ratio = value / step;
  return Math.abs(ratio - Math.round(ratio)) < TOLERANCE;
}

function roundToStep(value: number, step: number): number {
  return Math.round(value / step) * step;
}
