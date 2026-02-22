import * as THREE from "three";

export type SharedScissorPaneRect = {
  cssLeft: number;
  cssTop: number;
  cssWidth: number;
  cssHeight: number;
  deviceLeft: number;
  deviceTop: number;
  deviceBottom: number;
  deviceWidth: number;
  deviceHeight: number;
};

export type SharedScissorFrameContext = {
  renderer: THREE.WebGLRenderer;
  nowMs: number;
  deltaSeconds: number;
};

export type SharedPanePointerEvent = {
  originalEvent: PointerEvent;
  paneId: string;
  localX: number;
  localY: number;
  rect: SharedScissorPaneRect;
};

export type SharedPaneWheelEvent = {
  originalEvent: WheelEvent;
  paneId: string;
  localX: number;
  localY: number;
  rect: SharedScissorPaneRect;
};

export interface SharedScissorPane {
  id: string;
  element: HTMLElement;
  render(frame: SharedScissorFrameContext, rect: SharedScissorPaneRect): void;
  onResize?(rect: SharedScissorPaneRect): void;
  onPointerDown?(event: SharedPanePointerEvent): boolean;
  onPointerMove?(event: SharedPanePointerEvent): boolean;
  onPointerUp?(event: SharedPanePointerEvent): boolean;
  onAuxClick?(event: SharedPanePointerEvent): boolean;
  onWheel?(event: SharedPaneWheelEvent): boolean;
  onKeyDown?(event: KeyboardEvent): boolean;
  onKeyUp?(event: KeyboardEvent): boolean;
  dispose?(): void;
}

export type SharedScissorStageConfig = {
  mount: HTMLElement;
  width: number;
  height: number;
  pixelRatio?: number;
  antialias?: boolean;
  clearColor?: number;
  clearAlpha?: number;
};

type PaneEntry = {
  pane: SharedScissorPane;
  lastRectKey: string;
};

export class SharedScissorStage {
  readonly mount: HTMLElement;
  readonly renderer: THREE.WebGLRenderer;
  readonly canvas: HTMLCanvasElement;
  readonly maxBackingWidth: number;
  readonly maxBackingHeight: number;

  private readonly resizeObserver: ResizeObserver;
  private readonly panes = new Map<string, PaneEntry>();
  private readonly paneRects = new Map<string, SharedScissorPaneRect>();
  private readonly pointerCaptureById = new Map<number, string>();
  private raf = 0;
  private running = false;
  private lastFrameTimeMs = performance.now();
  private widthCss = 1;
  private heightCss = 1;
  private pixelRatio = 1;
  private focusedPaneId: string | null = null;
  private readonly clearColor: number;
  private readonly clearAlpha: number;
  private readonly savedMountPosition: string;
  private readonly savedMountOverflow: string;

