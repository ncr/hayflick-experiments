import * as THREE from "three";

const DEPTH_VS = /* glsl */ `
  varying float vViewZ;
  void main() {
    vec4 viewPos = modelViewMatrix * vec4(position, 1.0);
    vViewZ = -viewPos.z;
    gl_Position = projectionMatrix * viewPos;
  }
`;

const DEPTH_FS = /* glsl */ `
  precision highp float;
  uniform float uNear;
  uniform float uFar;
  varying float vViewZ;
  void main() {
    float d = clamp((vViewZ - uNear) / (uFar - uNear), 0.0, 1.0);
    gl_FragColor = vec4(d, d, d, 1.0);
  }
`;

/**
 * Writes linear view-z (camera-space distance, remapped to [0, 1] via
 * near/far) into the R channel. Use this as a scene.overrideMaterial when you
 * need reliable linear depth on an orthographic camera — three.js's
 * `MeshDepthMaterial` packs `gl_FragCoord.z` which is non-linear and interacts
 * badly with ortho projection on several WebGL2 / GPU configurations, and
 * `DepthTexture` silently returns 1.0 on some of the same configs. Writing
 * view-z via this custom shader is bedrock-reliable.
 *
 * Render it into a target with `type: THREE.HalfFloatType` — plain RGBA8
 * quantises [0,1] into 256 buckets which swamps the typical 0.05 edge
 * threshold.
 */
export class LinearDepthMaterial extends THREE.ShaderMaterial {
  constructor(near: number, far: number) {
    super({
      uniforms: {
        uNear: { value: near },
        uFar: { value: far }
      },
      vertexShader: DEPTH_VS,
      fragmentShader: DEPTH_FS,
      side: THREE.DoubleSide
    });
  }

  setRange(near: number, far: number): void {
    this.uniforms.uNear.value = near;
    this.uniforms.uFar.value = far;
  }
}
