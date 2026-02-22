import type { PixelPerfectIsoViewPose, PixelPerfectIsoViewState } from "./pixel-perfect-iso-view";
import {
  PixelPerfectIsoViewportCore,
  type PixelPerfectIsoViewportCoreVisualState,
  type PixelLocalPointerEventLike,
  type PixelLocalWheelEventLike
} from "./pixel-perfect-iso-viewport-core";
import type {
  SharedPanePointerEvent,
  SharedPaneWheelEvent,
  SharedScissorFrameContext,
  SharedScissorPane,
  SharedScissorPaneRect
} from "./shared-scissor-stage";

export type PixelPerfectIsoScissorPaneConfig = {
  id: string;
  element: HTMLElement;
  core: PixelPerfectIsoViewportCore;
  devicePixelRatio?: number;
};

function toLocalPointerLike(event: SharedPanePointerEvent): PixelLocalPointerEventLike {
  const src = event.originalEvent;
  return {
    clientX: src.clientX,
    clientY: src.clientY,
    localX: event.localX,
    localY: event.localY,
    button: src.button,
    buttons: src.buttons,
    pointerId: src.pointerId
  };
}

function toLocalWheelLike(event: SharedPaneWheelEvent): PixelLocalWheelEventLike {
  const src = event.originalEvent;
  return {
    clientX: src.clientX,
    clientY: src.clientY,
    localX: event.localX,
    localY: event.localY,
    deltaX: src.deltaX,
    deltaY: src.deltaY,
    deltaMode: src.deltaMode,
    ctrlKey: src.ctrlKey,
    metaKey: src.metaKey,
    shiftKey: src.shiftKey
  };
}

export class PixelPerfectIsoScissorPane implements SharedScissorPane {
  readonly id: string;
  readonly element: HTMLElement;
  readonly core: PixelPerfectIsoViewportCore;
  private readonly fixedDevicePixelRatio?: number;

  constructor(config: PixelPerfectIsoScissorPaneConfig) {
    this.id = config.id;
    this.element = config.element;
    this.core = config.core;
    this.fixedDevicePixelRatio = config.devicePixelRatio;
  }

  render(frame: SharedScissorFrameContext, rect: SharedScissorPaneRect): void {
    this.core.renderToRenderer(
      frame.renderer,
      {
        x: rect.deviceLeft,
        y: rect.deviceBottom,
        width: rect.deviceWidth,
        height: rect.deviceHeight
      },
      frame.nowMs,
      frame.deltaSeconds
    );
  }

  onResize(rect: SharedScissorPaneRect): void {
    const dpr =
      this.fixedDevicePixelRatio ??
      (rect.cssWidth > 0 ? rect.deviceWidth / rect.cssWidth : 1);
    this.core.resize(rect.cssWidth, rect.cssHeight, dpr, rect.deviceWidth, rect.deviceHeight);
  }

  onPointerDown(event: SharedPanePointerEvent): boolean {
    return this.core.onPointerDown(toLocalPointerLike(event));
  }

  onPointerMove(event: SharedPanePointerEvent): boolean {
    return this.core.onPointerMove(toLocalPointerLike(event));
  }

  onPointerUp(event: SharedPanePointerEvent): boolean {
    return this.core.onPointerUp(toLocalPointerLike(event));
  }

  onAuxClick(event: SharedPanePointerEvent): boolean {
    return this.core.onAuxClick(event.originalEvent.button);
  }

  onWheel(event: SharedPaneWheelEvent): boolean {
    return this.core.onWheel(toLocalWheelLike(event));
  }

  onKeyDown(event: KeyboardEvent): boolean {
    return this.core.onKeyDown(event);
  }

  onKeyUp(event: KeyboardEvent): boolean {
    return this.core.onKeyUp(event);
  }

  getViewPose(): PixelPerfectIsoViewPose {
    return this.core.getViewPose();
  }

  setViewPose(pose: PixelPerfectIsoViewPose): void {
    this.core.setViewPose(pose);
  }

  getState(): PixelPerfectIsoViewState {
    return this.core.getState();
  }

  getVisualState(): PixelPerfectIsoViewportCoreVisualState {
    return this.core.getVisualState();
  }

  setVisualState(state: PixelPerfectIsoViewportCoreVisualState): void {
    this.core.setVisualState(state);
  }

  isDragging(): boolean {
    return this.core.isDragging();
  }

  dispose(): void {
    this.core.dispose();
  }
}
