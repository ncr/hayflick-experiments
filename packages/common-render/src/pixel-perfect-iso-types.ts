import * as THREE from "three";

export type PixelPerfectIsoViewConfig = {
  mount: HTMLElement;
  width: number;
  height: number;
  scene: THREE.Scene;
  fixedRenderHeight: number;
  baseOrthoHeight: number;
  cameraDistance: number;
  cameraPitch: number;
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

export type PixelPerfectIsoViewState = {
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

export type PixelPerfectIsoViewPose = {
  targetX: number;
  targetZ: number;
  yawIndex: number;
  zoom: number;
};

export type PixelSnapMode = "nearest" | "floor" | "ceil";
