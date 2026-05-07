import { describe, expect, it } from "vitest";
import {
  IsoCoreDefaults,
  PixelPerfectDefaults,
  resolvePixelPerfectTuning,
  resolveLockedView,
  type IsoCoreTuning,
  type IsoGameViewTuning
} from "../pixel-perfect-types";
import {
  ISO_VIEW_CONTRACT,
  TOPDOWN_VIEW_CONTRACT,
  SIDE_VIEW_CONTRACT
} from "../iso-contract";

describe("PixelPerfectDefaults (locked IsoGameView tuning)", () => {
  it("freezes to prevent accidental mutation", () => {
    expect(Object.isFrozen(PixelPerfectDefaults)).toBe(true);
  });

  it("does NOT expose scale fields (locked, sourced from per-view contract)", () => {
    expect("fixedRenderHeight" in PixelPerfectDefaults).toBe(false);
    expect("baseOrthoHeight" in PixelPerfectDefaults).toBe(false);
    expect("cameraYaw" in PixelPerfectDefaults).toBe(false);
  });

  it("uses canonical iso-2:1 view + yawIndex = 0", () => {
    expect(PixelPerfectDefaults.cameraPitch).toBe("iso-2to1");
    expect(PixelPerfectDefaults.yawIndex).toBe(0);
  });

  it("enables 4x MSAA by default", () => {
    expect(PixelPerfectDefaults.lowTargetSamples).toBe(4);
  });

  it("enables smooth pixel transitions by default", () => {
    expect(PixelPerfectDefaults.smoothPixelTransitions).toBe(true);
  });
});

describe("IsoCoreDefaults (lower-level, configurable tuning)", () => {
  it("freezes to prevent accidental mutation", () => {
    expect(Object.isFrozen(IsoCoreDefaults)).toBe(true);
  });

  it("sources iso scale from ISO_VIEW_CONTRACT", () => {
    expect(IsoCoreDefaults.fixedRenderHeight).toBe(ISO_VIEW_CONTRACT.referenceLowHeight);
    expect(IsoCoreDefaults.baseOrthoHeight).toBe(ISO_VIEW_CONTRACT.baseOrthoHeight);
    expect(IsoCoreDefaults.cameraYaw).toBe(ISO_VIEW_CONTRACT.baseYaw);
  });

  it("yields R = 32·√2 → 32 px H × 16 px V per 1.28 m tile", () => {
    const R = IsoCoreDefaults.fixedRenderHeight / IsoCoreDefaults.baseOrthoHeight;
    expect(R).toBeCloseTo(32 * Math.SQRT2, 10);
    expect(R * (Math.SQRT2 / 2)).toBeCloseTo(32, 10);
    expect(R * (Math.SQRT2 / 2) / 2).toBeCloseTo(16, 10);
  });
});

describe("resolvePixelPerfectTuning", () => {
  it("returns a complete CORE tuning from an empty input", () => {
    const resolved = resolvePixelPerfectTuning({});
    const keys: Array<keyof IsoCoreTuning> = [
      "fixedRenderHeight",
      "baseOrthoHeight",
      "cameraDistance",
      "cameraPitch",
      "cameraYaw",
      "basePixelZoom",
      "zoomMin",
      "zoomMax",
      "zoomStep",
      "zoomAnimationRate",
      "zoomAnimationBurstRate",
      "zoomAnimationEpsilon",
      "rotationAnimationRate",
      "rotationAnimationEpsilon",
      "zoomBurstIdleMs",
      "outputOverscanLowPixels",
      "lowTargetSamples",
      "smoothPixelTransitions",
      "verticalBias"
    ];
    for (const key of keys) {
      expect(resolved[key]).toBe(IsoCoreDefaults[key]);
    }
  });

  it("overrides only the specified fields", () => {
    const resolved = resolvePixelPerfectTuning({
      baseOrthoHeight: 3.0,
      cameraDistance: 20,
      rotationAnimationEpsilon: 0.005
    });
    expect(resolved.baseOrthoHeight).toBe(3.0);
    expect(resolved.cameraDistance).toBe(20);
    expect(resolved.rotationAnimationEpsilon).toBe(0.005);
    expect(resolved.cameraPitch).toBe(IsoCoreDefaults.cameraPitch);
    expect(resolved.fixedRenderHeight).toBe(IsoCoreDefaults.fixedRenderHeight);
  });

  it("preserves extra fields passed through the input", () => {
    const resolved = resolvePixelPerfectTuning({
      baseOrthoHeight: 3.0,
      ...({ scene: "scene-marker" } as {})
    } as any);
    expect((resolved as any).scene).toBe("scene-marker");
    expect(resolved.baseOrthoHeight).toBe(3.0);
  });
});

