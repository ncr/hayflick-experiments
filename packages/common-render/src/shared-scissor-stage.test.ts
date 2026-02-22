import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const mockState = vi.hoisted(() => ({
  rendererInstances: [] as Array<{
    domElement: {
      width: number;
      height: number;
      style: Record<string, string>;
      parentElement: unknown;
    };
    calls: Array<[string, ...unknown[]]>;
  }>
}));

vi.mock("./gl-caps", () => ({
  queryMaxBackingSize: () => ({ width: 4096, height: 4096 })
}));

vi.mock("three", () => {
  class FakeWebGLRenderer {
    readonly domElement: {
      width: number;
      height: number;
      style: Record<string, string>;
      parentElement: unknown;
    };
    readonly calls: Array<[string, ...unknown[]]> = [];

    constructor(_options?: unknown) {
      this.domElement = {
        width: 0,
        height: 0,
        style: {},
        parentElement: null
      };
      mockState.rendererInstances.push(this);
    }

    setPixelRatio(value: number): void {
      this.calls.push(["setPixelRatio", value]);
    }

    setSize(width: number, height: number, updateStyle: boolean): void {
      this.domElement.width = width;
      this.domElement.height = height;
      this.calls.push(["setSize", width, height, updateStyle]);
    }

    getContext(): object {
      return {};
    }

    setScissorTest(enabled: boolean): void {
      this.calls.push(["setScissorTest", enabled]);
    }

    setViewport(x: number, y: number, width: number, height: number): void {
      this.calls.push(["setViewport", x, y, width, height]);
    }

    setClearColor(color: number, alpha: number): void {
      this.calls.push(["setClearColor", color, alpha]);
    }

    clear(color?: boolean, depth?: boolean, stencil?: boolean): void {
      this.calls.push(["clear", color, depth, stencil]);
    }

    dispose(): void {
      this.calls.push(["dispose"]);
    }
  }

  return { WebGLRenderer: FakeWebGLRenderer };
});

import { SharedScissorStage, type SharedScissorPane } from "./shared-scissor-stage";

class FakeResizeObserver {
  constructor(private readonly _callback: ResizeObserverCallback) {}
  observe(_target: unknown): void {}
  disconnect(): void {}
}

type Rect = DOMRect;

type FakeElement = {
  style: Record<string, string>;
  parentElement: FakeElement | null;
  children: unknown[];
  addEventListener: ReturnType<typeof vi.fn>;
  removeEventListener: ReturnType<typeof vi.fn>;
  appendChild: (child: any) => void;
  removeChild: (child: any) => void;
  getBoundingClientRect: () => Rect;
};

function makeRect(left: number, top: number, width: number, height: number): Rect {
  const right = left + width;
  const bottom = top + height;
  return {
    x: left,
    y: top,
    left,
    top,
    right,
    bottom,
    width,
    height,
    toJSON: () => ({})
  } as Rect;
}

function makeElement(nextRect: Rect): FakeElement {
  const el: FakeElement = {
    style: {},
    parentElement: null,
    children: [],
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    appendChild(child: any) {
      this.children.push(child);
      child.parentElement = this;
    },
    removeChild(child: any) {
      this.children = this.children.filter((entry) => entry !== child);
      if (child && typeof child === "object" && "parentElement" in child) {
        (child as { parentElement: unknown }).parentElement = null;
      }
    },
    getBoundingClientRect: () => nextRect
  };
  return el;
}

function setRect(el: FakeElement, nextRect: Rect): void {
  el.getBoundingClientRect = () => nextRect;
}

function makePane(id: string, element: FakeElement): SharedScissorPane & {
  renderSpy: ReturnType<typeof vi.fn>;
  resizeSpy: ReturnType<typeof vi.fn>;
  disposeSpy: ReturnType<typeof vi.fn>;
} {
  const renderSpy = vi.fn();
  const resizeSpy = vi.fn();
  const disposeSpy = vi.fn();
  return {
    id,
    element: element as unknown as HTMLElement,
    render: renderSpy,
    onResize: resizeSpy,
    dispose: disposeSpy,
    renderSpy,
    resizeSpy,
    disposeSpy
  };
}

function latestRendererCalls(): Array<[string, ...unknown[]]> {
  const renderer = mockState.rendererInstances.at(-1);
  if (!renderer) {
    throw new Error("Missing mocked renderer instance");
  }
  return renderer.calls;
}

