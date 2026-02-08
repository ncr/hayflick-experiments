import { describe, expect, it } from "vitest";
import { createMovementSystem, createPlayerInputSystem } from "./systems";
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
});
