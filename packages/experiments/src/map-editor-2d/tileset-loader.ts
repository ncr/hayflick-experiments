import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { LEVEL_EDITOR_WORLD_UNIT } from "@common/level-editor";

export type TilesetAssets = {
  wall: THREE.Group;
  door: THREE.Group;
  window: THREE.Group;
  corner: THREE.Group;
  endCap: THREE.Group;
};

const TILESET_BASE = "tilesets/modern_desert_monolith/tiles";

// Default material colors per tile type (the GLB textures are placeholders)
const TILE_COLORS: Record<string, number> = {
  wall: 0xe8ddd0,
  door: 0xc4a882,
  window: 0x8cb8d8,
  corner: 0xe8ddd0,
  endCap: 0xe8ddd0
};

const TILE_FILES: Array<{ key: keyof TilesetAssets; dir: string }> = [
  { key: "wall", dir: "wall_straight" },
  { key: "door", dir: "door_wall" },
  { key: "window", dir: "dimmed_vertical_panel_fixed" },
  { key: "corner", dir: "corner" },
  { key: "endCap", dir: "end_cap" }
];

const gltfLoader = new GLTFLoader();

async function loadGlb(assetPath: string): Promise<THREE.Group> {
  const url = `/api/assets/read?path=${encodeURIComponent(assetPath)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to load ${assetPath}: ${res.status}`);
  const buffer = await res.arrayBuffer();
  const gltf = await new Promise<{ scene: THREE.Group }>((resolve, reject) => {
    gltfLoader.parse(buffer, "", resolve, reject);
  });
  return gltf.scene;
}

function fixMaterials(group: THREE.Group, color: number): void {
  // The blockstudio GLBs have placeholder textures (112 bytes) and alpha-mask
  // materials that render invisible. Replace with a solid MeshStandardMaterial.
  const mat = new THREE.MeshStandardMaterial({
    color,
    roughness: 0.7,
    metalness: 0.05
  });
  group.traverse((obj) => {
    if (obj instanceof THREE.Mesh) {
      obj.material = mat;
    }
  });
}

export async function loadTilesetAssets(): Promise<TilesetAssets> {
  const entries = await Promise.all(
    TILE_FILES.map(async ({ key, dir }) => {
      const group = await loadGlb(`${TILESET_BASE}/${dir}/${dir}.glb`);
      group.scale.setScalar(LEVEL_EDITOR_WORLD_UNIT);
      fixMaterials(group, TILE_COLORS[key] ?? 0xcccccc);
      return { key, group };
    })
  );

  const assets = {} as Record<string, THREE.Group>;
  for (const { key, group } of entries) {
    assets[key] = group;
  }
  return assets as TilesetAssets;
}