describe("resolveLockedView", () => {
  it("iso-2to1 + yawIndex 0 -> (FRH=256, BOH=4√2, yaw=π/4)", () => {
    const r = resolveLockedView("iso-2to1", 0);
    expect(r.fixedRenderHeight).toBe(ISO_VIEW_CONTRACT.referenceLowHeight);
    expect(r.baseOrthoHeight).toBe(ISO_VIEW_CONTRACT.baseOrthoHeight);
    expect(r.cameraYaw).toBeCloseTo(Math.PI / 4, 12);
  });

  it("iso-2to1 yaw rotates by quarter-turns", () => {
    const r1 = resolveLockedView("iso-2to1", 1);
    const r2 = resolveLockedView("iso-2to1", 2);
    const r3 = resolveLockedView("iso-2to1", 3);
    expect(r1.cameraYaw).toBeCloseTo(Math.PI / 4 + Math.PI / 2, 12);
    expect(r2.cameraYaw).toBeCloseTo(Math.PI / 4 + Math.PI, 12);
    expect(r3.cameraYaw).toBeCloseTo(Math.PI / 4 + 3 * Math.PI / 2, 12);
  });

  it("yawIndex normalises out-of-range integers (mod 4)", () => {
    const r4 = resolveLockedView("iso-2to1", 4);
    const r0 = resolveLockedView("iso-2to1", 0);
    expect(r4.cameraYaw).toBeCloseTo(r0.cameraYaw, 12);
    const rNeg = resolveLockedView("iso-2to1", -1);
    const r3 = resolveLockedView("iso-2to1", 3);
    expect(rNeg.cameraYaw).toBeCloseTo(r3.cameraYaw, 12);
  });

  it("top-down -> R = 32 (32×32 px per tile, square)", () => {
    const r = resolveLockedView("top-down", 0);
    expect(r.fixedRenderHeight).toBe(TOPDOWN_VIEW_CONTRACT.referenceLowHeight);
    expect(r.baseOrthoHeight).toBe(TOPDOWN_VIEW_CONTRACT.baseOrthoHeight);
    expect(r.fixedRenderHeight / r.baseOrthoHeight).toBe(32);
  });

  it("side -> R = 32, base yaw = 0", () => {
    const r = resolveLockedView("side", 0);
    expect(r.fixedRenderHeight).toBe(SIDE_VIEW_CONTRACT.referenceLowHeight);
    expect(r.baseOrthoHeight).toBe(SIDE_VIEW_CONTRACT.baseOrthoHeight);
    expect(r.cameraYaw).toBe(0);
  });
});

describe("type relationship: IsoGameViewTuning ⊂ IsoCoreTuning (locked)", () => {
  it("locked tuning excludes the three scale fields", () => {
    const locked = PixelPerfectDefaults as IsoGameViewTuning;
    const lockedKeys = Object.keys(locked);
    expect(lockedKeys).not.toContain("fixedRenderHeight");
    expect(lockedKeys).not.toContain("baseOrthoHeight");
    expect(lockedKeys).not.toContain("cameraYaw");
  });
});
