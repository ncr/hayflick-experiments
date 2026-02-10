import {
  computeLowResolutionSize,
  computeOrthoHeightForLowResolution,
  computeOutputViewportLayout,
  computeRenderScale,
  computeViewportDeviceSize
} from "./pixel-perfect";

export type ZoomMode = "free" | "safe-ladder";

const SAFE_EPSILON = 1e-6;

export type PanPhaseState = {
  carryX: number;
  carryY: number;
  remainderX: number;
  remainderY: number;
};

export type PanPhaseStep = {
  cameraStepX: number;
  cameraStepY: number;
  state: PanPhaseState;
};

export type PixelControllerCanvasMetrics = {
  rectLeft: number;
  rectTop: number;
  cssToDeviceX: number;
  cssToDeviceY: number;
};

export type PixelControllerPoint = {
  x: number;
  y: number;
};

export type PixelPerfectControllerConfig = {
  minZoom: number;
  maxZoom: number;
  initialZoom: number;
  initialZoomMode?: ZoomMode;
  overscanLowPixels: number;
  baseOrthoHeight: number;
  referenceLowHeight: number;
  maxBackingWidth: number;
  maxBackingHeight: number;
  viewportCssWidth: number;
  viewportCssHeight: number;
  devicePixelRatio: number;
};

export type PixelPerfectControllerState = {
  zoomMode: ZoomMode;
  yawIndex: number;
  devicePixelRatio: number;
  maxUserScale: number;
  userScale: number;
  renderScale: number;
  safeZoomLevels: number[];
  viewportCssWidth: number;
  viewportCssHeight: number;
  viewportDeviceWidth: number;
  viewportDeviceHeight: number;
  lowRenderWidth: number;
  lowRenderHeight: number;
  orthoHeight: number;
  sceneOutputWidth: number;
  sceneOutputHeight: number;
  outputWidth: number;
  outputHeight: number;
  outputPadDeviceX: number;
  outputPadDeviceY: number;
  contentScaleX: number;
  contentScaleY: number;
  contentOffsetX: number;
  contentOffsetY: number;
  renderBaseX: number;
  renderBaseY: number;
  panRemainderX: number;
  panRemainderY: number;
  cumulativePanDeviceX: number;
  cumulativePanDeviceY: number;
};

export function createPanPhaseState(): PanPhaseState {
  return {
    carryX: 0,
    carryY: 0,
    remainderX: 0,
    remainderY: 0
  };
}

export function stepPanPhase(
  state: PanPhaseState,
  rawDeltaX: number,
  rawDeltaY: number,
  renderScale: number
): PanPhaseStep {
  const safeScale = Math.max(1, Math.trunc(renderScale));

  const carryX = state.carryX + rawDeltaX;
  const carryY = state.carryY + rawDeltaY;
  const wholeDeltaX = Math.trunc(carryX);
  const wholeDeltaY = Math.trunc(carryY);

  const nextCarryX = carryX - wholeDeltaX;
  const nextCarryY = carryY - wholeDeltaY;

  const accumulatedX = state.remainderX + wholeDeltaX;
  const accumulatedY = state.remainderY + wholeDeltaY;

  const cameraStepX = Math.trunc(accumulatedX / safeScale);
  const cameraStepY = Math.trunc(accumulatedY / safeScale);

  const remainderX = accumulatedX - cameraStepX * safeScale;
  const remainderY = accumulatedY - cameraStepY * safeScale;

  return {
    cameraStepX,
    cameraStepY,
    state: {
      carryX: nextCarryX,
      carryY: nextCarryY,
      remainderX,
      remainderY
    }
  };
}

export function rescalePanPhaseRemainder(
  remainder: number,
  previousScale: number,
  nextScale: number
): number {
  const safePrevious = Math.max(1, Math.trunc(previousScale));
  const safeNext = Math.max(1, Math.trunc(nextScale));
  return Math.trunc((remainder / safePrevious) * safeNext);
}

