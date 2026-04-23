export type DeviceSize = {
  width: number;
  height: number;
};

export type OutputViewportLayout = {
  sceneWidth: number;
  sceneHeight: number;
  outputWidth: number;
  outputHeight: number;
  outputPadX: number;
  outputPadY: number;
  contentScaleX: number;
  contentScaleY: number;
  contentOffsetX: number;
  contentOffsetY: number;
};

export function computeRenderScale(zoom: number, activeDpr: number): number {
  return Math.max(1, Math.round(zoom * activeDpr));
}

export function computeViewportDeviceSize(
  cssWidth: number,
  cssHeight: number,
  dpr: number,
  maxDeviceWidth: number,
  maxDeviceHeight: number
): DeviceSize {
  return {
    width: clamp(Math.round(cssWidth * dpr), 1, maxDeviceWidth),
    height: clamp(Math.round(cssHeight * dpr), 1, maxDeviceHeight)
  };
}

/**
 * Zoom-independent low-resolution target.
 *
 * Invariants:
 * - `baseRenderScale` must be the render scale for zoom=1, so low-res sampling
 *   grid does not change across zoom levels.
 * - Width and height are always even. An odd low-res dimension puts the
 *   buffer's center on a half-pixel (e.g. 269/2 = 134.5), which propagates a
 *   0.5-iso-px offset to every world position and pushes sub-pixel features
 *   (like a 1.6-iso-px slab end-face) across pixel boundaries inconsistently
 *   as the viewport resizes. Rounding up to even keeps the center on an
 *   integer iso-col so world origin, tile centres, and feature offsets all
 *   land on the same iso-cols regardless of viewport.
 */
export function computeLowResolutionSize(
  deviceWidth: number,
  deviceHeight: number,
  baseRenderScale: number
): DeviceSize {
  const safeBaseScale = Math.max(1, Math.trunc(baseRenderScale));
  const w = Math.ceil(deviceWidth / safeBaseScale);
  const h = Math.ceil(deviceHeight / safeBaseScale);
  return {
    width: Math.max(2, w + (w & 1)),
    height: Math.max(2, h + (h & 1))
  };
}

/**
 * Computes final output viewport dimensions for upscaled rendering.
 *
 * Invariant:
 * - Overscan is expressed in low-resolution pixels so coverage remains stable
 *   across device DPR and zoom levels.
 */
export function computeOutputViewportLayout(
  lowWidth: number,
  lowHeight: number,
  renderScale: number,
  overscanLowPixels: number
): OutputViewportLayout {
  const safeScale = Math.max(1, Math.trunc(renderScale));
  const safeOverscan = Math.max(0, Math.trunc(overscanLowPixels));

  const sceneWidth = lowWidth * safeScale;
  const sceneHeight = lowHeight * safeScale;
  const outputWidth = (lowWidth + safeOverscan) * safeScale;
  const outputHeight = (lowHeight + safeOverscan) * safeScale;

  const outputPadX = Math.floor((outputWidth - sceneWidth) * 0.5);
  const outputPadY = Math.floor((outputHeight - sceneHeight) * 0.5);
  const contentScaleX = sceneWidth / outputWidth;
  const contentScaleY = sceneHeight / outputHeight;
  const contentOffsetX = (1 - contentScaleX) * 0.5;
  const contentOffsetY = (1 - contentScaleY) * 0.5;

  return {
    sceneWidth,
    sceneHeight,
    outputWidth,
    outputHeight,
    outputPadX,
    outputPadY,
    contentScaleX,
    contentScaleY,
    contentOffsetX,
    contentOffsetY
  };
}

/**
 * Converts a base orthographic world height to the active low-resolution target.
 *
 * Invariant:
 * - `referenceLowHeight` is the canonical low-res height where `baseOrthoHeight`
 *   was tuned to satisfy world-to-pixel contract.
 */
export function computeOrthoHeightForLowResolution(
  baseOrthoHeight: number,
  lowHeight: number,
  referenceLowHeight: number
): number {
  const safeReference = Math.max(1, referenceLowHeight);
  return baseOrthoHeight * (lowHeight / safeReference);
}

export function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return min;
  }
  return Math.max(min, Math.min(max, value));
}
