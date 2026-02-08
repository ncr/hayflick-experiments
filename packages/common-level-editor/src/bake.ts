import { createMutableGridLevelResource, type MutableGridLevelResource } from "./grid-level";
import {
  TILE_WALL,
  type LevelModel,
  type Placement
} from "./model";

export type BakedTileLevel = {
  levelResource: MutableGridLevelResource;
  placements: Placement[];
};

function cellIndex(width: number, x: number, y: number): number {
  return y * width + x;
}

function inBounds(width: number, height: number, x: number, y: number): boolean {
  return x >= 0 && y >= 0 && x < width && y < height;
}

export function bakeTileLevel(levelModel: LevelModel, options?: { id?: string; version?: number }): BakedTileLevel {
  const { width, height } = levelModel;
  const blocked = new Uint8Array(width * height);

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const source = levelModel.tiles[cellIndex(width, x, y)];
      blocked[cellIndex(width, x, y)] = source === TILE_WALL ? 1 : 0;
    }
  }

  const placements = levelModel.placements.map((placement) => ({
    ...placement,
    data: placement.data ? { ...placement.data } : undefined
  }));

  for (const placement of placements) {
    if (placement.kind !== "door") {
      continue;
    }

    if (!inBounds(width, height, placement.x, placement.y)) {
      continue;
    }

    const isOpen = placement.data?.open === true;
    blocked[cellIndex(width, placement.x, placement.y)] = isOpen ? 0 : 1;
  }

  const blockedCells: Array<{ x: number; y: number }> = [];
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (blocked[cellIndex(width, x, y)] === 1) {
        blockedCells.push({ x, y });
      }
    }
  }

  return {
    levelResource: createMutableGridLevelResource({
      id: options?.id ?? "editor-game-ecs-level",
      version: options?.version ?? 1,
      width,
      height,
      blockedCells
    }),
    placements
  };
}
