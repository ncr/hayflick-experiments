import RAPIER3D, {
  type Collider,
  type ColliderHandle,
  type KinematicCharacterController,
  type RigidBody,
  type RigidBodyHandle,
  type World as RapierWorld
} from "@dimforge/rapier3d-compat";
import type { EID } from "@common/gameplay";

type Vector3 = {
  x: number;
  y: number;
  z: number;
};

type Quaternion = {
  x: number;
  y: number;
  z: number;
  w: number;
};

export type Physics3dBodyRef = {
  bodyHandle: RigidBodyHandle;
};

export type Physics3dColliderRef = {
  colliderHandle: ColliderHandle;
};

export type Physics3dCharacterCapsule = {
  radius: number;
  halfHeight: number;
};

export type Physics3dBoxPart = {
  translation: Vector3;
  halfExtents: Vector3;
};

export type Physics3dConvexHullPart = {
  translation: Vector3;
  vertices: Float32Array;
};

export const DEFAULT_PHYSICS3D_LINEAR_DAMPING = 0.22;
export const DEFAULT_PHYSICS3D_ANGULAR_DAMPING = 0.3;
export const DEFAULT_PHYSICS3D_COMPLEX_BODY_SOLVER_ITERATIONS = 2;
export const DEFAULT_PHYSICS3D_WORLD_TUNING = {
  maxCcdSubsteps: 4,
  numSolverIterations: 8,
  numInternalPgsIterations: 2,
  normalizedAllowedLinearError: 0.0005
} as const;

