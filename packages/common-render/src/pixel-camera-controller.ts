import * as THREE from "three";

export type PixelCameraControllerConfig = {
  zoomMin: number;
  zoomMax: number;
  zoomStep: number;
  rotationAnimationRate: number;
  rotationAnimationEpsilon: number;
  zoomAnimationRate: number;
  zoomAnimationBurstRate: number;
  zoomAnimationEpsilon: number;
  zoomBurstIdleMs: number;
  zoomAnchorMaxCorrectionCss: number;
};

export type PixelCameraControllerUpdateHooks = {
  projectWorldToClient: (world: THREE.Vector3, out: THREE.Vector2) => boolean;
  applyPanByPixels: (deltaX: number, deltaY: number) => void;
};

export type PixelCameraControllerWheelHooks = {
  worldAtClient: (
    clientX: number,
    clientY: number,
    out: THREE.Vector3
  ) => boolean;
};

export class PixelCameraController {
  private readonly config: PixelCameraControllerConfig;
  private readonly zoomAnchorClient = new THREE.Vector2();
  private readonly zoomAnchorWorld = new THREE.Vector3();
  private readonly projectedClient = new THREE.Vector2();
  private zoomAnchorActive = false;
  private zoomAnimationActive = false;
  private zoomBurstActive = false;
  private zoomBurstExpiresAtMs = 0;
  private yawIndex = 0;
  private animatedYawTurns = 0;
  private zoomTarget = 1;
  private zoomCurrent = 1;

  constructor(config: PixelCameraControllerConfig) {
    this.config = config;
  }

  getYawIndex(): number {
    return this.yawIndex;
  }

  getAnimatedYawTurns(): number {
    return this.animatedYawTurns;
  }

  getZoomTarget(): number {
    return this.zoomTarget;
  }

  getZoomCurrent(): number {
    return this.zoomCurrent;
  }

  reset(): void {
    this.yawIndex = 0;
    this.animatedYawTurns = 0;
    this.zoomTarget = 1;
    this.zoomCurrent = 1;
    this.zoomAnimationActive = false;
    this.zoomBurstActive = false;
    this.zoomAnchorActive = false;
    this.zoomBurstExpiresAtMs = 0;
  }

  cancelZoomAnchor(): void {
    this.zoomAnchorActive = false;
  }

  rotateQuarterTurns(delta: -1 | 1): void {
    this.zoomAnchorActive = false;
    this.yawIndex += delta;
  }

  handleWheelZoom(
    deltaY: number,
    clientX: number,
    clientY: number,
    nowMs: number,
    hooks: PixelCameraControllerWheelHooks
  ): boolean {
    const direction = deltaY > 0 ? -1 : 1;
    const nextZoom = THREE.MathUtils.clamp(
      this.zoomTarget + direction * this.config.zoomStep,
      this.config.zoomMin,
      this.config.zoomMax
    );
    if (Math.abs(nextZoom - this.zoomTarget) <= 1e-6) {
      return false;
    }

    this.zoomAnchorClient.set(clientX, clientY);
    if (hooks.worldAtClient(clientX, clientY, this.zoomAnchorWorld)) {
      this.zoomAnchorActive = true;
    } else {
      this.zoomAnchorActive = false;
    }

    this.zoomTarget = nextZoom;
    this.zoomAnimationActive =
      Math.abs(this.zoomTarget - this.zoomCurrent) >
      this.config.zoomAnimationEpsilon;
    this.zoomBurstActive = true;
    this.zoomBurstExpiresAtMs = nowMs + this.config.zoomBurstIdleMs;
    return true;
  }

  update(
    deltaSeconds: number,
    nowMs: number,
    hooks: PixelCameraControllerUpdateHooks
  ): void {
    const yawBlend = 1 - Math.exp(-this.config.rotationAnimationRate * deltaSeconds);
    this.animatedYawTurns += (this.yawIndex - this.animatedYawTurns) * yawBlend;
    if (
      Math.abs(this.animatedYawTurns - this.yawIndex) <=
      this.config.rotationAnimationEpsilon
    ) {
      this.animatedYawTurns = this.yawIndex;
    }

    const zoomRate = this.zoomBurstActive
      ? this.config.zoomAnimationBurstRate
      : this.config.zoomAnimationRate;
    const zoomBlend = 1 - Math.exp(-zoomRate * deltaSeconds);
    this.zoomCurrent += (this.zoomTarget - this.zoomCurrent) * zoomBlend;
    if (
      Math.abs(this.zoomCurrent - this.zoomTarget) <=
      this.config.zoomAnimationEpsilon
    ) {
      this.zoomCurrent = this.zoomTarget;
      this.zoomAnimationActive = false;
    } else {
      this.zoomAnimationActive = true;
    }

    if (this.zoomBurstActive && nowMs > this.zoomBurstExpiresAtMs) {
      this.zoomBurstActive = false;
    }

    if (!this.zoomAnchorActive) {
      return;
    }
    if (!hooks.projectWorldToClient(this.zoomAnchorWorld, this.projectedClient)) {
      this.zoomAnchorActive = false;
      return;
    }
    const rawCorrectionX = this.zoomAnchorClient.x - this.projectedClient.x;
    const rawCorrectionY = this.zoomAnchorClient.y - this.projectedClient.y;
    if (
      Math.abs(rawCorrectionX) < 0.75 &&
      Math.abs(rawCorrectionY) < 0.75 &&
      !this.zoomAnimationActive
    ) {
      this.zoomAnchorActive = false;
      return;
    }
    hooks.applyPanByPixels(
      THREE.MathUtils.clamp(
        rawCorrectionX,
        -this.config.zoomAnchorMaxCorrectionCss,
        this.config.zoomAnchorMaxCorrectionCss
      ),
      THREE.MathUtils.clamp(
        rawCorrectionY,
        -this.config.zoomAnchorMaxCorrectionCss,
        this.config.zoomAnchorMaxCorrectionCss
      )
    );
  }
}
