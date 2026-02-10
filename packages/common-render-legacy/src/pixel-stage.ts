import * as THREE from "three";

export type PixelStageOptions = {
  mount: HTMLElement;
  width: number;
  height: number;
  antialias?: boolean;
  pixelRatio?: number;
  clearColor?: number;
  clearAlpha?: number;
  mountPosition?: string;
  mountBackground?: string;
  mountOverflow?: string;
  canvasPosition?: string;
  canvasLeft?: string;
  canvasTop?: string;
  canvasDisplay?: string;
  canvasBackground?: string;
  canvasImageRendering?: string;
  canvasTransformOrigin?: string;
  initialCursor?: string;
};

export type PixelStageLayout = {
  deviceWidth: number;
  deviceHeight: number;
  cssWidth: number;
  cssHeight: number;
  left?: number;
  top?: number;
};

export type PixelStageMetrics = {
  rect: DOMRect;
  cssToDeviceX: number;
  cssToDeviceY: number;
};

type SavedStyle = {
  position: string;
  background: string;
  overflow: string;
};

type SavedCanvasStyle = {
  position: string;
  left: string;
  top: string;
  display: string;
  background: string;
  imageRendering: string;
  transformOrigin: string;
  cursor: string;
};

export class PixelStage {
  readonly mount: HTMLElement;
  readonly renderer: THREE.WebGLRenderer;
  readonly canvas: HTMLCanvasElement;
  readonly maxBackingWidth: number;
  readonly maxBackingHeight: number;

  private readonly savedMountStyle: SavedStyle;
  private readonly savedCanvasStyle: SavedCanvasStyle;
  private resizeObserver: ResizeObserver | null = null;
  private disposed = false;

  constructor(options: PixelStageOptions) {
    this.mount = options.mount;
    this.savedMountStyle = {
      position: this.mount.style.position,
      background: this.mount.style.background,
      overflow: this.mount.style.overflow
    };

    this.renderer = new THREE.WebGLRenderer({
      antialias: options.antialias ?? false
    });
    this.canvas = this.renderer.domElement;
    this.savedCanvasStyle = {
      position: this.canvas.style.position,
      left: this.canvas.style.left,
      top: this.canvas.style.top,
      display: this.canvas.style.display,
      background: this.canvas.style.background,
      imageRendering: this.canvas.style.imageRendering,
      transformOrigin: this.canvas.style.transformOrigin,
      cursor: this.canvas.style.cursor
    };

    this.renderer.setPixelRatio(options.pixelRatio ?? 1);
    this.renderer.setSize(options.width, options.height, true);
    if (options.clearColor !== undefined) {
      this.renderer.setClearColor(options.clearColor, options.clearAlpha ?? 1);
    }

    this.mount.style.position = options.mountPosition ?? "relative";
    if (options.mountBackground !== undefined) {
      this.mount.style.background = options.mountBackground;
    }
    if (options.mountOverflow !== undefined) {
      this.mount.style.overflow = options.mountOverflow;
    }

    this.canvas.style.position = options.canvasPosition ?? "absolute";
    this.canvas.style.left = options.canvasLeft ?? "0px";
    this.canvas.style.top = options.canvasTop ?? "0px";
    this.canvas.style.display = options.canvasDisplay ?? "block";
    if (options.canvasBackground !== undefined) {
      this.canvas.style.background = options.canvasBackground;
    }
    if (options.canvasImageRendering !== undefined) {
      this.canvas.style.imageRendering = options.canvasImageRendering;
    }
    if (options.canvasTransformOrigin !== undefined) {
      this.canvas.style.transformOrigin = options.canvasTransformOrigin;
    }
    if (options.initialCursor !== undefined) {
      this.canvas.style.cursor = options.initialCursor;
    }
    this.mount.appendChild(this.canvas);

    const caps = queryMaxBackingSize(this.renderer.getContext());
    this.maxBackingWidth = caps.width;
    this.maxBackingHeight = caps.height;
  }

