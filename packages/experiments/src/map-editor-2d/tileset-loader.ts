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

/** A single loaded kit: its manifest plus tiles keyed by tile name */
export type LoadedTileset = {
  manifest: TilesManifest;
  tiles: Map<string, LoadedTile>;
};

/** All loaded tiles, merged across one or more kits */
export type TilesetAssets = {
  /** Each loaded kit in load order — used by the toolbar to render one group per kit */
  tilesets: LoadedTileset[];
  /** Flat lookup across every kit, keyed by tile name */
  tiles: Map<string, LoadedTile>;
  /** Convenience: tiles grouped by kind, merged across kits */
  byKind: Map<string, LoadedTile[]>;
};

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/** Kits to load, in display order. Each must exist under assets/tilesets/<id>/artifacts/tiles/ */
const KIT_IDS: ReadonlyArray<string> = ["desert_sandstone", "greek_island_white", "ground_tiles"];

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
 * Prepare a loaded tile GLB for the realtime pixel-art PBR pipeline:
 *
 * - baseColor texture uses linear filtering — the pixel-art grid comes
 *   from the low-res render target (360p + integer upscale), not from
 *   nearest-neighbour texture sampling. Linear smooths harsh texel
 *   boundaries within surfaces while mesh edges stay sharp at the
 *   render budget.
 * - Every mesh casts and receives shadows so the directional key light in
 *   `map-editor-2d/index.ts` can do real contact shadows.
 */
function prepareTileMaterials(group: THREE.Group): void {
  group.traverse((obj) => {
    if (!(obj instanceof THREE.Mesh)) return;
    obj.castShadow = true;
    obj.receiveShadow = true;
    const materials = Array.isArray(obj.material) ? obj.material : [obj.material];
    for (const mat of materials) {
      if (mat instanceof THREE.MeshStandardMaterial && mat.map) {
        mat.map.magFilter = THREE.LinearFilter;
        mat.map.minFilter = THREE.LinearFilter;
        mat.map.needsUpdate = true;
      }
    }
  });
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

async function loadOneKit(kitId: string): Promise<LoadedTileset> {
  const tilesDir = `tilesets/${kitId}/artifacts/tiles`;
  const manifest = await fetchJson<TilesManifest>(`${tilesDir}/tiles.manifest.json`);

  console.log(`[tileset] ${manifest.name}: ${manifest.tiles.length} tiles`);

  const loaded = await Promise.all(
    manifest.tiles.map(async (entry) => {
      const group = await loadGlb(`${tilesDir}/${entry.name}/${entry.name}.glb`);
      group.scale.setScalar(LEVEL_EDITOR_WORLD_UNIT);
      prepareTileMaterials(group);
      return { entry, template: group } satisfies LoadedTile;
    })
  );

  const tiles = new Map<string, LoadedTile>();
  for (const tile of loaded) {
    tiles.set(tile.entry.name, tile);
  }

  return { manifest, tiles };
}

export async function loadTilesetAssets(): Promise<TilesetAssets> {
  // Load all configured kits in parallel
  const tilesets = await Promise.all(KIT_IDS.map(loadOneKit));

  // Merge into a flat lookup so callers that resolve by tile name (scene
  // builder, pointer tools, persisted state) don't need to know which kit a
  // tile came from. Tile-name collisions across kits would silently overwrite
  // — fine for now since current kits don't overlap, revisit if it changes.
  const tiles = new Map<string, LoadedTile>();
  const byKind = new Map<string, LoadedTile[]>();
  for (const kit of tilesets) {
    for (const tile of kit.tiles.values()) {
      if (tiles.has(tile.entry.name)) {
        console.warn(
          `[tileset] tile-name collision: "${tile.entry.name}" appears in multiple kits; ` +
          `the later kit (${kit.manifest.name}) wins`
        );
      }
      tiles.set(tile.entry.name, tile);
      const kindList = byKind.get(tile.entry.kind) ?? [];
      kindList.push(tile);
      byKind.set(tile.entry.kind, kindList);
    }
  }

  console.log(`[tileset] kinds: ${[...byKind.keys()].join(", ")}`);

  return { tilesets, tiles, byKind };
}
