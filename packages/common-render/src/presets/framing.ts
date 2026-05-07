/**
 * Named PixelPerfectPane tuning bundles for **tool views** (forge prop
 * preview, quad inspector, etc.). Framing fields (`fixedRenderHeight`,
 * `baseOrthoHeight`, `cameraDistance`, `basePixelZoom`) and animation-feel
 * fields are tuned together; spread the bundle into a
 * `PixelPerfectPaneConfig`.
 *
 * The game render path uses `IsoGameView`, which locks scale to
 * `ISO_VIEW_CONTRACT` and does NOT accept these tuples. Tool views (which
 * intentionally deviate from the game look) use `PixelPerfectPane` —
 * either directly or via a thin wrapper.
 *
 * ```ts
 * const pane = new PixelPerfectPane({
 *   stage, id, element, scene, width, height,
 *   ...PROP_PREVIEW_FRAMING,
 *   cameraPitch: "iso-2to1",
 *   cameraYaw: Math.PI / 4,
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
