import { describe, expect, it } from "vitest";
import { KeyboardTracker, createEventSystem, createInputSystem, createMovementSystem, createPlayerInputSystem } from "./systems";
import { World } from "./world";

describe("createPlayerInputSystem", () => {
  it("normalizes diagonal input and writes velocity for player-tagged entities", () => {
    const world = new World();
    const player = world.createEntity();
    world.transforms.add(player, { x: 0, y: 0 });
    world.playerTags.add(player, true);

    world.input.up = true;
    world.input.right = true;

    createPlayerInputSystem(4)(world);

    const velocity = world.velocities.get(player);
    expect(velocity).toBeDefined();
    expect(velocity?.vx ?? 0).toBeCloseTo(2.828427, 5);
    expect(velocity?.vy ?? 0).toBeCloseTo(2.828427, 5);
  });

  it("tolerates unexpected missing velocity reads without throwing", () => {
    const world = new World();
    const player = world.createEntity();
    world.transforms.add(player, { x: 0, y: 0 });
    world.playerTags.add(player, true);

    const originalGet = world.velocities.get.bind(world.velocities);
    let first = true;
    world.velocities.get = ((eid: number) => {
      if (first) {
        first = false;
        return undefined;
      }
      return originalGet(eid);
    }) as typeof world.velocities.get;

    expect(() => createPlayerInputSystem(4)(world)).not.toThrow();
  });
});

describe("createMovementSystem", () => {
  it("emits BumpedWall when blocked and Moved when free", () => {
    const world = new World({
      level: {
        id: "blocked-x>=1",
        version: 1,
        isBlocked(x) {
          return x >= 1;
        }
      }
    });

    const eid = world.createEntity();
    world.transforms.add(eid, { x: 0, y: 0 });
    world.velocities.add(eid, { vx: 1, vy: 0 });
    world.time.dt = 1;

    const movement = createMovementSystem();
    movement(world);

    expect(world.transforms.get(eid)).toEqual({ x: 0, y: 0 });
    expect(world.events.drain()).toEqual([{ type: "BumpedWall", e: eid }]);

    world.setLevel({
      id: "open",
      version: 1,
      isBlocked() {
        return false;
      }
    });

    movement(world);
    expect(world.transforms.get(eid)).toEqual({ x: 1, y: 0 });
    expect(world.events.drain()).toEqual([{ type: "Moved", e: eid }]);
  });

  it("skips malformed query entries defensively", () => {
    const world = new World();
    const eid = world.createEntity();
    world.time.dt = 1;
    world.queryTransformVelocity = function* () {
      yield eid;
    };

    expect(() => createMovementSystem()(world)).not.toThrow();
  });
});

describe("KeyboardTracker and createInputSystem", () => {
  it("reads held and pressed keys into world input resource", () => {
    const handlers = new Map<string, (event: { code: string }) => void>();
    const fakeWindow = {
      addEventListener(type: string, handler: (event: { code: string }) => void) {
        handlers.set(type, handler);
      },
      removeEventListener(type: string) {
        handlers.delete(type);
      }
    } as unknown as Window;

    const tracker = new KeyboardTracker(fakeWindow);
    handlers.get("keydown")?.({ code: "KeyW" });
    handlers.get("keydown")?.({ code: "KeyK" });

    const world = new World();
    createInputSystem(tracker)(world);
    expect(world.input.up).toBe(true);
    expect(world.input.savePressed).toBe(true);

    createInputSystem(tracker)(world);
    expect(world.input.savePressed).toBe(false);

    handlers.get("keyup")?.({ code: "KeyW" });
    createInputSystem(tracker)(world);
    expect(world.input.up).toBe(false);

    tracker.dispose(fakeWindow);
  });
});

describe("createEventSystem", () => {
  it("drains events and writes to debug sink", () => {
    const world = new World();
    world.time.frame = 12;
    world.events.emit({ type: "Moved", e: 1 });
    world.events.emit({ type: "BumpedWall", e: 2 });

    const sink: Array<{ frame: number; message: string }> = [];
    createEventSystem(sink)(world);

    expect(sink).toHaveLength(2);
    expect(sink[0]?.message).toContain("[frame 12]");
    expect(world.events.drain()).toEqual([]);
  });
});
