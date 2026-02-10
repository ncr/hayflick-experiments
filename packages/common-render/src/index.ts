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

export function makeRenderer(width: number, height: number, dpr: number): THREE.WebGLRenderer {
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(dpr);
  renderer.setSize(width, height, true);
  renderer.domElement.style.display = "block";
  return renderer;
}
