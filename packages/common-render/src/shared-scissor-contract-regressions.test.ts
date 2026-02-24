import { describe, expect, it, vi } from "vitest";
import { PixelPerfectIsoScissorPane } from "./pixel-perfect-iso-scissor-pane";
import { ThreeSceneScissorPane } from "./three-scene-scissor-pane";
import type { SharedScissorFrameContext, SharedScissorPaneRect } from "./shared-scissor-stage";

function makeRect(overrides: Partial<SharedScissorPaneRect> = {}): SharedScissorPaneRect {
  return {
    cssLeft: 0,
    cssTop: 0,
    cssWidth: 160,
    cssHeight: 120,
    deviceViewportLeft: -40,
    deviceViewportBottom: 18,
    deviceWidthUnclipped: 160,
    deviceHeightUnclipped: 120,
    deviceLeft: 0,
    deviceTop: 30,
    deviceBottom: 18,
    deviceWidth: 120,
    deviceHeight: 120,
    ...overrides
  };
}

describe("@common/render shared scissor contract regressions", () => {
  it("ThreeSceneScissorPane uses clipped scissor but unclipped viewport for partial offscreen panes", () => {
    const calls: Array<[string, ...unknown[]]> = [];
    const renderer = {
      setScissor: (x: number, y: number, w: number, h: number) => {
        calls.push(["setScissor", x, y, w, h]);
      },
      setViewport: (x: number, y: number, w: number, h: number) => {
        calls.push(["setViewport", x, y, w, h]);
      },
      render: (scene: unknown, camera: unknown) => {
        calls.push(["render", scene, camera]);
      }
    } as any;

    const pane = new ThreeSceneScissorPane({
      id: "mesh",
      element: {} as HTMLElement,
      scene: { id: "scene" } as any,
      camera: { id: "camera" } as any,
      autoResizePerspectiveCamera: false
    });

    pane.render(
      { renderer, nowMs: 0, deltaSeconds: 0 } as SharedScissorFrameContext,
      makeRect()
    );

    expect(calls).toContainEqual(["setScissor", 0, 18, 120, 120]);
    expect(calls).toContainEqual(["setViewport", -40, 18, 160, 120]);
  });

  it("PixelPerfectIsoScissorPane forwards separate pane viewport and clipped scissor rect to the core", () => {
    const renderToRenderer = vi.fn();
    const resize = vi.fn();
    const core = {
      renderToRenderer,
      resize
    } as any;
    const pane = new PixelPerfectIsoScissorPane({
      id: "pixel",
      element: {} as HTMLElement,
      core
    });
    const rect = makeRect();

    pane.render({ renderer: {} as any, nowMs: 1000, deltaSeconds: 1 / 60 }, rect);

    expect(renderToRenderer).toHaveBeenCalledWith(
      {},
      { x: -40, y: 18, width: 160, height: 120 },
      1000,
      1 / 60,
      { x: 0, y: 18, width: 120, height: 120 }
    );
  });

  it("PixelPerfectIsoScissorPane resize uses unclipped device size for logical viewport state", () => {
    const resize = vi.fn();
    const core = {
      renderToRenderer: vi.fn(),
      resize
    } as any;
    const pane = new PixelPerfectIsoScissorPane({
      id: "pixel",
      element: {} as HTMLElement,
      core
    });

    pane.onResize(
      makeRect({
        cssWidth: 80,
        cssHeight: 60,
        deviceViewportLeft: 120,
        deviceViewportBottom: 30,
        deviceWidthUnclipped: 160,
        deviceHeightUnclipped: 120,
        deviceLeft: 120,
        deviceBottom: 30,
        deviceWidth: 40,
        deviceHeight: 120
      })
    );

    expect(resize).toHaveBeenCalledWith(80, 60, 2, 160, 120);
  });
});
