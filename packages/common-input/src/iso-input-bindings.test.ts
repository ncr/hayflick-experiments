import { beforeAll, describe, expect, it, vi } from "vitest";
import {
  bindPixelPerfectIsoViewInput,
  bindSharedScissorStageInput
} from "./iso-input-bindings";

class FakeTarget {
  style = { touchAction: "" };
  private readonly listeners = new Map<string, Set<(event: any) => void>>();
  private readonly pointerCaptures = new Set<number>();

  addEventListener(type: string, handler: (event: any) => void): void {
    const set = this.listeners.get(type) ?? new Set();
    set.add(handler);
    this.listeners.set(type, set);
  }

  removeEventListener(type: string, handler: (event: any) => void): void {
    this.listeners.get(type)?.delete(handler);
  }

  emit(type: string, event: any): void {
    for (const handler of this.listeners.get(type) ?? []) {
      handler(event);
    }
  }

  setPointerCapture(pointerId: number): void {
    this.pointerCaptures.add(pointerId);
  }

  hasPointerCapture(pointerId: number): boolean {
    return this.pointerCaptures.has(pointerId);
  }

  releasePointerCapture(pointerId: number): void {
    this.pointerCaptures.delete(pointerId);
  }
}

beforeAll(() => {
  (globalThis as { WheelEvent?: { DOM_DELTA_PIXEL: number; DOM_DELTA_LINE: number } }).WheelEvent = {
    DOM_DELTA_PIXEL: 0,
    DOM_DELTA_LINE: 1
  };
});

function makePreventable<T extends object>(event: T): T & { preventDefault: ReturnType<typeof vi.fn> } {
  return {
    ...event,
    preventDefault: vi.fn()
  };
}

describe("@common/input iso view bindings", () => {
  it("routes middle-button drag into explicit pan drag commands", () => {
    const pointerTarget = new FakeTarget();
    const keyboardTarget = new FakeTarget();
    const view = {
      canvas: pointerTarget as unknown as HTMLCanvasElement,
      beginPanDrag: vi.fn(() => true),
      updatePanDrag: vi.fn(() => true),
      endPanDrag: vi.fn(() => true),
      panByCss: vi.fn(),
      zoomStepAtClient: vi.fn(),
      rotateQuarterTurns: vi.fn(),
      toggleZoomMode: vi.fn()
    };

    const detach = bindPixelPerfectIsoViewInput({
      view: view as unknown as any,
      pointerTarget: pointerTarget as unknown as HTMLElement,
      keyboardTarget: keyboardTarget as unknown as Window,
      enableTouch: false
    });

    pointerTarget.emit(
      "pointerdown",
      makePreventable({ button: 1, pointerId: 7, clientX: 100, clientY: 200 })
    );
    pointerTarget.emit(
      "pointermove",
      makePreventable({ pointerId: 7, clientX: 104, clientY: 205 })
    );
    pointerTarget.emit(
      "pointerup",
      makePreventable({ pointerId: 7, clientX: 104, clientY: 205 })
    );

    expect(view.beginPanDrag).toHaveBeenCalledWith(100, 200);
    expect(view.updatePanDrag).toHaveBeenCalledWith(104, 205);
    expect(view.endPanDrag).toHaveBeenCalled();

    detach();
  });

  it("routes trackpad wheel pan and keyboard shortcuts to explicit view commands", () => {
    const pointerTarget = new FakeTarget();
    const keyboardTarget = new FakeTarget();
    const view = {
      canvas: pointerTarget as unknown as HTMLCanvasElement,
      beginPanDrag: vi.fn(() => true),
      updatePanDrag: vi.fn(() => true),
      endPanDrag: vi.fn(() => true),
      panByCss: vi.fn(),
      zoomStepAtClient: vi.fn(),
      rotateQuarterTurns: vi.fn(),
      toggleZoomMode: vi.fn()
    };

    const detach = bindPixelPerfectIsoViewInput({
      view: view as unknown as any,
      pointerTarget: pointerTarget as unknown as HTMLElement,
      keyboardTarget: keyboardTarget as unknown as Window,
      enableTouch: false
    });

    pointerTarget.emit(
      "wheel",
      makePreventable({
        deltaMode: 0,
        deltaX: 2,
        deltaY: 3,
        shiftKey: false,
        ctrlKey: false,
        metaKey: false,
        clientX: 50,
        clientY: 60
      })
    );
    pointerTarget.emit(
      "wheel",
      makePreventable({
        deltaMode: 1,
        deltaX: 0,
        deltaY: -1,
        shiftKey: false,
        ctrlKey: false,
        metaKey: false,
        clientX: 10,
        clientY: 20
      })
    );

    keyboardTarget.emit("keydown", { code: "KeyQ", target: { tagName: "DIV", isContentEditable: false }, preventDefault: vi.fn() });
    keyboardTarget.emit("keydown", { code: "KeyE", target: { tagName: "DIV", isContentEditable: false }, preventDefault: vi.fn() });
    keyboardTarget.emit("keydown", { code: "KeyZ", target: { tagName: "DIV", isContentEditable: false }, preventDefault: vi.fn() });

    expect(view.panByCss).toHaveBeenCalled();
    expect(view.zoomStepAtClient).toHaveBeenCalled();
    expect(view.rotateQuarterTurns).toHaveBeenNthCalledWith(1, -1);
    expect(view.rotateQuarterTurns).toHaveBeenNthCalledWith(2, 1);
    expect(view.toggleZoomMode).toHaveBeenCalled();

    detach();
  });
});

