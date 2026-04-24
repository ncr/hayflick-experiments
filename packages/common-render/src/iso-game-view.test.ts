/* eslint-disable @typescript-eslint/no-explicit-any */
import * as THREE from "three";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const mockState = vi.hoisted(() => ({
  stageInstances: [] as any[],
  paneInstances: [] as any[]
}));

vi.mock("./stage/shared-scissor-stage", () => {
  class SharedScissorStageMock {
    readonly mount: HTMLElement;
    readonly renderer = { tag: "renderer" };
    readonly canvas = { style: { background: "stage-canvas-before" } } as any;
    readonly maxBackingWidth = 8192;
    readonly maxBackingHeight = 4096;
    readonly registerPane = vi.fn((pane: unknown) => {
      this._pane = pane;
    });
    readonly resize = vi.fn();
    readonly drawFrame = vi.fn();
    readonly start = vi.fn();
    readonly stop = vi.fn();
    readonly dispose = vi.fn();
    private readonly _dpr: number;
    private _pane: unknown = null;

    constructor(public readonly config: any) {
      this.mount = config.mount;
      this._dpr = config.pixelRatio ?? 1;
      mockState.stageInstances.push(this);
    }

    getDevicePixelRatio(): number {
      return this._dpr;
    }
  }

  return { SharedScissorStage: SharedScissorStageMock };
});

vi.mock("./stage/pixel-perfect-pane", () => {
  class PixelPerfectPaneMock {
    readonly id: string;
    readonly element: HTMLElement;
    readonly camera = { tag: "camera" };
    readonly cameraTarget = { tag: "cameraTarget" };
    readonly state = {
      cameraZoomCurrent: 1,
      cameraZoomTarget: 1,
      zoomAnimationActive: false,
      zoomBurstActive: false,
      controllerRenderScale: 2,
      baseRenderScale: 2,
      lowRenderWidth: 160,
      lowRenderHeight: 120,
      sceneOutputWidth: 160,
      sceneOutputHeight: 120,
      zoomMode: "free" as const,
      devicePixelRatio: 2
    };
    readonly pose = {
      targetX: 0,
      targetZ: 0,
      yawIndex: 0,
      zoom: 2
    };

    readonly getState = vi.fn(() => this.state);
    readonly getViewPose = vi.fn(() => this.pose);
    readonly setViewPose = vi.fn();
    readonly getYawIndex = vi.fn(() => this.pose.yawIndex);
    readonly rotateQuarterTurns = vi.fn();
    readonly panByCss = vi.fn();
    readonly stepCameraZoom = vi.fn();
    readonly toggleZoomMode = vi.fn();
    readonly beginPanDrag = vi.fn();
    readonly updatePanDrag = vi.fn(() => true);
    readonly endPanDrag = vi.fn(() => true);
    readonly stepCameraZoomAtLocalCss = vi.fn(() => true);
    readonly reset = vi.fn();
    readonly worldAtLocalCss = vi.fn((_x: number, _y: number, out: THREE.Vector3) => {
      out.set(1, 2, 3);
      return true;
    });
    readonly projectWorldToLocalCss = vi.fn((_world: THREE.Vector3, out: THREE.Vector2) => {
      out.set(5, 7);
      return true;
    });
    readonly snapWorldPointOnGround = vi.fn((_world: THREE.Vector3, out: THREE.Vector3) => {
      out.set(3, 4, 5);
      return true;
    });
    readonly getLowTarget = vi.fn(() => ({ tag: "low-target" }));
    readonly setLowTarget = vi.fn();
    readonly setOutputSourceTexture = vi.fn();
    beforeSceneRender: unknown = null;
    afterSceneRender: unknown = null;

    constructor(public readonly config: any) {
      this.id = config.id;
      this.element = config.element;
      mockState.paneInstances.push(this);
      // Mimic auto-register behaviour of the real pane.
      config.stage.registerPane(this);
    }
  }

  return { PixelPerfectPane: PixelPerfectPaneMock };
});

