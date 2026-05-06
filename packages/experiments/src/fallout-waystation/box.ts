import * as THREE from "three";
import { patchHeightFog } from "./fog";
import { patchAOFragment } from "./ao-patch";

// Per-face vertex tinting — the cheapest believability win for solid-color
// boxes. Top brightest, bottom darkest, sun-side warmer than shadow-side.
// Baked into a `color` BufferAttribute so MeshStandardMaterial with
// `vertexColors: true` picks it up.
//
// BoxGeometry vertex order is fixed by three.js: 4 verts per face, faces in
// order +X, -X, +Y, -Y, +Z, -Z. We rely on that.

export type FaceTint = {
  /** +Y face multiplier. Default 1.18. */
  topMul?: number;
  /** -Y face multiplier. Default 0.55. */
  bottomMul?: number;
  /** +X / +Z face multiplier ("sun side"). Default 1.0. */
  sunSideMul?: number;
  /** -X / -Z face multiplier ("shadow side"). Default 0.78. */
  shadowSideMul?: number;
  /** Per-vertex jitter to break uniformity (±0..1). Default 0. */
  noiseAmount?: number;
  /** Seed for noise hash. Default 0. */
  noiseSeed?: number;
};

const FACE_NORMALS: ReadonlyArray<readonly [number, number, number]> = [
  [1, 0, 0],
  [-1, 0, 0],
  [0, 1, 0],
  [0, -1, 0],
  [0, 0, 1],
  [0, 0, -1]
];

function mulberry32(seed: number): () => number {
  let a = seed | 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function applyFaceTint(
  geom: THREE.BufferGeometry,
  baseColor: THREE.ColorRepresentation,
  opts: FaceTint = {}
): void {
  const top = opts.topMul ?? 1.18;
  const bottom = opts.bottomMul ?? 0.55;
  const sunSide = opts.sunSideMul ?? 1.0;
  const shadowSide = opts.shadowSideMul ?? 0.78;
  const noise = opts.noiseAmount ?? 0;
  const rng = noise > 0 ? mulberry32((opts.noiseSeed ?? 0) * 1000 + 1) : null;

  const base = new THREE.Color(baseColor);
  const positionAttr = geom.getAttribute("position");
  const vertCount = positionAttr.count;
  if (vertCount !== 24) {
    throw new Error(
      `applyFaceTint expects BoxGeometry (24 verts); got ${vertCount}`
    );
  }
  const colors = new Float32Array(vertCount * 3);

  for (let face = 0; face < 6; face++) {
    const n = FACE_NORMALS[face];
    let mul: number;
    if (n[1] > 0.5) mul = top;
    else if (n[1] < -0.5) mul = bottom;
    else if (n[0] > 0.5 || n[2] > 0.5) mul = sunSide;
    else mul = shadowSide;

    const r = base.r * mul;
    const g = base.g * mul;
    const b = base.b * mul;

    for (let i = 0; i < 4; i++) {
      const idx = face * 4 + i;
      const j = rng ? (rng() - 0.5) * noise : 0;
      colors[idx * 3] = Math.max(0, r + j);
      colors[idx * 3 + 1] = Math.max(0, g + j);
      colors[idx * 3 + 2] = Math.max(0, b + j);
    }
  }

  geom.setAttribute("color", new THREE.BufferAttribute(colors, 3));

  // Per-vertex local-Y in [0, 1], read by ao-patch's box edge AO.
  geom.computeBoundingBox();
  const bb = geom.boundingBox!;
  const yMin = bb.min.y;
  const yRange = bb.max.y - bb.min.y;
  const localY = new Float32Array(vertCount);
  for (let i = 0; i < vertCount; i++) {
    localY[i] = yRange > 1e-6 ? (positionAttr.getY(i) - yMin) / yRange : 1;
  }
  geom.setAttribute("aLocalYNormalized", new THREE.BufferAttribute(localY, 1));
}

export type BoxOptions = {
  tint?: FaceTint;
  material?: Partial<THREE.MeshStandardMaterialParameters>;
  castShadow?: boolean;
  receiveShadow?: boolean;
};

export function createTintedBox(
  size: { x: number; y: number; z: number },
  baseColor: THREE.ColorRepresentation,
  opts: BoxOptions = {}
): THREE.Mesh<THREE.BoxGeometry, THREE.MeshStandardMaterial> {
  const geom = new THREE.BoxGeometry(size.x, size.y, size.z);
  applyFaceTint(geom, baseColor, opts.tint);
  const mat = new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.95,
    metalness: 0.0,
    flatShading: true,
    ...(opts.material ?? {})
  });
  patchHeightFog(mat);
  patchAOFragment(mat, { useEdgeAO: true });
  const mesh = new THREE.Mesh(geom, mat);
  mesh.castShadow = opts.castShadow ?? true;
  mesh.receiveShadow = opts.receiveShadow ?? true;
  return mesh;
}