describe("@common/input shared scissor stage bindings", () => {
  it("focuses hit pane and routes commands to pane targets without stage-owned listeners", () => {
    const pointerTarget = new FakeTarget();
    const keyboardTarget = new FakeTarget();
    const paneElement = {
      getBoundingClientRect: () => ({ left: 5, top: 6 })
    };
    const pane = {
      element: paneElement as unknown as HTMLElement,
      beginPanDrag: vi.fn(),
      updatePanDrag: vi.fn(() => true),
      endPanDrag: vi.fn(() => true),
      panByCss: vi.fn(),
      stepCameraZoomAtLocalCss: vi.fn(() => true),
      rotateQuarterTurns: vi.fn(),
      toggleZoomMode: vi.fn()
    };
    const getFocusedPaneId = vi.fn(() => "north");
    const setFocusedPaneId = vi.fn();
    const stage = {
      canvas: pointerTarget as unknown as HTMLCanvasElement,
      hitTestPane: vi.fn(() => ({ paneId: "north", localX: 1, localY: 2, rect: {} }))
    };
    const onFocusPaneId = vi.fn();

    const detach = bindSharedScissorStageInput({
      stage: stage as unknown as SharedScissorStage,
      pointerTarget: pointerTarget as unknown as HTMLElement,
      keyboardTarget: keyboardTarget as unknown as Window,
      onFocusPaneId,
      getFocusedPaneId,
      setFocusedPaneId,
      getPaneInputTarget: (paneId) => (paneId === "north" ? (pane as unknown as any) : null)
    });

    const pointerDownEvent = makePreventable({
      button: 1,
      pointerId: 7,
      clientX: 10,
      clientY: 20
    });
    const pointerMoveEvent = makePreventable({
      pointerId: 7,
      clientX: 12,
      clientY: 22
    });
    const pointerUpEvent = makePreventable({
      pointerId: 7,
      clientX: 12,
      clientY: 22
    });
    const wheelEvent = makePreventable({
      clientX: 10,
      clientY: 20,
      deltaMode: 0,
      deltaX: 2,
      deltaY: 3,
      shiftKey: false,
      ctrlKey: false,
      metaKey: false
    });

    pointerTarget.emit("pointerdown", pointerDownEvent);
    pointerTarget.emit("pointermove", pointerMoveEvent);
    pointerTarget.emit("pointerup", pointerUpEvent);
    pointerTarget.emit("wheel", wheelEvent);
    keyboardTarget.emit("keydown", { code: "KeyQ", target: { tagName: "DIV", isContentEditable: false }, preventDefault: vi.fn() });
    keyboardTarget.emit("keyup", { code: "KeyQ" });

    expect(setFocusedPaneId).toHaveBeenCalledWith("north");
    expect(onFocusPaneId).toHaveBeenCalledWith("north");
    expect(pane.beginPanDrag).toHaveBeenCalledWith(1, 2);
    expect(pane.updatePanDrag).toHaveBeenCalled();
    expect(pane.endPanDrag).toHaveBeenCalled();
    expect(pane.panByCss).toHaveBeenCalled();
    expect(pane.rotateQuarterTurns).toHaveBeenCalledWith(-1);
    expect(getFocusedPaneId).toHaveBeenCalled();

    detach();
    pointerTarget.emit("pointerdown", pointerDownEvent);
    expect(pane.beginPanDrag).toHaveBeenCalledTimes(1);
  });
});

type SharedScissorStage = import("@common/render").SharedScissorStage;
