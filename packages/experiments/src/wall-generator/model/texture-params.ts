import type { MaterialParams, TextureShaderUniforms, WallDimensions, TextureResolution } from "./types";

/**
 * Compute shader uniforms from material params, dimensions, and resolution.
 * Pure function — no Three.js types.
 */
export function computeShaderUniforms(
  material: MaterialParams,
  dims: WallDimensions,
  resolution: TextureResolution,
): TextureShaderUniforms {
  // Aspect ratio for correct texture tiling
  const aspect = dims.width / dims.height;

  return {
    uBaseColor: [...material.baseColor],
    uAccentColor: [...material.accentColor],
    uPatternScale: material.patternScale,
    uWeathering: material.weathering,
    uGrimeIntensity: material.grimeIntensity,
    uCrackDensity: material.crackDensity,
    uSeed: material.seed,
    uAspect: aspect,
  };
}

/**
 * Map a MaterialKind to its fragment shader import key.
 */
export function shaderKeyForMaterial(kind: MaterialParams["kind"]): string {
  return kind; // keys match file names: "brick" → brick.frag.glsl
}
