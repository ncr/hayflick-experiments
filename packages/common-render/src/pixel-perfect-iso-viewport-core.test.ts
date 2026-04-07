import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { PixelPerfectIsoViewportCore } from "./pixel-perfect-iso-viewport-core";

function makeCore(): PixelPerfectIsoViewportCore {
  return new PixelPerfectIsoViewportCore({
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
    devicePixelRatio: 1
  });
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
