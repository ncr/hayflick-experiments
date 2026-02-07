import type { LevelResource } from "@common/gameplay";
import {
  TILE_WALL,
  type LevelModel,
  type Placement
} from "./model";

export type MutableLevelResource = LevelResource & {
  width: number;
  height: number;
  collisionBlocked: Uint8Array;
  navBlocked: Uint8Array;
  setBlocked(cellX: number, cellY: number, blocked: boolean): void;
  getBlocked(cellX: number, cellY: number): boolean;
};

export type BakedLevel = {
  levelResource: MutableLevelResource;
  placements: Placement[];
};

function cellIndex(width: number, x: number, y: number): number {
  return y * width + x;
}

function inBounds(width: number, height: number, x: number, y: number): boolean {
  return x >= 0 && y >= 0 && x < width && y < height;
}

export function bakeLevel(levelModel: LevelModel): BakedLevel {
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

  const collisionBlocked = blocked;
  const navBlocked = blocked.slice();

  const levelResource: MutableLevelResource = {
    id: "editor-game-ecs-level",
    version: 1,
    width,
    height,
    collisionBlocked,
    navBlocked,
    isBlocked(x: number, y: number): boolean {
      const cellX = Math.floor(x);
      const cellY = Math.floor(y);

      if (!inBounds(width, height, cellX, cellY)) {
        return true;
      }

      return collisionBlocked[cellIndex(width, cellX, cellY)] === 1;
    },
    setBlocked(cellX: number, cellY: number, isBlocked: boolean): void {
      if (!inBounds(width, height, cellX, cellY)) {
        return;
      }

      const index = cellIndex(width, cellX, cellY);
      const value = isBlocked ? 1 : 0;
      collisionBlocked[index] = value;
      navBlocked[index] = value;
    },
    getBlocked(cellX: number, cellY: number): boolean {
      if (!inBounds(width, height, cellX, cellY)) {
        return true;
      }

      return collisionBlocked[cellIndex(width, cellX, cellY)] === 1;
    }
  };

  return {
    levelResource,
    placements
  };
}
