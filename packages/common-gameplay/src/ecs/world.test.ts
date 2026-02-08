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
    world.playerTags.add(eid, true);

    expect([...world.queryTransformVelocity()]).toEqual([eid]);
    expect([...world.queryTransformPlayer()]).toEqual([eid]);

    world.destroyEntity(eid);

    expect(world.alive(eid)).toBe(false);
    expect(world.transforms.has(eid)).toBe(false);
    expect(world.velocities.has(eid)).toBe(false);
    expect(world.playerTags.has(eid)).toBe(false);
  });

  it("serializes and deserializes component state without persisting runtime EIDs", () => {
    const source = new World({
      level: createOpenLevel("save-level", 7)
    });

    const player = source.createEntity();
    source.transforms.add(player, { x: 5, y: 6 });
    source.velocities.add(player, { vx: 1, vy: 0 });
    source.playerTags.add(player, true);
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
    expect(restored.playerTags.has(eid)).toBe(true);
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
    world.playerTags.add(eid, true);
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
      playerInputSystem() {
        calls.push("player");
      },
      movementSystem() {
        calls.push("movement");
      },
      eventSystem() {
        calls.push("event");
      }
    });

    expect(calls).toEqual(["input", "player", "movement", "event"]);
    expect(world.time.dt).toBe(0.25);
    expect(world.time.t).toBe(0.25);
    expect(world.time.frame).toBe(1);
  });
});
