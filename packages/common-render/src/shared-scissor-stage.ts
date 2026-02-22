import * as THREE from "three";
import { queryMaxBackingSize } from "./gl-caps";

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

export type SharedScissorPaneHit = {
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
    const computedMountStyle = window.getComputedStyle(this.mount);

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
    this.canvas.style.zIndex = "0";

    // Respect CSS-positioned mounts (e.g. absolute scissor canvas overlays) and only
    // force a positioning context when the computed position is still static.
    if (!this.mount.style.position && computedMountStyle.position === "static") {
      this.mount.style.position = "relative";
    }
    this.mount.style.overflow = this.mount.style.overflow || "hidden";
    this.mount.appendChild(this.canvas);

    const caps = queryMaxBackingSize(this.renderer.getContext());
    this.maxBackingWidth = caps.width;
    this.maxBackingHeight = caps.height;

    this.resize(Math.max(1, config.width), Math.max(1, config.height), this.pixelRatio);

    this.resizeObserver = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      this.resize(
        entry.contentRect.width,
        entry.contentRect.height,
        Math.max(1, window.devicePixelRatio || 1)
      );
    });
    this.resizeObserver.observe(this.mount);
  }

  registerPane(pane: SharedScissorPane): void {
    if (this.panes.has(pane.id)) {
      throw new Error(`SharedScissorStage duplicate pane id: ${pane.id}`);
    }
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

  drawFrame(nowMs: number, deltaSeconds: number): void {
    this.draw(nowMs, deltaSeconds);
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

  hitTestPane(clientX: number, clientY: number): SharedScissorPaneHit | null {
    this.measurePaneRects();
    const hit = this.findPaneAtClientPoint(clientX, clientY);
    if (!hit) {
      return null;
    }
    const domRect = hit.pane.element.getBoundingClientRect();
    return {
      paneId: hit.pane.id,
      localX: clientX - domRect.left,
      localY: clientY - domRect.top,
      rect: hit.rect
    };
  }

  getDevicePixelRatio(): number {
    return this.pixelRatio;
  }

  dispose(): void {
    this.stop();
    this.resizeObserver.disconnect();
    for (const entry of this.panes.values()) {
      entry.pane.dispose?.();
    }
    this.panes.clear();
    this.paneRects.clear();
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
}
