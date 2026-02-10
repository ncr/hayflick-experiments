import { describe, expect, it } from "vitest";
import { PixelPerfectController, type PixelControllerCanvasMetrics } from "./pixel-perfect-controller";

function createController() {
  return new PixelPerfectController({
    minZoom: 1,
    maxZoom: 20,
    initialZoom: 4,
    overscanLowPixels: 2,
    baseOrthoHeight: 5.966213466261495,
    referenceLowHeight: 270,
    maxBackingWidth: 8192,
    maxBackingHeight: 8192,
    viewportCssWidth: 920,
    viewportCssHeight: 620,
    devicePixelRatio: 1.6
  });
}

function createMetrics(): PixelControllerCanvasMetrics {
  return {
    rectLeft: 100,
    rectTop: 50,
    cssToDeviceX: 1.6,
    cssToDeviceY: 1.6
  };
}

describe("@common/render pixel-perfect controller", () => {
  it("keeps low-res grid stable across zoom steps", () => {
    const controller = createController();
    const before = controller.getState();
    controller.stepZoom(1);
    controller.stepZoom(1);
    const after = controller.getState();
    expect(after.lowRenderWidth).toBe(before.lowRenderWidth);
    expect(after.lowRenderHeight).toBe(before.lowRenderHeight);
    expect(after.sceneOutputWidth).toBeGreaterThan(before.sceneOutputWidth);
  });

  it("maps css pan to exact whole-device movement accounting for carry", () => {
    const controller = createController();
    const before = controller.getState();
    controller.panByCss(96, 0, 1.6, 1.6);
    const after = controller.getState();
    const measured = after.cumulativePanDeviceX - before.cumulativePanDeviceX;
    const expected = Math.trunc(96 * 1.6);
    expect(measured).toBe(expected);
  });

  it("maps client points to scene-normalized coordinates and back", () => {
    const controller = createController();
    const state = controller.getState();
    const metrics = createMetrics();
    const clientX =
      metrics.rectLeft +
      (state.renderBaseX + state.outputPadDeviceX + state.sceneOutputWidth * 0.25) /
        metrics.cssToDeviceX;
    const clientY =
      metrics.rectTop +
      (state.renderBaseY + state.outputPadDeviceY + state.sceneOutputHeight * 0.75) /
        metrics.cssToDeviceY;

    const scenePoint = controller.getScenePointFromClient(clientX, clientY, metrics);
    expect(scenePoint).not.toBeNull();
    if (!scenePoint) {
      return;
    }
    expect(scenePoint.x).toBeCloseTo(0.25, 8);
    expect(scenePoint.y).toBeCloseTo(0.75, 8);

    const projected = controller.getClientPointFromScene(scenePoint.x, scenePoint.y, metrics);
    expect(projected).not.toBeNull();
    if (!projected) {
      return;
    }
    expect(projected.x).toBeCloseTo(clientX, 8);
    expect(projected.y).toBeCloseTo(clientY, 8);
  });

  it("snaps zoom to safe ladder levels for fractional DPR", () => {
    const controller = createController();
    controller.setZoomMode("safe-ladder");
    const snapped = controller.getState();
    expect(snapped.userScale).toBe(5);
    expect(snapped.safeZoomLevels.length).toBeGreaterThanOrEqual(1);
    expect(snapped.safeZoomLevels.every((zoom) => zoom % 5 === 0)).toBe(true);
  });

  it("provides viewport for bottom-origin WebGL coordinates", () => {
    const controller = createController();
    const state = controller.getState();
    const viewport = controller.getRenderViewport(state.viewportDeviceHeight);
    expect(viewport.width).toBe(state.outputWidth);
    expect(viewport.height).toBe(state.outputHeight);
    expect(viewport.y).toBe(state.viewportDeviceHeight - (state.renderBaseY + state.outputHeight));
  });
});
