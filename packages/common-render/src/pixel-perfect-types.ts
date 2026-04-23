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

/**
 * Everything about a {@link IsoGameView} that the caller *might* want to
 * tune. All are optional; defaults in {@link PixelPerfectDefaults} match the
 * iso-2:1 art pipeline (240 low-res lines, tile centres on integer iso rows/cols).
 */
export type IsoGameViewTuning = {
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
  lowTargetSamples: number;
  /** When false, the output upscale pass uses hard nearest-neighbor texel edges with no boundary smoothing. */
  smoothPixelTransitions: boolean;
  /** Where the camera target sits vertically on screen: 0.5 = centered, 1/3 = lower third. */
  verticalBias: number;
  /**
   * Per-pane tone mapping. `"aces"` enables ACESFilmic + tags the pane's
   * low target as `SRGBColorSpace`; `"none"` forces `NoToneMapping`. The
   * pane installs internal before/after hooks to apply the mode and restore
   * the renderer state after the scene is rendered, so multi-pane scenes
   * can mix modes without contaminating each other.
   *
   * Default: `"none"` (unchanged from pre-config behavior).
   */
  toneMapping: "none" | "aces";
  /**
   * When true, the pane requests shadow rendering. Shadows are actually
   * enabled at the stage level (renderer is shared across panes); this
   * field only validates that the hosting stage has shadows on. If the
   * stage does not, the pane logs a one-time warning and renders without
   * shadows.
   */
  shadows: boolean;
};

/**
 * Baseline tuning tuned for the game's iso-2:1 art: 240 low-res scanlines,
 * `baseOrthoHeight = 4.8·√2` so tile centres (1.28 m spacing) and 8 cm mesh
 * features land on integer iso-pixels, canonical yaw = π/4.
 *
 * Don't change these — override fields via {@link IsoGameViewConfig} when
 * a scene genuinely needs a different framing. The defaults are reference values.
 */
export const PixelPerfectDefaults: Readonly<IsoGameViewTuning> = Object.freeze({
  fixedRenderHeight: 240,
  baseOrthoHeight: 4.8 * Math.SQRT2,
  cameraDistance: 40,
  cameraPitch: "iso-2to1",
  cameraYaw: Math.PI / 4,
  basePixelZoom: 1,
  zoomMin: 1,
  zoomMax: 8,
  zoomStep: 1,
  zoomAnimationRate: 12,
  zoomAnimationBurstRate: 24,
  zoomAnimationEpsilon: 0.01,
  rotationAnimationRate: 16,
  rotationAnimationEpsilon: 0.02,
  zoomBurstIdleMs: 300,
  outputOverscanLowPixels: 2,
  lowTargetSamples: 4,
  smoothPixelTransitions: true,
  verticalBias: 0.5,
  toneMapping: "none",
  shadows: false
});

export type IsoGameViewConfig = {
  mount: HTMLElement;
  width: number;
  height: number;
  scene: THREE.Scene;
  clearColor?: number;
  clearAlpha?: number;
  mountBackground?: string;
  canvasBackground?: string;
} & Partial<IsoGameViewTuning>;

/**
 * Internal config for {@link IsoViewport}. Callers get the same
 * partial tuning story as {@link IsoGameViewConfig} — defaults from
 * {@link PixelPerfectDefaults} are applied inside the constructor.
 */
export type IsoViewportInput = {
  width: number;
  height: number;
  scene: THREE.Scene;
  clearColor?: number;
  clearAlpha?: number;
  maxBackingWidth: number;
  maxBackingHeight: number;
  devicePixelRatio?: number;
} & Partial<IsoGameViewTuning>;

/** Resolved (defaults-merged) shape used inside the viewport core. */
export type IsoViewportResolved = Omit<
  IsoViewportInput,
  keyof IsoGameViewTuning
> &
  IsoGameViewTuning;

export type IsoGameViewState = {
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

export type IsoGameViewPose = {
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

/** Merge a partial tuning over {@link PixelPerfectDefaults}. */
export function resolvePixelPerfectTuning<T extends Partial<IsoGameViewTuning>>(
  input: T
): T & IsoGameViewTuning {
  return { ...PixelPerfectDefaults, ...input } as T & IsoGameViewTuning;
}
