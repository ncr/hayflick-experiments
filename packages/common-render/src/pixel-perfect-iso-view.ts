import * as THREE from "three";
import { PixelPerfectIsoScissorPane } from "./pixel-perfect-iso-scissor-pane";
import { PixelPerfectIsoViewportCore } from "./pixel-perfect-iso-viewport-core";
import { SharedScissorStage } from "./shared-scissor-stage";
import type {
  PixelPerfectIsoViewConfig,
  PixelPerfectIsoViewPose,
  PixelPerfectIsoViewState,
  PixelSnapMode
} from "./pixel-perfect-iso-types";

export type {
  PixelPerfectIsoViewConfig,
  PixelPerfectIsoViewPose,
  PixelPerfectIsoViewState,
  PixelSnapMode
} from "./pixel-perfect-iso-types";

const SINGLE_PANE_ID = "main";

export class PixelPerfectIsoView {
  readonly stage: SharedScissorStage;
  readonly renderer: THREE.WebGLRenderer;
  readonly camera: THREE.OrthographicCamera;
  readonly cameraTarget: THREE.Vector3;

  private readonly mount: HTMLElement;
  private readonly core: PixelPerfectIsoViewportCore;
  private readonly pane: PixelPerfectIsoScissorPane;
  private readonly savedMountBackground: string;
  private readonly savedCanvasBackground: string;
  private readonly projectLocal = new THREE.Vector2();
  private disposed = false;

  constructor(config: PixelPerfectIsoViewConfig) {
    this.mount = config.mount;
    this.savedMountBackground = this.mount.style.background;

    this.stage = new SharedScissorStage({
      mount: config.mount,
      width: config.width,
      height: config.height,
      pixelRatio: Math.max(1, window.devicePixelRatio || 1),
      antialias: false,
      clearColor: config.clearColor ?? 0x0b0f14,
      clearAlpha: config.clearAlpha ?? 1
    });
    this.renderer = this.stage.renderer;
    this.savedCanvasBackground = this.stage.canvas.style.background;

    if (config.mountBackground !== undefined) {
      this.mount.style.background = config.mountBackground;
    }
    if (config.canvasBackground !== undefined) {
      this.stage.canvas.style.background = config.canvasBackground;
    }

    this.core = new PixelPerfectIsoViewportCore({
      width: config.width,
      height: config.height,
      scene: config.scene,
      fixedRenderHeight: config.fixedRenderHeight,
      baseOrthoHeight: config.baseOrthoHeight,
      cameraDistance: config.cameraDistance,
      cameraPitch: config.cameraPitch,
      cameraYaw: config.cameraYaw,
      basePixelZoom: config.basePixelZoom,
      zoomMin: config.zoomMin,
      zoomMax: config.zoomMax,
      zoomStep: config.zoomStep,
      zoomAnimationRate: config.zoomAnimationRate,
      zoomAnimationBurstRate: config.zoomAnimationBurstRate,
      zoomAnimationEpsilon: config.zoomAnimationEpsilon,
      rotationAnimationRate: config.rotationAnimationRate,
      rotationAnimationEpsilon: config.rotationAnimationEpsilon,
      zoomBurstIdleMs: config.zoomBurstIdleMs,
      outputOverscanLowPixels: config.outputOverscanLowPixels,
      clearColor: config.clearColor,
      clearAlpha: config.clearAlpha,
      maxBackingWidth: this.stage.maxBackingWidth,
      maxBackingHeight: this.stage.maxBackingHeight,
      devicePixelRatio: this.stage.getDevicePixelRatio()
    });

    this.pane = new PixelPerfectIsoScissorPane({
      id: SINGLE_PANE_ID,
      element: this.mount,
      core: this.core,
      devicePixelRatio: this.stage.getDevicePixelRatio()
    });
    this.stage.registerPane(this.pane);

    this.camera = this.core.camera;
    this.cameraTarget = this.core.cameraTarget;
  }

  getState(): PixelPerfectIsoViewState {
    return this.core.getState();
  }

  getViewPose(): PixelPerfectIsoViewPose {
    return this.core.getViewPose();
  }

  setViewPose(pose: PixelPerfectIsoViewPose): void {
    this.core.setViewPose(pose);
  }

  getYawIndex(): number {
    return this.core.getYawIndex();
  }

  rotateQuarterTurns(delta: -1 | 1): void {
    this.core.rotateQuarterTurns(delta);
  }

  panByCss(dx: number, dy: number): void {
    this.core.panByCss(dx, dy);
  }

  stepCameraZoom(direction: -1 | 1): void {
    this.core.stepCameraZoom(direction);
  }

  toggleZoomMode(): void {
    this.core.toggleZoomMode();
  }

  beginPanDrag(clientX: number, clientY: number): boolean {
    const local = this.toLocalCss(clientX, clientY);
    if (!local) {
      return false;
    }
    this.core.beginPanDrag(local.x, local.y);
    return true;
  }

  updatePanDrag(clientX: number, clientY: number): boolean {
    const local = this.toLocalCss(clientX, clientY);
    if (!local) {
      return false;
    }
    return this.core.updatePanDrag(local.x, local.y);
  }

  endPanDrag(): boolean {
    return this.core.endPanDrag();
  }

  zoomStepAtClient(
    direction: -1 | 1,
    clientX: number,
    clientY: number,
    nowMs?: number
  ): boolean {
    const local = this.toLocalCss(clientX, clientY);
    if (!local) {
      return false;
    }
    return this.core.zoomStepAtLocalCss(direction, local.x, local.y, nowMs);
  }

  get canvas(): HTMLCanvasElement {
    return this.stage.canvas;
  }

  reset(): void {
    this.core.reset();
  }

  resize(nextWidth: number, nextHeight: number): void {
    this.stage.resize(nextWidth, nextHeight, Math.max(1, window.devicePixelRatio || 1));
  }

  frame(nowMs: number, deltaSeconds: number): void {
    this.stage.drawFrame(nowMs, deltaSeconds);
  }

  worldAtClient(clientX: number, clientY: number, out: THREE.Vector3): boolean {
    const local = this.toLocalCss(clientX, clientY);
    if (!local) {
      return false;
    }
    return this.core.worldAtLocalCss(local.x, local.y, out);
  }

  projectWorldToClient(world: THREE.Vector3, out: THREE.Vector2): boolean {
    const local = this.projectLocal;
    if (!this.core.projectWorldToLocalCss(world, local)) {
      return false;
    }
    const rect = this.mount.getBoundingClientRect();
    out.set(rect.left + local.x, rect.top + local.y);
    return true;
  }

  snapWorldPointOnGround(
    world: THREE.Vector3,
    out: THREE.Vector3,
    mode: PixelSnapMode = "nearest"
  ): boolean {
    return this.core.snapWorldPointOnGround(world, out, mode);
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.stage.canvas.style.background = this.savedCanvasBackground;
    this.stage.dispose();
    this.mount.style.background = this.savedMountBackground;
  }

  private toLocalCss(clientX: number, clientY: number): { x: number; y: number } | null {
    const rect = this.mount.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) {
      return null;
    }
    return {
      x: clientX - rect.left,
      y: clientY - rect.top
    };
  }
}
