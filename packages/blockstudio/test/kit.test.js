import { test } from "vitest";
import assert from "node:assert/strict";

import {
  SUPPORTED_MODULAR_KIT_KINDS,
  WALL_KIT_REQUIRED_PARTS,
  createKitDefinition,
  createModularKitDefinition,
  createVariantFromRequest,
  normalizeGroundKitSpec,
  normalizeModularKitSpec,
  normalizeWallKitSpec,
  validateKitSpec,
  validateModularKitSpec
} from "../src/shared/kit.js";

test("normalizeModularKitSpec defaults to wall_kit", () => {
  const spec = normalizeModularKitSpec({
    wallSpan: 128
  });

  assert.equal(spec.kind, "wall_kit");
  assert.deepEqual(SUPPORTED_MODULAR_KIT_KINDS, ["wall_kit", "ground"]);
});

test("normalizeWallKitSpec creates a repeatable window family", () => {
  const spec = normalizeWallKitSpec({
    baseUnit: 128,
    authoringUnitsPerBaseUnit: 128,
    wallSpan: 128,
    wallHeight: 280,
    windowFamilies: [
      {
        name: "wide_window",
        leftWidth: 16,
        middleWidth: 32,
        rightWidth: 16,
        repeatableMiddlePanels: 3,
        variants: [{ name: "fixed" }]
      }
    ]
  });

  const roles = new Set(spec.parts.map((part) => part.role).filter(Boolean));
  const leftWindow = spec.parts.find((part) => part.role === "window_left");
  const middleWindow = spec.parts.find((part) => part.role === "window_middle");
  const rightWindow = spec.parts.find((part) => part.role === "window_right");

  assert.equal(spec.windowFamilies[0].repeatableMiddlePanels, 3);
  assert.deepEqual(WALL_KIT_REQUIRED_PARTS.every((role) => roles.has(role)), true);
  assert.equal(spec.parts.some((part) => part.role === "floor_tile" && part.kind === "floor_tile"), true);
  assert.equal(spec.parts.some((part) => part.role === "window_left" && part.kind === "window_module"), true);
  assert.equal(spec.parts.some((part) => part.role === "window_middle" && part.articulation?.type === "fixed"), true);
  assert.equal(spec.parts.some((part) => part.role === "window_right" && part.kind === "window_module"), true);
  assert.equal(spec.parts.some((part) => part.name === "wall" && part.kind === "wall"), true);
  assert.equal(spec.parts.some((part) => part.name === "door" && part.kind === "door_wall"), true);
  assert.equal(spec.parts.some((part) => part.kind === "window_family"), false);
  assert.equal(spec.parts.some((part) => part.kind === "corner"), true);
  assert.equal(spec.parts.some((part) => part.kind === "end_cap"), false);
  assert.equal(spec.parts.length, 7);
  assert.deepEqual(leftWindow.dimensions, [128, 280, spec.wallThickness]);
  assert.equal(leftWindow.anchor.class, "edge_midpoint");
  assert.equal(leftWindow.logicalFootprint.type, "edge_run");
  assert.equal(leftWindow.logicalFootprint.runCells, 1);
  assert.deepEqual(leftWindow.meshEnvelope, [128, 280, spec.wallThickness]);
  assert.deepEqual(middleWindow.dimensions, [128, 280, spec.wallThickness]);
  assert.equal(middleWindow.anchor.class, "edge_midpoint");
  assert.deepEqual(middleWindow.meshEnvelope, [128, 280, spec.wallThickness]);
  assert.deepEqual(rightWindow.dimensions, [128, 280, spec.wallThickness]);
  assert.equal(rightWindow.anchor.class, "edge_midpoint");
  assert.deepEqual(rightWindow.meshEnvelope, [128, 280, spec.wallThickness]);
  assert.equal(spec.renderContract.baseUnitCm, 128);
  assert.equal(spec.textureProfile.densityLabel, "8x");
  assert.equal(spec.textureProfile.resolution, 140);
  assert.equal(spec.anchorPolicy.snap.wall, "edge_midpoint");
});