export type Physics3dResource = {
  world: RapierWorld;
  characterController: KinematicCharacterController;
  fixedDt: number;
  accumulator: number;
  maxSubsteps: number;
  eidToBody: Map<EID, RigidBodyHandle>;
  eidToColliders: Map<EID, Set<ColliderHandle>>;
  characterColliderByEid: Map<EID, ColliderHandle>;
  desiredCharacterVelocityByEid: Map<EID, { vx: number; vz: number }>;
  ensureKinematicCharacterCapsule(
    eid: EID,
    translation: Vector3,
    capsule: Physics3dCharacterCapsule,
    options?: {
      collisionGroups?: number;
      friction?: number;
      restitution?: number;
    }
  ): { bodyHandle: RigidBodyHandle; colliderHandle: ColliderHandle; created: boolean };
  createFixedCuboidEntity(
    eid: EID,
    options: {
      translation: Vector3;
      rotation?: Quaternion;
      halfExtents: Vector3;
      friction?: number;
      restitution?: number;
      collisionGroups?: number;
    }
  ): { bodyHandle: RigidBodyHandle; colliderHandle: ColliderHandle };
  createFixedCompoundCuboidEntity(
    eid: EID,
    options: {
      translation: Vector3;
      rotation?: Quaternion;
      parts: Physics3dBoxPart[];
      friction?: number;
      restitution?: number;
      collisionGroups?: number;
    }
  ): {
    bodyHandle: RigidBodyHandle;
    colliderHandle: ColliderHandle;
    colliderHandles: ColliderHandle[];
  };
  createFixedCompoundConvexHullEntity(
    eid: EID,
    options: {
      translation: Vector3;
      rotation?: Quaternion;
      parts: Physics3dConvexHullPart[];
      friction?: number;
      restitution?: number;
      collisionGroups?: number;
    }
  ): {
    bodyHandle: RigidBodyHandle;
    colliderHandle: ColliderHandle;
    colliderHandles: ColliderHandle[];
  };
  createFixedConvexHullEntity(
    eid: EID,
    options: {
      translation: Vector3;
      rotation?: Quaternion;
      vertices: Float32Array;
      friction?: number;
      restitution?: number;
      collisionGroups?: number;
    }
  ): { bodyHandle: RigidBodyHandle; colliderHandle: ColliderHandle } | null;
  createFixedTrimeshEntity(
    eid: EID,
    options: {
      translation: Vector3;
      rotation?: Quaternion;
      vertices: Float32Array;
      indices: Uint32Array;
      friction?: number;
      restitution?: number;
      collisionGroups?: number;
    }
  ): { bodyHandle: RigidBodyHandle; colliderHandle: ColliderHandle };
  createDynamicCuboidEntity(
    eid: EID,
    options: {
      translation: Vector3;
      rotation?: Quaternion;
      halfExtents: Vector3;
      mass?: number;
      friction?: number;
      restitution?: number;
      linearDamping?: number;
      angularDamping?: number;
      ccd?: boolean;
      additionalSolverIterations?: number;
      collisionGroups?: number;
    }
  ): { bodyHandle: RigidBodyHandle; colliderHandle: ColliderHandle };
  createDynamicCompoundCuboidEntity(
    eid: EID,
    options: {
      translation: Vector3;
      rotation?: Quaternion;
      parts: Physics3dBoxPart[];
      mass?: number;
      friction?: number;
      restitution?: number;
      linearDamping?: number;
      angularDamping?: number;
      ccd?: boolean;
      additionalSolverIterations?: number;
      collisionGroups?: number;
    }
  ): {
    bodyHandle: RigidBodyHandle;
    colliderHandle: ColliderHandle;
    colliderHandles: ColliderHandle[];
  };
  createDynamicCompoundConvexHullEntity(
    eid: EID,
    options: {
      translation: Vector3;
      rotation?: Quaternion;
      parts: Physics3dConvexHullPart[];
      mass?: number;
      friction?: number;
      restitution?: number;
      linearDamping?: number;
      angularDamping?: number;
      ccd?: boolean;
      additionalSolverIterations?: number;
      collisionGroups?: number;
    }
  ): {
    bodyHandle: RigidBodyHandle;
    colliderHandle: ColliderHandle;
    colliderHandles: ColliderHandle[];
  };
  createDynamicConvexHullEntity(
    eid: EID,
    options: {
      translation: Vector3;
      rotation?: Quaternion;
      vertices: Float32Array;
      mass?: number;
      friction?: number;
      restitution?: number;
      linearDamping?: number;
      angularDamping?: number;
      ccd?: boolean;
      additionalSolverIterations?: number;
      collisionGroups?: number;
    }
  ): { bodyHandle: RigidBodyHandle; colliderHandle: ColliderHandle } | null;
  createStaticCuboidCollider(options: {
    translation: Vector3;
    halfExtents: Vector3;
    friction?: number;
    restitution?: number;
    collisionGroups?: number;
  }): ColliderHandle;
  setCharacterDesiredVelocity(eid: EID, velocity: { vx: number; vz: number }): void;
  getEntityTranslation(eid: EID): Vector3 | null;
  getEntityRotation(eid: EID): Quaternion | null;
  getEntityLinearVelocity(eid: EID): Vector3 | null;
  getEntityAngularVelocity(eid: EID): Vector3 | null;
  setEntityTranslation(eid: EID, translation: Vector3): void;
  setEntityLinearVelocity(
    eid: EID,
    velocity: Vector3,
    wakeUp?: boolean
  ): void;
  setEntityAngularVelocity(
    eid: EID,
    velocity: Vector3,
    wakeUp?: boolean
  ): void;
  sleepEntity(eid: EID): void;
  wakeEntity(eid: EID): void;
  isEntitySleeping(eid: EID): boolean;
  setColliderEnabled(handle: ColliderHandle, enabled: boolean): void;
  removeEntity(eid: EID): void;
  step(dtFrame: number): number;
  dispose(): void;
};

type MutableIntegrationParameters = {
  dt: number;
  maxCcdSubsteps: number;
  numSolverIterations: number;
  numInternalPgsIterations: number;
  normalizedAllowedLinearError: number;
};

type DynamicBodyTuningTarget = Pick<
  RigidBody,
  "setLinearDamping" | "setAngularDamping" | "enableCcd" | "setAdditionalSolverIterations"
>;

function getBody(resource: Physics3dResource, eid: EID): RigidBody | null {
  const handle = resource.eidToBody.get(eid);
  if (handle === undefined) {
    return null;
  }
  return resource.world.bodies.get(handle);
}

function getCollider(
  resource: Physics3dResource,
  handle: ColliderHandle
): Collider | null {
  return resource.world.colliders.get(handle);
}

