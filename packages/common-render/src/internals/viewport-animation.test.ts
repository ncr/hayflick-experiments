import { describe, expect, it } from "vitest";
import {
  easeToward,
  RotationAnimation,
  ZoomAnimation
} from "./viewport-animation";

describe("easeToward", () => {
  it("returns current unchanged when deltaSeconds is zero or negative", () => {
    expect(easeToward(5, 10, 4, 0)).toBe(5);
    expect(easeToward(5, 10, 4, -0.1)).toBe(5);
  });

  it("moves current toward target monotonically", () => {
    const rate = 8;
    const dt = 1 / 60;
    let v = 0;
    for (let i = 0; i < 60; i++) {
      const next = easeToward(v, 1, rate, dt);
      expect(next).toBeGreaterThanOrEqual(v);
      expect(next).toBeLessThanOrEqual(1);
      v = next;
    }
    expect(v).toBeGreaterThan(0.5);
  });

  it("approaches target asymptotically without overshoot", () => {
    let v = 0;
    for (let i = 0; i < 10000; i++) {
      v = easeToward(v, 1, 20, 1 / 60);
    }
    expect(v).toBeCloseTo(1, 6);
    expect(v).toBeLessThanOrEqual(1);
  });
});

describe("RotationAnimation", () => {
  it("starts at 0 and resetTo sets both the animated value and snap state", () => {
    const r = new RotationAnimation();
    expect(r.animatedYawTurns).toBe(0);
    r.resetTo(3);
    expect(r.animatedYawTurns).toBe(3);
  });

  it("eases toward the target yaw over many frames", () => {
    const r = new RotationAnimation();
    for (let i = 0; i < 30; i++) {
      r.advance(1, 1 / 60, 16, 1e-3);
    }
    expect(r.animatedYawTurns).toBeGreaterThan(0.5);
    expect(r.animatedYawTurns).toBeLessThanOrEqual(1);
  });

  it("snaps exactly onto the integer target after it gets close", () => {
    const r = new RotationAnimation();
    r.resetTo(0);
    for (let i = 0; i < 600; i++) {
      r.advance(1, 1 / 60, 16, 1e-3);
    }
    expect(r.animatedYawTurns).toBe(1);
  });

  it("cancelSnap lets a new target be pursued from the current interpolated value", () => {
    const r = new RotationAnimation();
    for (let i = 0; i < 5; i++) {
      r.advance(1, 1 / 60, 16, 1e-3);
    }
    const partway = r.animatedYawTurns;
    r.cancelSnap();
    // A single zero-time advance toward a new target must not change the value.
    r.advance(-1, 0, 16, 1e-3);
    expect(r.animatedYawTurns).toBe(partway);
  });
});

describe("ZoomAnimation", () => {
  const cfg = { min: 1, max: 8, baseRate: 12, burstRate: 48, epsilon: 0.01 };

  it("clamps the initial value into [min,max]", () => {
    const z = new ZoomAnimation(cfg, 20);
    expect(z.current).toBe(8);
    expect(z.target).toBe(8);
    expect(z.stable).toBe(8);
  });

  it("setTarget sets active when outside epsilon, clears otherwise", () => {
    const z = new ZoomAnimation(cfg, 1);
    z.setTarget(2);
    expect(z.target).toBe(2);
    expect(z.active).toBe(true);
    z.setTarget(1);
    expect(z.active).toBe(false);
  });

  it("snapTo collapses target/current/stable and clears active/burst", () => {
    const z = new ZoomAnimation(cfg, 1);
    z.startBurst(1000);
    z.setTarget(4);
    z.snapTo(3);
    expect(z.target).toBe(3);
    expect(z.current).toBe(3);
    expect(z.stable).toBe(3);
    expect(z.active).toBe(false);
    expect(z.burstActive).toBe(false);
  });

  it("advance moves current toward target and marks inactive when settled", () => {
    const z = new ZoomAnimation(cfg, 1);
    z.setTarget(4);
    for (let i = 0; i < 1000; i++) {
      z.advance(1 / 60);
    }
    expect(z.current).toBe(4);
    expect(z.active).toBe(false);
  });

  it("tickBurstExpiry clears the burst once past the expiry time", () => {
    const z = new ZoomAnimation(cfg, 1);
    z.startBurst(500);
    z.tickBurstExpiry(100);
    expect(z.burstActive).toBe(true);
    z.tickBurstExpiry(600);
    expect(z.burstActive).toBe(false);
  });

  it("burst rate settles faster than base rate for the same target change", () => {
    const baseZ = new ZoomAnimation(cfg, 1);
    const burstZ = new ZoomAnimation(cfg, 1);
    baseZ.setTarget(4);
    burstZ.setTarget(4);
    burstZ.startBurst(10000);
    for (let i = 0; i < 10; i++) {
      baseZ.advance(1 / 60);
      burstZ.advance(1 / 60);
    }
    expect(burstZ.current).toBeGreaterThan(baseZ.current);
  });

  it("cancelBurst clears the burst flag immediately", () => {
    const z = new ZoomAnimation(cfg, 1);
    z.startBurst(1000);
    z.cancelBurst();
    expect(z.burstActive).toBe(false);
  });
});
