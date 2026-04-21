import * as THREE from "three";

const ID_VS = /* glsl */ `
  void main() {
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const ID_FS = /* glsl */ `
  precision highp float;
  uniform vec3 uIdColor;
  void main() {
    gl_FragColor = vec4(uIdColor, 1.0);
  }
`;

/**
 * Smallest non-zero RGB float component that still survives quantization to
 * `Uint8` in a RGBA8 render target. `1/255 ≈ 0.00392`. Used by
 * {@link encodeOutlineGroupColor} so id=0 gets distinguishable from a
 * cleared-to-black background.
 */
export const OUTLINE_GROUP_ID_EPS = 1 / 255;

/**
 * Encode a small integer group id into a high-contrast RGB colour so two
 * adjacent pixels with different ids remain distinguishable after
 * quantisation + nearest-neighbour sampling in the edge-detection pass.
 */
export function encodeOutlineGroupColor(groupId: number, out?: THREE.Color): THREE.Color {
  const r = ((groupId * 53 + 37) & 0xff) / 255;
  const g = ((groupId * 131 + 71) & 0xff) / 255;
  const b = ((groupId * 197 + 113) & 0xff) / 255;
  const color = out ?? new THREE.Color();
  color.setRGB(
    Math.max(OUTLINE_GROUP_ID_EPS, r),
    Math.max(OUTLINE_GROUP_ID_EPS, g),
    Math.max(OUTLINE_GROUP_ID_EPS, b)
  );
  return color;
}

/**
 * Flat material that writes a uniform id colour. Use as `mesh.material` during
 * the outline pipeline's id pass — the fragment is RGB-encoded via
 * {@link encodeOutlineGroupColor} so the post-process can detect group
 * boundaries between meshes.
 */
export class OutlineGroupMaterial extends THREE.ShaderMaterial {
  readonly groupId: number;
  readonly color: THREE.Color;

  constructor(groupId: number) {
    const color = encodeOutlineGroupColor(groupId);
    super({
      uniforms: { uIdColor: { value: color.clone() } },
      vertexShader: ID_VS,
      fragmentShader: ID_FS,
      side: THREE.DoubleSide
    });
    this.groupId = groupId;
    this.color = color;
  }
}