function bindEntityBody(
  resource: Physics3dResource,
  eid: EID,
  body: RigidBody,
  colliders: Collider[]
): void {
  resource.eidToBody.set(eid, body.handle);
  resource.eidToColliders.set(
    eid,
    new Set(colliders.map((collider) => collider.handle))
  );
}

function makeFixedBodyDesc(
  translation: Vector3,
  rotation?: Quaternion
): RAPIER3D.RigidBodyDesc {
  const desc = RAPIER3D.RigidBodyDesc.fixed().setTranslation(
    translation.x,
    translation.y,
    translation.z
  );
  if (rotation) {
    desc.setRotation(rotation);
  }
  return desc;
}

function createCuboidColliderDesc(options: {
  halfExtents: Vector3;
  friction?: number;
  restitution?: number;
  collisionGroups?: number;
}): RAPIER3D.ColliderDesc {
  const desc = RAPIER3D.ColliderDesc.cuboid(
    options.halfExtents.x,
    options.halfExtents.y,
    options.halfExtents.z
  )
    .setFriction(options.friction ?? 0.9)
    .setRestitution(options.restitution ?? 0);
  if (options.collisionGroups !== undefined) {
    desc.setCollisionGroups(options.collisionGroups);
  }
  return desc;
}

export function applyPhysics3dWorldTuning(
  integrationParameters: MutableIntegrationParameters,
  fixedDt: number,
  options?: {
    maxCcdSubsteps?: number;
    numSolverIterations?: number;
    numInternalPgsIterations?: number;
    normalizedAllowedLinearError?: number;
  }
): void {
  integrationParameters.dt = fixedDt;
  integrationParameters.maxCcdSubsteps =
    options?.maxCcdSubsteps ?? DEFAULT_PHYSICS3D_WORLD_TUNING.maxCcdSubsteps;
  integrationParameters.numSolverIterations =
    options?.numSolverIterations ?? DEFAULT_PHYSICS3D_WORLD_TUNING.numSolverIterations;
  integrationParameters.numInternalPgsIterations =
    options?.numInternalPgsIterations ??
    DEFAULT_PHYSICS3D_WORLD_TUNING.numInternalPgsIterations;
  integrationParameters.normalizedAllowedLinearError =
    options?.normalizedAllowedLinearError ??
    DEFAULT_PHYSICS3D_WORLD_TUNING.normalizedAllowedLinearError;
}

export function configureDynamicBodyTuning(
  body: DynamicBodyTuningTarget,
  options?: {
    linearDamping?: number;
    angularDamping?: number;
    ccd?: boolean;
    additionalSolverIterations?: number;
    usesComplexCollider?: boolean;
  }
): void {
  body.setLinearDamping(
    options?.linearDamping ?? DEFAULT_PHYSICS3D_LINEAR_DAMPING
  );
  body.setAngularDamping(
    options?.angularDamping ?? DEFAULT_PHYSICS3D_ANGULAR_DAMPING
  );
  body.enableCcd(options?.ccd ?? true);
  body.setAdditionalSolverIterations(
    options?.additionalSolverIterations ??
      (options?.usesComplexCollider
        ? DEFAULT_PHYSICS3D_COMPLEX_BODY_SOLVER_ITERATIONS
        : 0)
  );
}

