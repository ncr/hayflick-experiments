import { describe, expect, it, vi } from "vitest";
import { attachTouchGestures } from "./touch-gestures";

class FakeTarget {
  style = { touchAction: "" };
  private readonly listeners = new Map<string, Set<(event: any) => void>>();

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
}

function touch(identifier: number, x: number, y: number) {
  return { identifier, clientX: x, clientY: y };
}

function touchEvent(changedTouches: Array<{ identifier: number; clientX: number; clientY: number }>) {
  return {
    changedTouches,
    preventDefault: vi.fn()
  };
}

describe("@common/input touch gestures", () => {
  it("emits pan start/move/end and restores touch-action on cleanup", () => {
    const target = new FakeTarget();
    target.style.touchAction = "manipulation";
    const onPanStart = vi.fn();
    const onPan = vi.fn();
    const onPanEnd = vi.fn();

    const detach = attachTouchGestures(target as unknown as HTMLElement, {
      onPanStart,
      onPan,
      onPanEnd
    });

    expect(target.style.touchAction).toBe("none");

    target.emit("touchstart", touchEvent([touch(1, 10, 20)]));
    target.emit("touchmove", touchEvent([touch(1, 13, 25)]));
    target.emit("touchend", touchEvent([touch(1, 13, 25)]));

    expect(onPanStart).toHaveBeenCalledTimes(1);
    expect(onPan).toHaveBeenCalledWith(3, 5);
    expect(onPanEnd).toHaveBeenCalledTimes(1);

    detach();
    expect(target.style.touchAction).toBe("manipulation");
  });

  it("emits pinch scale deltas for two-finger moves", () => {
    const target = new FakeTarget();
    const onPinch = vi.fn();

    const detach = attachTouchGestures(target as unknown as HTMLElement, { onPinch });

    target.emit("touchstart", touchEvent([touch(1, 0, 0), touch(2, 10, 0)]));
    target.emit("touchmove", touchEvent([touch(2, 20, 0)]));

    expect(onPinch).toHaveBeenCalled();
    const [scaleDelta] = onPinch.mock.calls[0] ?? [];
    expect(scaleDelta).toBeCloseTo(2, 6);

    detach();
  });
});
