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
  clearColor?: number;
  clearAlpha?: number;
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
