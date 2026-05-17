import { describe, expect, it } from "vitest";
import { createOpenLevel } from "./save-load";
import { frame } from "./systems";
import { World } from "./world";

describe("World", () => {
  it("creates, queries, and destroys entities with component cleanup", () => {
    const world = new World();
    world.destroyEntity(999);
    const eid = world.createEntity();

    world.transforms.add(eid, { x: 1, y: 2 });
    world.velocities.add(eid, { vx: 3, vy: 4 });
    world.controlled.add(eid, { speed: 80 });

    expect([...world.queryTransformVelocity()]).toEqual([eid]);
    expect([...world.queryTransformControlled()]).toEqual([eid]);

    world.destroyEntity(eid);

    expect(world.alive(eid)).toBe(false);
    expect(world.transforms.has(eid)).toBe(false);
    expect(world.velocities.has(eid)).toBe(false);
    expect(world.controlled.has(eid)).toBe(false);
    expect(world.sceneRefs.has(eid)).toBe(false);
  });

  it("serializes and deserializes component state without persisting runtime EIDs", () => {
    const source = new World({
      level: createOpenLevel("save-level", 7)
    });

    const player = source.createEntity();
    source.transforms.add(player, { x: 5, y: 6 });
    source.velocities.add(player, { vx: 1, vy: 0 });
    // `controlled` is intentionally runtime-only — it carries a function
    // speed that can't serialize. The game re-attaches the binding in
    // its setup after load.
    source.persistents.add(player, { kind: "player" });
    source.time.t = 9.5;

    const save = source.serialize();
    expect(JSON.stringify(save)).not.toContain("eid");

    const restored = new World({
      resolveLevel(snapshot) {
        return createOpenLevel(snapshot.id, snapshot.version);
      }
    });

    restored.deserialize(save);
    const [eid] = [...restored.entities()];
    expect(eid).toBe(1);
    expect(restored.transforms.get(eid)).toEqual({ x: 5, y: 6 });
    expect(restored.velocities.get(eid)).toEqual({ vx: 1, vy: 0 });
    expect(restored.persistents.get(eid)).toEqual({ kind: "player" });
    expect(restored.level.id).toBe("save-level");
    expect(restored.level.version).toBe(7);
    expect(restored.time.t).toBe(9.5);
  });

  it("delegates save/load wrappers to localStorage helpers", () => {
    const storage = new Map<string, string>();
    const localStorageMock = {
      getItem(key: string) {
        return storage.has(key) ? storage.get(key)! : null;
      },
      setItem(key: string, value: string) {
        storage.set(key, value);
      }
    };
    (globalThis as { localStorage: typeof localStorageMock }).localStorage = localStorageMock;

    const world = new World({
      level: createOpenLevel("wrapper", 1)
    });
    const eid = world.createEntity();
    world.transforms.add(eid, { x: 2, y: 3 });
    world.time.t = 7;

    world.saveToLocalStorage("wrapper-key");

    const target = new World({
      resolveLevel(snapshot) {
        return createOpenLevel(snapshot.id, snapshot.version);
      }
    });

    expect(target.loadFromLocalStorage("wrapper-key")).toBe(true);
    expect([...target.entities()]).toHaveLength(1);
  });
});

describe("frame", () => {
  it("runs systems in fixed order and advances time once per frame", () => {
    const world = new World();
    const calls: string[] = [];

    frame(world, 0.25, {
      inputSystem() {
        calls.push("input");
      },
      controlledInputSystem() {
        calls.push("controlled");
      },
      movementSystem() {
        calls.push("movement");
      },
      meshSyncSystem() {
        calls.push("meshSync");
      },
      eventSystem() {
        calls.push("event");
      }
    });

    expect(calls).toEqual(["input", "controlled", "movement", "meshSync", "event"]);
    expect(world.time.dt).toBe(0.25);
    expect(world.time.t).toBe(0.25);
    expect(world.time.frame).toBe(1);
  });
});
