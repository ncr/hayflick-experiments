import { describe, expect, it } from "vitest";
import { buildWallSegmentSpecs } from "./wall-segments";

describe("segmented wall edge suppression", () => {
  it("marks only internal segment ends as suppressed", () => {
    expect(buildWallSegmentSpecs(3, 1)).toEqual([
      { index: 0, centerX: -1, suppressMinX: false, suppressMaxX: true },
      { index: 1, centerX: 0, suppressMinX: true, suppressMaxX: true },
      { index: 2, centerX: 1, suppressMinX: true, suppressMaxX: false }
    ]);
  });

  it("rejects non-positive wall segment layouts", () => {
    expect(() => buildWallSegmentSpecs(0, 1)).toThrow("positive integer");
    expect(() => buildWallSegmentSpecs(3, 0)).toThrow("positive");
  });
});