  constructor(config: SharedScissorStageConfig) {
    this.mount = config.mount;
    this.pixelRatio = Math.max(1, (config.pixelRatio ?? window.devicePixelRatio) || 1);
    this.clearColor = config.clearColor ?? 0x0b0f14;
    this.clearAlpha = config.clearAlpha ?? 1;
    this.savedMountPosition = this.mount.style.position;
    this.savedMountOverflow = this.mount.style.overflow;

    this.renderer = new THREE.WebGLRenderer({
      antialias: config.antialias ?? false,
      alpha: (config.clearAlpha ?? 1) < 1
    });
    this.renderer.setPixelRatio(1);
    this.canvas = this.renderer.domElement;
    this.canvas.style.position = "absolute";
    this.canvas.style.left = "0";
    this.canvas.style.top = "0";
    this.canvas.style.display = "block";
    this.canvas.style.width = "100%";
    this.canvas.style.height = "100%";
    this.canvas.style.imageRendering = "pixelated";
    this.canvas.style.touchAction = "none";
    this.canvas.style.zIndex = "0";

    this.mount.style.position = this.mount.style.position || "relative";
    this.mount.style.overflow = this.mount.style.overflow || "hidden";
    this.mount.appendChild(this.canvas);

    const caps = queryMaxBackingSize(this.renderer.getContext());
    this.maxBackingWidth = caps.width;
    this.maxBackingHeight = caps.height;

    this.resize(Math.max(1, config.width), Math.max(1, config.height), this.pixelRatio);

    this.canvas.addEventListener("pointerdown", this.handlePointerDown);
    this.canvas.addEventListener("pointermove", this.handlePointerMove);
    this.canvas.addEventListener("pointerup", this.handlePointerUp);
    this.canvas.addEventListener("pointercancel", this.handlePointerUp);
    this.canvas.addEventListener("auxclick", this.handleAuxClick);
    this.canvas.addEventListener("wheel", this.handleWheel, { passive: false });
    window.addEventListener("keydown", this.handleKeyDown);
    window.addEventListener("keyup", this.handleKeyUp);

    this.resizeObserver = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      this.resize(entry.contentRect.width, entry.contentRect.height);
    });
    this.resizeObserver.observe(this.mount);
  }

  registerPane(pane: SharedScissorPane): void {
    this.panes.set(pane.id, { pane, lastRectKey: "" });
    this.measurePaneRects();
  }

  unregisterPane(id: string): void {
    const entry = this.panes.get(id);
    if (!entry) return;
    this.panes.delete(id);
    this.paneRects.delete(id);
    if (this.focusedPaneId === id) {
      this.focusedPaneId = null;
    }
    entry.pane.dispose?.();
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.lastFrameTimeMs = performance.now();
    const tick = (nowMs: number): void => {
      if (!this.running) return;
      const dt = Math.min(0.05, Math.max(0, (nowMs - this.lastFrameTimeMs) / 1000));
      this.lastFrameTimeMs = nowMs;
      this.draw(nowMs, dt);
      this.raf = requestAnimationFrame(tick);
    };
    this.raf = requestAnimationFrame(tick);
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    cancelAnimationFrame(this.raf);
    this.raf = 0;
  }

  resize(widthCss: number, heightCss: number, nextPixelRatio?: number): void {
    this.widthCss = Math.max(1, widthCss);
    this.heightCss = Math.max(1, heightCss);
    if (Number.isFinite(nextPixelRatio) && (nextPixelRatio ?? 1) > 0) {
      this.pixelRatio = Math.max(1, nextPixelRatio ?? 1);
    }

    const mountRect = this.mount.getBoundingClientRect();
    const absWidthFromRect =
      mountRect.width > 0
        ? Math.round(mountRect.right * this.pixelRatio) - Math.round(mountRect.left * this.pixelRatio)
        : 0;
    const absHeightFromRect =
      mountRect.height > 0
        ? Math.round(mountRect.bottom * this.pixelRatio) - Math.round(mountRect.top * this.pixelRatio)
        : 0;

    const fallbackDeviceWidth = Math.round(this.widthCss * this.pixelRatio);
    const fallbackDeviceHeight = Math.round(this.heightCss * this.pixelRatio);

    const deviceWidth = Math.max(
      1,
      Math.min(this.maxBackingWidth, absWidthFromRect > 0 ? absWidthFromRect : fallbackDeviceWidth)
    );
    const deviceHeight = Math.max(
      1,
      Math.min(this.maxBackingHeight, absHeightFromRect > 0 ? absHeightFromRect : fallbackDeviceHeight)
    );

    this.renderer.setSize(deviceWidth, deviceHeight, false);
    this.canvas.style.width = `${this.widthCss}px`;
    this.canvas.style.height = `${this.heightCss}px`;
    this.measurePaneRects();
  }

  getRenderer(): THREE.WebGLRenderer {
    return this.renderer;
  }

  getCanvas(): HTMLCanvasElement {
    return this.canvas;
  }

  getFocusedPaneId(): string | null {
    return this.focusedPaneId;
  }

  setFocusedPaneId(id: string | null): void {
    if (id == null) {
      this.focusedPaneId = null;
      return;
    }
    this.focusedPaneId = this.panes.has(id) ? id : null;
  }

  getPaneRects(): ReadonlyMap<string, SharedScissorPaneRect> {
    return this.paneRects;
  }

  getDevicePixelRatio(): number {
    return this.pixelRatio;
  }

  dispose(): void {
    this.stop();
    this.resizeObserver.disconnect();
    this.canvas.removeEventListener("pointerdown", this.handlePointerDown);
    this.canvas.removeEventListener("pointermove", this.handlePointerMove);
    this.canvas.removeEventListener("pointerup", this.handlePointerUp);
    this.canvas.removeEventListener("pointercancel", this.handlePointerUp);
    this.canvas.removeEventListener("auxclick", this.handleAuxClick);
    this.canvas.removeEventListener("wheel", this.handleWheel);
    window.removeEventListener("keydown", this.handleKeyDown);
    window.removeEventListener("keyup", this.handleKeyUp);
    for (const entry of this.panes.values()) {
      entry.pane.dispose?.();
    }
    this.panes.clear();
    this.paneRects.clear();
    this.pointerCaptureById.clear();
    if (this.canvas.parentElement === this.mount) {
      this.mount.removeChild(this.canvas);
    }
    this.mount.style.position = this.savedMountPosition;
    this.mount.style.overflow = this.savedMountOverflow;
    this.renderer.dispose();
  }

  private draw(nowMs: number, deltaSeconds: number): void {
    this.measurePaneRects();
    const renderer = this.renderer;
    renderer.setScissorTest(false);
    renderer.setViewport(0, 0, renderer.domElement.width, renderer.domElement.height);
    renderer.setClearColor(this.clearColor, this.clearAlpha);
    renderer.clear(true, true, true);
    renderer.setScissorTest(true);

    const frameCtx: SharedScissorFrameContext = { renderer, nowMs, deltaSeconds };
    for (const entry of this.panes.values()) {
      const rect = this.paneRects.get(entry.pane.id);
      if (!rect) continue;
      if (rect.deviceWidth <= 1 || rect.deviceHeight <= 1) continue;
      entry.pane.render(frameCtx, rect);
    }
    renderer.setScissorTest(false);
  }

  private measurePaneRects(): void {
    const mountRect = this.mount.getBoundingClientRect();
    const cssToDeviceX = mountRect.width > 0 ? this.canvas.width / mountRect.width : 1;
    const cssToDeviceY = mountRect.height > 0 ? this.canvas.height / mountRect.height : 1;
    const canvasWidth = this.canvas.width;
    const canvasHeight = this.canvas.height;
    const expectedCanvasWidthAbs =
      mountRect.width > 0
        ? Math.round(mountRect.right * this.pixelRatio) - Math.round(mountRect.left * this.pixelRatio)
        : 0;
    const expectedCanvasHeightAbs =
      mountRect.height > 0
        ? Math.round(mountRect.bottom * this.pixelRatio) - Math.round(mountRect.top * this.pixelRatio)
        : 0;
    const useAbsoluteEdgeQuantization =
      expectedCanvasWidthAbs === canvasWidth && expectedCanvasHeightAbs === canvasHeight;
    const mountLeftAbsPx = Math.round(mountRect.left * this.pixelRatio);
    const mountTopAbsPx = Math.round(mountRect.top * this.pixelRatio);

    for (const [id, entry] of this.panes) {
      const rect = entry.pane.element.getBoundingClientRect();
      const cssLeft = rect.left - mountRect.left;
      const cssTop = rect.top - mountRect.top;
      const cssWidth = rect.width;
      const cssHeight = rect.height;
      const deviceLeftRaw = useAbsoluteEdgeQuantization
        ? Math.round(rect.left * this.pixelRatio) - mountLeftAbsPx
        : Math.round(cssLeft * cssToDeviceX);
      const deviceTopRaw = useAbsoluteEdgeQuantization
        ? Math.round(rect.top * this.pixelRatio) - mountTopAbsPx
        : Math.round(cssTop * cssToDeviceY);
      const deviceRightRaw = useAbsoluteEdgeQuantization
        ? Math.round(rect.right * this.pixelRatio) - mountLeftAbsPx
        : Math.round((cssLeft + cssWidth) * cssToDeviceX);
      const deviceBottomTopOriginRaw = useAbsoluteEdgeQuantization
        ? Math.round(rect.bottom * this.pixelRatio) - mountTopAbsPx
        : Math.round((cssTop + cssHeight) * cssToDeviceY);
      const deviceLeft = Math.max(0, Math.min(canvasWidth, deviceLeftRaw));
      const deviceTop = Math.max(0, Math.min(canvasHeight, deviceTopRaw));
      const deviceRight = Math.max(0, Math.min(canvasWidth, deviceRightRaw));
      const deviceBottomTopOrigin = Math.max(
        0,
        Math.min(canvasHeight, deviceBottomTopOriginRaw)
      );
      const deviceWidth = Math.max(0, deviceRight - deviceLeft);
      const deviceHeight = Math.max(0, deviceBottomTopOrigin - deviceTop);
      const deviceBottom = Math.max(0, canvasHeight - (deviceTop + deviceHeight));
      const nextRect: SharedScissorPaneRect = {
        cssLeft,
        cssTop,
        cssWidth,
        cssHeight,
        deviceLeft,
        deviceTop,
        deviceBottom,
        deviceWidth,
        deviceHeight
      };
      this.paneRects.set(id, nextRect);
      const key = `${deviceLeft}|${deviceTop}|${deviceWidth}|${deviceHeight}|${cssWidth.toFixed(2)}|${cssHeight.toFixed(2)}`;
      if (key !== entry.lastRectKey) {
        entry.lastRectKey = key;
        entry.pane.onResize?.(nextRect);
      }
    }
  }

  private findPaneAtClientPoint(clientX: number, clientY: number): {
    pane: SharedScissorPane;
    rect: SharedScissorPaneRect;
  } | null {
    for (const entry of this.panes.values()) {
      const rect = this.paneRects.get(entry.pane.id);
      if (!rect) continue;
      const domRect = entry.pane.element.getBoundingClientRect();
      if (
        clientX < domRect.left ||
        clientY < domRect.top ||
        clientX > domRect.right ||
        clientY > domRect.bottom
      ) {
        continue;
      }
      return { pane: entry.pane, rect };
    }
    return null;
  }

  private toPointerEventPayload(
    pane: SharedScissorPane,
    rect: SharedScissorPaneRect,
    event: PointerEvent
  ): SharedPanePointerEvent {
    const domRect = pane.element.getBoundingClientRect();
    return {
      originalEvent: event,
      paneId: pane.id,
      localX: event.clientX - domRect.left,
      localY: event.clientY - domRect.top,
      rect
    };
  }

  private toWheelEventPayload(
    pane: SharedScissorPane,
    rect: SharedScissorPaneRect,
    event: WheelEvent
  ): SharedPaneWheelEvent {
    const domRect = pane.element.getBoundingClientRect();
    return {
      originalEvent: event,
      paneId: pane.id,
      localX: event.clientX - domRect.left,
      localY: event.clientY - domRect.top,
      rect
    };
  }

  private handlePointerDown = (event: PointerEvent): void => {
    this.measurePaneRects();
    const hit = this.findPaneAtClientPoint(event.clientX, event.clientY);
    if (!hit) return;
    this.focusedPaneId = hit.pane.id;
    const consumed = hit.pane.onPointerDown?.(this.toPointerEventPayload(hit.pane, hit.rect, event)) ?? false;
    if (consumed) {
      this.pointerCaptureById.set(event.pointerId, hit.pane.id);
      try {
        this.canvas.setPointerCapture(event.pointerId);
      } catch {
        // no-op
      }
      event.preventDefault();
    }
  };

  private handlePointerMove = (event: PointerEvent): void => {
    this.measurePaneRects();
    const capturedPaneId = this.pointerCaptureById.get(event.pointerId);
    const hit = capturedPaneId
      ? (() => {
          const entry = this.panes.get(capturedPaneId);
          const rect = capturedPaneId ? this.paneRects.get(capturedPaneId) : null;
          return entry && rect ? { pane: entry.pane, rect } : null;
        })()
      : this.findPaneAtClientPoint(event.clientX, event.clientY);
    if (!hit) return;
    const consumed = hit.pane.onPointerMove?.(this.toPointerEventPayload(hit.pane, hit.rect, event)) ?? false;
    if (consumed) {
      event.preventDefault();
    }
  };

  private handlePointerUp = (event: PointerEvent): void => {
    this.measurePaneRects();
    const capturedPaneId = this.pointerCaptureById.get(event.pointerId);
    const hit = capturedPaneId
      ? (() => {
          const entry = this.panes.get(capturedPaneId);
          const rect = capturedPaneId ? this.paneRects.get(capturedPaneId) : null;
          return entry && rect ? { pane: entry.pane, rect } : null;
        })()
      : this.findPaneAtClientPoint(event.clientX, event.clientY);
    if (!hit) {
      this.pointerCaptureById.delete(event.pointerId);
      return;
    }
    const consumed = hit.pane.onPointerUp?.(this.toPointerEventPayload(hit.pane, hit.rect, event)) ?? false;
    this.pointerCaptureById.delete(event.pointerId);
    if (this.canvas.hasPointerCapture(event.pointerId)) {
      try {
        this.canvas.releasePointerCapture(event.pointerId);
      } catch {
        // no-op
      }
    }
    if (consumed) {
      event.preventDefault();
    }
  };

  private handleAuxClick = (event: MouseEvent): void => {
    this.measurePaneRects();
    const hit = this.findPaneAtClientPoint(event.clientX, event.clientY);
    if (!hit) return;
    const consumed =
      hit.pane.onAuxClick?.({
        originalEvent: event as unknown as PointerEvent,
        paneId: hit.pane.id,
        localX: event.clientX - hit.pane.element.getBoundingClientRect().left,
        localY: event.clientY - hit.pane.element.getBoundingClientRect().top,
        rect: hit.rect
      }) ?? false;
    if (consumed) {
      event.preventDefault();
    }
  };

  private handleWheel = (event: WheelEvent): void => {
    this.measurePaneRects();
    const hit = this.findPaneAtClientPoint(event.clientX, event.clientY);
    if (!hit) return;
    const consumed = hit.pane.onWheel?.(this.toWheelEventPayload(hit.pane, hit.rect, event)) ?? false;
    if (consumed) {
      event.preventDefault();
    }
  };

  private handleKeyDown = (event: KeyboardEvent): void => {
    if (!this.focusedPaneId) return;
    const pane = this.panes.get(this.focusedPaneId)?.pane;
    if (!pane?.onKeyDown) return;
    if (pane.onKeyDown(event)) {
      event.preventDefault();
    }
  };

  private handleKeyUp = (event: KeyboardEvent): void => {
    if (!this.focusedPaneId) return;
    const pane = this.panes.get(this.focusedPaneId)?.pane;
    if (!pane?.onKeyUp) return;
    if (pane.onKeyUp(event)) {
      event.preventDefault();
    }
  };
}

function queryMaxBackingSize(gl: WebGLRenderingContext | WebGL2RenderingContext): {
  width: number;
  height: number;
} {
  const viewportDims = gl.getParameter(gl.MAX_VIEWPORT_DIMS) as Int32Array | number[];
  const safeLimit = (value: number): number =>
    Math.max(1, Number.isFinite(value) ? Math.floor(value) : 4096);
  const width = safeLimit(viewportDims[0] ?? 4096);
  const height = safeLimit(viewportDims[1] ?? 4096);
  return { width, height };
}
