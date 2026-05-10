import { describe, expect, it, vi } from "vitest";
import { createKnobRegistry } from "./createKnobRegistry";

describe("createKnobRegistry", () => {
  it("number knob returns a getter that follows updates", () => {
    const registry = createKnobRegistry();
    const get = registry.number("speed", { min: 0, max: 10, default: 3 });
    expect(get()).toBe(3);

    const entry = registry.entries().find((e) => e.spec.key === "speed")!;
    entry.set(7);
    expect(get()).toBe(7);
  });

  it("toggle and select knobs work", () => {
    const registry = createKnobRegistry();
    const getToggle = registry.toggle("flag", { default: true });
    const getMode = registry.select("mode", { options: ["a", "b"] as const, default: "a" });

    expect(getToggle()).toBe(true);
    expect(getMode()).toBe("a");

    const flagEntry = registry.entries().find((e) => e.spec.key === "flag")!;
    const modeEntry = registry.entries().find((e) => e.spec.key === "mode")!;
    flagEntry.set(false);
    modeEntry.set("b");

    expect(getToggle()).toBe(false);
    expect(getMode()).toBe("b");
  });

  it("registering twice is a no-op (keeps existing value + spec)", () => {
    const registry = createKnobRegistry();
    registry.number("speed", { min: 0, max: 10, default: 3 });
    const entry = registry.entries().find((e) => e.spec.key === "speed")!;
    entry.set(7);

    const get2 = registry.number("speed", { min: 0, max: 10, default: 3 });
    expect(get2()).toBe(7);
  });

  it("subscribe fires on register and on value change; unsubscribe stops it", () => {
    const registry = createKnobRegistry();
    const listener = vi.fn();
    const unsubscribe = registry.subscribe(listener);

    registry.number("a", { min: 0, max: 1, default: 0 });
    expect(listener).toHaveBeenCalledTimes(1);

    const entry = registry.entries().find((e) => e.spec.key === "a")!;
    entry.set(0.5);
    expect(listener).toHaveBeenCalledTimes(2);

    unsubscribe();
    entry.set(0.8);
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("entries() returns a stable snapshot until a change invalidates it", () => {
    const registry = createKnobRegistry();
    registry.number("a", { min: 0, max: 1, default: 0 });
    const snap1 = registry.entries();
    const snap2 = registry.entries();
    expect(snap1).toBe(snap2);

    snap1[0].set(0.5);
    const snap3 = registry.entries();
    expect(snap3).not.toBe(snap1);
  });
});
