import { describe, expect, it } from "vitest";
import {
  ISO_INPUT_DIAGONAL_A_RATE,
  ISO_INPUT_DIAGONAL_B_RATE,
  KeyboardTracker,
  createEventSystem,
  createInputSystem,
  createMovementSystem,
  createPlayerInputSystem,
  recommendedMinPxPerSecForIso
} from "./systems";
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

describe("recommendedMinPxPerSecForIso", () => {
  it("a-axis fluid threshold: speed where one a-tick per frame is guaranteed on diagonals", () => {
    // At 60fps, dominant axis advances ISO_INPUT_DIAGONAL_A_RATE * v per
    // frame. Setting that to 1 ⇒ v = 60 / 0.894 ≈ 67 px/s.
    const v = recommendedMinPxPerSecForIso({ targetFps: 60 });
    expect(v).toBeCloseTo(60 / ISO_INPUT_DIAGONAL_A_RATE, 5);
    expect(v).toBeGreaterThan(66);
    expect(v).toBeLessThan(68);
  });

  it("stair-per-frame threshold: speed where b also ticks every frame on diagonals", () => {
    // b-rate is half of a-rate, so threshold is doubled.
    const aFluid = recommendedMinPxPerSecForIso({ targetFps: 60, mode: "a-fluid" });
    const stair = recommendedMinPxPerSecForIso({ targetFps: 60, mode: "stair-per-frame" });
    expect(stair).toBeCloseTo(60 / ISO_INPUT_DIAGONAL_B_RATE, 5);
    expect(stair / aFluid).toBeCloseTo(2, 5);
  });

  it("scales linearly with targetFps", () => {
    const v60 = recommendedMinPxPerSecForIso({ targetFps: 60 });
    const v120 = recommendedMinPxPerSecForIso({ targetFps: 120 });
    expect(v120).toBeCloseTo(v60 * 2, 5);
  });

  it("default targetFps is 60", () => {
    expect(recommendedMinPxPerSecForIso()).toBeCloseTo(
      recommendedMinPxPerSecForIso({ targetFps: 60 }),
      5
    );
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
