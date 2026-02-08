/**
 * Rapier physics is kept as an explicit resource so ECS gameplay state stays decoupled
 * from physics implementation details.
 *
 * Runtime flow per frame:
 * 1) sync-in writes desired kinematic velocity from ECS components,
 * 2) fixed-step integration consumes an accumulator (stable across FPS),
 * 3) sync-out copies Rapier body positions back into ECS transforms.
 *
 * LevelResource remains separate from Rapier because gameplay logic/pathing can query
 * grid-level blocking independently from physics internals, while door toggles update both.
 */

import RAPIER, {
  type Collider,
  type ColliderHandle,
  type KinematicCharacterController,
  type RigidBody,
  type RigidBodyHandle,
  type World as RapierWorld
} from "@dimforge/rapier2d-compat";
import type { EID, Transform, World } from "@common/gameplay";
import { DataStore } from "@common/gameplay";

export type PhysicsBodyRef = {
  bodyHandle: RigidBodyHandle;
};

export type PhysicsColliderRef = {
  colliderHandle: ColliderHandle;
};

export type PhysicsCapsuleDesc = {
  radius: number;
  halfHeight?: number;
};

export type PhysicsResource = {
  rapierWorld: RapierWorld;
  characterController: KinematicCharacterController;
  fixedDt: number;
  accumulator: number;
  maxSubsteps: number;
  eidToBody: Map<EID, RigidBodyHandle>;
  eidToColliders: Map<EID, Set<ColliderHandle>>;
  colliderToEid: Map<number, EID>;
  ensureKinematicBody(
    eid: EID,
    transform: Transform,
    capsuleDesc: PhysicsCapsuleDesc
  ): { bodyHandle: RigidBodyHandle; colliderHandle: ColliderHandle; created: boolean };
  ensureStaticColliderRect(x: number, y: number, w: number, h: number): ColliderHandle;
  removeEntity(eid: EID): void;
  setKinematicTarget(eid: EID, nextPos: { x: number; y: number }): void;
  setTranslation(eid: EID, pos: { x: number; y: number }): void;
  setDesiredVelocity(eid: EID, velocity: { vx: number; vy: number }): void;
  getTranslation(eid: EID): { x: number; y: number } | null;
  setColliderEnabled(handle: ColliderHandle, enabled: boolean): void;
  clearStaticGeometry(): void;
  step(dtFrame: number): number;
  dispose(): void;
};

export type PhysicsEnsureOptions = {
  world: World;
  physics: PhysicsResource;
  entities: Iterable<EID>;
  capsule: PhysicsCapsuleDesc;
  physicsBodies?: DataStore<PhysicsBodyRef>;
  physicsColliders?: DataStore<PhysicsColliderRef>;
};

export type PhysicsSyncInOptions = {
  world: World;
  physics: PhysicsResource;
  entities: Iterable<EID>;
};

export type PhysicsStepOptions = {
  physics: PhysicsResource;
  dtFrame: number;
};

export type PhysicsSyncOutOptions = {
  world: World;
  physics: PhysicsResource;
  entities: Iterable<EID>;
};

let rapierInitPromise: Promise<void> | null = null;

export function initRapier(): Promise<void> {
  if (!rapierInitPromise) {
    rapierInitPromise = RAPIER.init();
  }

  return rapierInitPromise;
}

function getBody(physics: PhysicsResource, eid: EID): RigidBody | null {
  const handle = physics.eidToBody.get(eid);
  if (handle === undefined) {
    return null;
  }

  return physics.rapierWorld.bodies.get(handle);
}

function getMainCollider(physics: PhysicsResource, eid: EID): Collider | null {
  const handles = physics.eidToColliders.get(eid);
  if (!handles || handles.size === 0) {
    return null;
  }

  for (const handle of handles) {
    const collider = physics.rapierWorld.colliders.get(handle);
    if (collider) {
      return collider;
    }
  }

  return null;
}

