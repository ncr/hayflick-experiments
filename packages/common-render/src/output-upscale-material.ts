import * as THREE from "three";

const UPSCALE_VS = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`;

// Smooth pixel-perfect sampling: crisp texel interiors with 1-device-pixel
// transitions at texel boundaries. Eliminates shimmer when the viewport shifts
// by sub-texel amounts while preserving sharp upscaled pixels everywhere else.
const UPSCALE_FS = /* glsl */ `
  precision highp float;
  uniform sampler2D uSource;
  uniform vec2 uContentScale;
  uniform vec2 uContentOffset;
  uniform float uZoom;
  uniform vec2 uSourceSize;
  uniform vec2 uZoomPivot;
  uniform float uEffectiveScale;
  uniform float uSmoothSampling;
  varying vec2 vUv;
  void main() {
    vec2 sampleUv = (vUv - uContentOffset) / uContentScale;
    sampleUv = (sampleUv - uZoomPivot) / max(0.0001, uZoom) + uZoomPivot;
    sampleUv = clamp(sampleUv, vec2(0.0), vec2(1.0));
    vec2 tc = sampleUv * uSourceSize;
    vec2 fl = floor(tc - 0.5) + 0.5;
    if (uSmoothSampling < 0.5) {
      gl_FragColor = texture2D(uSource, fl / uSourceSize);
      return;
    }
    vec2 f = tc - fl;
    f = clamp((f - 0.5) * uEffectiveScale + 0.5, 0.0, 1.0);
    gl_FragColor = texture2D(uSource, (fl + f) / uSourceSize);
  }
`;

export type OutputUpscaleConfig = {
  source: THREE.Texture;
  smoothPixelTransitions: boolean;
};

/**
 * Upscales the low-resolution render target onto the final output viewport.
 *
 * When `smoothPixelTransitions` is on, texel boundaries get a 1-device-pixel
 * transition band so sub-texel camera shifts don't flicker; otherwise the
 * sample is pure nearest-neighbour.
 */
export class OutputUpscaleMaterial extends THREE.ShaderMaterial {
  constructor(config: OutputUpscaleConfig) {
    super({
      uniforms: {
        uSource: { value: config.source },
        uContentScale: { value: new THREE.Vector2(1, 1) },
        uContentOffset: { value: new THREE.Vector2(0, 0) },
        uZoom: { value: 1 },
        uSourceSize: { value: new THREE.Vector2(1, 1) },
        uZoomPivot: { value: new THREE.Vector2(0.5, 0.5) },
        uEffectiveScale: { value: 1 },
        uSmoothSampling: { value: config.smoothPixelTransitions ? 1 : 0 }
      },
      vertexShader: UPSCALE_VS,
      fragmentShader: UPSCALE_FS,
      depthTest: false
    });
  }

  setSource(texture: THREE.Texture): void {
    this.uniforms.uSource.value = texture;
  }

  setContentScale(x: number, y: number): void {
    (this.uniforms.uContentScale.value as THREE.Vector2).set(x, y);
  }

  setContentOffset(x: number, y: number): void {
    (this.uniforms.uContentOffset.value as THREE.Vector2).set(x, y);
  }

  setSourceSize(width: number, height: number): void {
    (this.uniforms.uSourceSize.value as THREE.Vector2).set(width, height);
  }

  setZoom(zoom: number): void {
    this.uniforms.uZoom.value = zoom;
  }

  setZoomPivot(x: number, y: number): void {
    (this.uniforms.uZoomPivot.value as THREE.Vector2).set(x, y);
  }

  setEffectiveScale(scale: number): void {
    this.uniforms.uEffectiveScale.value = scale;
  }
}
