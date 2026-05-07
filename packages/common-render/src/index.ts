/**
 * @common/render — pixel-perfect iso-2:1 rendering foundation.
 *
 * Public surface is intentionally slim. Three ways to put a scene on screen:
 *
 *   new IsoGameView({ mount, width, height, scene })               // single-scene facade
 *   new IsoGameView({ ..., outlines: true })                       // + 4-pass outlines
 *   new PixelPerfectPane({ stage, id, element, scene, ...config })      // shared-stage pane
 *
 * For raw (non-pixel-perfect) three.js scenes in a shared-stage layout, use
 * {@link PerspectivePane}.
 */

// ========== Facades ==========

export {
  IsoGameView,
  type IsoGameViewConfig,
  type IsoGameViewPose,
  type IsoGameViewState,
  type PixelSnapMode,
  type OutlineTuning
} from "./iso-game-view";

// ========== Multi-pane stage ==========

export {
  SharedScissorStage,
  type SharedScissorStageConfig,
  type SharedScissorPane
} from "./stage/shared-scissor-stage";

export {
  PixelPerfectPane,
  type PixelPerfectPaneConfig
} from "./stage/pixel-perfect-pane";

export {
  PerspectivePane,
  type PerspectivePaneConfig
} from "./stage/perspective-pane";

// ========== Config / defaults ==========

export {
  PixelPerfectDefaults,
  type PixelView
} from "./pixel-perfect-types";

export { OutlineDefaults } from "./outline/outline-pipeline";

// ========== Outline API surface ==========
// The OutlinePipeline instance lives on `PixelPerfectPane.outline` /
// `IsoGameView.outline` when the pane/view is constructed with
// `outlines: true | {...}`. The class is intentionally *not* exported as a
// value — construction flows through pane/view config only. The type
// export is kept so consumers can annotate `view.outline`.
//
// Only the debug-mode string-union stays public for consumers that want
// to set or display mode labels (outline-walls experiment).

export { type EdgeDetectionDebugMode } from "./outline/edge-detection-material";
export { type OutlinePipeline } from "./outline/outline-pipeline";

// ========== Presets ==========

export {
  addStandardGameLighting,
  type StandardGameLightingOptions,
  type StandardGameLightingHandle
} from "./presets/standard-lighting";

export {
  assignOutlineGroupsByMaterialName,
  type MaterialNameGroupMap
} from "./presets/outline-groups";

export {
  PROP_PREVIEW_FRAMING,
  TILESET_VIEWER_TARGET_CONFIG,
  TILESET_VIEWER_NORMAL_CONFIG
} from "./presets/framing";

export { setCommonRenderWarningsEnabled } from "./presets/dev-warnings";

// ========== Iso view contract (locked) ==========

export {
  ISO_VIEW_CONTRACT,
  TOPDOWN_VIEW_CONTRACT,
  SIDE_VIEW_CONTRACT
} from "./iso-contract";

// ========== Texture helpers ==========

export {
  applyPixelArtTextureDefaults,
  applyPixelArtTextureDefaultsToTree
} from "./texture-helpers";