export function createPhysics3dResource(options?: {
  gravity?: Vector3;
  fixedDt?: number;
  maxSubsteps?: number;
  characterOffset?: number;
  maxCcdSubsteps?: number;
  numSolverIterations?: number;
  numInternalPgsIterations?: number;
  normalizedAllowedLinearError?: number;
}): Physics3dResource {
  const world = new RAPIER3D.World(options?.gravity ?? { x: 0, y: -9.81, z: 0 });
  const characterController = world.createCharacterController(
    options?.characterOffset ?? 0.01
  );
  characterController.setSlideEnabled(true);
  characterController.setUp({ x: 0, y: 1, z: 0 });
  const fixedDt = options?.fixedDt ?? 1 / 60;
  applyPhysics3dWorldTuning(world.integrationParameters, fixedDt, {
    maxCcdSubsteps: options?.maxCcdSubsteps,
    numSolverIterations: options?.numSolverIterations,
    numInternalPgsIterations: options?.numInternalPgsIterations,
    normalizedAllowedLinearError: options?.normalizedAllowedLinearError
  });

  const resource: Physics3dResource = {
    world,
    characterController,
    fixedDt,
    accumulator: 0,
    maxSubsteps: options?.maxSubsteps ?? 8,
    eidToBody: new Map<EID, RigidBodyHandle>(),
    eidToColliders: new Map<EID, Set<ColliderHandle>>(),
    characterColliderByEid: new Map<EID, ColliderHandle>(),
    desiredCharacterVelocityByEid: new Map<EID, { vx: number; vz: number }>(),
    ensureKinematicCharacterCapsule(
      eid: EID,
      translation: Vector3,
      capsule: Physics3dCharacterCapsule,
      options?: {
        collisionGroups?: number;
        friction?: number;
        restitution?: number;
      }
    ): { bodyHandle: RigidBodyHandle; colliderHandle: ColliderHandle; created: boolean } {
      const existingBodyHandle = resource.eidToBody.get(eid);
      const existingColliderHandle = resource.characterColliderByEid.get(eid);
      if (existingBodyHandle !== undefined && existingColliderHandle !== undefined) {
        return {
          bodyHandle: existingBodyHandle,
          colliderHandle: existingColliderHandle,
          created: false
        };
      }

      const bodyDesc = RAPIER3D.RigidBodyDesc.kinematicPositionBased()
        .setTranslation(translation.x, translation.y, translation.z)
        .lockRotations();
      const body = world.createRigidBody(bodyDesc);
      const colliderDesc = RAPIER3D.ColliderDesc.capsule(
        capsule.halfHeight,
        capsule.radius
      )
        .setFriction(options?.friction ?? 0.9)
        .setRestitution(options?.restitution ?? 0);
      if (options?.collisionGroups !== undefined) {
        colliderDesc.setCollisionGroups(options.collisionGroups);
      }
      const collider = world.createCollider(colliderDesc, body);

      bindEntityBody(resource, eid, body, [collider]);
      resource.characterColliderByEid.set(eid, collider.handle);
      resource.desiredCharacterVelocityByEid.set(eid, { vx: 0, vz: 0 });

      return {
        bodyHandle: body.handle,
        colliderHandle: collider.handle,
        created: true
      };
    },
    createFixedCuboidEntity(
      eid: EID,
      options: {
        translation: Vector3;
        rotation?: Quaternion;
        halfExtents: Vector3;
        friction?: number;
        restitution?: number;
        collisionGroups?: number;
      }
    ): { bodyHandle: RigidBodyHandle; colliderHandle: ColliderHandle } {
      const body = world.createRigidBody(
        makeFixedBodyDesc(options.translation, options.rotation)
      );
      const collider = world.createCollider(
        createCuboidColliderDesc(options),
        body
      );

      bindEntityBody(resource, eid, body, [collider]);
      return {
        bodyHandle: body.handle,
        colliderHandle: collider.handle
      };
    },
    createFixedCompoundCuboidEntity(
      eid: EID,
      options: {
        translation: Vector3;
        rotation?: Quaternion;
        parts: Physics3dBoxPart[];
        friction?: number;
        restitution?: number;
        collisionGroups?: number;
      }
    ): {
      bodyHandle: RigidBodyHandle;
      colliderHandle: ColliderHandle;
      colliderHandles: ColliderHandle[];
    } {
      const body = world.createRigidBody(
        makeFixedBodyDesc(options.translation, options.rotation)
      );
      const colliders: Collider[] = [];
      for (const part of options.parts) {
        const desc = createCuboidColliderDesc({
          halfExtents: part.halfExtents,
          friction: options.friction,
          restitution: options.restitution,
          collisionGroups: options.collisionGroups
        });
        desc.setTranslation(
          part.translation.x,
          part.translation.y,
          part.translation.z
        );
        colliders.push(world.createCollider(desc, body));
      }
      if (colliders.length <= 0) {
        const fallback = world.createCollider(
          createCuboidColliderDesc({
            halfExtents: { x: 0.15, y: 0.15, z: 0.15 },
            friction: options.friction,
            restitution: options.restitution,
            collisionGroups: options.collisionGroups
          }),
          body
        );
        colliders.push(fallback);
      }

      bindEntityBody(resource, eid, body, colliders);
      return {
        bodyHandle: body.handle,
        colliderHandle: colliders[0].handle,
        colliderHandles: colliders.map((collider) => collider.handle)
      };
    },
    createFixedCompoundConvexHullEntity(
      eid: EID,
      options: {
        translation: Vector3;
        rotation?: Quaternion;
        parts: Physics3dConvexHullPart[];
        friction?: number;
        restitution?: number;
        collisionGroups?: number;
      }
    ): {
      bodyHandle: RigidBodyHandle;
      colliderHandle: ColliderHandle;
      colliderHandles: ColliderHandle[];
    } {
      const body = world.createRigidBody(
        makeFixedBodyDesc(options.translation, options.rotation)
      );
      const colliders: Collider[] = [];
      for (const part of options.parts) {
        const desc = RAPIER3D.ColliderDesc.convexHull(part.vertices);
        if (!desc) {
          continue;
        }
        desc
          .setTranslation(
            part.translation.x,
            part.translation.y,
            part.translation.z
          )
          .setFriction(options.friction ?? 0.9)
          .setRestitution(options.restitution ?? 0);
        if (options.collisionGroups !== undefined) {
          desc.setCollisionGroups(options.collisionGroups);
        }
        colliders.push(world.createCollider(desc, body));
      }
      if (colliders.length <= 0) {
        const fallback = world.createCollider(
          createCuboidColliderDesc({
            halfExtents: { x: 0.15, y: 0.15, z: 0.15 },
            friction: options.friction,
            restitution: options.restitution,
            collisionGroups: options.collisionGroups
          }),
          body
        );
        colliders.push(fallback);
      }

      bindEntityBody(resource, eid, body, colliders);
      return {
        bodyHandle: body.handle,
        colliderHandle: colliders[0].handle,
        colliderHandles: colliders.map((collider) => collider.handle)
      };
    },
    createFixedConvexHullEntity(
      eid: EID,
      options: {
        translation: Vector3;
        rotation?: Quaternion;
        vertices: Float32Array;
        friction?: number;
        restitution?: number;
        collisionGroups?: number;
      }
    ): { bodyHandle: RigidBodyHandle; colliderHandle: ColliderHandle } | null {
      const body = world.createRigidBody(
        makeFixedBodyDesc(options.translation, options.rotation)
      );
      const desc = RAPIER3D.ColliderDesc.convexHull(options.vertices);
      if (!desc) {
        world.removeRigidBody(body);
        return null;
      }
      desc
        .setFriction(options.friction ?? 0.9)
        .setRestitution(options.restitution ?? 0);
      if (options.collisionGroups !== undefined) {
        desc.setCollisionGroups(options.collisionGroups);
      }
      const collider = world.createCollider(desc, body);
      bindEntityBody(resource, eid, body, [collider]);
      return {
        bodyHandle: body.handle,
        colliderHandle: collider.handle
      };
    },
    createFixedTrimeshEntity(
      eid: EID,
      options: {
        translation: Vector3;
        rotation?: Quaternion;
        vertices: Float32Array;
        indices: Uint32Array;
        friction?: number;
        restitution?: number;
        collisionGroups?: number;
      }
    ): { bodyHandle: RigidBodyHandle; colliderHandle: ColliderHandle } {
      const body = world.createRigidBody(
        makeFixedBodyDesc(options.translation, options.rotation)
      );
      const desc = RAPIER3D.ColliderDesc.trimesh(options.vertices, options.indices)
        .setFriction(options.friction ?? 0.9)
        .setRestitution(options.restitution ?? 0);
      if (options.collisionGroups !== undefined) {
        desc.setCollisionGroups(options.collisionGroups);
      }
      const collider = world.createCollider(desc, body);

      bindEntityBody(resource, eid, body, [collider]);
      return {
        bodyHandle: body.handle,
        colliderHandle: collider.handle
      };
    },
    createDynamicCuboidEntity(
      eid: EID,
      options: {
        translation: Vector3;
        rotation?: Quaternion;
        halfExtents: Vector3;
        mass?: number;
        friction?: number;
        restitution?: number;
        linearDamping?: number;
        angularDamping?: number;
        ccd?: boolean;
        additionalSolverIterations?: number;
        collisionGroups?: number;
      }
    ): { bodyHandle: RigidBodyHandle; colliderHandle: ColliderHandle } {
      const bodyDesc = RAPIER3D.RigidBodyDesc.dynamic().setTranslation(
        options.translation.x,
        options.translation.y,
        options.translation.z
      );
      if (options.rotation) {
        bodyDesc.setRotation(options.rotation);
      }
      const body = world.createRigidBody(bodyDesc);
      configureDynamicBodyTuning(body, options);

      const desc = createCuboidColliderDesc(options).setMass(options.mass ?? 1);
      const collider = world.createCollider(desc, body);
      bindEntityBody(resource, eid, body, [collider]);
      return {
        bodyHandle: body.handle,
        colliderHandle: collider.handle
      };
    },
    createDynamicCompoundCuboidEntity(
      eid: EID,
      options: {
        translation: Vector3;
        rotation?: Quaternion;
        parts: Physics3dBoxPart[];
        mass?: number;
        friction?: number;
        restitution?: number;
        linearDamping?: number;
        angularDamping?: number;
        ccd?: boolean;
        additionalSolverIterations?: number;
        collisionGroups?: number;
      }
    ): {
      bodyHandle: RigidBodyHandle;
      colliderHandle: ColliderHandle;
      colliderHandles: ColliderHandle[];
    } {
      const bodyDesc = RAPIER3D.RigidBodyDesc.dynamic().setTranslation(
        options.translation.x,
        options.translation.y,
        options.translation.z
      );
      if (options.rotation) {
        bodyDesc.setRotation(options.rotation);
      }
      const body = world.createRigidBody(bodyDesc);
      configureDynamicBodyTuning(body, options);

      const colliders: Collider[] = [];
      const partCount = Math.max(1, options.parts.length);
      const partMass = (options.mass ?? 1) / partCount;
      for (const part of options.parts) {
        const desc = createCuboidColliderDesc({
          halfExtents: part.halfExtents,
          friction: options.friction,
          restitution: options.restitution,
          collisionGroups: options.collisionGroups
        })
          .setTranslation(
            part.translation.x,
            part.translation.y,
            part.translation.z
          )
          .setMass(partMass);
        colliders.push(world.createCollider(desc, body));
      }
      if (colliders.length <= 0) {
        const fallback = world.createCollider(
          createCuboidColliderDesc({
            halfExtents: { x: 0.15, y: 0.15, z: 0.15 },
            friction: options.friction,
            restitution: options.restitution,
            collisionGroups: options.collisionGroups
          }).setMass(options.mass ?? 1),
          body
        );
        colliders.push(fallback);
      }

      bindEntityBody(resource, eid, body, colliders);
      return {
        bodyHandle: body.handle,
        colliderHandle: colliders[0].handle,
        colliderHandles: colliders.map((collider) => collider.handle)
      };
    },
    createDynamicCompoundConvexHullEntity(
      eid: EID,
      options: {
        translation: Vector3;
        rotation?: Quaternion;
        parts: Physics3dConvexHullPart[];
        mass?: number;
        friction?: number;
        restitution?: number;
        linearDamping?: number;
        angularDamping?: number;
        ccd?: boolean;
        additionalSolverIterations?: number;
        collisionGroups?: number;
      }
    ): {
      bodyHandle: RigidBodyHandle;
      colliderHandle: ColliderHandle;
      colliderHandles: ColliderHandle[];
    } {
      const bodyDesc = RAPIER3D.RigidBodyDesc.dynamic().setTranslation(
        options.translation.x,
        options.translation.y,
        options.translation.z
      );
      if (options.rotation) {
        bodyDesc.setRotation(options.rotation);
      }
      const body = world.createRigidBody(bodyDesc);
      configureDynamicBodyTuning(body, {
        ...options,
        usesComplexCollider: true
      });

      const colliders: Collider[] = [];
      const partCount = Math.max(1, options.parts.length);
      const partMass = (options.mass ?? 1) / partCount;
      for (const part of options.parts) {
        const desc = RAPIER3D.ColliderDesc.convexHull(part.vertices);
        if (!desc) {
          continue;
        }
        desc
          .setTranslation(
            part.translation.x,
            part.translation.y,
            part.translation.z
          )
          .setFriction(options.friction ?? 0.9)
          .setRestitution(options.restitution ?? 0)
          .setMass(partMass);
        if (options.collisionGroups !== undefined) {
          desc.setCollisionGroups(options.collisionGroups);
        }
        colliders.push(world.createCollider(desc, body));
      }
      if (colliders.length <= 0) {
        const fallback = world.createCollider(
          createCuboidColliderDesc({
            halfExtents: { x: 0.15, y: 0.15, z: 0.15 },
            friction: options.friction,
            restitution: options.restitution,
            collisionGroups: options.collisionGroups
          }).setMass(options.mass ?? 1),
          body
        );
        colliders.push(fallback);
      }

      bindEntityBody(resource, eid, body, colliders);
      return {
        bodyHandle: body.handle,
        colliderHandle: colliders[0].handle,
        colliderHandles: colliders.map((collider) => collider.handle)
      };
    },
    createDynamicConvexHullEntity(
      eid: EID,
      options: {
        translation: Vector3;
        rotation?: Quaternion;
        vertices: Float32Array;
        mass?: number;
        friction?: number;
        restitution?: number;
        linearDamping?: number;
        angularDamping?: number;
        ccd?: boolean;
        additionalSolverIterations?: number;
        collisionGroups?: number;
      }
    ): { bodyHandle: RigidBodyHandle; colliderHandle: ColliderHandle } | null {
      const bodyDesc = RAPIER3D.RigidBodyDesc.dynamic().setTranslation(
        options.translation.x,
        options.translation.y,
        options.translation.z
      );
      if (options.rotation) {
        bodyDesc.setRotation(options.rotation);
      }
      const body = world.createRigidBody(bodyDesc);
      configureDynamicBodyTuning(body, {
        ...options,
        usesComplexCollider: true
      });

      const desc = RAPIER3D.ColliderDesc.convexHull(options.vertices);
      if (!desc) {
        world.removeRigidBody(body);
        return null;
      }
      desc
        .setFriction(options.friction ?? 0.9)
        .setRestitution(options.restitution ?? 0)
        .setMass(options.mass ?? 1);
      if (options.collisionGroups !== undefined) {
        desc.setCollisionGroups(options.collisionGroups);
      }
      const collider = world.createCollider(desc, body);
      bindEntityBody(resource, eid, body, [collider]);
      return {
        bodyHandle: body.handle,
        colliderHandle: collider.handle
      };
    },
    createStaticCuboidCollider(options: {
      translation: Vector3;
      halfExtents: Vector3;
      friction?: number;
      restitution?: number;
      collisionGroups?: number;
    }): ColliderHandle {
      const body = world.createRigidBody(
        RAPIER3D.RigidBodyDesc.fixed().setTranslation(
          options.translation.x,
          options.translation.y,
          options.translation.z
        )
      );
      const collider = world.createCollider(
        createCuboidColliderDesc(options),
        body
      );
      return collider.handle;
    },
    setCharacterDesiredVelocity(eid: EID, velocity: { vx: number; vz: number }): void {
      resource.desiredCharacterVelocityByEid.set(eid, {
        vx: velocity.vx,
        vz: velocity.vz
      });
    },
    getEntityTranslation(eid: EID): Vector3 | null {
      const body = getBody(resource, eid);
      if (!body) {
        return null;
      }
      const translation = body.translation();
      return {
        x: translation.x,
        y: translation.y,
        z: translation.z
      };
    },
    getEntityRotation(eid: EID): Quaternion | null {
      const body = getBody(resource, eid);
      if (!body) {
        return null;
      }
      const rotation = body.rotation();
      return {
        x: rotation.x,
        y: rotation.y,
        z: rotation.z,
        w: rotation.w
      };
    },
    getEntityLinearVelocity(eid: EID): Vector3 | null {
      const body = getBody(resource, eid);
      if (!body) {
        return null;
      }
      const velocity = body.linvel();
      return {
        x: velocity.x,
        y: velocity.y,
        z: velocity.z
      };
    },
    getEntityAngularVelocity(eid: EID): Vector3 | null {
      const body = getBody(resource, eid);
      if (!body) {
        return null;
      }
      const velocity = body.angvel();
      return {
        x: velocity.x,
        y: velocity.y,
        z: velocity.z
      };
    },
    setEntityTranslation(eid: EID, translation: Vector3): void {
      const body = getBody(resource, eid);
      if (!body) {
        return;
      }
      body.setTranslation(translation, true);
      if (body.isKinematic()) {
        body.setNextKinematicTranslation(translation);
      }
    },
    setEntityLinearVelocity(
      eid: EID,
      velocity: Vector3,
      wakeUp = true
    ): void {
      const body = getBody(resource, eid);
      if (!body) {
        return;
      }
      body.setLinvel(
        { x: velocity.x, y: velocity.y, z: velocity.z },
        wakeUp
      );
    },
    setEntityAngularVelocity(
      eid: EID,
      velocity: Vector3,
      wakeUp = true
    ): void {
      const body = getBody(resource, eid);
      if (!body) {
        return;
      }
      body.setAngvel(
        { x: velocity.x, y: velocity.y, z: velocity.z },
        wakeUp
      );
    },
    sleepEntity(eid: EID): void {
      const body = getBody(resource, eid);
      if (!body || body.isKinematic()) {
        return;
      }
      body.sleep();
    },
    wakeEntity(eid: EID): void {
      const body = getBody(resource, eid);
      if (!body || body.isKinematic()) {
        return;
      }
      body.wakeUp();
    },
    isEntitySleeping(eid: EID): boolean {
      const body = getBody(resource, eid);
      if (!body) {
        return false;
      }
      return body.isSleeping();
    },
    setColliderEnabled(handle: ColliderHandle, enabled: boolean): void {
      const collider = world.colliders.get(handle);
      if (!collider) {
        return;
      }
      collider.setEnabled(enabled);
    },
    removeEntity(eid: EID): void {
      const bodyHandle = resource.eidToBody.get(eid);
      if (bodyHandle !== undefined) {
        const body = world.bodies.get(bodyHandle);
        if (body) {
          world.removeRigidBody(body);
        }
      }
      resource.eidToBody.delete(eid);
      resource.eidToColliders.delete(eid);
      resource.characterColliderByEid.delete(eid);
      resource.desiredCharacterVelocityByEid.delete(eid);
    },
    step(dtFrame: number): number {
      resource.accumulator += Math.max(0, dtFrame);

      let steps = 0;
      while (resource.accumulator >= resource.fixedDt && steps < resource.maxSubsteps) {
        for (const [
          eid,
          desiredVelocity
        ] of resource.desiredCharacterVelocityByEid.entries()) {
          const body = getBody(resource, eid);
          const colliderHandle = resource.characterColliderByEid.get(eid);
          if (!body || colliderHandle === undefined) {
            continue;
          }
          const collider = getCollider(resource, colliderHandle);
          if (!collider) {
            continue;
          }

          resource.characterController.computeColliderMovement(collider, {
            x: desiredVelocity.vx * resource.fixedDt,
            y: 0,
            z: desiredVelocity.vz * resource.fixedDt
          });
          const movement = resource.characterController.computedMovement();
          const current = body.translation();
          body.setNextKinematicTranslation({
            x: current.x + movement.x,
            y: current.y + movement.y,
            z: current.z + movement.z
          });
        }

        world.timestep = resource.fixedDt;
        world.step();
        resource.accumulator -= resource.fixedDt;
        steps += 1;
      }

      if (steps >= resource.maxSubsteps && resource.accumulator > resource.fixedDt) {
        resource.accumulator = 0;
      }

      return steps;
    },
    dispose(): void {
      try {
        world.removeCharacterController(characterController);
      } catch {
        // No-op: world teardown continues even if controller is already removed.
      }
      world.free();
    }
  };

  return resource;
}
