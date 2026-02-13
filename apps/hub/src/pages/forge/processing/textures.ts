import * as THREE from "three";

function getImageDimensions(
  image: unknown
): { width: number; height: number } | null {
  const img = image as Record<string, unknown>;
  const w = (img.width as number) || (img.videoWidth as number) || 0;
  const h = (img.height as number) || (img.videoHeight as number) || 0;
  if (w <= 0 || h <= 0) return null;
  return { width: w, height: h };
}

/** Draw any image source (ImageBitmap, HTMLImageElement, etc.) to a canvas at original size. */
function imageToCanvas(image: CanvasImageSource, w: number, h: number): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d")!;
  ctx.drawImage(image, 0, 0, w, h);
  return canvas;
}

export function downsampleTexture(
  texture: THREE.Texture,
  targetSize: number
): THREE.Texture {
  const image = texture.image;
  if (!image) return texture;

  const dims = getImageDimensions(image);
  if (!dims) return texture;
  if (dims.width <= targetSize && dims.height <= targetSize) return texture;

  const aspect = dims.width / dims.height;
  let newWidth: number, newHeight: number;
  if (aspect >= 1) {
    newWidth = targetSize;
    newHeight = Math.round(targetSize / aspect);
  } else {
    newHeight = targetSize;
    newWidth = Math.round(targetSize * aspect);
  }

  // First render source at full size to a canvas (handles ImageBitmap reliably)
  const srcCanvas = imageToCanvas(image as CanvasImageSource, dims.width, dims.height);

  // Then downsample from that canvas
  const destCanvas = document.createElement("canvas");
  destCanvas.width = newWidth;
  destCanvas.height = newHeight;
  const ctx = destCanvas.getContext("2d")!;
  ctx.drawImage(srcCanvas, 0, 0, newWidth, newHeight);

  const newTexture = new THREE.CanvasTexture(destCanvas);
  newTexture.flipY = texture.flipY;
  newTexture.wrapS = texture.wrapS;
  newTexture.wrapT = texture.wrapT;
  newTexture.magFilter = texture.magFilter;
  newTexture.minFilter = texture.minFilter;
  newTexture.colorSpace = texture.colorSpace;
  newTexture.channel = texture.channel;
  newTexture.needsUpdate = true;

  return newTexture;
}

export function downsampleMeshTextures(
  object: THREE.Object3D,
  targetSize: number
): void {
  // Cache: original texture → downsampled texture, so shared textures
  // across materials all get replaced consistently
  const cache = new Map<THREE.Texture, THREE.Texture>();

  const textureProps = [
    "map",
    "normalMap",
    "roughnessMap",
    "metalnessMap",
    "aoMap",
    "emissiveMap",
  ] as const;

  object.traverse((child) => {
    if (!(child instanceof THREE.Mesh)) return;

    const materials = Array.isArray(child.material)
      ? child.material
      : [child.material];

    for (const mat of materials) {
      if (!(mat instanceof THREE.MeshStandardMaterial)) continue;

      let changed = false;
      for (const prop of textureProps) {
        const tex = mat[prop];
        if (!tex) continue;

        let downsampled = cache.get(tex);
        if (downsampled === undefined) {
          downsampled = downsampleTexture(tex, targetSize);
          cache.set(tex, downsampled);
        }

        if (downsampled !== tex) {
          (mat[prop] as THREE.Texture) = downsampled;
          changed = true;
        }
      }
      if (changed) {
        mat.needsUpdate = true;
      }
    }
  });
}

export type TextureChannel =
  | "baseColor"
  | "normal"
  | "roughness"
  | "metallic"
  | "ao"
  | "emissive";

export function getTextureForChannel(
  material: THREE.MeshStandardMaterial,
  channel: TextureChannel
): THREE.Texture | null {
  switch (channel) {
    case "baseColor":
      return material.map;
    case "normal":
      return material.normalMap;
    case "roughness":
      return material.roughnessMap;
    case "metallic":
      return material.metalnessMap;
    case "ao":
      return material.aoMap;
    case "emissive":
      return material.emissiveMap;
    default:
      return null;
  }
}
