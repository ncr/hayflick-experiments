/**
 * Named IsoGameView tuning bundles.
 *
 * Framing fields (`fixedRenderHeight`, `baseOrthoHeight`, `cameraDistance`,
 * `basePixelZoom`) and animation-feel fields must be tuned together to keep
 * the pixel-lock invariants (see `docs/PIXEL_PERFECT_FOUNDATION.md`). These
 * presets pin sets of values that are known to work so consumers can spread
 * them into `IsoGameViewConfig` without reinventing the tuple.
 *
 * ```ts
 * new IsoGameView({
 *   mount, width, height, scene,
 *   ...PROP_PREVIEW_FRAMING,
 *   // override individual fields below the spread
 *   baseOrthoHeight: PROP_PREVIEW_FRAMING.baseOrthoHeight * zoomOutFactor
 * });
 * ```
 */

/**
 * Canonical tuple for prop-preview viewports (Asset Forge, PixelQuad). Tighter
 * framing than the game default so single props read well at zoom 1–6, with
 * snappier zoom/rotation animation for interactive previews.
 */
export const PROP_PREVIEW_FRAMING = {
  fixedRenderHeight: 270,
  baseOrthoHeight: 5.966213466261495,
  cameraDistance: 30,
  basePixelZoom: 2,
  zoomMax: 6,
  zoomAnimationRate: 14,
  zoomAnimationBurstRate: 42,
  zoomAnimationEpsilon: 0.001,
  rotationAnimationRate: 18,
  rotationAnimationEpsilon: 0.001,
  zoomBurstIdleMs: 200
} as const;

export {
  TILESET_VIEWER_TARGET_CONFIG,
  TILESET_VIEWER_NORMAL_CONFIG
} from "../tileset-viewer-config";