export function computeSafeZoomLevels(
  activeDpr: number,
  minZoom: number,
  maxZoom: number
): number[] {
  const safeDpr = Math.max(1e-6, activeDpr);
  const out: number[] = [];
  for (let zoom = Math.ceil(minZoom); zoom <= Math.floor(maxZoom); zoom += 1) {
    const devicePixels = zoom * safeDpr;
    if (Math.abs(devicePixels - Math.round(devicePixels)) <= SAFE_EPSILON) {
      out.push(zoom);
    }
  }
  return out;
}

export function nearestZoomLevel(levels: number[], target: number): number {
  if (levels.length === 0) {
    return Math.round(target);
  }
  let best = levels[0];
  let bestDist = Math.abs(best - target);
  for (let i = 1; i < levels.length; i += 1) {
    const candidate = levels[i];
    const dist = Math.abs(candidate - target);
    if (dist < bestDist) {
      best = candidate;
      bestDist = dist;
    }
  }
  return best;
}

export function stepZoomLevel(
  levels: number[],
  current: number,
  direction: -1 | 1
): number {
  if (levels.length === 0) {
    return current;
  }
  const nearest = nearestZoomLevel(levels, current);
  const index = levels.indexOf(nearest);
  const nextIndex = Math.max(0, Math.min(levels.length - 1, index + direction));
  return levels[nextIndex];
}

export class PixelPerfectController {
  private readonly minZoom: number;
  private readonly maxZoom: number;
  private readonly overscanLowPixels: number;
  private readonly baseOrthoHeight: number;
  private readonly referenceLowHeight: number;
  private readonly maxBackingWidth: number;
  private readonly maxBackingHeight: number;

  private zoomMode: ZoomMode;
  private yawIndex = 0;
  private devicePixelRatio: number;
  private viewportCssWidth: number;
  private viewportCssHeight: number;
  private viewportDeviceWidth = 1;
  private viewportDeviceHeight = 1;
  private maxUserScale: number;
  private userScale: number;
  private renderScale = 1;
  private safeZoomLevels: number[] = [];
  private lowRenderWidth = 1;
  private lowRenderHeight = 1;
  private orthoHeight: number;
  private sceneOutputWidth = 1;
  private sceneOutputHeight = 1;
  private outputWidth = 1;
  private outputHeight = 1;
  private outputPadDeviceX = 0;
  private outputPadDeviceY = 0;
  private contentScaleX = 1;
  private contentScaleY = 1;
  private contentOffsetX = 0;
  private contentOffsetY = 0;
  private renderBaseX = 0;
  private renderBaseY = 0;
  private panPhase = createPanPhaseState();
  private cumulativePanDeviceX = 0;
  private cumulativePanDeviceY = 0;

  constructor(config: PixelPerfectControllerConfig) {
    this.minZoom = config.minZoom;
    this.maxZoom = config.maxZoom;
    this.overscanLowPixels = config.overscanLowPixels;
    this.baseOrthoHeight = config.baseOrthoHeight;
    this.referenceLowHeight = config.referenceLowHeight;
    this.maxBackingWidth = Math.max(1, Math.floor(config.maxBackingWidth));
    this.maxBackingHeight = Math.max(1, Math.floor(config.maxBackingHeight));
    this.zoomMode = config.initialZoomMode ?? "free";
    this.viewportCssWidth = Math.max(1, config.viewportCssWidth);
    this.viewportCssHeight = Math.max(1, config.viewportCssHeight);
    this.devicePixelRatio = Math.max(1, config.devicePixelRatio);
    this.maxUserScale = Math.floor(this.maxZoom);
    this.userScale = clamp(config.initialZoom, this.minZoom, this.maxZoom);
    this.orthoHeight = this.baseOrthoHeight;
    this.recomputeLayout();
  }

