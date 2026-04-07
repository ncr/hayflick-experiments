import * as THREE from "three";

/**
 * Discrete camera modes for the pixel-perfect renderer. Each value resolves to a
 * fixed camera pitch internally so the screen-to-world projection always lands on
 * the integer-pixel grid the renderer guarantees:
 *
 * - `"top-down"` — looks straight down at the ground plane (yaw rotates the map)
 * - `"iso-2to1"` — 30° pitch; the canonical 2:1 isometric (2 horizontal pixels
 *   per 1 vertical pixel along major axes). This is what the rest of the
 *   pipeline assumes; do not introduce other angles.
 * - `"side"` — 0° pitch (horizontal eye level); yaw snaps the camera onto
 *   one of the four cardinal world axes for side-scroller / FPS-style framing.
 */
export type PixelView = "top-down" | "iso-2to1" | "side";

/** Resolve a {@link PixelView} mode to its numeric pitch in radians. */
export function pitchForPixelView(view: PixelView): number {
  switch (view) {
    case "top-down":
      // Avoid the camera lookAt singularity at exactly π/2.
      return Math.PI / 2 - 1e-3;
    case "iso-2to1":
      return Math.PI / 6;
    case "side":
      return 0;
  }
}

export type PixelPerfectViewConfig = {
  mount: HTMLElement;
  width: number;
  height: number;
  scene: THREE.Scene;
  fixedRenderHeight: number;
  baseOrthoHeight: number;
  cameraDistance: number;
  cameraPitch: PixelView;
  cameraYaw: number;
  basePixelZoom: number;
  zoomMin: number;
  zoomMax: number;
  zoomStep: number;
  zoomAnimationRate: number;
  zoomAnimationBurstRate: number;
  zoomAnimationEpsilon: number;
  rotationAnimationRate: number;
  rotationAnimationEpsilon: number;
  zoomBurstIdleMs: number;
  outputOverscanLowPixels: number;
  /** MSAA sample count for the low-res render target. Default: 4. Set to 0 to disable. */
  lowTargetSamples?: number;
  clearColor?: number;
  clearAlpha?: number;
  /** Where the camera target sits vertically on screen: 0.5 = centered (default), 1/3 = lower third. */
  verticalBias?: number;
  mountBackground?: string;
  canvasBackground?: string;
};

export type PixelPerfectViewState = {
  cameraZoomCurrent: number;
  cameraZoomTarget: number;
  zoomAnimationActive: boolean;
  zoomBurstActive: boolean;
  controllerRenderScale: number;
  baseRenderScale: number;
  lowRenderWidth: number;
  lowRenderHeight: number;
  sceneOutputWidth: number;
  sceneOutputHeight: number;
  zoomMode: "free" | "safe-ladder";
  devicePixelRatio: number;
};

export type PixelPerfectViewPose = {
  targetX: number;
  targetZ: number;
  /**
   * Optional vertical position of the camera target. Only meaningful for the
   * `"side"` view, which pans along world Y. Top-down / iso modes ignore it
   * (the target is always clamped to the ground plane in those modes).
   */
  targetY?: number;
  yawIndex: number;
  zoom: number;
};

export type PixelSnapMode = "nearest" | "floor" | "ceil";
