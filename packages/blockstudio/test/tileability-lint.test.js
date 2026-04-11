import { test } from "vitest";
import assert from "node:assert/strict";

import { createKitDefinition, createModularKitDefinition } from "../src/shared/kit.js";
import { lintKitTileability } from "../src/shared/tileability-lint.js";

function createCleanWallKit() {
  return createKitDefinition({
    spec: {
      name: "lint_wall_kit",
      baseUnit: 128,
      authoringUnitsPerBaseUnit: 128,
      wallSpan: 128,
      wallHeight: 280,
      wallThickness: 32,
      floorThickness: 6,
      door: {
        width: 90,
        height: 220,
        frameThickness: 16,
        frameProtrusion: 3,
        thickness: 5,
        hingeSide: "left"
      },
      windowFamilies: [
        {
          name: "vertical_black_panel",
          leftWidth: 16,
          middleWidth: 32,
          rightWidth: 16,
          sillHeight: 0,
          openingHeight: 280,
          glassThickness: 4,
          variants: [{ name: "fixed", articulation: { type: "fixed" } }]
        }
      ]
    },
    styleProfile: { id: "lint_style" }
  });
}

function createCleanGroundKit() {
  return createModularKitDefinition({
    kind: "ground",
    spec: {
      name: "lint_ground_kit",
      tiles: [{ name: "grass" }, { name: "asphalt" }]
    },
    styleProfile: { id: "lint_style" }
  });
}

test("clean wall kit has zero tileability issues", () => {
  const kit = createCleanWallKit();
  assert.deepEqual(lintKitTileability(kit), []);
});

test("clean ground kit has zero tileability issues", () => {
  const kit = createCleanGroundKit();
  assert.deepEqual(lintKitTileability(kit), []);
});

test("corner overhang is detected when meshEnvelope exceeds baseUnit", () => {
  const kit = createCleanWallKit();
  const corner = kit.partCatalog.find((part) => part.kind === "corner");
  assert.ok(corner, "kit must include a corner part");
  const [x, y, z] = corner.meshEnvelope;
  corner.meshEnvelope = [x + 16, y, z + 16];

  const issues = lintKitTileability(kit);
  const cornerIssues = issues.filter((msg) => msg.includes("corner"));
  assert.ok(
    cornerIssues.some((msg) => msg.includes("overhangs") || msg.includes("exceeds baseUnit")),
    `expected corner overhang issue, got: ${JSON.stringify(issues)}`
  );
});

test("wall run discontinuity is detected when meshEnvelope width drifts from wallSpan", () => {
  const kit = createCleanWallKit();
  const wall = kit.partCatalog.find((part) => part.name === "wall");
  const [, y, z] = wall.meshEnvelope;
  wall.meshEnvelope = [wall.meshEnvelope[0] - 4, y, z];

  const issues = lintKitTileability(kit);
  assert.ok(
    issues.some((msg) => msg.startsWith("wall:") && (msg.includes("gap") || msg.includes("does not match wallSpan"))),
    `expected wall gap issue, got: ${JSON.stringify(issues)}`
  );
});

test("wall run overlap is detected when meshEnvelope width exceeds wallSpan", () => {
  const kit = createCleanWallKit();
  const wall = kit.partCatalog.find((part) => part.name === "wall");
  const [, y, z] = wall.meshEnvelope;
  wall.meshEnvelope = [wall.meshEnvelope[0] + 4, y, z];

  const issues = lintKitTileability(kit);
  assert.ok(
    issues.some((msg) => msg.startsWith("wall:") && (msg.includes("overlap") || msg.includes("does not match wallSpan"))),
    `expected wall overlap issue, got: ${JSON.stringify(issues)}`
  );
});

test("window family trim widths that exceed wallSpan are flagged", () => {
  const kit = createCleanWallKit();
  kit.spec.windowFamilies[0].leftWidth = 64;
  kit.spec.windowFamilies[0].middleWidth = 64;
  kit.spec.windowFamilies[0].rightWidth = 64;

  const issues = lintKitTileability(kit);
  assert.ok(
    issues.some((msg) => msg.includes("window family") && msg.includes("exceed wallSpan")),
    `expected window trim overflow issue, got: ${JSON.stringify(issues)}`
  );
});

test("ground tile envelope mismatch is detected", () => {
  const kit = createCleanGroundKit();
  const tile = kit.partCatalog[0];
  tile.meshEnvelope = [tile.meshEnvelope[0] - 8, tile.meshEnvelope[1], tile.meshEnvelope[2]];

  const issues = lintKitTileability(kit);
  assert.ok(
    issues.some((msg) => msg.startsWith(`${tile.name}:`) && msg.includes("must be")),
    `expected floor tile envelope mismatch, got: ${JSON.stringify(issues)}`
  );
});
