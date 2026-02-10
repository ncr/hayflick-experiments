import { describe, expect, it } from "vitest";
import {
  createPanPhaseState,
  stepPanPhase
} from "./pan-phase";

function runLegacyRoundedPhase(
  deltas: number[],
  renderScale: number
): number[] {
  let remainder = 0;
  let cameraSteps = 0;
  const outputs: number[] = [];

  for (const delta of deltas) {
    remainder += delta;
    const step = Math.trunc(remainder / renderScale);
    if (step !== 0) {
      remainder -= step * renderScale;
      cameraSteps += step;
    }
    outputs.push(cameraSteps * renderScale + Math.round(remainder));
  }

  return outputs;
}

function runQuantizedPhase(
  deltas: number[],
  renderScale: number
): number[] {
  let state = createPanPhaseState();
  let cameraSteps = 0;
  const outputs: number[] = [];

  for (const delta of deltas) {
    const next = stepPanPhase(state, delta, 0, renderScale);
    state = next.state;
    cameraSteps += next.cameraStepX;
    outputs.push(cameraSteps * renderScale + state.remainderX);
  }

  return outputs;
}

describe("pixel-perfect-2to1 pan phase", () => {
  it("keeps exact screen-pixel decomposition for integer drag deltas", () => {
    let state = createPanPhaseState();
    let cameraSteps = 0;
    let cumulativeScreenPixels = 0;
    const renderScale = 4;

    for (let i = 0; i < 128; i += 1) {
      const next = stepPanPhase(state, 1, 0, renderScale);
      state = next.state;
      cameraSteps += next.cameraStepX;
      cumulativeScreenPixels += 1;

      expect(state.remainderX).toBeGreaterThanOrEqual(0);
      expect(state.remainderX).toBeLessThan(renderScale);
      expect(Number.isInteger(state.remainderX)).toBe(true);
      expect(Number.isInteger(cameraSteps)).toBe(true);

      const reconstructed = cameraSteps * renderScale + state.remainderX;
      expect(reconstructed).toBe(cumulativeScreenPixels);
    }
  });

  it("quantizes fractional pointer deltas to whole screen pixels without early +/-1 jumps", () => {
    const deltas = Array.from({ length: 32 }, () => 0.25);
    const legacy = runLegacyRoundedPhase(deltas, 4);
    const quantized = runQuantizedPhase(deltas, 4);

    let cumulativeRaw = 0;
    const quantizedExpected: number[] = [];
    for (const delta of deltas) {
      cumulativeRaw += delta;
      quantizedExpected.push(Math.trunc(cumulativeRaw));
    }

    // Legacy path moves early because rounding the floating remainder can jump
    // before a full screen-pixel delta has been accumulated.
    expect(legacy).not.toEqual(quantizedExpected);
    expect(quantized).toEqual(quantizedExpected);
  });
});

