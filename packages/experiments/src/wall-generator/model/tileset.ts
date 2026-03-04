import type { TilesetConfig, PieceConfig, PieceKind } from "./types";
import { defaultPieceConfig } from "./piece-catalog";
import { pieceSlug } from "./piece-metadata";

/**
 * Expand a tileset config into individual piece configs.
 */
export function expandTileset(tilesetConfig: TilesetConfig): PieceConfig[] {
  return tilesetConfig.pieces.map((kind) =>
    defaultPieceConfig(kind, {
      dimensions: { ...tilesetConfig.dimensions },
      material: { ...tilesetConfig.material },
      opening: { ...tilesetConfig.opening },
      trim: { ...tilesetConfig.trim },
      textureResolution: tilesetConfig.textureResolution,
    }),
  );
}

/**
 * Generate the tileset index.json data.
 */
export function generateTilesetIndex(configs: PieceConfig[]): {
  gridSize: number;
  pieces: string[];
} {
  return {
    gridSize: 1.0,
    pieces: configs.map(pieceSlug),
  };
}
