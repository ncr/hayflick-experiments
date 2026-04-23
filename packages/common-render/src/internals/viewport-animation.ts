import * as THREE from "three";

/**
 * Exponential approach easing. `rate` is in "inverse seconds" — at rate `r` and
 * a 1-second tick, the output moves `1 - e^-r` of the way to `target`. Returns
 * `current` unchanged when deltaSeconds is non-positive.
 */
export function easeToward(
  current: number,
  target: number,
  rate: number,
  deltaSeconds: number
): number {
  if (deltaSeconds <= 0) {
    return current;
  }
  const blend = 1 - Math.exp(-rate * deltaSeconds);
  return current + (target - current) * blend;
}

/**
 * Animates a fractional `animatedYawTurns` toward the integer `targetYawTurns`.
 * Two regimes:
 * 1. Exponential approach at `rate` (frame-rate independent).
 * 2. Once within `epsilon`, a fixed-duration smoothstep settle that guarantees
 *    we reach the exact integer target — no residual drift.
 */
export class RotationAnimation {
  static readonly SNAP_SETTLE_SECONDS = 0.08;

  animatedYawTurns = 0;
  private snapActive = false;
  private snapFromTurns = 0;
  private snapToTurns = 0;
  private snapElapsedSeconds = 0;

  resetTo(yawTurns: number): void {
    this.animatedYawTurns = yawTurns;
    this.snapActive = false;
    this.snapFromTurns = yawTurns;
    this.snapToTurns = yawTurns;
    this.snapElapsedSeconds = 0;
  }

  advance(
    targetYawTurns: number,
    deltaSeconds: number,
    rate: number,
    epsilon: number
  ): void {
    if (this.snapActive && this.snapToTurns !== targetYawTurns) {
      this.snapActive = false;
    }

    if (this.snapActive) {
      this.snapElapsedSeconds += Math.max(0, deltaSeconds);
      const duration = RotationAnimation.SNAP_SETTLE_SECONDS;
      const tRaw = duration > 0 ? this.snapElapsedSeconds / duration : 1;
      const t = THREE.MathUtils.clamp(tRaw, 0, 1);
      const easedT = t * t * (3 - 2 * t);
      this.animatedYawTurns = THREE.MathUtils.lerp(
        this.snapFromTurns,
        this.snapToTurns,
        easedT
      );
      if (t >= 1) {
        this.animatedYawTurns = this.snapToTurns;
        this.snapActive = false;
      }
      return;
    }

    this.animatedYawTurns = easeToward(
      this.animatedYawTurns,
      targetYawTurns,
      rate,
      deltaSeconds
    );
    const snapEpsilon = Math.min(epsilon, 1e-5);
    if (Math.abs(this.animatedYawTurns - targetYawTurns) <= snapEpsilon) {
      this.snapActive = true;
      this.snapFromTurns = this.animatedYawTurns;
      this.snapToTurns = targetYawTurns;
      this.snapElapsedSeconds = 0;
    }
  }

  cancelSnap(): void {
    this.snapActive = false;
    this.snapFromTurns = this.animatedYawTurns;
    this.snapToTurns = this.animatedYawTurns;
    this.snapElapsedSeconds = 0;
  }
}

export type ZoomAnimationConfig = {
  min: number;
  max: number;
  baseRate: number;
  burstRate: number;
  epsilon: number;
};

/**
 * Animates `current` toward `target` with two rates: a calm base rate and a
 * snappier burst rate used briefly after a zoom-step input so quick flicks feel
 * responsive. `stable` is the clamped value used by render-side math.
 */
export class ZoomAnimation {
  target: number;
  current: number;
  stable: number;
  active = false;
  burstActive = false;

  private burstExpiresAtMs = 0;
  private readonly cfg: ZoomAnimationConfig;

  constructor(cfg: ZoomAnimationConfig, initial: number) {
    this.cfg = cfg;
    const clamped = THREE.MathUtils.clamp(initial, cfg.min, cfg.max);
    this.target = clamped;
    this.current = clamped;
    this.stable = clamped;
  }

  setTarget(next: number): void {
    this.target = THREE.MathUtils.clamp(next, this.cfg.min, this.cfg.max);
    this.active = Math.abs(this.target - this.current) > this.cfg.epsilon;
  }

  snapTo(next: number): void {
    const clamped = THREE.MathUtils.clamp(next, this.cfg.min, this.cfg.max);
    this.target = clamped;
    this.current = clamped;
    this.stable = clamped;
    this.active = false;
    this.burstActive = false;
  }

  startBurst(expiresAtMs: number): void {
    this.burstActive = true;
    this.burstExpiresAtMs = expiresAtMs;
  }

  tickBurstExpiry(nowMs: number): void {
    if (this.burstActive && nowMs > this.burstExpiresAtMs) {
      this.burstActive = false;
    }
  }

  cancelBurst(): void {
    this.burstActive = false;
  }

  advance(deltaSeconds: number): void {
    const rate = this.burstActive ? this.cfg.burstRate : this.cfg.baseRate;
    this.current = easeToward(this.current, this.target, rate, deltaSeconds);
    if (Math.abs(this.current - this.target) <= this.cfg.epsilon) {
      this.current = this.target;
      this.active = false;
    } else {
      this.active = true;
    }
    this.stable = THREE.MathUtils.clamp(this.current, this.cfg.min, this.cfg.max);
  }
}
