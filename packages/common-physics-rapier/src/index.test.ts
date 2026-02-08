import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { World } from "@common/gameplay";
import {
  createPhysicsResource,
  initRapier,
  physicsEnsureSystem,
  physicsStepSystem,
  physicsSyncInSystem,
  physicsSyncOutSystem
} from "./index";

beforeAll(async () => {
  await initRapier();
});

describe("common-physics-rapier", () => {
  let cleanup: Array<() => void> = [];

  afterEach(() => {
    for (const dispose of cleanup) {
      dispose();
    }
    cleanup = [];
  });

  it("creates kinematic bodies and syncs back positions", () => {
    const world = new World();
    const physics = createPhysicsResource();
    cleanup.push(() => physics.dispose());

    const player = world.createEntity();
    world.playerTags.add(player, true);
    world.transforms.add(player, { x: 2, y: 2 });
    world.velocities.add(player, { vx: 1.5, vy: 0.4 });

    physicsEnsureSystem({
      world,
      physics,
      entities: world.queryTransformPlayer(),
      capsule: { radius: 0.25 }
    });

    physicsSyncInSystem({
      world,
      physics,
      entities: world.queryTransformPlayer()
    });

    for (let i = 0; i < 12; i += 1) {
      physicsStepSystem({ physics, dtFrame: 1 / 60 });
    }

    physicsSyncOutSystem({
      world,
      physics,
      entities: world.queryTransformPlayer()
    });

    const playerTransform = world.transforms.get(player);
    expect(playerTransform).toBeDefined();
    expect((playerTransform?.x ?? 0) > 2.1).toBe(true);
    expect((playerTransform?.y ?? 0) > 2.02).toBe(true);
  });

  it("slides along static colliders with character controller", () => {
    const world = new World();
    const physics = createPhysicsResource();
    cleanup.push(() => physics.dispose());

    const player = world.createEntity();
    world.playerTags.add(player, true);
    world.transforms.add(player, { x: 0, y: 0 });
    world.velocities.add(player, { vx: 2, vy: 2 });

    physics.ensureStaticColliderRect(0.8, 0, 0.2, 6);

    physicsEnsureSystem({
      world,
      physics,
      entities: world.queryTransformPlayer(),
      capsule: { radius: 0.25 }
    });

    physicsSyncInSystem({
      world,
      physics,
      entities: world.queryTransformPlayer()
    });

    for (let i = 0; i < 60; i += 1) {
      physicsStepSystem({ physics, dtFrame: 1 / 60 });
    }

    physicsSyncOutSystem({
      world,
      physics,
      entities: world.queryTransformPlayer()
    });

    const playerTransform = world.transforms.get(player);
    expect(playerTransform).toBeDefined();

    // X is constrained by the obstacle while Y keeps advancing.
    expect((playerTransform?.x ?? 0) < 0.7).toBe(true);
    expect((playerTransform?.y ?? 0) > 0.6).toBe(true);
  });

  it("removes static colliders and entity mappings", () => {
    const world = new World();
    const physics = createPhysicsResource();
    cleanup.push(() => physics.dispose());

    const player = world.createEntity();
    world.playerTags.add(player, true);
    world.transforms.add(player, { x: 1, y: 1 });
    world.velocities.add(player, { vx: 0, vy: 0 });

    physics.ensureStaticColliderRect(2, 2, 1, 1);
    physicsEnsureSystem({
      world,
      physics,
      entities: world.queryTransformPlayer(),
      capsule: { radius: 0.2 }
    });

    expect(physics.eidToBody.has(player)).toBe(true);
    expect(physics.rapierWorld.colliders.len()).toBeGreaterThan(0);

    physics.removeEntity(player);
    physics.clearStaticGeometry();

    expect(physics.eidToBody.has(player)).toBe(false);
    expect(physics.eidToColliders.has(player)).toBe(false);
    expect(physics.rapierWorld.colliders.len()).toBe(0);
  });
});
