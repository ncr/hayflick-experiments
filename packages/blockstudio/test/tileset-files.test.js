import { test } from "vitest";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { WALL_KIT_REQUIRED_PARTS } from "../src/shared/kit.js";
import {
  buildWallKitSpecFromTilesetProfile,
  readTilesetProfile,
  saveTilesetProfile
} from "../src/server/tileset-files.js";

test("saveTilesetProfile persists normalized kitSpec data without legacy pivot fields", () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "blockstudio-profile-"));
  const saved = saveTilesetProfile({
    repoRoot,
    tilesetId: "desert_house",
    name: "Desert House",
    profile: {
      pivots: {
        placement: "bottom_left_back"
      },
      geometry: {
        tileWidth: 128,
        wallHeight: 280,
        wallThickness: 32
      },
      kitSpec: {
        catalogWindowSource: {
          familyName: "vertical_black_panel",
          variantName: "fixed"
        },
        windowFamilies: [
          {
            name: "vertical_black_panel",
            leftWidth: 16,
            middleWidth: 32,
            rightWidth: 16,
            sillHeight: 0,
            openingHeight: 280,
            variants: [{ name: "fixed" }]
          }
        ]
      }
    }
  });

  const savedJson = JSON.parse(fs.readFileSync(saved.layout.metadataFile, "utf8"));
  assert.equal(savedJson.geometry.wallSpan, 128);
  assert.equal("tileWidth" in savedJson.geometry, false);
  assert.equal("pivots" in savedJson, false);
  assert.equal(savedJson.kitSpec.catalogWindowSource.familyName, "vertical_black_panel");
  assert.equal(savedJson.kitSpec.windowFamilies[0].name, "vertical_black_panel");
  assert.equal(savedJson.kitSpec.windowFamilies[0].variants[0].name, "fixed");
});

test("buildWallKitSpecFromTilesetProfile reconstructs a normalized wall kit spec", () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "blockstudio-build-spec-"));
  saveTilesetProfile({
    repoRoot,
    tilesetId: "desert_house",
    name: "Desert House",
    profile: {
      geometry: {
        baseUnit: 128,
        authoringUnitsPerBaseUnit: 128,
        wallSpan: 128,
        wallHeight: 280,
        wallThickness: 32,
        floorThickness: 6
      },
      kitSpec: {
        catalogWindowSource: {
          familyName: "vertical_black_panel",
          variantName: "fixed"
        },
        windowFamilies: [
          {
            name: "vertical_black_panel",
            leftWidth: 16,
            middleWidth: 32,
            rightWidth: 16,
            sillHeight: 0,
            openingHeight: 280,
            variants: [
              { name: "fixed", articulation: { type: "fixed" } },
              { name: "casement_left", articulation: { type: "casement_left" } }
            ]
          }
        ]
      }
    }
  });

  const { layout, profile } = readTilesetProfile({
    repoRoot,
    tilesetId: "desert_house",
    name: "Desert House"
  });
  const spec = buildWallKitSpecFromTilesetProfile(profile, { layout });
  const roles = new Set(spec.parts.map((part) => part.role).filter(Boolean));
  const leftWindow = spec.parts.find((part) => part.role === "window_left");
  const middleWindow = spec.parts.find((part) => part.role === "window_middle");
  const rightWindow = spec.parts.find((part) => part.role === "window_right");

  assert.deepEqual(profile.requiredParts, WALL_KIT_REQUIRED_PARTS);
  assert.equal(spec.wallSpan, 128);
  assert.equal(spec.authoringUnitsPerBaseUnit, 128);
  assert.equal(spec.anchorPolicy.snap.wall, "edge_midpoint");
  assert.equal(spec.catalogWindowSource.familyName, "vertical_black_panel");
  assert.equal(spec.windowFamilies[0].name, "vertical_black_panel");
  assert.equal(spec.windowFamilies[0].variants[1].articulation.type, "casement_left");
  assert.equal(WALL_KIT_REQUIRED_PARTS.every((role) => roles.has(role)), true);
  assert.deepEqual(leftWindow.meshEnvelope, [128, 280, 32]);
  assert.deepEqual(middleWindow.dimensions, [128, 280, 32]);
  assert.deepEqual(middleWindow.meshEnvelope, [128, 280, 32]);
  assert.equal(middleWindow.logicalFootprint.type, "edge_run");
  assert.equal(middleWindow.anchor.class, "edge_midpoint");
  assert.deepEqual(rightWindow.meshEnvelope, [128, 280, 32]);
  assert.equal(spec.includeEndCaps, false);
});
