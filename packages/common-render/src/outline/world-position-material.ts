import * as THREE from "three";

const WP_VS = /* glsl */ `
  varying vec3 vWorldPos;
  void main() {
    vec4 worldPos = modelMatrix * vec4(position, 1.0);
    vWorldPos = worldPos.xyz;
    gl_Position = projectionMatrix * viewMatrix * worldPos;
  }
`;

const WP_FS = /* glsl */ `
  precision highp float;
  varying vec3 vWorldPos;
  void main() {
    gl_FragColor = vec4(vWorldPos, 1.0);
  }
`;

/**
 * Writes per-fragment world-space position into the render target. Intended
 * for a half-float RGBA target — at the scenes we use (< 100 world units in
 * span) fp16 precision is ~4 decimal digits, plenty for the sub-centimetre
 * distinctions the suppression predicate needs.
 *
 * Paired with {@link EdgeDetectionMaterial}'s `uWorldPosTex`, this lets the
 * edge shader ask the unambiguous question "are these two pixels on the same
 * physical surface?" rather than leaning on camera-space depth deltas.
 */
export class WorldPositionMaterial extends THREE.ShaderMaterial {
  constructor() {
    super({
      uniforms: {},
      vertexShader: WP_VS,
      fragmentShader: WP_FS,
      side: THREE.DoubleSide
    });
  }
}
