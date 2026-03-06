import { describe, expect, it } from "vitest";

import { lifecycleToStageStatuses, stageStatusesToLifecycle } from "./forge-store";

describe("forge lifecycle mapping", () => {
  it("maps mesh-ready directly to ref+mesh without an intermediate approval stage", () => {
    expect(lifecycleToStageStatuses("mesh-ready")).toEqual({
      ref: "VALID",
      mesh: "VALID",
      phy: "EMPTY",
    });
  });

  it("maps physics-ready directly to all three visible stages", () => {
    expect(lifecycleToStageStatuses("physics-ready")).toEqual({
      ref: "VALID",
      mesh: "VALID",
      phy: "VALID",
    });
  });

  it("derives lifecycle from the visible stage state only", () => {
    expect(
      stageStatusesToLifecycle({
        ref: "VALID",
        mesh: "VALID",
        phy: "EMPTY",
      })
    ).toBe("mesh-ready");
    expect(
      stageStatusesToLifecycle({
        ref: "VALID",
        mesh: "VALID",
        phy: "VALID",
      })
    ).toBe("physics-ready");
  });
});