  resize(cssWidth: number, cssHeight: number, dpr: number): void {
    const nextCssWidth = Math.max(1, cssWidth);
    const nextCssHeight = Math.max(1, cssHeight);
    const previousDpr = this.devicePixelRatio;
    const nextDpr = Math.max(1, dpr);

    this.viewportCssWidth = nextCssWidth;
    this.viewportCssHeight = nextCssHeight;

    if (Math.abs(nextDpr - previousDpr) > 1e-9) {
      const inputRatio = nextDpr / previousDpr;
      this.panPhase = {
        ...this.panPhase,
        carryX: this.panPhase.carryX * inputRatio,
        carryY: this.panPhase.carryY * inputRatio
      };
      this.devicePixelRatio = nextDpr;
    }

    this.recomputeLayout();
  }

  setZoomMode(mode: ZoomMode): boolean {
    if (this.zoomMode === mode) {
      return false;
    }
    this.zoomMode = mode;
    this.recomputeLayout();
    return true;
  }

  toggleZoomMode(): ZoomMode {
    this.zoomMode = this.zoomMode === "free" ? "safe-ladder" : "free";
    this.recomputeLayout();
    return this.zoomMode;
  }

  setUserScale(scale: number): boolean {
    const next = clamp(scale, this.minZoom, this.maxUserScale);
    if (Math.abs(next - this.userScale) <= 1e-9) {
      return false;
    }
    this.userScale = next;
    this.recomputeLayout();
    return true;
  }

  stepZoom(direction: -1 | 1): boolean {
    let nextZoom = this.userScale;
    if (this.zoomMode === "safe-ladder" && this.safeZoomLevels.length > 0) {
      nextZoom = stepZoomLevel(this.safeZoomLevels, this.userScale, direction);
    } else {
      nextZoom = clamp(this.userScale + direction, this.minZoom, this.maxUserScale);
    }
    if (Math.abs(nextZoom - this.userScale) <= 1e-9) {
      return false;
    }
    this.userScale = nextZoom;
    this.recomputeLayout();
    return true;
  }

  rotateQuarterTurns(step: -1 | 1): number {
    this.yawIndex += step;
    return this.yawIndex;
  }

  getYawIndex(): number {
    return this.yawIndex;
  }

  resetPanCarry(): void {
    if (this.panPhase.carryX === 0 && this.panPhase.carryY === 0) {
      return;
    }
    this.panPhase = {
      ...this.panPhase,
      carryX: 0,
      carryY: 0
    };
  }

  panByDevice(deltaDeviceX: number, deltaDeviceY: number): PanPhaseStep {
    const previousRemainderX = this.panPhase.remainderX;
    const previousRemainderY = this.panPhase.remainderY;
    const next = stepPanPhase(
      this.panPhase,
      deltaDeviceX,
      deltaDeviceY,
      this.renderScale
    );
    this.panPhase = next.state;
    this.cumulativePanDeviceX +=
      next.cameraStepX * this.renderScale +
      this.panPhase.remainderX -
      previousRemainderX;
    this.cumulativePanDeviceY +=
      next.cameraStepY * this.renderScale +
      this.panPhase.remainderY -
      previousRemainderY;
    return next;
  }

  panByCss(
    deltaCssX: number,
    deltaCssY: number,
    cssToDeviceX: number,
    cssToDeviceY: number
  ): PanPhaseStep {
    return this.panByDevice(deltaCssX * cssToDeviceX, deltaCssY * cssToDeviceY);
  }