describe("@common/render SharedScissorStage", () => {
  const originalWindow = (globalThis as { window?: unknown }).window;
  const originalResizeObserver = globalThis.ResizeObserver;

  beforeAll(() => {
    const fakeWindow = {
      devicePixelRatio: 2,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      getComputedStyle: (el: { style?: Record<string, string> }) => ({
        position: el.style?.position || "static"
      })
    };
    (globalThis as { window: unknown }).window = fakeWindow;
    (globalThis as { ResizeObserver: typeof ResizeObserver }).ResizeObserver =
      FakeResizeObserver as unknown as typeof ResizeObserver;
  });

  afterAll(() => {
    if (originalWindow === undefined) {
      delete (globalThis as { window?: unknown }).window;
    } else {
      (globalThis as { window: unknown }).window = originalWindow;
    }
    (globalThis as { ResizeObserver: typeof ResizeObserver | undefined }).ResizeObserver =
      originalResizeObserver;
  });

  beforeEach(() => {
    mockState.rendererInstances.length = 0;
    const win = (globalThis as any).window as {
      devicePixelRatio: number;
      addEventListener: ReturnType<typeof vi.fn>;
    };
    win.devicePixelRatio = 2;
    win.addEventListener.mockClear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("does not attach window or mount input listeners in the constructor", () => {
    const mount = makeElement(makeRect(10, 20, 320, 240));

    const stage = new SharedScissorStage({
      mount: mount as unknown as HTMLElement,
      width: 320,
      height: 240
    });

    const win = (globalThis as any).window as { addEventListener: ReturnType<typeof vi.fn> };
    expect(win.addEventListener).not.toHaveBeenCalled();
    expect(mount.addEventListener).not.toHaveBeenCalled();

    stage.dispose();
  });

  it("throws on duplicate pane registration", () => {
    const mount = makeElement(makeRect(0, 0, 200, 100));
    const paneEl = makeElement(makeRect(0, 0, 100, 50));
    const pane = makePane("pane-a", paneEl);

    const stage = new SharedScissorStage({ mount: mount as unknown as HTMLElement, width: 200, height: 100 });
    stage.registerPane(pane);

    expect(() => stage.registerPane(makePane("pane-a", paneEl))).toThrow(
      "SharedScissorStage duplicate pane id: pane-a"
    );

    stage.dispose();
  });

  it("uses absolute-edge quantization for pane rects and hit-testing on fractional layouts", () => {
    const mount = makeElement(makeRect(10.25, 20.25, 100.5, 50.5));
    const paneEl = makeElement(makeRect(11.25, 21.25, 50.5, 25.5));
    const pane = makePane("pane-a", paneEl);

    const stage = new SharedScissorStage({
      mount: mount as unknown as HTMLElement,
      width: 100.5,
      height: 50.5,
      pixelRatio: 2
    });
    stage.registerPane(pane);

    const paneRect = stage.getPaneRects().get("pane-a");
    expect(paneRect).toEqual({
      cssLeft: 1,
      cssTop: 1,
      cssWidth: 50.5,
      cssHeight: 25.5,
      deviceLeft: 2,
      deviceTop: 2,
      deviceBottom: 48,
      deviceWidth: 101,
      deviceHeight: 51
    });
    expect(pane.resizeSpy).toHaveBeenCalledTimes(1);

    const hit = stage.hitTestPane(12, 22);
    expect(hit).toEqual({
      paneId: "pane-a",
      localX: 0.75,
      localY: 0.75,
      rect: paneRect
    });

    stage.dispose();
  });

  it("unregisterPane removes the pane without disposing it", () => {
    const mount = makeElement(makeRect(0, 0, 200, 100));
    const paneEl = makeElement(makeRect(0, 0, 80, 80));
    const pane = makePane("pane-a", paneEl);

    const stage = new SharedScissorStage({ mount: mount as unknown as HTMLElement, width: 200, height: 100 });
    stage.registerPane(pane);

    stage.unregisterPane("pane-a");

    expect(stage.getPaneRects().has("pane-a")).toBe(false);
    expect(pane.disposeSpy).not.toHaveBeenCalled();

    stage.dispose();
    expect(pane.disposeSpy).not.toHaveBeenCalled();
  });

  it("renders only panes with meaningful device size and resets scissor test state", () => {
    const mount = makeElement(makeRect(0, 0, 300, 200));
    const largeEl = makeElement(makeRect(10, 10, 100, 80));
    const tinyEl = makeElement(makeRect(200, 10, 0.5, 0.5));
    const largePane = makePane("large", largeEl);
    const tinyPane = makePane("tiny", tinyEl);

    const stage = new SharedScissorStage({
      mount: mount as unknown as HTMLElement,
      width: 300,
      height: 200,
      pixelRatio: 1
    });
    stage.registerPane(largePane);
    stage.registerPane(tinyPane);

    const before = latestRendererCalls().length;
    stage.drawFrame(1000, 1 / 60);
    const drawCalls = latestRendererCalls().slice(before);

    expect(largePane.renderSpy).toHaveBeenCalledTimes(1);
    expect(tinyPane.renderSpy).not.toHaveBeenCalled();
    expect(drawCalls.at(-1)).toEqual(["setScissorTest", false]);

    stage.dispose();
  });

  it("re-measures pane rects when element geometry changes", () => {
    const mount = makeElement(makeRect(0, 0, 300, 200));
    const paneEl = makeElement(makeRect(20, 30, 60, 40));
    const pane = makePane("pane-a", paneEl);
    const stage = new SharedScissorStage({
      mount: mount as unknown as HTMLElement,
      width: 300,
      height: 200,
      pixelRatio: 1
    });
    stage.registerPane(pane);
    expect(pane.resizeSpy).toHaveBeenCalledTimes(1);

    setRect(paneEl, makeRect(25, 35, 60, 40));
    stage.hitTestPane(30, 40);

    expect(pane.resizeSpy).toHaveBeenCalledTimes(2);
    expect(stage.getPaneRects().get("pane-a")?.deviceLeft).toBe(25);
    expect(stage.getPaneRects().get("pane-a")?.deviceTop).toBe(35);

    stage.dispose();
  });
});
