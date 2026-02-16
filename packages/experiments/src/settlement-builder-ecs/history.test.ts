import { describe, expect, it } from "vitest";
import { createHistoryController } from "./history";

describe("settlement history", () => {
  it("undo/redo follows linear stack behavior", () => {
    const history = createHistoryController<number>({
      maxEntries: 5,
      clone: (value) => value
    });

    history.push(0);
    history.push(1);

    expect(history.canUndo()).toBe(true);
    expect(history.undo(2)).toBe(1);
    expect(history.undo(1)).toBe(0);
    expect(history.undo(0)).toBeNull();

    expect(history.canRedo()).toBe(true);
    expect(history.redo(0)).toBe(1);
    expect(history.redo(1)).toBe(2);
    expect(history.redo(2)).toBeNull();
  });

  it("drops oldest entries when bounded", () => {
    const history = createHistoryController<number>({
      maxEntries: 2,
      clone: (value) => value
    });

    history.push(1);
    history.push(2);
    history.push(3);

    expect(history.undo(4)).toBe(3);
    expect(history.undo(3)).toBe(2);
    expect(history.undo(2)).toBeNull();
  });
});
