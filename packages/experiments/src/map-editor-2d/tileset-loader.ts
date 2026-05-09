import * as THREE from "three";
import {
  createGreyboxMeshTemplate,
  listGreyboxDefinitions,
  type GreyboxDefinition
} from "@common/level-editor";

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

export type LoadedTile = {
  entry: TileEntry;
  template: THREE.Group;
  definition: GreyboxDefinition;
};

export type LoadedTileset = {
  manifest: TilesManifest;
  tiles: Map<string, LoadedTile>;
};

export type TilesetAssets = {
  tilesets: LoadedTileset[];
  tiles: Map<string, LoadedTile>;
  byKind: Map<string, LoadedTile[]>;
};

function logicalFootprintForDefinition(definition: GreyboxDefinition): TileFootprint {
  if (definition.placement === "cell") {
    return { type: "cell" };
  }
  if (definition.placement === "vertex") {
    return { type: "corner_vertex" };
  }
  return { type: "edge_run", runUnits: 128, runCells: 1, baseUnit: 128 };
}

function entryForDefinition(definition: GreyboxDefinition): TileEntry {
  return {
    name: definition.id,
    kind: definition.semantic.kind,
    anchorClass: definition.anchorClass,
    articulationType: definition.semantic.kind === "door" ? "hinged" : null,
    meshEnvelope: definition.dimensionsCm,
    logicalFootprint: logicalFootprintForDefinition(definition)
  };
}

export async function loadTilesetAssets(): Promise<TilesetAssets> {
  const definitions = listGreyboxDefinitions();
  const tiles = new Map<string, LoadedTile>();
  const byKind = new Map<string, LoadedTile[]>();
  const entries: TileEntry[] = [];

  for (const definition of definitions) {
    const entry = entryForDefinition(definition);
    const loaded: LoadedTile = {
      entry,
      definition,
      template: createGreyboxMeshTemplate(definition)
    };
    entries.push(entry);
    tiles.set(entry.name, loaded);
    const kindList = byKind.get(entry.kind) ?? [];
    kindList.push(loaded);
    byKind.set(entry.kind, kindList);
  }

  const greyboxSet: LoadedTileset = {
    manifest: {
      kitId: "greyboxes",
      name: "Greyboxes",
      tiles: entries
    },
    tiles
  };

  return {
    tilesets: [greyboxSet],
    tiles,
    byKind
  };
}
