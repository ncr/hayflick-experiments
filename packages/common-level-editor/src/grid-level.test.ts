import { describe, expect, it } from "vitest";
import { createMutableGridLevelResource } from "./grid-level";

describe("createMutableGridLevelResource", () => {
  it("reads and writes blocked state with bounds and coordinate mapping", () => {
    const level = createMutableGridLevelResource({
      id: "grid",
      version: 1,
      width: 4,
      height: 3,
      blockedCells: [{ x: 1, y: 1 }]
    });

    expect(level.isBlocked(1.1, 1.1)).toBe(true);
    expect(level.isBlocked(0.1, 1.1)).toBe(false);
    expect(level.isBlocked(-1, 0)).toBe(true);

    level.setBlocked(0, 2, true);
    expect(level.getBlocked(0, 2)).toBe(true);

    level.setBlocked(0, 2, false);
    expect(level.getBlocked(0, 2)).toBe(false);
  });

  it("supports custom world-to-cell projection", () => {
    const level = createMutableGridLevelResource({
      id: "projected",
      version: 1,
      width: 2,
      height: 2,
      blockedCells: [{ x: 1, y: 0 }],
      toCell(x, y) {
        return { x: Math.floor((x + 10) / 5), y: Math.floor((y + 10) / 5) };
      }
    });

    expect(level.isBlocked(-2, -9)).toBe(true);
    expect(level.isBlocked(-8, -9)).toBe(false);
  });
});
