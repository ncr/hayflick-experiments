import { afterEach, describe, expect, it, vi } from "vitest";
import {
  SAVE_SCHEMA_VERSION,
  createOpenLevel,
  loadWorldFromLocalStorage,
  migrateSave,
  resolveOpenLevel,
  saveWorldToLocalStorage,
  serializeWorld
} from "./save-load";
import { World } from "./world";

describe("createOpenLevel", () => {
  it("creates a non-blocking default level resource", () => {
    const level = createOpenLevel("open", 2);
    expect(level.id).toBe("open");
    expect(level.version).toBe(2);
    expect(level.isBlocked(100, 100)).toBe(false);
  });
});

describe("migrateSave", () => {
  it("accepts valid v1 payloads and rejects invalid payloads", () => {
    const valid = migrateSave({
      schemaVersion: SAVE_SCHEMA_VERSION,
      level: { id: "a", version: 1 },
      time: { t: 2 },
      entities: [
        {
          components: {
            Transform: { x: 1, y: 2 },
            Velocity: { vx: 3, vy: 4 },
            // Legacy PlayerTag fields in old saves are silently ignored —
            // `Controlled` is now runtime-only.
            PlayerTag: true,
            Persistent: { kind: "player" }
          }
        }
      ]
    });

    expect(valid).not.toBeNull();
    expect(valid?.entities).toHaveLength(1);
    expect(valid?.entities[0]?.components.Persistent).toEqual({ kind: "player" });
    expect(migrateSave({ schemaVersion: 999 })).toBeNull();
    expect(migrateSave({ level: {}, time: {}, entities: [] })).toBeNull();
    expect(migrateSave(null)).toBeNull();
  });

  it("skips malformed entity entries while keeping valid ones", () => {
    const migrated = migrateSave({
      schemaVersion: SAVE_SCHEMA_VERSION,
      level: { id: "a", version: 1 },
      time: { t: 2 },
      entities: [
        "bad",
        { components: "bad" },
        { components: { Transform: { x: 1, y: 2 } } }
      ]
    });

    expect(migrated).not.toBeNull();
    expect(migrated?.entities).toHaveLength(1);
    expect(migrated?.entities[0]?.components.Transform).toEqual({ x: 1, y: 2 });
  });
});

describe("serializeWorld", () => {
  it("writes save records without runtime EIDs", () => {
    const world = new World({
      level: {
        id: "lvl",
        version: 3,
        isBlocked() {
          return false;
        }
      }
    });
    const eid = world.createEntity();
    world.transforms.add(eid, { x: 9, y: 8 });

    const save = serializeWorld(world);
    expect(save.schemaVersion).toBe(SAVE_SCHEMA_VERSION);
    expect(save.level).toEqual({ id: "lvl", version: 3 });
    expect(JSON.stringify(save)).not.toContain(`"${eid}"`);
  });
});

describe("localStorage save/load helpers", () => {
  const storage = new Map<string, string>();
  const localStorageMock = {
    getItem(key: string) {
      return storage.has(key) ? storage.get(key)! : null;
    },
    setItem(key: string, value: string) {
      storage.set(key, value);
    }
  };

  afterEach(() => {
    storage.clear();
    vi.unstubAllGlobals();
  });

  it("saves and restores world state from localStorage", () => {
    vi.stubGlobal("localStorage", localStorageMock);

    const source = new World();
    const eid = source.createEntity();
    source.transforms.add(eid, { x: 3, y: 4 });
    source.time.t = 5;

    saveWorldToLocalStorage(source, "save-key");

    const target = new World({
      resolveLevel(snapshot) {
        return resolveOpenLevel(snapshot);
      }
    });

    expect(loadWorldFromLocalStorage(target, "save-key")).toBe(true);
    const loadedEid = [...target.entities()][0];
    expect(target.transforms.get(loadedEid)).toEqual({ x: 3, y: 4 });
    expect(target.time.t).toBe(5);
  });

  it("returns false for missing, malformed, or unsupported saves", () => {
    vi.stubGlobal("localStorage", localStorageMock);
    const world = new World();

    expect(loadWorldFromLocalStorage(world, "missing")).toBe(false);

    storage.set("bad-json", "{oops");
    expect(loadWorldFromLocalStorage(world, "bad-json")).toBe(false);

    storage.set("bad-schema", JSON.stringify({ schemaVersion: 999 }));
    expect(loadWorldFromLocalStorage(world, "bad-schema")).toBe(false);
  });
});