export function createPhysicsResource(options?: {
  fixedDt?: number;
  maxSubsteps?: number;
  characterOffset?: number;
}): PhysicsResource {
  const rapierWorld = new RAPIER.World({ x: 0, y: 0 });
  const characterController = rapierWorld.createCharacterController(options?.characterOffset ?? 0.01);
  characterController.setSlideEnabled(true);
  characterController.setUp({ x: 0, y: 1 });

  const eidToBody = new Map<EID, RigidBodyHandle>();
  const eidToColliders = new Map<EID, Set<ColliderHandle>>();
  const colliderToEid = new Map<number, EID>();

  const staticColliderToBody = new Map<ColliderHandle, RigidBodyHandle>();
  const desiredVelocityByEid = new Map<EID, { vx: number; vy: number }>();

  const resource: PhysicsResource = {
    rapierWorld,
    characterController,
    fixedDt: options?.fixedDt ?? 1 / 60,
    accumulator: 0,
    maxSubsteps: options?.maxSubsteps ?? 8,
    eidToBody,
    eidToColliders,
    colliderToEid,
    ensureKinematicBody(
      eid: EID,
      transform: Transform,
      capsuleDesc: PhysicsCapsuleDesc
    ): { bodyHandle: RigidBodyHandle; colliderHandle: ColliderHandle; created: boolean } {
      const existingBody = eidToBody.get(eid);
      const existingColliders = eidToColliders.get(eid);

      if (existingBody !== undefined && existingColliders && existingColliders.size > 0) {
        const colliderHandle = [...existingColliders][0];
        return {
          bodyHandle: existingBody,
          colliderHandle,
          created: false
        };
      }

      const bodyDesc = RAPIER.RigidBodyDesc.kinematicPositionBased()
        .setTranslation(transform.x, transform.y)
        .lockRotations();
      const body = rapierWorld.createRigidBody(bodyDesc);

      const colliderDesc =
        capsuleDesc.halfHeight && capsuleDesc.halfHeight > 0
          ? RAPIER.ColliderDesc.capsule(capsuleDesc.halfHeight, capsuleDesc.radius)
          : RAPIER.ColliderDesc.ball(capsuleDesc.radius);

      const collider = rapierWorld.createCollider(colliderDesc, body);

      eidToBody.set(eid, body.handle);
      eidToColliders.set(eid, new Set([collider.handle]));
      colliderToEid.set(collider.handle, eid);

      return {
        bodyHandle: body.handle,
        colliderHandle: collider.handle,
        created: true
      };
    },
    ensureStaticColliderRect(x: number, y: number, w: number, h: number): ColliderHandle {
      const bodyDesc = RAPIER.RigidBodyDesc.fixed().setTranslation(x, y);
      const body = rapierWorld.createRigidBody(bodyDesc);
      const colliderDesc = RAPIER.ColliderDesc.cuboid(w * 0.5, h * 0.5);
      const collider = rapierWorld.createCollider(colliderDesc, body);

      staticColliderToBody.set(collider.handle, body.handle);
      return collider.handle;
    },
    removeEntity(eid: EID): void {
      const bodyHandle = eidToBody.get(eid);
      if (bodyHandle !== undefined) {
        const body = rapierWorld.bodies.get(bodyHandle);
        if (body) {
          rapierWorld.removeRigidBody(body);
        }
      }

      const colliders = eidToColliders.get(eid);
      if (colliders) {
        for (const handle of colliders) {
          colliderToEid.delete(handle);
        }
      }

      eidToBody.delete(eid);
      eidToColliders.delete(eid);
      desiredVelocityByEid.delete(eid);
    },
    setKinematicTarget(eid: EID, nextPos: { x: number; y: number }): void {
      const body = getBody(resource, eid);
      if (!body) {
        return;
      }

      body.setNextKinematicTranslation({ x: nextPos.x, y: nextPos.y });
    },
    setTranslation(eid: EID, pos: { x: number; y: number }): void {
      const body = getBody(resource, eid);
      if (!body) {
        return;
      }

      body.setTranslation({ x: pos.x, y: pos.y }, true);
      body.setNextKinematicTranslation({ x: pos.x, y: pos.y });
    },
    setDesiredVelocity(eid: EID, velocity: { vx: number; vy: number }): void {
      desiredVelocityByEid.set(eid, { vx: velocity.vx, vy: velocity.vy });
    },
    getTranslation(eid: EID): { x: number; y: number } | null {
      const body = getBody(resource, eid);
      if (!body) {
        return null;
      }

      const t = body.translation();
      return { x: t.x, y: t.y };
    },
    setColliderEnabled(handle: ColliderHandle, enabled: boolean): void {
      const collider = rapierWorld.colliders.get(handle);
      if (!collider) {
        return;
      }

      collider.setEnabled(enabled);
    },
    clearStaticGeometry(): void {
      for (const [, bodyHandle] of staticColliderToBody) {
        const body = rapierWorld.bodies.get(bodyHandle);
        if (!body) {
          continue;
        }

        rapierWorld.removeRigidBody(body);
      }

      staticColliderToBody.clear();
    },
    step(dtFrame: number): number {
      resource.accumulator += Math.max(0, dtFrame);

      let steps = 0;
      while (resource.accumulator >= resource.fixedDt && steps < resource.maxSubsteps) {
        for (const [eid, velocity] of desiredVelocityByEid) {
          const body = getBody(resource, eid);
          const collider = getMainCollider(resource, eid);
          if (!body || !collider) {
            continue;
          }

          resource.characterController.computeColliderMovement(collider, {
            x: velocity.vx * resource.fixedDt,
            y: velocity.vy * resource.fixedDt
          });

          const corrected = resource.characterController.computedMovement();
          const current = body.translation();
          body.setNextKinematicTranslation({
            x: current.x + corrected.x,
            y: current.y + corrected.y
          });
        }

        rapierWorld.timestep = resource.fixedDt;
        rapierWorld.step();

        resource.accumulator -= resource.fixedDt;
        steps += 1;
      }

      if (steps === resource.maxSubsteps && resource.accumulator > resource.fixedDt) {
        resource.accumulator = 0;
      }

      return steps;
    },
    dispose(): void {
      resource.clearStaticGeometry();

      for (const eid of [...eidToBody.keys()]) {
        resource.removeEntity(eid);
      }

      rapierWorld.removeCharacterController(characterController);
      rapierWorld.free();
      desiredVelocityByEid.clear();
    }
  };

  return resource;
}