import { IsoGameView } from "./iso-game-view";
import { setCommonRenderWarningsEnabled } from "./presets/dev-warnings";

setCommonRenderWarningsEnabled(false);

type RectLike = {
  left: number;
  top: number;
  width: number;
  height: number;
  right: number;
  bottom: number;
};

function makeRect(left: number, top: number, width: number, height: number): RectLike {
  return { left, top, width, height, right: left + width, bottom: top + height };
}

function makeMount(rect: RectLike): any {
  let currentRect = rect;
  return {
    style: { background: "mount-before" },
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    getBoundingClientRect: vi.fn(() => currentRect),
    setRect(next: RectLike) {
      currentRect = next;
    }
  };
}

function makeConfig(mount: HTMLElement): any {
  return {
    mount,
    width: 160,
    height: 120,
    scene: new THREE.Scene(),
    fixedRenderHeight: 120,
    baseOrthoHeight: 6,
    cameraDistance: 10,
    cameraPitch: "iso-2to1",
    cameraYaw: Math.PI / 4,
    verticalBias: 0.34,
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
    lowTargetSamples: 0,
    smoothPixelTransitions: false,
    clearColor: 0x123456,
    clearAlpha: 0.75,
    outlines: false
  };
}

describe("@common/render IsoGameView facade", () => {
  const originalWindow = (globalThis as any).window;

  beforeAll(() => {
    (globalThis as any).window = {
      devicePixelRatio: 2,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn()
    };
  });

  afterAll(() => {
    if (originalWindow === undefined) {
      delete (globalThis as any).window;
    } else {
      (globalThis as any).window = originalWindow;
    }
  });

  beforeEach(() => {
    mockState.stageInstances.length = 0;
    mockState.paneInstances.length = 0;
    (globalThis as any).window.devicePixelRatio = 2;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("constructs a stage + pane pair and wires them together", () => {
    const mount = makeMount(makeRect(100, 200, 160, 120)) as HTMLElement;
    const view = new IsoGameView(makeConfig(mount));

    const stage = mockState.stageInstances[0];
    const pane = mockState.paneInstances[0];

    expect(stage).toBeTruthy();
    expect(pane).toBeTruthy();

    expect(stage.config.mount).toBe(mount);
    expect(stage.config.width).toBe(160);
    expect(stage.config.height).toBe(120);
    expect(stage.config.pixelRatio).toBe(2);
    expect(stage.registerPane).toHaveBeenCalledWith(pane);

    expect(pane.config.stage).toBe(stage);
    expect(pane.config.id).toBe("main");
    expect(pane.config.element).toBe(mount);
    expect(pane.config.width).toBe(160);
    expect(pane.config.height).toBe(120);
    expect(pane.config.clearColor).toBe(0x123456);
    expect(pane.config.clearAlpha).toBe(0.75);
    expect(pane.config.lowTargetSamples).toBe(0);
    expect(pane.config.smoothPixelTransitions).toBe(false);
    expect(pane.config.verticalBias).toBe(0.34);

    expect(view.renderer).toBe(stage.renderer);
    expect(view.canvas).toBe(stage.canvas);
    expect(view.camera).toBe(pane.camera);
    expect(view.cameraTarget).toBe(pane.cameraTarget);
  });

  it("delegates state, commands, frame, and resize to the pane/stage", () => {
    const mount = makeMount(makeRect(0, 0, 160, 120)) as HTMLElement;
    const view = new IsoGameView(makeConfig(mount));
    const stage = mockState.stageInstances[0];
    const pane = mockState.paneInstances[0];

    const pose = { targetX: 2, targetZ: 3, yawIndex: 1, zoom: 4 };
    view.getState();
    view.getViewPose();
    view.setViewPose(pose);
    view.getYawIndex();
    view.rotateQuarterTurns(1);
    view.panByCss(3, 4);
    view.stepCameraZoom(-1);
    view.toggleZoomMode();
    view.reset();
    view.frame(1000, 1 / 60);

    (globalThis as any).window.devicePixelRatio = 3;
    view.resize(300, 200);

    expect(pane.getState).toHaveBeenCalled();
    expect(pane.getViewPose).toHaveBeenCalled();
    expect(pane.setViewPose).toHaveBeenCalledWith(pose);
    expect(pane.getYawIndex).toHaveBeenCalled();
    expect(pane.rotateQuarterTurns).toHaveBeenCalledWith(1);
    expect(pane.panByCss).toHaveBeenCalledWith(3, 4);
    expect(pane.stepCameraZoom).toHaveBeenCalledWith(-1);
    expect(pane.toggleZoomMode).toHaveBeenCalled();
    expect(pane.reset).toHaveBeenCalled();
    expect(stage.drawFrame).toHaveBeenCalledWith(1000, 1 / 60);
    expect(stage.resize).toHaveBeenCalledWith(300, 200, 3);
  });

  it("translates client coordinates into local CSS coordinates for drag/zoom/world queries", () => {
    const mount = makeMount(makeRect(100, 200, 160, 120));
    const view = new IsoGameView(makeConfig(mount as unknown as HTMLElement));
    const pane = mockState.paneInstances[0];

    expect(view.beginPanDrag(112, 228)).toBe(true);
    expect(view.updatePanDrag(113, 229)).toBe(true);
    expect(view.endPanDrag()).toBe(true);
    expect(view.zoomStepAtClient(1, 118, 234, 456)).toBe(true);

    const world = new THREE.Vector3();
    expect(view.worldAtClient(121, 241, world)).toBe(true);
    expect(world.toArray()).toEqual([1, 2, 3]);

    expect(pane.beginPanDrag).toHaveBeenCalledWith(12, 28);
    expect(pane.updatePanDrag).toHaveBeenCalledWith(13, 29);
    expect(pane.stepCameraZoomAtLocalCss).toHaveBeenCalledWith(1, 18, 34, 456);
    expect(pane.worldAtLocalCss).toHaveBeenCalledWith(21, 41, world);
  });

  it("maps projected local coordinates back to client space and guards zero-sized mounts", () => {
    const mount = makeMount(makeRect(50, 75, 160, 120));
    const view = new IsoGameView(makeConfig(mount as unknown as HTMLElement));
    const pane = mockState.paneInstances[0];

    const client = new THREE.Vector2();
    expect(view.projectWorldToClient(new THREE.Vector3(1, 2, 3), client)).toBe(true);
    expect(client.toArray()).toEqual([55, 82]);

    mount.setRect(makeRect(50, 75, 0, 0));
    expect(view.beginPanDrag(51, 76)).toBe(false);
    expect(view.updatePanDrag(51, 76)).toBe(false);
    expect(view.zoomStepAtClient(1, 51, 76)).toBe(false);
    expect(view.worldAtClient(51, 76, new THREE.Vector3())).toBe(false);

    expect(pane.beginPanDrag).toHaveBeenCalledTimes(0);
    expect(pane.updatePanDrag).toHaveBeenCalledTimes(0);
  });

  it("disposes stage exactly once", () => {
    const mount = makeMount(makeRect(0, 0, 160, 120)) as HTMLElement;
    const view = new IsoGameView(makeConfig(mount));
    const stage = mockState.stageInstances[0];

    view.dispose();
    view.dispose();

    expect(stage.dispose).toHaveBeenCalledTimes(1);
  });

  it("does not attach DOM input listeners from the facade", () => {
    const mount = makeMount(makeRect(0, 0, 160, 120)) as HTMLElement;
    new IsoGameView(makeConfig(mount));

    expect((mount as any).addEventListener).not.toHaveBeenCalled();
    expect((globalThis as any).window.addEventListener).not.toHaveBeenCalled();
  });
});
