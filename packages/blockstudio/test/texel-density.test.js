import { test } from "vitest";
import assert from "node:assert/strict";

import { deriveTextureProfile, normalizeGameRenderContract } from "../src/shared/texel-density.js";

test("normalizeGameRenderContract defaults to the confirmed forge low-res pixel contract", () => {
  const contract = normalizeGameRenderContract({});

  assert.equal(contract.baseUnitCm, 128);
  assert.deepEqual(contract.gamePixelsPerBaseUnit, {
    horizontal: 32,
    vertical: 16
  });
  assert.equal(contract.modelUnitsPerBaseUnit, 128);
  assert.equal(contract.densityAxis, "horizontal");
  assert.equal(contract.defaultDisplayScale, 2);
  assert.equal(contract.derived.centimetersPerGamePixel.horizontal, 4);
  assert.equal(contract.derived.centimetersPerGamePixel.vertical, 8);
  assert.equal(contract.derived.centimetersPerModelUnit, 1);
  assert.deepEqual(
    contract.derived.densityPresets.map((entry) => entry.density),
    [4, 8, 16]
  );
});

test("deriveTextureProfile recommends a centimeter-based default density", () => {
  const textureProfile = deriveTextureProfile({
    authoringUnitsPerBaseUnit: 128,
    wallSpan: 128,
    wallHeight: 280
  });

  assert.equal(textureProfile.texturePixelsPerGamePixel, 2);
  assert.equal(textureProfile.resolution, 140);
  assert.equal(textureProfile.uvWidth, 280);
  assert.equal(textureProfile.uvHeight, 280);
  assert.equal(textureProfile.densityLabel, "8x");
  assert.equal(textureProfile.centimetersPerTexturePixel.x, 2);
  assert.equal(textureProfile.gamePixelsPerTexturePixel.horizontal, 0.5);
});

test("deriveTextureProfile supports 4 texels per game pixel for detailed tilesets", () => {
  const textureProfile = deriveTextureProfile({
    authoringUnitsPerBaseUnit: 128,
    wallSpan: 128,
    wallHeight: 280,
    textureProfile: {
      texturePixelsPerGamePixel: 4
    }
  });

  assert.equal(textureProfile.texturePixelsPerGamePixel, 4);
  assert.equal(textureProfile.resolution, 280);
  assert.equal(textureProfile.density.x, 16);
  assert.equal(textureProfile.centimetersPerTexturePixel.x, 1);
});
