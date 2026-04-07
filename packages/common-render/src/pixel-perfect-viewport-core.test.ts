import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { PixelPerfectViewportCore } from "./pixel-perfect-viewport-core";

function makeCore(
  overrides: Partial<ConstructorParameters<typeof PixelPerfectViewportCore>[0]> = {}
): PixelPerfectViewportCore {
  return new PixelPerfectViewportCore({
    width: 160,
    height: 120,
    scene: new THREE.Scene(),
    fixedRenderHeight: 120,
    baseOrthoHeight: 6,
    cameraDistance: 10,
    cameraPitch: "iso-2to1",
    cameraYaw: Math.PI / 4,
    basePixelZoom: 2,
    zoomMin: 1,
    zoomMax: 6,
    zoomStep: 1,
    zoomAnimationRate: 14,
    zoomAnimationBurstRate: 42,
    zoomAnimationEpsilon: 0.02,
    rotationAnimationRate: 18,
    rotationAnimationEpsilon: 1e-3,
    zoomBurstIdleMs: 90,
    outputOverscanLowPixels: 2,
    clearColor: 0x0b0f14,
    clearAlpha: 1,
    maxBackingWidth: 4096,
    maxBackingHeight: 4096,
    devicePixelRatio: 1,
    ...overrides
  });
}

function makeSideCore(): PixelPerfectViewportCore {
  return makeCore({ cameraPitch: "side", cameraYaw: 0 });
}

class FakeRenderer {
  domElement = { width: 512, height: 512 };
  private scissorTest = false;
  readonly viewportCalls: Array<[number, number, number, number]> = [];
  readonly scissorCalls: Array<[number, number, number, number]> = [];

  getScissorTest(): boolean {
    return this.scissorTest;
  }

  setScissorTest(next: boolean): void {
    this.scissorTest = next;
  }

  setRenderTarget(_target: unknown): void {}

  setViewport(x: number, y: number, w: number, h: number): void {
    this.viewportCalls.push([x, y, w, h]);
  }

  setScissor(x: number, y: number, w: number, h: number): void {
    this.scissorCalls.push([x, y, w, h]);
  }

  clear(): void {}

  render(_scene: unknown, _camera: unknown): void {}

  setClearColor(_color: number, _alpha: number): void {}
}

describe("@common/render iso viewport core", () => {
  it("supports explicit drag commands without DOM event wrappers", () => {
    const core = makeCore();
    const before = core.getViewPose();

    core.beginPanDrag(40, 40);
    expect(core.isDragging()).toBe(true);
    expect(core.updatePanDrag(48, 46)).toBe(true);
    expect(core.endPanDrag()).toBe(true);
    expect(core.isDragging()).toBe(false);

    const after = core.getViewPose();
    expect(after.targetX !== before.targetX || after.targetZ !== before.targetZ).toBe(true);
  });

  it("supports anchored zoom at local CSS coordinates", () => {
    const core = makeCore();
    const before = core.getState();
    const changed = core.zoomStepAtLocalCss(1, 80, 60, 123);
    const after = core.getState();

    expect(changed).toBe(true);
    expect(after.cameraZoomTarget).toBeGreaterThan(before.cameraZoomTarget);
  });

  it("exposes zoom mode toggle as an explicit command", () => {
    const core = makeCore();
    expect(core.getState().zoomMode).toBe("free");
    core.toggleZoomMode();
    expect(core.getState().zoomMode).toBe("safe-ladder");
  });

  it("round-trips visual state including pan carry and remainders", () => {
    const coreA = makeCore();
    coreA.panByCss(7.25, 3.5);
    coreA.rotateQuarterTurns(1);
    coreA.zoomStepAtLocalCss(1, 80, 60, 100);
    const state = coreA.getVisualState();

    const coreB = makeCore();
    coreB.setVisualState(state);
    expect(coreB.getVisualState()).toEqual(state);
  });

  it("allows overscanned output viewport to use negative local offsets inside scissor render", () => {
    const core = makeCore();
    const renderer = new FakeRenderer();
    core.renderToRenderer(
      renderer as unknown as THREE.WebGLRenderer,
      { x: 10, y: 20, width: 160, height: 120 },
      0,
      0
    );

    expect(renderer.viewportCalls.length).toBeGreaterThanOrEqual(4);
    const outputViewport = renderer.viewportCalls[renderer.viewportCalls.length - 2];
    expect(outputViewport[1]).toBeLessThan(20);
  });

  describe("side view mode", () => {
    it("does not clamp cameraTarget.y to 0 after vertical pan", () => {
      const core = makeSideCore();
      core.panByCss(0, 200);
      const pose = core.getViewPose();
      expect(Math.abs(pose.targetY ?? 0)).toBeGreaterThan(1e-3);
    });

    it("panByCss moves the target by per-pixel scale, not the full frustum width", () => {
      const core = makeSideCore();
      const before = core.getViewPose();
      core.panByCss(20, 0);
      const after = core.getViewPose();
      const dx = after.targetX - before.targetX;
      const dz = after.targetZ - before.targetZ;
      const moved = Math.sqrt(dx * dx + dz * dz);
      // The dead fallback used `frustumWidth` directly (~baseOrthoHeight *
      // aspect = 6 * 160/120 = 8 world units per device pixel of remainder),
      // which would move the target by tens of world units for a 20-pixel
      // drag. The camera-basis fix scales by world units per low-res pixel,
      // keeping it well under 5 world units even for this pan amount.
      expect(moved).toBeGreaterThan(0);
      expect(moved).toBeLessThan(5);
    });

    it("snapWorldPointOnGround returns false in side mode", () => {
      const core = makeSideCore();
      const out = new THREE.Vector3();
      const ok = core.snapWorldPointOnGround(new THREE.Vector3(1, 0, 1), out);
      expect(ok).toBe(false);
    });

    it("getViewPose round-trips through setViewPose for non-zero targetY", () => {
      const coreA = makeSideCore();
      coreA.setViewPose({ targetX: 1.5, targetY: 2.25, targetZ: -0.75, yawIndex: 0, zoom: 2 });
      const pose = coreA.getViewPose();
      expect(pose.targetX).toBeCloseTo(1.5);
      expect(pose.targetY).toBeCloseTo(2.25);
      expect(pose.targetZ).toBeCloseTo(-0.75);

      const coreB = makeSideCore();
      coreB.setViewPose(pose);
      const round = coreB.getViewPose();
      expect(round.targetX).toBeCloseTo(pose.targetX);
      expect(round.targetY).toBeCloseTo(pose.targetY ?? 0);
      expect(round.targetZ).toBeCloseTo(pose.targetZ);
    });

    it("getVisualState round-trips through setVisualState for non-zero targetY", () => {
      const coreA = makeSideCore();
      coreA.panByCss(3, 17);
      const state = coreA.getVisualState();
      expect(Math.abs(state.targetY)).toBeGreaterThan(1e-6);

      const coreB = makeSideCore();
      coreB.setVisualState(state);
      expect(coreB.getVisualState()).toEqual(state);
    });
  });

  it("supports clipped scissor rects with an unclipped pane viewport to avoid sticky edge scrolling", () => {
    const core = makeCore();
    const renderer = new FakeRenderer();

    core.renderToRenderer(
      renderer as unknown as THREE.WebGLRenderer,
      { x: -40, y: 18, width: 160, height: 120 },
      0,
      0,
      { x: 0, y: 18, width: 120, height: 120 }
    );

    expect(renderer.scissorCalls).toContainEqual([0, 18, 120, 120]);
    expect(renderer.viewportCalls).toContainEqual([-40, 18, 160, 120]);
  });
});
