import { describe, expect, it } from "vitest";
import {
  createAssetRegistry,
  resolveAssetOptions,
  validateAssetMetadata,
  type RenderableAsset
} from "./asset-contract";

const renderable = {
  node: {} as never,
  dispose() {
    return undefined;
  }
};

function asset(id: string): RenderableAsset {
  return {
    metadata: {
      id,
      label: id,
      kind: "scenery",
      creates: "object3d"
    },
    create() {
      return { renderable };
    }
  };
}

describe("asset contract", () => {
  it("validates the small required metadata surface", () => {
    expect(
      validateAssetMetadata({
        id: "waystation.ground",
        label: "Ground",
        kind: "scenery",
        creates: "object3d",
        defaults: { visible: true },
        requires: ["building"]
      })
    ).toEqual({
      id: "waystation.ground",
      label: "Ground",
      kind: "scenery",
      creates: "object3d",
      defaults: { visible: true },
      requires: ["building"]
    });
  });

  it("rejects malformed metadata and duplicate asset ids", () => {
    expect(() => validateAssetMetadata({})).toThrow(
      'Asset metadata field "id" must be a non-empty string.'
    );
    expect(() =>
      validateAssetMetadata({
        id: "bad",
        label: "Bad",
        kind: "unknown",
        creates: "object3d"
      })
    ).toThrow('Asset metadata field "kind" is not supported: unknown');
    expect(() => createAssetRegistry([asset("a"), asset("a")])).toThrow(
      "Duplicate renderable asset id: a"
    );
  });

  it("reports missing asset references directly", () => {
    const registry = createAssetRegistry([asset("known")]);

    expect(registry.require("known").metadata.id).toBe("known");
    expect(() => registry.require("missing")).toThrow(
      "Unknown renderable asset: missing"
    );
  });

  it("merges asset defaults with placement options", () => {
    expect(
      resolveAssetOptions(
        {
          id: "asset",
          label: "Asset",
          kind: "effect",
          creates: "object3d",
          defaults: { building: "building", enabled: true }
        },
        { enabled: false }
      )
    ).toEqual({ building: "building", enabled: false });
  });
});
