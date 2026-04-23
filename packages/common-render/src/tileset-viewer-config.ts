/**
 * Canonical `IsoGameView` tuning for experiments that browse a single
 * tileset in a framed iso preview (tile-viewer, texture-workshop).
 *
 * `baseOrthoHeight` = 20 tiles * 1.28 world units per tile * 0.4 framing factor
 * = 10.24 world units. That's the `LEVEL_EDITOR_WORLD_UNIT` constant inlined
 * here to avoid making `@common/render` depend on `@common/level-editor`. If
 * the level-editor ever changes its tile size, update this constant too.
 *
 * The `NORMAL` variant is the same framing rendered at 2x resolution for the
 * fidelity pane in multi-pane tileset viewers.
 */
export const TILESET_VIEWER_TARGET_CONFIG = {
  fixedRenderHeight: 360,
  baseOrthoHeight: 10.24,
  cameraDistance: 50,
  zoomMax: 6,
  zoomStep: 0.5,
  rotationAnimationRate: 12,
  rotationAnimationEpsilon: 0.005
} as const;

export const TILESET_VIEWER_NORMAL_CONFIG = {
  ...TILESET_VIEWER_TARGET_CONFIG,
  fixedRenderHeight: 720
} as const;
