import * as THREE from "three";
export {
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
  PixelPerfectIsoView,
  type PixelPerfectIsoViewConfig,
  type PixelPerfectIsoViewPose,
  type PixelPerfectIsoViewState,
  type PixelSnapMode
} from "./pixel-perfect-iso-view";
export {
  PixelPerfectIsoViewportCore,
  type PixelPerfectIsoViewportCoreConfig,
  type PixelPerfectIsoRenderViewport,
  type PixelPerfectIsoViewportCoreVisualState,
  type PixelLocalPointerEventLike,
  type PixelLocalWheelEventLike
} from "./pixel-perfect-iso-viewport-core";
export {
  SharedScissorStage,
  type SharedScissorStageConfig,
  type SharedScissorPane,
  type SharedScissorPaneRect,
  type SharedScissorFrameContext,
  type SharedPanePointerEvent,
  type SharedPaneWheelEvent,
  type SharedScissorPaneHit
} from "./shared-scissor-stage";
export {
  PixelPerfectIsoScissorPane,
  type PixelPerfectIsoScissorPaneConfig
} from "./pixel-perfect-iso-scissor-pane";
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
