import type { EID, LevelResource, Persistent, SaveEntityRecord, SaveGame, Transform, Velocity } from "./types";
import type { World } from "./world";

export const SAVE_SCHEMA_VERSION = 1;

// Save/load keeps format versioned and migration-ready from day one.
// We serialize component data by entity records, never raw EIDs.
export function createDemoLevel(id = "demo-halfplane", version = 1): LevelResource {
  return {
    id,
    version,
    isBlocked(x: number): boolean {
      return x > 5;
    }
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function readNumber(record: Record<string, unknown>, key: string): number | null {
  const value = record[key];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return null;
  }
  return value;
}

function readString(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === "string" ? value : null;
}

function readTransform(value: unknown): Transform | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const x = readNumber(value, "x");
  const y = readNumber(value, "y");
  if (x === null || y === null) {
    return undefined;
  }

  return { x, y };
}

function readVelocity(value: unknown): Velocity | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const vx = readNumber(value, "vx");
  const vy = readNumber(value, "vy");
  if (vx === null || vy === null) {
    return undefined;
  }

  return { vx, vy };
}

function readPersistent(value: unknown): Persistent | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const kind = readString(value, "kind");
  if (kind === null) {
    return undefined;
  }

  return { kind };
}

function hasAnyComponent(components: SaveEntityRecord["components"]): boolean {
  return (
    components.Transform !== undefined ||
    components.Velocity !== undefined ||
    components.PlayerTag === true ||
    components.Persistent !== undefined
  );
}

function migrateV1(raw: Record<string, unknown>): SaveGame | null {
  const levelRaw = raw.level;
  const timeRaw = raw.time;
  const entitiesRaw = raw.entities;

  if (!isRecord(levelRaw) || !isRecord(timeRaw) || !Array.isArray(entitiesRaw)) {
    return null;
  }

  const levelId = readString(levelRaw, "id");
  const levelVersion = readNumber(levelRaw, "version");
  const timeT = readNumber(timeRaw, "t");

  if (levelId === null || levelVersion === null || timeT === null) {
    return null;
  }

  const entities: SaveEntityRecord[] = [];

  for (const entityRaw of entitiesRaw) {
    if (!isRecord(entityRaw)) {
      continue;
    }

    const componentsRaw = entityRaw.components;
    if (!isRecord(componentsRaw)) {
      continue;
    }

    const components: SaveEntityRecord["components"] = {};

    const transform = readTransform(componentsRaw.Transform);
    if (transform) {
      components.Transform = transform;
    }

    const velocity = readVelocity(componentsRaw.Velocity);
    if (velocity) {
      components.Velocity = velocity;
    }

    if (componentsRaw.PlayerTag === true) {
      components.PlayerTag = true;
    }

    const persistent = readPersistent(componentsRaw.Persistent);
    if (persistent) {
      components.Persistent = persistent;
    }

    if (hasAnyComponent(components)) {
      entities.push({ components });
    }
  }

  return {
    schemaVersion: SAVE_SCHEMA_VERSION,
    level: {
      id: levelId,
      version: levelVersion
    },
    time: {
      t: timeT
    },
    entities
  };
}

// Migration hook entrypoint; ready for future schema upgrades.
export function migrateSave(raw: unknown): SaveGame | null {
  if (!isRecord(raw)) {
    return null;
  }

  const version = readNumber(raw, "schemaVersion");
  if (version === null) {
    return null;
  }

  if (version === 1) {
    return migrateV1(raw);
  }

  console.warn(`[ecs-foundation] Unsupported save schemaVersion: ${String(version)}`);
  return null;
}

function levelFromSave(level: { id: string; version: number }): LevelResource {
  return createDemoLevel(level.id, level.version);
}

export function serializeWorld(world: World): SaveGame {
  const entities: SaveEntityRecord[] = [];

  for (const eid of world.entities()) {
    const components: SaveEntityRecord["components"] = {};

    const transform = world.transforms.get(eid);
    if (transform) {
      components.Transform = { x: transform.x, y: transform.y };
    }

    const velocity = world.velocities.get(eid);
    if (velocity) {
      components.Velocity = { vx: velocity.vx, vy: velocity.vy };
    }

    if (world.playerTags.has(eid)) {
      components.PlayerTag = true;
    }

    const persistent = world.persistents.get(eid);
    if (persistent) {
      components.Persistent = { kind: persistent.kind };
    }

    if (hasAnyComponent(components)) {
      entities.push({ components });
    }
  }

  return {
    schemaVersion: SAVE_SCHEMA_VERSION,
    level: {
      id: world.level.id,
      version: world.level.version
    },
    time: {
      t: world.time.t
    },
    entities
  };
}

export function deserializeWorld(world: World, save: SaveGame): void {
  world.clear();

  world.setLevel(levelFromSave(save.level));
  world.time.dt = 0;
  world.time.t = save.time.t;
  world.time.frame = 0;

  world.input.up = false;
  world.input.down = false;
  world.input.left = false;
  world.input.right = false;
  world.input.savePressed = false;
  world.input.loadPressed = false;

  for (const savedEntity of save.entities) {
    const eid: EID = world.createEntity();
    const components = savedEntity.components;

    if (components.Transform) {
      world.transforms.add(eid, {
        x: components.Transform.x,
        y: components.Transform.y
      });
    }

    if (components.Velocity) {
      world.velocities.add(eid, {
        vx: components.Velocity.vx,
        vy: components.Velocity.vy
      });
    }

    if (components.PlayerTag === true) {
      world.playerTags.add(eid, true);
    }

    if (components.Persistent) {
      world.persistents.add(eid, { kind: components.Persistent.kind });
    }
  }
}

export function saveWorldToLocalStorage(world: World, key = "ecs_demo_save"): void {
  const save = serializeWorld(world);
  const json = JSON.stringify(save);
  localStorage.setItem(key, json);
}

export function loadWorldFromLocalStorage(world: World, key = "ecs_demo_save"): boolean {
  const json = localStorage.getItem(key);
  if (!json) {
    return false;
  }

  try {
    const raw = JSON.parse(json) as unknown;
    const migrated = migrateSave(raw);
    if (!migrated) {
      console.warn("[ecs-foundation] Save payload failed migration/validation.");
      return false;
    }

    deserializeWorld(world, migrated);
    return true;
  } catch (error) {
    console.warn("[ecs-foundation] Failed to parse save payload.", error);
    return false;
  }
}
