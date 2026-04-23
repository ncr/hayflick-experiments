/**
 * Three.js texture hot-swap: ImageData → CanvasTexture on loaded meshes.
 *
 * Materials in GLBs are named `blockstudio_<role>` (e.g. blockstudio_wall,
 * blockstudio_trim, blockstudio_asphalt). The role key from the control
 * panel matches this suffix.
 */

import * as THREE from "three";

// ---------------------------------------------------------------------------
// ImageData → CanvasTexture
// ---------------------------------------------------------------------------

/**
 * Create a new THREE.CanvasTexture from ImageData.
 *
 * glTF textures use flipY=false (OpenGL convention: UV origin at bottom-left).
 * We draw the ImageData flipped so the CanvasTexture can also use flipY=false,
 * avoiding shader recompilation when swapping onto a glTF material.
 */
export function imageDataToCanvasTexture(
  data: ImageData,
  srgb: boolean
): THREE.CanvasTexture {
  const canvas = document.createElement("canvas");
  canvas.width = data.width;
  canvas.height = data.height;
  const ctx = canvas.getContext("2d")!;

  // Flip vertically so we can set flipY=false (matching glTF convention)
  ctx.translate(0, data.height);
  ctx.scale(1, -1);
  // Need a temp canvas to drawImage since putImageData ignores transforms
  const tmp = document.createElement("canvas");
  tmp.width = data.width;
  tmp.height = data.height;
  tmp.getContext("2d")!.putImageData(data, 0, 0);
  ctx.drawImage(tmp, 0, 0);

  const tex = new THREE.CanvasTexture(canvas);
  tex.flipY = false; // match glTF convention
  tex.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.LinearSRGBColorSpace;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearFilter;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.needsUpdate = true;
  return tex;
}

/**
 * Update an existing CanvasTexture's pixels in-place (no new object alloc).
 * Used for slider re-derivation — instant feedback.
 */
export function updateCanvasTexture(
  tex: THREE.CanvasTexture,
  data: ImageData
): void {
  const canvas = tex.image as HTMLCanvasElement;
  const ctx = canvas.getContext("2d")!;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.save();
  ctx.translate(0, canvas.height);
  ctx.scale(1, -1);
  const tmp = document.createElement("canvas");
  tmp.width = data.width;
  tmp.height = data.height;
  tmp.getContext("2d")!.putImageData(data, 0, 0);
  ctx.drawImage(tmp, 0, 0);
  ctx.restore();
  tex.needsUpdate = true;
}

// ---------------------------------------------------------------------------
// Apply textures to mesh group
// ---------------------------------------------------------------------------

export type TextureSet = {
  baseColor: THREE.CanvasTexture;
  normal: THREE.CanvasTexture;
  arm: THREE.CanvasTexture;
};

/**
 * Traverse a THREE.Group and apply textures to all MeshStandardMaterials
 * whose name is `blockstudio_<roleKey>`.
 *
 * Clones the material before modifying so the original GLB template is
 * not mutated and each clone gets its own shader program.
 */
export function applyTexturesToGroup(
  group: THREE.Object3D,
  roleKey: string,
  textures: TextureSet
): void {
  const targetName = `blockstudio_${roleKey}`;

  group.traverse((obj) => {
    if (!(obj instanceof THREE.Mesh)) return;

    const mats: THREE.Material[] = Array.isArray(obj.material)
      ? obj.material
      : [obj.material];

    for (let i = 0; i < mats.length; i++) {
      const orig = mats[i];
      if (!(orig instanceof THREE.MeshStandardMaterial)) continue;
      if (orig.name !== targetName) continue;

      // Clone so we don't mutate the shared template material
      const mat = orig.clone();
      mat.name = targetName;

      mat.map = textures.baseColor;
      mat.normalMap = textures.normal;
      mat.normalMapType = THREE.TangentSpaceNormalMap;

      // ARM: R=AO, G=Roughness, B=Metalness — same texture for all three
      mat.aoMap = textures.arm;
      mat.roughnessMap = textures.arm;
      mat.metalnessMap = textures.arm;

      // Factors: 1.0 means "use the map value directly"
      mat.roughness = 1.0;
      mat.metalness = 1.0;

      mat.needsUpdate = true;

      // Replace on the mesh
      if (Array.isArray(obj.material)) {
        obj.material[i] = mat;
      } else {
        obj.material = mat;
      }
    }
  });
}

/**
 * Create a full texture set from ImageData maps.
 */
export function createTextureSet(maps: {
  baseColor: ImageData;
  normal: ImageData;
  arm: ImageData;
}): TextureSet {
  return {
    baseColor: imageDataToCanvasTexture(maps.baseColor, true),
    normal: imageDataToCanvasTexture(maps.normal, false),
    arm: imageDataToCanvasTexture(maps.arm, false)
  };
}

/**
 * Update existing texture set with new ImageData (for slider changes).
 * Updates textures in-place — materials already reference them.
 */
export function updateTextureSet(
  textures: TextureSet,
  maps: { normal: ImageData; arm: ImageData }
): void {
  updateCanvasTexture(textures.normal, maps.normal);
  updateCanvasTexture(textures.arm, maps.arm);
}
