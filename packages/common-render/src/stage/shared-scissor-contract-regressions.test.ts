/* eslint-disable @typescript-eslint/no-explicit-any */
import { afterEach, describe, expect, it, vi } from "vitest";

const viewportCoreState = vi.hoisted(() => ({
  lastRenderArgs: null as null | Parameters<
    (r: unknown, v: unknown, nowMs: number, dt: number, scissor: unknown) => void
  >,
  lastResizeArgs: null as null | Parameters<
    (cssW: number, cssH: number, dpr: number, devW: number, devH: number) => void
  >,
  renderToRenderer: null as null | ReturnType<typeof vi.fn>,
  resize: null as null | ReturnType<typeof vi.fn>,
  dispose: null as null | ReturnType<typeof vi.fn>
}));

vi.mock("../internals/iso-viewport", () => {
  class ViewportCoreMock {
    readonly camera = { tag: "camera", layers: { enable: () => {} } };
    readonly cameraTarget = { tag: "cameraTarget" };
    readonly renderToRenderer = vi.fn(
      (renderer: unknown, v: unknown, nowMs: number, dt: number, scissor: unknown) => {
        viewportCoreState.lastRenderArgs = [renderer, v, nowMs, dt, scissor];
      }
    );
    readonly resize = vi.fn(
      (cssW: number, cssH: number, dpr: number, devW: number, devH: number) => {
        viewportCoreState.lastResizeArgs = [cssW, cssH, dpr, devW, devH];
      }
    );
    readonly dispose = vi.fn();

    constructor() {
      viewportCoreState.renderToRenderer = this.renderToRenderer;
      viewportCoreState.resize = this.resize;
      viewportCoreState.dispose = this.dispose;
    }
  }
  return { IsoViewport: ViewportCoreMock };
});

import { PixelPerfectPane } from "./pixel-perfect-pane";
import { PerspectivePane } from "./perspective-pane";
import type { SharedScissorFrameContext, SharedScissorPane, SharedScissorPaneRect } from "./shared-scissor-stage";
import { setCommonRenderWarningsEnabled } from "../presets/dev-warnings";

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

function makeFakeStage() {
  const registered: SharedScissorPane[] = [];
  return {
    stage: {
      registerPane: (pane: SharedScissorPane) => {
        registered.push(pane);
      },
      renderer: { shadowMap: { enabled: false } },
      maxBackingWidth: 4096,
      maxBackingHeight: 4096,
      getDevicePixelRatio: () => 2
    } as any,
    registered
  };
}

describe("@common/render shared scissor contract regressions", () => {
  afterEach(() => {
    setCommonRenderWarningsEnabled(true);
    vi.restoreAllMocks();
  });

  it("PerspectivePane uses clipped scissor but unclipped viewport for partial offscreen panes", () => {
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

    const { stage } = makeFakeStage();
    const pane = new PerspectivePane({
      stage,
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

  it("PixelPerfectPane forwards separate pane viewport and clipped scissor rect to its internal core", () => {
    const { stage } = makeFakeStage();
    const element = { clientWidth: 160, clientHeight: 120 } as HTMLElement;
    const pane = new PixelPerfectPane({
      stage,
      id: "pixel",
      element,
      scene: {} as any,
      width: 160,
      height: 120
    });

    const renderer = {} as any;
    pane.render(
      { renderer, nowMs: 1000, deltaSeconds: 1 / 60 },
      makeRect()
    );

    expect(viewportCoreState.lastRenderArgs).toEqual([
      renderer,
      { x: -40, y: 18, width: 160, height: 120 },
      1000,
      1 / 60,
      { x: 0, y: 18, width: 120, height: 120 }
    ]);
  });

  it("PixelPerfectPane resize uses unclipped device size for logical viewport state", () => {
    const { stage } = makeFakeStage();
    const element = { clientWidth: 80, clientHeight: 60 } as HTMLElement;
    const pane = new PixelPerfectPane({
      stage,
      id: "pixel",
      element,
      scene: {} as any,
      width: 80,
      height: 60
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

    expect(viewportCoreState.lastResizeArgs).toEqual([80, 60, 2, 160, 120]);
  });

  it("honors the shared warning gate for missing stage shadows diagnostics", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { stage } = makeFakeStage();
    setCommonRenderWarningsEnabled(false);

    new PixelPerfectPane({
      stage,
      id: "shadowed-pixel",
      element: { clientWidth: 80, clientHeight: 60 } as HTMLElement,
      scene: {} as any,
      width: 80,
      height: 60,
      shadows: true
    });

    expect(warnSpy).not.toHaveBeenCalled();
    setCommonRenderWarningsEnabled(true);
  });
});
