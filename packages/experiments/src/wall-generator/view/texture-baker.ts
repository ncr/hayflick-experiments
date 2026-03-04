import * as THREE from "three";
import type { MaterialParams, TextureResolution, WallDimensions } from "../model/types";
import { computeShaderUniforms } from "../model/texture-params";

import bakeVertexShader from "../shaders/bake-vertex.glsl";
import brickFrag from "../shaders/brick.frag.glsl";
import plasterFrag from "../shaders/plaster.frag.glsl";
import concreteFrag from "../shaders/concrete.frag.glsl";
import woodFrag from "../shaders/wood-paneling.frag.glsl";
import corrugatedFrag from "../shaders/corrugated-metal.frag.glsl";
import chainLinkFrag from "../shaders/chain-link.frag.glsl";

const FRAGMENT_SHADERS: Record<MaterialParams["kind"], string> = {
  brick: brickFrag,
  plaster: plasterFrag,
  concrete: concreteFrag,
  "wood-paneling": woodFrag,
  "corrugated-metal": corrugatedFrag,
  "chain-link": chainLinkFrag,
};

/**
 * Create a ShaderMaterial for live preview on the mesh.
 */
export function createPreviewMaterial(
  material: MaterialParams,
  dims: WallDimensions,
  resolution: TextureResolution,
): THREE.ShaderMaterial {
  const uniforms = computeShaderUniforms(material, dims, resolution);
  const fragSrc = FRAGMENT_SHADERS[material.kind];

  return new THREE.ShaderMaterial({
    vertexShader: `
      varying vec2 vUv;
      void main() {
        vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: fragSrc,
    uniforms: {
      uBaseColor: { value: new THREE.Vector3(...uniforms.uBaseColor) },
      uAccentColor: { value: new THREE.Vector3(...uniforms.uAccentColor) },
      uPatternScale: { value: uniforms.uPatternScale },
      uWeathering: { value: uniforms.uWeathering },
      uGrimeIntensity: { value: uniforms.uGrimeIntensity },
      uCrackDensity: { value: uniforms.uCrackDensity },
      uSeed: { value: uniforms.uSeed },
      uAspect: { value: uniforms.uAspect },
    },
    side: THREE.DoubleSide,
  });
}

/**
 * Update an existing preview material's uniforms (avoids recreating shader).
 */
export function updatePreviewMaterialUniforms(
  mat: THREE.ShaderMaterial,
  material: MaterialParams,
  dims: WallDimensions,
  resolution: TextureResolution,
) {
  const uniforms = computeShaderUniforms(material, dims, resolution);
  mat.uniforms.uBaseColor.value.set(...uniforms.uBaseColor);
  mat.uniforms.uAccentColor.value.set(...uniforms.uAccentColor);
  mat.uniforms.uPatternScale.value = uniforms.uPatternScale;
  mat.uniforms.uWeathering.value = uniforms.uWeathering;
  mat.uniforms.uGrimeIntensity.value = uniforms.uGrimeIntensity;
  mat.uniforms.uCrackDensity.value = uniforms.uCrackDensity;
  mat.uniforms.uSeed.value = uniforms.uSeed;
  mat.uniforms.uAspect.value = uniforms.uAspect;
}

/**
 * Check if material kind changed (requires new shader material).
 */
export function materialKindChanged(
  mat: THREE.ShaderMaterial,
  newKind: MaterialParams["kind"],
): boolean {
  const currentFrag = mat.fragmentShader;
  const newFrag = FRAGMENT_SHADERS[newKind];
  return currentFrag !== newFrag;
}

/**
 * Bake the procedural texture to a PNG Uint8Array.
 * Renders shader to an offscreen RenderTarget, reads pixels back.
 */
export function bakeTexture(
  renderer: THREE.WebGLRenderer,
  material: MaterialParams,
  dims: WallDimensions,
  resolution: TextureResolution,
): Uint8Array {
  const fragSrc = FRAGMENT_SHADERS[material.kind];
  const uniforms = computeShaderUniforms(material, dims, resolution);

  // Fullscreen quad scene
  const bakeScene = new THREE.Scene();
  const bakeCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const quadGeo = new THREE.PlaneGeometry(2, 2);
  const bakeMat = new THREE.ShaderMaterial({
    vertexShader: bakeVertexShader,
    fragmentShader: fragSrc,
    uniforms: {
      uBaseColor: { value: new THREE.Vector3(...uniforms.uBaseColor) },
      uAccentColor: { value: new THREE.Vector3(...uniforms.uAccentColor) },
      uPatternScale: { value: uniforms.uPatternScale },
      uWeathering: { value: uniforms.uWeathering },
      uGrimeIntensity: { value: uniforms.uGrimeIntensity },
      uCrackDensity: { value: uniforms.uCrackDensity },
      uSeed: { value: uniforms.uSeed },
      uAspect: { value: uniforms.uAspect },
    },
  });

  const quad = new THREE.Mesh(quadGeo, bakeMat);
  bakeScene.add(quad);

  // Render to target
  const rt = new THREE.WebGLRenderTarget(resolution, resolution, {
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    format: THREE.RGBAFormat,
    type: THREE.UnsignedByteType,
  });

  renderer.setRenderTarget(rt);
  renderer.render(bakeScene, bakeCamera);
  renderer.setRenderTarget(null);

  // Read pixels
  const pixels = new Uint8Array(resolution * resolution * 4);
  renderer.readRenderTargetPixels(rt, 0, 0, resolution, resolution, pixels);

  // Cleanup
  rt.dispose();
  quadGeo.dispose();
  bakeMat.dispose();

  return pixels;
}

/**
 * Convert raw RGBA pixels to PNG using canvas.
 */
export async function pixelsToPng(
  pixels: Uint8Array,
  resolution: number,
): Promise<Uint8Array> {
  const canvas = document.createElement("canvas");
  canvas.width = resolution;
  canvas.height = resolution;
  const ctx = canvas.getContext("2d")!;

  // WebGL pixels are bottom-up, flip vertically
  const imageData = ctx.createImageData(resolution, resolution);
  for (let y = 0; y < resolution; y++) {
    const srcRow = (resolution - 1 - y) * resolution * 4;
    const dstRow = y * resolution * 4;
    for (let x = 0; x < resolution * 4; x++) {
      imageData.data[dstRow + x] = pixels[srcRow + x];
    }
  }
  ctx.putImageData(imageData, 0, 0);

  const blob = await new Promise<Blob>((resolve) =>
    canvas.toBlob((b) => resolve(b!), "image/png"),
  );
  return new Uint8Array(await blob.arrayBuffer());
}
