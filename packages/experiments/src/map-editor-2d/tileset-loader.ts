import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { LEVEL_EDITOR_WORLD_UNIT } from "@common/level-editor";

// ---------------------------------------------------------------------------
// Manifest types (subset of what tiles.manifest.json contains)
// ---------------------------------------------------------------------------

export type TileFootprint =
  | { type: "edge_run"; runUnits: number; runCells: number; baseUnit: number }
  | { type: "submodule"; runUnits: number; baseUnit: number }
  | { type: "cell" }
  | { type: "corner_vertex" }
  | { type: "edge_cap" };

export type TileEntry = {
  name: string;
  kind: string;
  anchorClass: string;
  articulationType: string | null;
  meshEnvelope: [number, number, number];
  logicalFootprint: TileFootprint;
};

export type TilesManifest = {
  kitId: string;
  name: string;
  tiles: TileEntry[];
};

// ---------------------------------------------------------------------------
// Loaded tile: manifest entry + Three.js group template
// ---------------------------------------------------------------------------

export type LoadedTile = {
  entry: TileEntry;
  template: THREE.Group;
};

/** All loaded tiles from the kit, keyed by tile name */
export type TilesetAssets = {
  manifest: TilesManifest;
  tiles: Map<string, LoadedTile>;
  /** Convenience: tiles grouped by kind */
  byKind: Map<string, LoadedTile[]>;
};

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

const TILESET_BASE = "tilesets/desert_sandstone";
const TILES_DIR = `${TILESET_BASE}/tiles`;

const gltfLoader = new GLTFLoader();

async function fetchJson<T>(assetPath: string): Promise<T> {
  const url = `/api/assets/read?path=${encodeURIComponent(assetPath)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to load ${assetPath}: ${res.status}`);
  const json = await res.json();
  // The api-proxy wraps json/txt in { content: string }
  return typeof json.content === "string" ? JSON.parse(json.content) : json;
}

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

/**
 * Set nearest-neighbor filtering on all textures for pixel-art style.
 */
function fixTextureFiltering(group: THREE.Group): void {
  group.traverse((obj) => {
    if (!(obj instanceof THREE.Mesh)) return;
    const materials = Array.isArray(obj.material) ? obj.material : [obj.material];
    for (const mat of materials) {
      if (mat instanceof THREE.MeshStandardMaterial && mat.map) {
        mat.map.magFilter = THREE.NearestFilter;
        mat.map.minFilter = THREE.NearestFilter;
        mat.map.needsUpdate = true;
      }
    }
  });
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function loadTilesetAssets(): Promise<TilesetAssets> {
  const manifest = await fetchJson<TilesManifest>(`${TILES_DIR}/tiles.manifest.json`);

  console.log(`[tileset] ${manifest.name}: ${manifest.tiles.length} tiles`);

  // Load all tile GLBs in parallel
  const loaded = await Promise.all(
    manifest.tiles.map(async (entry) => {
      const group = await loadGlb(`${TILES_DIR}/${entry.name}/${entry.name}.glb`);
      group.scale.setScalar(LEVEL_EDITOR_WORLD_UNIT);
      fixTextureFiltering(group);
      return { entry, template: group } satisfies LoadedTile;
    })
  );

  const tiles = new Map<string, LoadedTile>();
  const byKind = new Map<string, LoadedTile[]>();
  for (const tile of loaded) {
    tiles.set(tile.entry.name, tile);
    const kindList = byKind.get(tile.entry.kind) ?? [];
    kindList.push(tile);
    byKind.set(tile.entry.kind, kindList);
  }

  console.log(`[tileset] kinds: ${[...byKind.keys()].join(", ")}`);

  return { manifest, tiles, byKind };
}
