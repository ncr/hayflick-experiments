import { describe, expect, it } from "vitest";
import * as THREE from "three";
import {
  applyPixelArtTextureDefaults,
  applyPixelArtTextureDefaultsToTree,
  applyTexelCenterOffset
} from "./texture-helpers";

function makeTextureWithSize(width: number, height: number): THREE.Texture {
  const tex = new THREE.Texture();
  (tex as unknown as { image: { width: number; height: number } }).image = {
    width,
    height
  };
  return tex;
}

describe("applyTexelCenterOffset", () => {
  it("sets offset to half-texel for a 64x64 texture", () => {
    const tex = makeTextureWithSize(64, 64);
    applyTexelCenterOffset(tex);
    expect(tex.offset.x).toBeCloseTo(0.5 / 64, 10);
    expect(tex.offset.y).toBeCloseTo(0.5 / 64, 10);
  });

  it("scales correctly for non-square textures", () => {
    const tex = makeTextureWithSize(128, 256);
    applyTexelCenterOffset(tex);
    expect(tex.offset.x).toBeCloseTo(0.5 / 128, 10);
    expect(tex.offset.y).toBeCloseTo(0.5 / 256, 10);
  });

  it("falls back to a default 64-texel size when image dimensions are missing", () => {
    const tex = new THREE.Texture();
    applyTexelCenterOffset(tex);
    expect(tex.offset.x).toBeCloseTo(0.5 / 64, 10);
    expect(tex.offset.y).toBeCloseTo(0.5 / 64, 10);
  });
});

describe("applyPixelArtTextureDefaults", () => {
  it("forces nearest filtering in both directions and disables mipmaps", () => {
    const tex = makeTextureWithSize(64, 64);
    applyPixelArtTextureDefaults(tex);
    expect(tex.magFilter).toBe(THREE.NearestFilter);
    expect(tex.minFilter).toBe(THREE.NearestFilter);
    expect(tex.generateMipmaps).toBe(false);
  });

  it("applies the half-texel offset", () => {
    const tex = makeTextureWithSize(64, 64);
    applyPixelArtTextureDefaults(tex);
    expect(tex.offset.x).toBeCloseTo(0.5 / 64, 10);
    expect(tex.offset.y).toBeCloseTo(0.5 / 64, 10);
  });

  it("marks the texture as needing GPU re-upload", () => {
    const tex = makeTextureWithSize(64, 64);
    const before = tex.version;
    applyPixelArtTextureDefaults(tex);
    expect(tex.version).toBeGreaterThan(before);
  });
});

describe("applyPixelArtTextureDefaultsToTree", () => {
  it("walks the tree and sets defaults on every PBR map", () => {
    const root = new THREE.Group();
    const baseMap = makeTextureWithSize(64, 64);
    const normalMap = makeTextureWithSize(64, 64);
    const aoMap = makeTextureWithSize(64, 64);
    const mat = new THREE.MeshStandardMaterial({
      map: baseMap,
      normalMap,
      aoMap
    });
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), mat);
    root.add(mesh);

    applyPixelArtTextureDefaultsToTree(root);

    for (const tex of [baseMap, normalMap, aoMap]) {
      expect(tex.magFilter).toBe(THREE.NearestFilter);
      expect(tex.minFilter).toBe(THREE.NearestFilter);
      expect(tex.generateMipmaps).toBe(false);
      expect(tex.offset.x).toBeCloseTo(0.5 / 64, 10);
      expect(tex.offset.y).toBeCloseTo(0.5 / 64, 10);
    }
  });

  it("skips non-Mesh objects and non-standard materials", () => {
    const root = new THREE.Group();
    const unaffectedMap = makeTextureWithSize(64, 64);
    unaffectedMap.magFilter = THREE.LinearFilter;
    const basicMat = new THREE.MeshBasicMaterial({ map: unaffectedMap });
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), basicMat);
    root.add(mesh);

    applyPixelArtTextureDefaultsToTree(root);

    expect(unaffectedMap.magFilter).toBe(THREE.LinearFilter);
  });

  it("handles an array of materials on a single mesh", () => {
    const root = new THREE.Group();
    const texA = makeTextureWithSize(64, 64);
    const texB = makeTextureWithSize(128, 128);
    const matA = new THREE.MeshStandardMaterial({ map: texA });
    const matB = new THREE.MeshStandardMaterial({ map: texB });
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), [matA, matB]);
    root.add(mesh);

    applyPixelArtTextureDefaultsToTree(root);

    expect(texA.magFilter).toBe(THREE.NearestFilter);
    expect(texB.magFilter).toBe(THREE.NearestFilter);
    expect(texB.offset.x).toBeCloseTo(0.5 / 128, 10);
  });
});
