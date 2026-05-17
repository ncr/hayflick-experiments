import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { DataStore, World } from "@common/gameplay";
import {
  createPhysicsResource,
  initRapier,
  physicsEventsSystem,
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

  it("caches Rapier init across calls", async () => {
    const first = initRapier();
    const second = initRapier();
    expect(first).toBe(second);
    await second;
  });

  it("ensures one kinematic body per entity and wires ECS-facing stores", () => {
    const world = new World();
    const physics = createPhysicsResource();
    cleanup.push(() => physics.dispose());

    const tracked = world.createEntity();
    world.transforms.add(tracked, { x: 2, y: 2 });

    const missingTransform = world.createEntity();

    const dead = world.createEntity();
    world.transforms.add(dead, { x: 5, y: 5 });
    world.destroyEntity(dead);

    const bodyRefs = new DataStore<{ bodyHandle: number }>();
    const colliderRefs = new DataStore<{ colliderHandle: number }>();

    physicsEnsureSystem({
      world,
      physics,
      entities: [tracked, missingTransform, dead],
      capsule: { radius: 0.25, halfHeight: 0.2 },
      physicsBodies: bodyRefs,
      physicsColliders: colliderRefs
    });

    expect(physics.eidToBody.has(tracked)).toBe(true);
    expect(physics.eidToBody.has(missingTransform)).toBe(false);
    expect(physics.eidToBody.has(dead)).toBe(false);
    expect(bodyRefs.has(tracked)).toBe(true);
    expect(colliderRefs.has(tracked)).toBe(true);

    const ensuredAgain = physics.ensureKinematicBody(tracked, { x: 99, y: 99 }, { radius: 0.25 });
    expect(ensuredAgain.created).toBe(false);
  });

  it("creates kinematic bodies and syncs back positions", () => {
    const world = new World();
    const physics = createPhysicsResource();
    cleanup.push(() => physics.dispose());

    const player = world.createEntity();
    world.controlled.add(player, { speed: 0 });
    world.transforms.add(player, { x: 2, y: 2 });
    world.velocities.add(player, { vx: 1.5, vy: 0.4 });

    physicsEnsureSystem({
      world,
      physics,
      entities: world.queryTransformControlled(),
      capsule: { radius: 0.25 }
    });

    physicsSyncInSystem({
      world,
      physics,
      entities: world.queryTransformControlled()
    });

    for (let i = 0; i < 12; i += 1) {
      physicsStepSystem({ physics, dtFrame: 1 / 60 });
    }

    physicsSyncOutSystem({
      world,
      physics,
      entities: world.queryTransformControlled()
    });

    const playerTransform = world.transforms.get(player);
    expect(playerTransform).toBeDefined();
    expect((playerTransform?.x ?? 0) > 2.1).toBe(true);
    expect((playerTransform?.y ?? 0) > 2.02).toBe(true);
  });

  it("supports explicit translation + target and ignores sync-out for missing bodies", () => {
    const world = new World();
    const physics = createPhysicsResource();
    cleanup.push(() => physics.dispose());

    const player = world.createEntity();
    world.transforms.add(player, { x: 1, y: 1 });
    world.velocities.add(player, { vx: 0, vy: 0 });

    const noPhysicsBody = world.createEntity();
    world.transforms.add(noPhysicsBody, { x: 8, y: 8 });

    physicsEnsureSystem({
      world,
      physics,
      entities: [player],
      capsule: { radius: 0.2 }
    });

    expect(physics.getTranslation(999_999)).toBeNull();

    physics.setTranslation(player, { x: 3, y: 4 });
    expect(physics.getTranslation(player)).toEqual({ x: 3, y: 4 });

    physics.setKinematicTarget(player, { x: 4, y: 5 });
    physicsStepSystem({ physics, dtFrame: 1 / 60 });

    physicsSyncOutSystem({
      world,
      physics,
      entities: [player, noPhysicsBody, 123_456]
    });

    expect(world.transforms.get(player)).toEqual({ x: 4, y: 5 });
    expect(world.transforms.get(noPhysicsBody)).toEqual({ x: 8, y: 8 });
  });

  it("slides along static colliders with character controller", () => {
    const world = new World();
    const physics = createPhysicsResource();
    cleanup.push(() => physics.dispose());

    const player = world.createEntity();
    world.controlled.add(player, { speed: 0 });
    world.transforms.add(player, { x: 0, y: 0 });
    world.velocities.add(player, { vx: 2, vy: 2 });

    physics.ensureStaticColliderRect(0.8, 0, 0.2, 6);

    physicsEnsureSystem({
      world,
      physics,
      entities: world.queryTransformControlled(),
      capsule: { radius: 0.25 }
    });

    physicsSyncInSystem({
      world,
      physics,
      entities: world.queryTransformControlled()
    });

    for (let i = 0; i < 60; i += 1) {
      physicsStepSystem({ physics, dtFrame: 1 / 60 });
    }

    physicsSyncOutSystem({
      world,
      physics,
      entities: world.queryTransformControlled()
    });

    const playerTransform = world.transforms.get(player);
    expect(playerTransform).toBeDefined();

    // X is constrained by the obstacle while Y keeps advancing.
    expect((playerTransform?.x ?? 0) < 0.7).toBe(true);
    expect((playerTransform?.y ?? 0) > 0.6).toBe(true);
  });

  it("applies fixed-step clamping and supports collider enable/disable", () => {
    const world = new World();
    const physics = createPhysicsResource({ fixedDt: 1 / 60, maxSubsteps: 2 });
    cleanup.push(() => physics.dispose());

    const player = world.createEntity();
    world.transforms.add(player, { x: 0, y: 0 });
    world.velocities.add(player, { vx: 2, vy: 0 });

    physicsEnsureSystem({
      world,
      physics,
      entities: [player],
      capsule: { radius: 0.25 }
    });
    physicsSyncInSystem({ world, physics, entities: [player] });

    const negativeSteps = physics.step(-1);
    expect(negativeSteps).toBe(0);

    const clampedSteps = physics.step(1);
    expect(clampedSteps).toBe(2);
    expect(physics.accumulator).toBe(0);

    const handle = physics.ensureStaticColliderRect(2, 2, 1, 1);
    const collider = physics.rapierWorld.colliders.get(handle);
    expect(collider?.isEnabled()).toBe(true);

    physics.setColliderEnabled(handle, false);
    expect(collider?.isEnabled()).toBe(false);

    physics.setColliderEnabled(handle, true);
    expect(collider?.isEnabled()).toBe(true);

    physics.setColliderEnabled(999_999 as number, true);

    physics.clearStaticGeometry();
    expect(physics.rapierWorld.colliders.get(handle)).toBeNull();
  });

  it("removes static colliders and entity mappings", () => {
    const world = new World();
    const physics = createPhysicsResource();
    cleanup.push(() => physics.dispose());

    const player = world.createEntity();
    world.controlled.add(player, { speed: 0 });
    world.transforms.add(player, { x: 1, y: 1 });
    world.velocities.add(player, { vx: 0, vy: 0 });

    physics.ensureStaticColliderRect(2, 2, 1, 1);
    physicsEnsureSystem({
      world,
      physics,
      entities: world.queryTransformControlled(),
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

  it("skips stepping entities missing a collider and keeps cleanup robust", () => {
    const world = new World();
    const physics = createPhysicsResource();
    cleanup.push(() => physics.dispose());

    const player = world.createEntity();
    world.transforms.add(player, { x: 1, y: 1 });
    world.velocities.add(player, { vx: 3, vy: 0 });

    physicsEnsureSystem({
      world,
      physics,
      entities: [player],
      capsule: { radius: 0.2 }
    });
    physicsSyncInSystem({ world, physics, entities: [player] });

    const colliderHandle = [...(physics.eidToColliders.get(player) ?? [])][0];
    const collider = physics.rapierWorld.colliders.get(colliderHandle);
    if (collider) {
      physics.rapierWorld.removeCollider(collider, true);
    }

    expect(() => physics.step(1 / 30)).not.toThrow();

    const bodyHandle = physics.eidToBody.get(player);
    const body = bodyHandle === undefined ? null : physics.rapierWorld.bodies.get(bodyHandle);
    if (body) {
      physics.rapierWorld.removeRigidBody(body);
    }

    physics.removeEntity(player);
    physics.removeEntity(777_777);
    expect(physics.eidToBody.has(player)).toBe(false);
    expect(physics.eidToColliders.has(player)).toBe(false);
  });

  it("keeps physicsEventsSystem as a no-op hook", () => {
    expect(() => physicsEventsSystem()).not.toThrow();
  });
});