export function physicsEnsureSystem(options: PhysicsEnsureOptions): void {
  const { world, physics, entities, capsule, physicsBodies, physicsColliders } = options;

  for (const eid of entities) {
    if (!world.alive(eid)) {
      continue;
    }

    const transform = world.transforms.get(eid);
    if (!transform) {
      continue;
    }

    const ensured = physics.ensureKinematicBody(eid, transform, capsule);
    if (physicsBodies && !physicsBodies.has(eid)) {
      physicsBodies.add(eid, { bodyHandle: ensured.bodyHandle });
    }

    if (physicsColliders && !physicsColliders.has(eid)) {
      physicsColliders.add(eid, { colliderHandle: ensured.colliderHandle });
    }
  }
}

export function physicsSyncInSystem(options: PhysicsSyncInOptions): void {
  const { world, physics, entities } = options;

  for (const eid of entities) {
    if (!world.alive(eid)) {
      continue;
    }

    const velocity = world.velocities.get(eid) ?? { vx: 0, vy: 0 };
    physics.setDesiredVelocity(eid, velocity);
  }
}

export function physicsStepSystem(options: PhysicsStepOptions): number {
  return options.physics.step(options.dtFrame);
}

export function physicsSyncOutSystem(options: PhysicsSyncOutOptions): void {
  const { world, physics, entities } = options;

  for (const eid of entities) {
    if (!world.alive(eid)) {
      continue;
    }

    const transform = world.transforms.get(eid);
    if (!transform) {
      continue;
    }

    const next = physics.getTranslation(eid);
    if (!next) {
      continue;
    }

    transform.x = next.x;
    transform.y = next.y;
  }
}

export function physicsEventsSystem(): void {
  // Hook point for future contact/event bridging from Rapier into ECS events.
}
