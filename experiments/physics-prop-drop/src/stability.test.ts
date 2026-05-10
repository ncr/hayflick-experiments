import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import RAPIER3D from "@dimforge/rapier3d-compat";
import { describe, expect, it } from "vitest";

import {
  createPhysics3dResource,
  type Physics3dConvexHullPart
} from "./physics/game-physics-3d";
import {
  bodyTranslationFromRootPose,
  type PhysicsQuaternion
} from "./physics/prop-physics-math";
import {
  collisionGroups,
  PHYSICS_LAYER,
  PHYSICS_MASK
} from "./physics/physics-settings";
import { parseForgePropMeta, type ForgePropMetaSnapshot } from "./forge-props";
import { generatePropPlacements } from "./placement-layout";
import {
  deriveRoomSupportFloorPart,
  omitRoomSupportSurfaceParts,
  parseRoomCompoundColliderAsset,
  scaleCompoundConvexHullParts
} from "./room-compound-collider";

const DROP_HEIGHT = 1.0;
const ROOM_SCALE = { x: 10, y: 10, z: 10 };
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, "../../../");

async function readJson(filePath: string): Promise<unknown> {
  return JSON.parse(await readFile(filePath, "utf8")) as unknown;
}

async function loadPropMetas(): Promise<ForgePropMetaSnapshot[]> {
  const propsDir = path.join(REPO_ROOT, "assets/forge/props");
  const entries = await readdir(propsDir, { withFileTypes: true });
  const propIds = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  const metas = await Promise.all(
    propIds.map(async (propId) => {
      const raw = await readJson(path.join(propsDir, propId, "meta.json"));
      return parseForgePropMeta(propId, raw as Record<string, unknown>);
    })
  );
  return metas.filter((meta) => meta.collider !== null);
}

async function loadRoomColliderParts(): Promise<Physics3dConvexHullPart[]> {
  const raw = await readJson(
    path.join(REPO_ROOT, "assets/empty+room+interior+3d+collider-balanced.json")
  );
  const parsed = typeof (raw as { content?: unknown }).content === "string"
    ? JSON.parse((raw as { content: string }).content)
    : raw;
  return scaleCompoundConvexHullParts(parseRoomCompoundColliderAsset(parsed), ROOM_SCALE);
}

function collectAwakeProps(
  physics: ReturnType<typeof createPhysics3dResource>,
  props: ForgePropMetaSnapshot[]
) {
  return props
    .map((meta, index) => ({
      id: meta.id,
      sleeping: physics.isEntitySleeping(index + 2),
      linearVelocity: physics.getEntityLinearVelocity(index + 2),
      angularVelocity: physics.getEntityAngularVelocity(index + 2)
    }))
    .filter((entry) => !entry.sleeping);
}

describe("physics-prop-drop stability", () => {
  it("lets dropped forge props fall asleep on a flat floor", async () => {
    await RAPIER3D.init();

    const physics = createPhysics3dResource({ gravity: { x: 0, y: -9.81, z: 0 } });
    physics.createFixedCuboidEntity(1, {
      translation: { x: 0, y: -0.05, z: 0 },
      halfExtents: { x: 10, y: 0.05, z: 10 },
      friction: 0.9,
      restitution: 0.01,
      collisionGroups: collisionGroups(
        PHYSICS_LAYER.WORLD_STATIC,
        PHYSICS_MASK.WORLD_STATIC
      )
    });

    const props = await loadPropMetas();
    const slots = generatePropPlacements(
      props.map((meta) => ({
        width: meta.collider?.dimensions.width ?? 1,
        depth: meta.collider?.dimensions.depth ?? 1
      })),
      2.0
    );

    for (let i = 0; i < props.length; i++) {
      const meta = props[i]!;
      const slot = slots[i]!;
      if (!meta.collider) {
        continue;
      }

      const rotation: PhysicsQuaternion = {
        x: 0,
        y: Math.sin(slot.rotY * 0.5),
        z: 0,
        w: Math.cos(slot.rotY * 0.5)
      };
      const translation = bodyTranslationFromRootPose(
        slot.x,
        DROP_HEIGHT,
        slot.z,
        meta.collider.localRootOffset,
        rotation
      );

      physics.createDynamicCompoundConvexHullEntity(i + 2, {
        translation,
        rotation,
        parts: meta.collider.parts,
        mass: meta.physics.mass,
        friction: meta.physics.friction,
        restitution: meta.physics.restitution,
        linearDamping: meta.physics.linearDamping,
        angularDamping: meta.physics.angularDamping,
        ccd: true,
        collisionGroups: collisionGroups(
          PHYSICS_LAYER.PROP_LOOSE,
          PHYSICS_MASK.PROP_LOOSE
        )
      });
    }

    for (let i = 0; i < 20 * 60; i++) {
      physics.step(1 / 60);
    }

    const awakeProps = collectAwakeProps(physics, props);

    physics.dispose();

    expect(awakeProps).toEqual([]);
  }, 20000);

  it("lets dropped forge props fall asleep on the room floor", async () => {
    await RAPIER3D.init();

    const physics = createPhysics3dResource({ gravity: { x: 0, y: -9.81, z: 0 } });
    const roomCollisionGroups = collisionGroups(
      PHYSICS_LAYER.WORLD_STATIC,
      PHYSICS_MASK.WORLD_STATIC
    );

    const roomParts = await loadRoomColliderParts();
    physics.createFixedCompoundConvexHullEntity(1, {
      translation: { x: 0, y: 0, z: 0 },
      parts: omitRoomSupportSurfaceParts(roomParts),
      friction: 0.9,
      restitution: 0.01,
      collisionGroups: roomCollisionGroups
    });
    const supportFloor = deriveRoomSupportFloorPart(roomParts);
    if (supportFloor) {
      physics.createFixedCuboidEntity(101, {
        translation: supportFloor.translation,
        halfExtents: supportFloor.halfExtents,
        friction: 0.9,
        restitution: 0.01,
        collisionGroups: roomCollisionGroups
      });
    }

    const props = await loadPropMetas();
    const slots = generatePropPlacements(
      props.map((meta) => ({
        width: meta.collider?.dimensions.width ?? 1,
        depth: meta.collider?.dimensions.depth ?? 1
      })),
      2.0
    );

    for (let i = 0; i < props.length; i++) {
      const meta = props[i]!;
      const slot = slots[i]!;
      if (!meta.collider) {
        continue;
      }

      const rotation: PhysicsQuaternion = {
        x: 0,
        y: Math.sin(slot.rotY * 0.5),
        z: 0,
        w: Math.cos(slot.rotY * 0.5)
      };
      const translation = bodyTranslationFromRootPose(
        slot.x,
        DROP_HEIGHT,
        slot.z,
        meta.collider.localRootOffset,
        rotation
      );

      physics.createDynamicCompoundConvexHullEntity(i + 2, {
        translation,
        rotation,
        parts: meta.collider.parts,
        mass: meta.physics.mass,
        friction: meta.physics.friction,
        restitution: meta.physics.restitution,
        linearDamping: meta.physics.linearDamping,
        angularDamping: meta.physics.angularDamping,
        ccd: true,
        collisionGroups: collisionGroups(
          PHYSICS_LAYER.PROP_LOOSE,
          PHYSICS_MASK.PROP_LOOSE
        )
      });
    }

    for (let i = 0; i < 20 * 60; i++) {
      physics.step(1 / 60);
    }

    const awakeProps = collectAwakeProps(physics, props);

    physics.dispose();

    expect(awakeProps).toEqual([]);
  }, 20000);
});