  applyLayout(layout: PixelStageLayout): void {
    const deviceWidth = Math.max(1, Math.floor(layout.deviceWidth));
    const deviceHeight = Math.max(1, Math.floor(layout.deviceHeight));
    const cssWidth = Math.max(1, layout.cssWidth);
    const cssHeight = Math.max(1, layout.cssHeight);
    const left = layout.left ?? 0;
    const top = layout.top ?? 0;

    this.renderer.setSize(deviceWidth, deviceHeight, false);
    this.canvas.style.width = `${cssWidth}px`;
    this.canvas.style.height = `${cssHeight}px`;
    this.canvas.style.left = `${left}px`;
    this.canvas.style.top = `${top}px`;
  }

  observeResize(onResize: (width: number, height: number) => void): void {
    this.disconnectResizeObserver();
    this.resizeObserver = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) {
        return;
      }
      onResize(entry.contentRect.width, entry.contentRect.height);
    });
    this.resizeObserver.observe(this.mount);
  }

  getCanvasMetrics(): PixelStageMetrics | null {
    const rect = this.canvas.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) {
      return null;
    }
    const cssToDeviceX = this.canvas.width / rect.width;
    const cssToDeviceY = this.canvas.height / rect.height;
    if (
      !Number.isFinite(cssToDeviceX) ||
      !Number.isFinite(cssToDeviceY) ||
      cssToDeviceX <= 0 ||
      cssToDeviceY <= 0
    ) {
      return null;
    }
    return { rect, cssToDeviceX, cssToDeviceY };
  }

  setCursor(cursor: string): void {
    this.canvas.style.cursor = cursor;
  }

  clearCursor(): void {
    this.canvas.style.cursor = "";
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.disconnectResizeObserver();
    this.canvas.style.position = this.savedCanvasStyle.position;
    this.canvas.style.left = this.savedCanvasStyle.left;
    this.canvas.style.top = this.savedCanvasStyle.top;
    this.canvas.style.display = this.savedCanvasStyle.display;
    this.canvas.style.background = this.savedCanvasStyle.background;
    this.canvas.style.imageRendering = this.savedCanvasStyle.imageRendering;
    this.canvas.style.transformOrigin = this.savedCanvasStyle.transformOrigin;
    this.canvas.style.cursor = this.savedCanvasStyle.cursor;
    if (this.canvas.parentElement === this.mount) {
      this.mount.removeChild(this.canvas);
    }
    this.mount.style.position = this.savedMountStyle.position;
    this.mount.style.background = this.savedMountStyle.background;
    this.mount.style.overflow = this.savedMountStyle.overflow;
    this.renderer.dispose();
  }

  private disconnectResizeObserver(): void {
    if (!this.resizeObserver) {
      return;
    }
    this.resizeObserver.disconnect();
    this.resizeObserver = null;
  }
}

function queryMaxBackingSize(gl: WebGLRenderingContext | WebGL2RenderingContext): {
  width: number;
  height: number;
} {
  const viewportDims = gl.getParameter(gl.MAX_VIEWPORT_DIMS) as
    | Int32Array
    | number[];
  const safeLimit = (value: number): number =>
    Number.isFinite(value) && value > 0 ? value : 8192;

  return {
    width: Math.max(
      1,
      Math.floor(
        Math.min(
          safeLimit(Number(viewportDims?.[0] ?? 0)),
          safeLimit(Number(gl.getParameter(gl.MAX_RENDERBUFFER_SIZE) ?? 0)),
          safeLimit(Number(gl.getParameter(gl.MAX_TEXTURE_SIZE) ?? 0))
        )
      )
    ),
    height: Math.max(
      1,
      Math.floor(
        Math.min(
          safeLimit(Number(viewportDims?.[1] ?? 0)),
          safeLimit(Number(gl.getParameter(gl.MAX_RENDERBUFFER_SIZE) ?? 0)),
          safeLimit(Number(gl.getParameter(gl.MAX_TEXTURE_SIZE) ?? 0))
        )
      )
    )
  };
}
