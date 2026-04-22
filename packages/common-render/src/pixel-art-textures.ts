import * as THREE from "three";

const DEFAULT_TEXEL_SIZE = 64;

function textureDimensions(texture: THREE.Texture): { width: number; height: number } {
  const image = texture.image as { width?: number; height?: number } | undefined;
  return {
    width: image?.width ?? DEFAULT_TEXEL_SIZE,
    height: image?.height ?? DEFAULT_TEXEL_SIZE
  };
}

/**
 * Snap a texture's sampling into texel centers by shifting UVs half a texel.
 *
 * Why this is required with nearest filtering on world-space box-projected
 * UVs: Blender's `_assign_box_projection_uvs` divides world coordinates by
 * `UV_SCALE_AUTH_UNITS` (128). Any geometry edge whose world coordinate is
 * an integer multiple of `uv_scale / texture_width` lands on EXACT texel
 * boundaries — e.g. a 16 cm wall thickness at uv_scale 128 and 64-texel
 * textures produces UV 0.125, which is 8.0 texels to the bit. GPU nearest
 * sampling at an exact boundary has no deterministic tie-break, so
 * sub-ULP drift in interpolated UVs (caused by any camera-matrix change)
 * flips the chosen texel between N-1 and N and produces 1-pixel flicker
 * at edges shared by two such faces.
 *
 * A half-texel offset converts floor((uv) * W) into round(uv * W), which
 * matches "nearest texel center" semantics and is unambiguous everywhere.
 * The visual shift is half a texel — imperceptible in pixel-art output.
 */
export function applyTexelCenterOffset(texture: THREE.Texture): void {
  const { width, height } = textureDimensions(texture);
  texture.offset.set(0.5 / width, 0.5 / height);
  texture.needsUpdate = true;
}

/**
 * Configure a tileable world-space texture for pixel-art rendering.
 *
 * - Nearest filtering (no texel bleed inside surfaces).
 * - No mipmaps (we render at integer zoom; minification never kicks in
 *   on the low-res target).
 * - Half-texel offset (see `applyTexelCenterOffset` for rationale).
 *
 * Use this on every `THREE.Texture` you plan to sample with nearest
 * filtering from box-projected / world-space UVs. Render-target textures
 * sampled with screen-space coords do not need the offset.
 */
export function applyPixelArtTextureDefaults(texture: THREE.Texture): void {
  texture.magFilter = THREE.NearestFilter;
  texture.minFilter = THREE.NearestFilter;
  texture.generateMipmaps = false;
  applyTexelCenterOffset(texture);
}

/**
 * Apply `applyPixelArtTextureDefaults` to every PBR map on every
 * `MeshStandardMaterial` under `root`. Covers `map`, `normalMap`,
 * `roughnessMap`, `metalnessMap`, and `aoMap`.
 */
export function applyPixelArtTextureDefaultsToTree(root: THREE.Object3D): void {
  root.traverse((obj) => {
    if (!(obj instanceof THREE.Mesh)) return;
    const materials = Array.isArray(obj.material) ? obj.material : [obj.material];
    for (const material of materials) {
      if (!(material instanceof THREE.MeshStandardMaterial)) continue;
      const maps: Array<THREE.Texture | null | undefined> = [
        material.map,
        material.normalMap,
        material.roughnessMap,
        material.metalnessMap,
        material.aoMap
      ];
      for (const tex of maps) {
        if (tex) applyPixelArtTextureDefaults(tex);
      }
    }
  });
}
