import { describe, it, expect } from "vitest";
import { computeShaderUniforms, shaderKeyForMaterial } from "./texture-params";
import { DEFAULT_MATERIAL, DEFAULT_DIMENSIONS } from "./piece-catalog";

describe("computeShaderUniforms", () => {
  it("computes correct aspect ratio", () => {
    const uniforms = computeShaderUniforms(DEFAULT_MATERIAL, { width: 2, height: 1, thickness: 0.2 }, 512);
    expect(uniforms.uAspect).toBe(2);
  });

  it("passes through material values", () => {
    const uniforms = computeShaderUniforms(DEFAULT_MATERIAL, DEFAULT_DIMENSIONS, 512);
    expect(uniforms.uBaseColor).toEqual([...DEFAULT_MATERIAL.baseColor]);
    expect(uniforms.uPatternScale).toBe(DEFAULT_MATERIAL.patternScale);
    expect(uniforms.uSeed).toBe(DEFAULT_MATERIAL.seed);
  });
});

describe("shaderKeyForMaterial", () => {
  it("returns material kind as key", () => {
    expect(shaderKeyForMaterial("brick")).toBe("brick");
    expect(shaderKeyForMaterial("chain-link")).toBe("chain-link");
  });
});
