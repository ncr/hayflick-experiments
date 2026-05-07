import * as THREE from "three";
import {
  ISO_VIEW_CONTRACT,
  TOPDOWN_VIEW_CONTRACT,
  SIDE_VIEW_CONTRACT
} from "./iso-contract";

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
      return TOPDOWN_VIEW_CONTRACT.pitch;
    case "iso-2to1":
      return ISO_VIEW_CONTRACT.pitch;
    case "side":
      return SIDE_VIEW_CONTRACT.pitch;
  }
}

/**
 * Lower-level configurable tuning. Used by {@link IsoViewport} and
 * {@link PixelPerfectPane} — the pre-locked path tools take when they
 * need custom framing (forge prop preview, tileset inspector, diag
 * scenes). The game render path uses {@link IsoGameView}, which exposes
 * only the locked subset (see {@link IsoGameViewTuning}).
 */
export type IsoCoreTuning = {
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
   * low target as `SRGBColorSpace`; `"none"` forces `NoToneMapping`.
   */
  toneMapping: "none" | "aces";
  /**
   * When true, the pane requests shadow rendering. Shadows are actually
   * enabled at the stage level.
   */
  shadows: boolean;
};

/**
 * Locked public tuning for {@link IsoGameView}. The cornerstone iso-2:1
 * view aesthetic is non-configurable on the game render path:
 *   - scale (`fixedRenderHeight`, `baseOrthoHeight`) is sourced from
 *     {@link ISO_VIEW_CONTRACT} / {@link TOPDOWN_VIEW_CONTRACT} /
 *     {@link SIDE_VIEW_CONTRACT}
 *   - yaw is restricted to quarter-turn rotations from the view's base
 *     via {@link IsoGameViewTuning.yawIndex} (0..3)
 *   - pitch is fixed by `cameraPitch` to one of three discrete values
 *
 * Tools that need different framing must construct {@link PixelPerfectPane}
 * directly (which accepts the configurable {@link IsoCoreTuning}).
 */
export type IsoGameViewTuning = {
  cameraPitch: PixelView;
  /** Cardinal yaw rotation: 0..3 quarter-turns from the view's base yaw. */
  yawIndex: number;
  cameraDistance: number;
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
  lowTargetSamples: number;
  smoothPixelTransitions: boolean;
  verticalBias: number;
  toneMapping: "none" | "aces";
  shadows: boolean;
};

/**
 * Defaults for the lower-level {@link IsoCoreTuning}. Iso scale fields
 * are sourced from {@link ISO_VIEW_CONTRACT}; tools building
 * {@link PixelPerfectPane} pass overrides as needed.
 */
export const IsoCoreDefaults: Readonly<IsoCoreTuning> = Object.freeze({
  fixedRenderHeight: ISO_VIEW_CONTRACT.referenceLowHeight,
  baseOrthoHeight: ISO_VIEW_CONTRACT.baseOrthoHeight,
  cameraDistance: 40,
  cameraPitch: "iso-2to1",
  cameraYaw: ISO_VIEW_CONTRACT.baseYaw,
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

/**
 * Defaults for the locked {@link IsoGameViewTuning}. A subset of
 * {@link IsoCoreDefaults} — the scale fields are not present (sourced
 * from the per-view contract at construction time).
 */
export const PixelPerfectDefaults: Readonly<IsoGameViewTuning> = Object.freeze({
  cameraPitch: IsoCoreDefaults.cameraPitch,
  yawIndex: 0,
  cameraDistance: IsoCoreDefaults.cameraDistance,
  basePixelZoom: IsoCoreDefaults.basePixelZoom,
  zoomMin: IsoCoreDefaults.zoomMin,
  zoomMax: IsoCoreDefaults.zoomMax,
  zoomStep: IsoCoreDefaults.zoomStep,
  zoomAnimationRate: IsoCoreDefaults.zoomAnimationRate,
  zoomAnimationBurstRate: IsoCoreDefaults.zoomAnimationBurstRate,
  zoomAnimationEpsilon: IsoCoreDefaults.zoomAnimationEpsilon,
  rotationAnimationRate: IsoCoreDefaults.rotationAnimationRate,
  rotationAnimationEpsilon: IsoCoreDefaults.rotationAnimationEpsilon,
  zoomBurstIdleMs: IsoCoreDefaults.zoomBurstIdleMs,
  outputOverscanLowPixels: IsoCoreDefaults.outputOverscanLowPixels,
  lowTargetSamples: IsoCoreDefaults.lowTargetSamples,
  smoothPixelTransitions: IsoCoreDefaults.smoothPixelTransitions,
  verticalBias: IsoCoreDefaults.verticalBias,
  toneMapping: IsoCoreDefaults.toneMapping,
  shadows: IsoCoreDefaults.shadows
});

export type IsoGameViewConfig = {
  mount: HTMLElement;
  width: number;
  height: number;
  scene: THREE.Scene;
  clearColor?: number;
  clearAlpha?: number;
} & Partial<IsoGameViewTuning>;

/**
 * Internal config for {@link IsoViewport}. Accepts the full configurable
 * {@link IsoCoreTuning} — defaults from {@link IsoCoreDefaults} are applied
 * inside the constructor.
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
} & Partial<IsoCoreTuning>;

/** Resolved (defaults-merged) shape used inside the viewport core. */
export type IsoViewportResolved = Omit<
  IsoViewportInput,
  keyof IsoCoreTuning
> &
  IsoCoreTuning;

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

/** Merge a partial CORE tuning over {@link IsoCoreDefaults}. */
export function resolvePixelPerfectTuning<T extends Partial<IsoCoreTuning>>(
  input: T
): T & IsoCoreTuning {
  return { ...IsoCoreDefaults, ...input } as T & IsoCoreTuning;
}

/**
 * Translate the locked `(cameraPitch, yawIndex)` pair into the underlying
 * scale + continuous yaw the {@link IsoViewport} consumes. Sourced from
 * the per-view contract — never compute these manually on the game render
 * path. Used internally by {@link IsoGameView}.
 */
export function resolveLockedView(
  cameraPitch: PixelView,
  yawIndex: number
): {
  fixedRenderHeight: number;
  baseOrthoHeight: number;
  cameraYaw: number;
} {
  const contract =
    cameraPitch === "iso-2to1"
      ? ISO_VIEW_CONTRACT
      : cameraPitch === "top-down"
        ? TOPDOWN_VIEW_CONTRACT
        : SIDE_VIEW_CONTRACT;
  const idx = ((Math.round(yawIndex) % 4) + 4) % 4;
  return {
    fixedRenderHeight: contract.referenceLowHeight,
    baseOrthoHeight: contract.baseOrthoHeight,
    cameraYaw: contract.baseYaw + idx * (Math.PI / 2)
  };
}