  getScenePointFromClient(
    clientX: number,
    clientY: number,
    metrics: PixelControllerCanvasMetrics
  ): PixelControllerPoint | null {
    if (
      !Number.isFinite(metrics.cssToDeviceX) ||
      !Number.isFinite(metrics.cssToDeviceY) ||
      metrics.cssToDeviceX <= 0 ||
      metrics.cssToDeviceY <= 0
    ) {
      return null;
    }
    const deviceX = (clientX - metrics.rectLeft) * metrics.cssToDeviceX;
    const deviceY = (clientY - metrics.rectTop) * metrics.cssToDeviceY;
    const renderStartX = this.renderBaseX + this.panPhase.remainderX;
    const renderStartY = this.renderBaseY + this.panPhase.remainderY;
    const localRenderX = deviceX - (renderStartX + this.outputPadDeviceX);
    const localRenderY = deviceY - (renderStartY + this.outputPadDeviceY);
    if (
      localRenderX < 0 ||
      localRenderY < 0 ||
      localRenderX > this.sceneOutputWidth ||
      localRenderY > this.sceneOutputHeight
    ) {
      return null;
    }
    return {
      x: localRenderX / this.sceneOutputWidth,
      y: localRenderY / this.sceneOutputHeight
    };
  }

  getClientPointFromScene(
    sceneX: number,
    sceneY: number,
    metrics: PixelControllerCanvasMetrics
  ): PixelControllerPoint | null {
    if (
      !Number.isFinite(metrics.cssToDeviceX) ||
      !Number.isFinite(metrics.cssToDeviceY) ||
      metrics.cssToDeviceX <= 0 ||
      metrics.cssToDeviceY <= 0
    ) {
      return null;
    }

    const deviceX =
      this.renderBaseX +
      this.panPhase.remainderX +
      this.outputPadDeviceX +
      sceneX * this.sceneOutputWidth;
    const deviceY =
      this.renderBaseY +
      this.panPhase.remainderY +
      this.outputPadDeviceY +
      sceneY * this.sceneOutputHeight;

    return {
      x: metrics.rectLeft + deviceX / metrics.cssToDeviceX,
      y: metrics.rectTop + deviceY / metrics.cssToDeviceY
    };
  }

  getRenderViewport(canvasDeviceHeight: number): {
    x: number;
    y: number;
    width: number;
    height: number;
  } {
    const renderLeft = this.renderBaseX + this.panPhase.remainderX;
    const renderTop = this.renderBaseY + this.panPhase.remainderY;
    const renderBottom = canvasDeviceHeight - (renderTop + this.outputHeight);
    return {
      x: renderLeft,
      y: renderBottom,
      width: this.outputWidth,
      height: this.outputHeight
    };
  }

  getState(): PixelPerfectControllerState {
    return {
      zoomMode: this.zoomMode,
      yawIndex: this.yawIndex,
      devicePixelRatio: this.devicePixelRatio,
      maxUserScale: this.maxUserScale,
      userScale: this.userScale,
      renderScale: this.renderScale,
      safeZoomLevels: [...this.safeZoomLevels],
      viewportCssWidth: this.viewportCssWidth,
      viewportCssHeight: this.viewportCssHeight,
      viewportDeviceWidth: this.viewportDeviceWidth,
      viewportDeviceHeight: this.viewportDeviceHeight,
      lowRenderWidth: this.lowRenderWidth,
      lowRenderHeight: this.lowRenderHeight,
      orthoHeight: this.orthoHeight,
      sceneOutputWidth: this.sceneOutputWidth,
      sceneOutputHeight: this.sceneOutputHeight,
      outputWidth: this.outputWidth,
      outputHeight: this.outputHeight,
      outputPadDeviceX: this.outputPadDeviceX,
      outputPadDeviceY: this.outputPadDeviceY,
      contentScaleX: this.contentScaleX,
      contentScaleY: this.contentScaleY,
      contentOffsetX: this.contentOffsetX,
      contentOffsetY: this.contentOffsetY,
      renderBaseX: this.renderBaseX,
      renderBaseY: this.renderBaseY,
      panRemainderX: this.panPhase.remainderX,
      panRemainderY: this.panPhase.remainderY,
      cumulativePanDeviceX: this.cumulativePanDeviceX,
      cumulativePanDeviceY: this.cumulativePanDeviceY
    };
  }

