import type { IsoCoreTuning } from "../pixel-perfect-types";

/**
 * Named PixelPerfectPane tuning bundles for **tool views** (forge prop
 * preview, quad inspector, etc.). Framing fields (`fixedRenderHeight`,
 * `baseOrthoHeight`, `cameraDistance`, `basePixelZoom`) and animation-feel
 * fields are tuned together. Prefer the `profile` field on
 * `PixelPerfectPaneConfig` for production consumers; the raw constants stay
 * exported for tests and narrow one-off tools.
 *
 * The game render path uses `IsoGameView`, which locks scale to
 * `ISO_VIEW_CONTRACT` and does NOT accept these tuples. Tool views (which
 * intentionally deviate from the game look) use `PixelPerfectPane` —
 * either directly or via a thin wrapper.
 *
 * ```ts
 * const pane = new PixelPerfectPane({
 *   stage, id, element, scene, width, height,
 *   profile: { name: "prop-preview", framingScale: 1.2 }
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
  cameraPitch: "iso-2to1",
  cameraYaw: Math.PI / 4,
  basePixelZoom: 2,
  zoomMax: 6,
  zoomAnimationRate: 14,
  zoomAnimationBurstRate: 42,
  zoomAnimationEpsilon: 0.001,
  rotationAnimationRate: 18,
  rotationAnimationEpsilon: 0.001,
  zoomBurstIdleMs: 200
} as const;

export type PixelPerfectPaneProfileConfig =
  | "prop-preview"
  | {
      name: "prop-preview";
      framingScale?: number;
    };

export function resolvePixelPerfectPaneProfile(
  profile: PixelPerfectPaneProfileConfig | undefined
): Partial<IsoCoreTuning> {
  if (!profile) {
    return {};
  }
  const config = typeof profile === "string" ? { name: profile } : profile;
  switch (config.name) {
    case "prop-preview": {
      const framingScale =
        typeof config.framingScale === "number" &&
        Number.isFinite(config.framingScale) &&
        config.framingScale > 0
          ? config.framingScale
          : 1;
      return {
        ...PROP_PREVIEW_FRAMING,
        baseOrthoHeight: PROP_PREVIEW_FRAMING.baseOrthoHeight * framingScale
      };
    }
  }
}

export {
  TILESET_VIEWER_TARGET_CONFIG,
  TILESET_VIEWER_NORMAL_CONFIG
} from "../tileset-viewer-config";
