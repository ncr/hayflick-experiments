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
  PixelPerfectView,
  type PixelPerfectViewConfig,
  type PixelPerfectViewPose,
  type PixelPerfectViewState,
  type PixelSnapMode
} from "./pixel-perfect-view";
export {
  OutputUpscaleMaterial,
  type OutputUpscaleConfig
} from "./output-upscale-material";
export {
  PixelPerfectDefaults,
  pitchForPixelView,
  resolvePixelPerfectTuning,
  type PixelPerfectViewTuning,
  type PixelPerfectViewportCoreInput,
  type PixelPerfectViewportCoreResolved,
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
export {
  PixelPerfectOutlinedView,
  OutlineDefaults,
  type PixelPerfectOutlinedViewConfig,
  type OutlineTuning
} from "./outline/outlined-view";
export {
  EdgeDetectionMaterial,
  EDGE_DETECTION_DEBUG_MODES,
  edgeDetectionDebugModeIndex,
  type EdgeDetectionConfig,
  type EdgeDetectionDebugMode
} from "./outline/edge-detection-material";
export {
  LinearDepthMaterial
} from "./outline/linear-depth-material";
export {
  OutlineGroupMaterial,
  OUTLINE_GROUP_ID_EPS,
  encodeOutlineGroupColor
} from "./outline/outline-group-material";
export function makeRenderer(width: number, height: number, dpr: number): THREE.WebGLRenderer {
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(dpr);
  renderer.setSize(width, height, true);
  renderer.domElement.style.display = "block";
  return renderer;
}
