import * as THREE from "three";
export {
  clamp,
  computeLowResolutionSize,
  computeOrthoHeightForLowResolution,
  computeOutputViewportLayout,
  computeRenderScale,
  computeViewportDeviceSize,
  type DeviceSize,
  type OutputViewportLayout
} from "./pixel-perfect";
export {
  PixelPerfectController,
  computeSafeZoomLevels,
  createPanPhaseState,
  nearestZoomLevel,
  rescalePanPhaseRemainder,
  stepPanPhase,
  stepZoomLevel,
  type PanPhaseState,
  type PanPhaseStep,
  type PixelControllerCanvasMetrics,
  type PixelControllerPoint,
  type PixelPerfectControllerConfig,
  type PixelPerfectControllerState,
  type ZoomMode
} from "./pixel-perfect-controller";
export {
  PixelStage,
  type PixelStageLayout,
  type PixelStageMetrics,
  type PixelStageOptions
} from "./pixel-stage";
export {
  PixelPerfectView,
  type PixelPerfectViewConfig,
  type PixelPerfectViewPose,
  type PixelPerfectViewState,
  type PixelSnapMode
} from "./pixel-perfect-view";
export {
  pitchForPixelView,
  type PixelView
} from "./pixel-perfect-types";
export {
  PixelPerfectViewportCore,
  type PixelPerfectViewportCoreConfig,
  type PixelPerfectRenderViewport,
  type PixelPerfectViewportCoreVisualState
} from "./pixel-perfect-viewport-core";
export {
  SharedScissorStage,
  type SharedScissorStageConfig,
  type SharedScissorPane,
  type SharedScissorPaneRect,
  type SharedScissorFrameContext,
  type SharedScissorPaneHit
} from "./shared-scissor-stage";
export {
  PixelPerfectScissorPane,
  type PixelPerfectScissorPaneConfig
} from "./pixel-perfect-scissor-pane";
export {
  ThreeSceneScissorPane,
  type ThreeSceneScissorPaneConfig
} from "./three-scene-scissor-pane";
export function makeRenderer(width: number, height: number, dpr: number): THREE.WebGLRenderer {
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(dpr);
  renderer.setSize(width, height, true);
  renderer.domElement.style.display = "block";
  return renderer;
}
