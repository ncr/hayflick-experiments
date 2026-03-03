import { describe, expect, it, vi } from "vitest";
import type { Viewport3dViewState } from "../forge/Viewport";
import { syncViewStateToViewports } from "./view-sync";

function makeState(): Viewport3dViewState {
  return {
    target: [1, 2, 3],
    distance: 4,
    yaw: Math.PI * 0.75,
    pitch: 1.2
  };
}

describe("forge-v2 view sync", () => {
  it("applies a shared view state to each linked viewport and skips null handles", () => {
    const state = makeState();
    const a = { setViewState: vi.fn() };
    const b = { setViewState: vi.fn() };

    syncViewStateToViewports(state, [a, null, undefined, b]);

    expect(a.setViewState).toHaveBeenCalledTimes(1);
    expect(a.setViewState).toHaveBeenCalledWith(state);
    expect(b.setViewState).toHaveBeenCalledTimes(1);
    expect(b.setViewState).toHaveBeenCalledWith(state);
  });
});

