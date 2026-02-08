import { describe, expect, it } from "vitest";
import { EventBus } from "./events";

describe("EventBus", () => {
  it("queues, drains, and clears frame events explicitly", () => {
    const bus = new EventBus();
    bus.emit({ type: "Moved", e: 1 });
    bus.emit({ type: "BumpedWall", e: 2 });

    expect(bus.drain()).toEqual([
      { type: "Moved", e: 1 },
      { type: "BumpedWall", e: 2 }
    ]);
    expect(bus.drain()).toEqual([]);

    bus.emit({ type: "Moved", e: 3 });
    bus.clear();
    expect(bus.drain()).toEqual([]);
  });
});