  private recomputeLayout(): void {
    const viewport = computeViewportDeviceSize(
      this.viewportCssWidth,
      this.viewportCssHeight,
      this.devicePixelRatio,
      this.maxBackingWidth,
      this.maxBackingHeight
    );
    this.viewportDeviceWidth = viewport.width;
    this.viewportDeviceHeight = viewport.height;

    this.maxUserScale = this.computeMaxUserScale();
    this.safeZoomLevels = computeSafeZoomLevels(
      this.devicePixelRatio,
      this.minZoom,
      this.maxUserScale
    );

    if (this.zoomMode === "safe-ladder") {
      if (this.safeZoomLevels.length === 0) {
        this.zoomMode = "free";
      } else {
        this.userScale = nearestZoomLevel(this.safeZoomLevels, this.userScale);
      }
    }
    this.userScale = clamp(this.userScale, this.minZoom, this.maxUserScale);

    const nextRenderScale = computeRenderScale(this.userScale, this.devicePixelRatio);
    if (this.renderScale > 0 && nextRenderScale !== this.renderScale) {
      this.panPhase = {
        ...this.panPhase,
        remainderX: rescalePanPhaseRemainder(
          this.panPhase.remainderX,
          this.renderScale,
          nextRenderScale
        ),
        remainderY: rescalePanPhaseRemainder(
          this.panPhase.remainderY,
          this.renderScale,
          nextRenderScale
        )
      };
    }
    this.renderScale = nextRenderScale;

    const baseScale = Math.max(1, computeRenderScale(1, this.devicePixelRatio));
    const lowResolution = computeLowResolutionSize(
      this.viewportDeviceWidth,
      this.viewportDeviceHeight,
      baseScale
    );
    this.lowRenderWidth = lowResolution.width;
    this.lowRenderHeight = lowResolution.height;

    const layout = computeOutputViewportLayout(
      this.lowRenderWidth,
      this.lowRenderHeight,
      this.renderScale,
      this.overscanLowPixels
    );
    this.sceneOutputWidth = layout.sceneWidth;
    this.sceneOutputHeight = layout.sceneHeight;
    this.outputWidth = layout.outputWidth;
    this.outputHeight = layout.outputHeight;
    this.outputPadDeviceX = layout.outputPadX;
    this.outputPadDeviceY = layout.outputPadY;
    this.contentScaleX = layout.contentScaleX;
    this.contentScaleY = layout.contentScaleY;
    this.contentOffsetX = layout.contentOffsetX;
    this.contentOffsetY = layout.contentOffsetY;
    this.renderBaseX = Math.floor((this.viewportDeviceWidth - this.outputWidth) * 0.5);
    this.renderBaseY = Math.floor((this.viewportDeviceHeight - this.outputHeight) * 0.5);

    this.orthoHeight = computeOrthoHeightForLowResolution(
      this.baseOrthoHeight,
      this.lowRenderHeight,
      this.referenceLowHeight
    );
  }

  private computeMaxUserScale(): number {
    const safeMinZoom = Math.ceil(this.minZoom);
    const safeMaxZoom = Math.floor(this.maxZoom);
    const baseScale = Math.max(1, computeRenderScale(1, this.devicePixelRatio));
    const lowResolution = computeLowResolutionSize(
      this.viewportDeviceWidth,
      this.viewportDeviceHeight,
      baseScale
    );

    let best = safeMinZoom;
    for (let zoom = safeMinZoom; zoom <= safeMaxZoom; zoom += 1) {
      const candidateScale = computeRenderScale(zoom, this.devicePixelRatio);
      const candidateLayout = computeOutputViewportLayout(
        lowResolution.width,
        lowResolution.height,
        candidateScale,
        this.overscanLowPixels
      );
      if (
        candidateLayout.outputWidth <= this.maxBackingWidth &&
        candidateLayout.outputHeight <= this.maxBackingHeight
      ) {
        best = zoom;
      } else {
        break;
      }
    }

    return Math.max(safeMinZoom, Math.min(safeMaxZoom, best));
  }
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return min;
  }
  return Math.max(min, Math.min(max, value));
}
