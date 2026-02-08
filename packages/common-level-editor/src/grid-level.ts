import type { LevelResource } from "@common/gameplay";

export type GridCell = {
  x: number;
  y: number;
};

export type MutableGridLevelResource = LevelResource & {
  width: number;
  height: number;
  collisionBlocked: Uint8Array;
  navBlocked: Uint8Array;
  setBlocked(cellX: number, cellY: number, blocked: boolean): void;
  getBlocked(cellX: number, cellY: number): boolean;
};

export type CreateMutableGridLevelResourceOptions = {
  id: string;
  version: number;
  width: number;
  height: number;
  blockedCells?: Iterable<GridCell>;
  toCell?: (x: number, y: number) => GridCell;
};

function inBounds(width: number, height: number, x: number, y: number): boolean {
  return x >= 0 && y >= 0 && x < width && y < height;
}

function toIndex(width: number, x: number, y: number): number {
  return y * width + x;
}

export function createMutableGridLevelResource(options: CreateMutableGridLevelResourceOptions): MutableGridLevelResource {
  const { id, version, width, height } = options;
  const blockedCells = options.blockedCells ?? [];
  const toCell = options.toCell ?? ((x: number, y: number) => ({ x: Math.floor(x), y: Math.floor(y) }));

  const collisionBlocked = new Uint8Array(width * height);

  for (const cell of blockedCells) {
    if (!inBounds(width, height, cell.x, cell.y)) {
      continue;
    }

    collisionBlocked[toIndex(width, cell.x, cell.y)] = 1;
  }

  const navBlocked = collisionBlocked.slice();

  return {
    id,
    version,
    width,
    height,
    collisionBlocked,
    navBlocked,
    isBlocked(x: number, y: number): boolean {
      const cell = toCell(x, y);
      if (!inBounds(width, height, cell.x, cell.y)) {
        return true;
      }

      return collisionBlocked[toIndex(width, cell.x, cell.y)] === 1;
    },
    setBlocked(cellX: number, cellY: number, blocked: boolean): void {
      if (!inBounds(width, height, cellX, cellY)) {
        return;
      }

      const value = blocked ? 1 : 0;
      const index = toIndex(width, cellX, cellY);
      collisionBlocked[index] = value;
      navBlocked[index] = value;
    },
    getBlocked(cellX: number, cellY: number): boolean {
      if (!inBounds(width, height, cellX, cellY)) {
        return true;
      }

      return collisionBlocked[toIndex(width, cellX, cellY)] === 1;
    }
  };
}