test("createModularKitDefinition stores the explicit kit kind", () => {
  const kit = createModularKitDefinition({
    kind: "wall_kit",
    spec: { name: "cozy_room_kit" },
    styleProfile: { id: "style_1" }
  });

  assert.equal(kit.kind, "wall_kit");
  assert.equal(kit.summary.kind, "wall_kit");
});

test("createVariantFromRequest appends a new articulated window variant", () => {
  const baseKit = createKitDefinition({
    spec: {
      windowFamilies: [
        {
          name: "plain_window",
          variants: [{ name: "fixed" }]
        }
      ]
    },
    styleProfile: {
      id: "style_1"
    }
  });

  const nextKit = createVariantFromRequest(baseKit, {
    familyName: "plain_window",
    variant: {
      name: "casement_left",
      articulation: { type: "casement_left" }
    }
  });

  const family = nextKit.spec.windowFamilies.find((entry) => entry.name === "plain_window");
  assert.equal(family.variants.length, 2);
  assert.equal(family.variants[1].articulation.pivotRole, "hinge_edge");
});

test("validateKitSpec rejects oversize doors", () => {
  const spec = normalizeWallKitSpec({
    wallSpan: 128,
    door: {
      width: 128
    }
  });

  const issues = validateKitSpec(spec);
  assert.equal(issues.length > 0, true);
});

test("validateKitSpec allows multi-cell windows built from modular segments", () => {
  const spec = normalizeWallKitSpec({
    wallSpan: 128,
    windowFamilies: [
      {
        name: "panorama",
        leftWidth: 16,
        middleWidth: 48,
        rightWidth: 16,
        variants: [
          {
            name: "fixed",
            repeatableMiddlePanels: 3,
            articulation: { type: "fixed" }
          }
        ]
      }
    ]
  });

  const issues = validateKitSpec(spec);
  assert.deepEqual(issues, []);
});

test("validateKitSpec rejects end-window wall segments that consume a full tile", () => {
  const spec = normalizeWallKitSpec({
    wallSpan: 128,
    windowFamilies: [
      {
        name: "broken_window",
        leftWidth: 128,
        middleWidth: 32,
        rightWidth: 16,
        variants: [{ name: "fixed" }]
      }
    ]
  });

  const issues = validateKitSpec(spec);
  assert.deepEqual(issues, [
    'Window family "broken_window" left wall segment must be narrower than one logical wall tile.'
  ]);
});

test("normalizeGroundKitSpec creates parts for each tile", () => {
  const spec = normalizeGroundKitSpec({
    name: "ground_tiles",
    tiles: [{ name: "grass" }, { name: "concrete_walk" }, { name: "asphalt" }]
  });

  assert.equal(spec.kind, "ground");
  assert.equal(spec.tiles.length, 3);
  assert.deepEqual(spec.tiles.map((t) => t.name), ["grass", "concrete_walk", "asphalt"]);
  assert.equal(spec.parts.length, 3);
  assert.deepEqual(spec.parts.map((p) => p.name).sort(), ["asphalt", "concrete_walk", "grass"]);
  for (const part of spec.parts) {
    assert.equal(part.kind, "floor_tile");
    assert.deepEqual(part.dimensions, [128, 6, 128]);
  }
});

test("validateModularKitSpec rejects duplicate ground tile names", () => {
  const spec = normalizeGroundKitSpec({
    tiles: [{ name: "grass" }, { name: "grass" }]
  });
  const issues = validateModularKitSpec(spec);
  assert.equal(issues.length, 1);
  assert.ok(issues[0].includes("Duplicate"));
});

test("validateModularKitSpec delegates to the wall kit validator", () => {
  const spec = normalizeModularKitSpec({
    kind: "wall_kit",
    wallSpan: 128,
    door: {
      width: 128
    }
  });

  const issues = validateModularKitSpec(spec);
  assert.equal(issues.length > 0, true);
});
