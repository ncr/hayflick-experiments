import * as THREE from "three";
import type { PixelPerfectViewPose, PixelPerfectViewState, PixelSnapMode } from "./pixel-perfect-types";
import {
  PixelPerfectViewportCore,
  type PixelPerfectViewportCoreVisualState
} from "./pixel-perfect-viewport-core";
import type {
  SharedScissorFrameContext,
  SharedScissorPane,
  SharedScissorPaneRect
} from "./shared-scissor-stage";

export type PixelPerfectScissorPaneConfig = {
  id: string;
  element: HTMLElement;
  core: PixelPerfectViewportCore;
  devicePixelRatio?: number;
};

export class PixelPerfectScissorPane implements SharedScissorPane {
  readonly id: string;
  readonly element: HTMLElement;
  private readonly core: PixelPerfectViewportCore;
  private readonly fixedDevicePixelRatio?: number;

  constructor(config: PixelPerfectScissorPaneConfig) {
    this.id = config.id;
    this.element = config.element;
    this.core = config.core;
    this.fixedDevicePixelRatio = config.devicePixelRatio;
  }

  render(frame: SharedScissorFrameContext, rect: SharedScissorPaneRect): void {
    this.core.renderToRenderer(
      frame.renderer,
      {
        x: rect.deviceViewportLeft,
        y: rect.deviceViewportBottom,
        width: rect.deviceWidthUnclipped,
        height: rect.deviceHeightUnclipped
      },
      frame.nowMs,
      frame.deltaSeconds,
      {
        x: rect.deviceLeft,
        y: rect.deviceBottom,
        width: rect.deviceWidth,
        height: rect.deviceHeight
      }
    );
  }

  onResize(rect: SharedScissorPaneRect): void {
    const dpr =
      this.fixedDevicePixelRatio ??
      (rect.cssWidth > 0 ? rect.deviceWidthUnclipped / rect.cssWidth : 1);
    const logicalDeviceWidth = Math.max(1, rect.deviceWidthUnclipped || Math.round(rect.cssWidth * dpr));
    const logicalDeviceHeight = Math.max(1, rect.deviceHeightUnclipped || Math.round(rect.cssHeight * dpr));
    this.core.resize(rect.cssWidth, rect.cssHeight, dpr, logicalDeviceWidth, logicalDeviceHeight);
  }

  getViewPose(): PixelPerfectViewPose {
    return this.core.getViewPose();
  }

  setViewPose(pose: PixelPerfectViewPose): void {
    this.core.setViewPose(pose);
  }

  getState(): PixelPerfectViewState {
    return this.core.getState();
  }

  getVisualState(): PixelPerfectViewportCoreVisualState {
    return this.core.getVisualState();
  }

  setVisualState(state: PixelPerfectViewportCoreVisualState): void {
    this.core.setVisualState(state);
  }

  panByCss(dx: number, dy: number): void {
    this.core.panByCss(dx, dy);
  }

  rotateQuarterTurns(delta: -1 | 1): void {
    this.core.rotateQuarterTurns(delta);
  }

  stepCameraZoomAtLocalCss(direction: -1 | 1, localX: number, localY: number, nowMs?: number): boolean {
    return this.core.zoomStepAtLocalCss(direction, localX, localY, nowMs);
  }

  toggleZoomMode(): void {
    this.core.toggleZoomMode();
  }

  beginPanDrag(localX: number, localY: number): void {
    this.core.beginPanDrag(localX, localY);
  }

  updatePanDrag(localX: number, localY: number): boolean {
    return this.core.updatePanDrag(localX, localY);
  }

  endPanDrag(): boolean {
    return this.core.endPanDrag();
  }

  worldAtLocalCss(localX: number, localY: number, out: THREE.Vector3): boolean {
    return this.core.worldAtLocalCss(localX, localY, out);
  }

  projectWorldToLocalCss(world: THREE.Vector3, out: THREE.Vector2): boolean {
    return this.core.projectWorldToLocalCss(world, out);
  }

  snapWorldPointOnGround(world: THREE.Vector3, out: THREE.Vector3, mode?: PixelSnapMode): boolean {
    return this.core.snapWorldPointOnGround(world, out, mode);
  }

  isDragging(): boolean {
    return this.core.isDragging();
  }

  dispose(): void {
    this.core.dispose();
  }
}
