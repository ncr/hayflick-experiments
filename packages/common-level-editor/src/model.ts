export const TILE_WALKABLE = 0;
export const TILE_WALL = 1;

export type TileType = 0 | 1;

export type DoorPlacementData = {
  open?: boolean;
  locked?: boolean;
};

export const LEVEL_MODEL_PLACEMENT_KIND = {
  DOOR: "door"
} as const;

export type Placement = {
  id: string;
  kind: typeof LEVEL_MODEL_PLACEMENT_KIND.DOOR;
  x: number;
  y: number;
  rot?: number;
  data?: DoorPlacementData;
};

export type LevelModel = {
  width: number;
  height: number;
  tiles: TileType[];
  placements: Placement[];
};

function isFiniteInt(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && Number.isInteger(value);
}

function readRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  return value as Record<string, unknown>;
}

export function isDoorPlacementKind(value: unknown): value is Placement["kind"] {
  return value === LEVEL_MODEL_PLACEMENT_KIND.DOOR;
}

function isDoorPlacementAt(placement: Placement, x: number, y: number): boolean {
  return placement.kind === LEVEL_MODEL_PLACEMENT_KIND.DOOR && placement.x === x && placement.y === y;
}

export function createLevelModel(width: number, height: number): LevelModel {
  const clampedWidth = Math.max(1, Math.floor(width));
  const clampedHeight = Math.max(1, Math.floor(height));

  return {
    width: clampedWidth,
    height: clampedHeight,
    tiles: new Array<TileType>(clampedWidth * clampedHeight).fill(TILE_WALKABLE),
    placements: []
  };
}

export function createDefaultLevelModel(): LevelModel {
  const model = createLevelModel(18, 18);

  const drawRoom = (minX: number, minY: number, maxX: number, maxY: number): void => {
    for (let x = minX; x <= maxX; x += 1) {
      setTileAt(model, x, minY, TILE_WALL);
      setTileAt(model, x, maxY, TILE_WALL);
    }
    for (let y = minY; y <= maxY; y += 1) {
      setTileAt(model, minX, y, TILE_WALL);
      setTileAt(model, maxX, y, TILE_WALL);
    }
  };

  // Two-room mockup with a shared wall.
  drawRoom(4, 6, 9, 11);
  drawRoom(9, 6, 14, 11);

  // Door between rooms (shared wall) and one exterior door.
  addDoorPlacement(model, {
    id: "door-1",
    kind: LEVEL_MODEL_PLACEMENT_KIND.DOOR,
    x: 9,
    y: 8,
    rot: 1,
    data: { open: false }
  });
  addDoorPlacement(model, {
    id: "door-2",
    kind: LEVEL_MODEL_PLACEMENT_KIND.DOOR,
    x: 6,
    y: 6,
    rot: 0,
    data: { open: false }
  });

  return model;
}

export function cloneLevelModel(model: LevelModel): LevelModel {
  return {
    width: model.width,
    height: model.height,
    tiles: model.tiles.slice(),
    placements: model.placements.map((placement) => ({
      ...placement,
      data: placement.data ? { ...placement.data } : undefined
    }))
  };
}

export function cellIndex(model: LevelModel, x: number, y: number): number {
  return y * model.width + x;
}

export function inBounds(model: LevelModel, x: number, y: number): boolean {
  return x >= 0 && y >= 0 && x < model.width && y < model.height;
}

export function getTileAt(model: LevelModel, x: number, y: number): TileType {
  if (!inBounds(model, x, y)) {
    return TILE_WALL;
  }

  return model.tiles[cellIndex(model, x, y)] ?? TILE_WALKABLE;
}

export function setTileAt(model: LevelModel, x: number, y: number, tile: TileType): boolean {
  if (!inBounds(model, x, y)) {
    return false;
  }

  const index = cellIndex(model, x, y);
  if (model.tiles[index] === tile) {
    return false;
  }

  model.tiles[index] = tile;
  return true;
}

export function findDoorPlacementAt(model: LevelModel, x: number, y: number): Placement | undefined {
  return model.placements.find((placement) => isDoorPlacementAt(placement, x, y));
}

export function removeDoorPlacementAt(model: LevelModel, x: number, y: number): boolean {
  const index = model.placements.findIndex((placement) => isDoorPlacementAt(placement, x, y));
  if (index < 0) {
    return false;
  }

  model.placements.splice(index, 1);
  return true;
}

export function addDoorPlacement(model: LevelModel, placement: Placement): void {
  const existing = model.placements.findIndex((entry) => entry.id === placement.id);
  if (existing >= 0) {
    model.placements[existing] = {
      ...placement,
      data: placement.data ? { ...placement.data } : undefined
    };
    return;
  }

  model.placements.push({
    ...placement,
    data: placement.data ? { ...placement.data } : undefined
  });
}

export function nextPlacementId(model: LevelModel): string {
  const taken = new Set(model.placements.map((placement) => placement.id));
  let next = model.placements.length + 1;

  while (taken.has(`door-${next}`)) {
    next += 1;
  }

  return `door-${next}`;
}

export function serializeLevelModel(model: LevelModel): string {
  return JSON.stringify(model);
}

export function parseLevelModel(raw: unknown): LevelModel | null {
  const record = readRecord(raw);
  if (!record) {
    return null;
  }

  const width = record.width;
  const height = record.height;
  const tiles = record.tiles;
  const placements = record.placements;

  if (!isFiniteInt(width) || !isFiniteInt(height) || !Array.isArray(tiles) || !Array.isArray(placements)) {
    return null;
  }

  if (width < 1 || height < 1 || tiles.length !== width * height) {
    return null;
  }

  const parsedTiles: TileType[] = [];

  for (const tile of tiles) {
    if (tile === TILE_WALKABLE || tile === TILE_WALL) {
      parsedTiles.push(tile);
      continue;
    }

    return null;
  }

  const parsedPlacements: Placement[] = [];

  for (const placementRaw of placements) {
    const placement = readRecord(placementRaw);
    if (!placement) {
      return null;
    }

    const id = placement.id;
    const kind = placement.kind;
    const x = placement.x;
    const y = placement.y;
    const rot = placement.rot;
    const dataRaw = placement.data;

    if (typeof id !== "string" || !isDoorPlacementKind(kind) || !isFiniteInt(x) || !isFiniteInt(y)) {
      return null;
    }

    if (x < 0 || y < 0 || x >= width || y >= height) {
      return null;
    }

    let data: DoorPlacementData | undefined;
    if (dataRaw !== undefined) {
      const dataRecord = readRecord(dataRaw);
      if (!dataRecord) {
        return null;
      }

      const openValue = dataRecord.open;
      const lockedValue = dataRecord.locked;

      data = {};
      if (openValue !== undefined) {
        if (typeof openValue !== "boolean") {
          return null;
        }
        data.open = openValue;
      }

      if (lockedValue !== undefined) {
        if (typeof lockedValue !== "boolean") {
          return null;
        }
        data.locked = lockedValue;
      }
    }

    let parsedRot: number | undefined;
    if (rot !== undefined) {
      if (!isFiniteInt(rot)) {
        return null;
      }
      parsedRot = ((rot % 4) + 4) % 4;
    }

    parsedPlacements.push({
      id,
      kind: LEVEL_MODEL_PLACEMENT_KIND.DOOR,
      x,
      y,
      rot: parsedRot,
      data
    });
  }

  return {
    width,
    height,
    tiles: parsedTiles,
    placements: parsedPlacements
  };
}
