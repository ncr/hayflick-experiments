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

// ---------------------------------------------------------------------------
// Flat textured-mesh catalog (assets/textured-meshes/<name>/)
// ---------------------------------------------------------------------------

/**
 * Placement metadata sidecar for a base mesh.
 * Written at `assets/meshes/<baseMeshId>.manifest.json`. Shape mirrors the
 * `part` + `artifactTransform` subset of per-tile manifests from the kit
 * pipeline, minus kit-specific fields like kitId/kitName/textures.
 */
type BaseMeshManifest = {
  id: string;
  artifactTransform: unknown;
  part: {
    name: string;
    kind: string;
    anchorClass: string;
    articulationType: string | null;
    meshEnvelope: [number, number, number];
    logicalFootprint: TileFootprint;
  };
};

/** Entry manifest written by the bake endpoint. */
type TexturedMeshEntryManifest = {
  name: string;
  baseMeshId: string;
  roles: string[];
  prompts?: Record<string, string>;
  bakedAt: string;
};

async function tryFetchJson<T>(assetPath: string): Promise<T | null> {
  const url = `/api/assets/read?path=${encodeURIComponent(assetPath)}`;
  const res = await fetch(url);
  if (!res.ok) return null;
  const json = await res.json();
  return (typeof json.content === "string" ? JSON.parse(json.content) : json) as T;
}

async function loadTexturedMeshCatalog(): Promise<LoadedTileset | null> {
  // Ask the API for entry names — it knows the directory layout.
  const listRes = await fetch("/api/textured-mesh/list");
  if (!listRes.ok) return null;
  const listJson = (await listRes.json()) as { entries: Array<{ name: string }> };
  if (listJson.entries.length === 0) return null;

  const tiles = new Map<string, LoadedTile>();
  const tileEntries: TileEntry[] = [];

  for (const { name } of listJson.entries) {
    const entryManifest = await tryFetchJson<TexturedMeshEntryManifest>(
      `textured-meshes/${name}/manifest.json`
    );
    if (!entryManifest) {
      console.warn(`[textured-meshes] skipping ${name}: no manifest.json`);
      continue;
    }
    const baseManifest = await tryFetchJson<BaseMeshManifest>(
      `meshes/${entryManifest.baseMeshId}.manifest.json`
    );
    if (!baseManifest) {
      console.warn(
        `[textured-meshes] skipping ${name}: base mesh manifest "${entryManifest.baseMeshId}" not found`
      );
      continue;
    }

    // Build a TileEntry — same shape as kit manifests, but the entry's
    // display name is the user-chosen tilekit name, not the base mesh name.
    const entry: TileEntry = {
      name,
      kind: baseManifest.part.kind,
      anchorClass: baseManifest.part.anchorClass,
      articulationType: baseManifest.part.articulationType,
      meshEnvelope: baseManifest.part.meshEnvelope,
      logicalFootprint: baseManifest.part.logicalFootprint
    };

    const group = await loadGlb(`textured-meshes/${name}/artifact.glb`);
    group.scale.setScalar(LEVEL_EDITOR_WORLD_UNIT);
    prepareTileMaterials(group);

    tiles.set(name, { entry, template: group });
    tileEntries.push(entry);
  }

  if (tiles.size === 0) return null;

  const manifest: TilesManifest = {
    kitId: "textured-meshes",
    name: "custom",
    tiles: tileEntries
  };
  console.log(`[textured-meshes] loaded ${tiles.size} entries`);
  return { manifest, tiles };
}

export async function loadTilesetAssets(): Promise<TilesetAssets> {
  // Load all configured kits + the flat textured-mesh catalog in parallel.
  const [kitResults, catalog] = await Promise.all([
    Promise.all(KIT_IDS.map(loadOneKit)),
    loadTexturedMeshCatalog()
  ]);
  const tilesets: LoadedTileset[] = catalog ? [...kitResults, catalog] : kitResults;

  // Merge into a flat lookup so callers that resolve by tile name (scene
  // builder, pointer tools, persisted state) don't need to know which tileset
  // a tile came from. Name collisions across kits/entries silently overwrite
  // with a warning — rare and fixable by renaming.
  const tiles = new Map<string, LoadedTile>();
  const byKind = new Map<string, LoadedTile[]>();
  for (const kit of tilesets) {
    for (const tile of kit.tiles.values()) {
      if (tiles.has(tile.entry.name)) {
        console.warn(
          `[tileset] tile-name collision: "${tile.entry.name}" appears in multiple sources; ` +
          `the later source (${kit.manifest.name}) wins`
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
