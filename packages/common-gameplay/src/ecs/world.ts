import { EventBus } from "./events";
import {
  createOpenLevel,
  deserializeWorld,
  loadWorldFromLocalStorage,
  resolveOpenLevel,
  saveWorldToLocalStorage,
  serializeWorld
} from "./save-load";
import { DataStore } from "./store";
import type { SceneObject } from "../devtools/scene";
import type {
  Controlled,
  EID,
  InputState,
  LevelResolver,
  LevelResource,
  LevelSnapshot,
  Persistent,
  SceneRef,
  SaveGame,
  TimeResource,
  Transform,
  Velocity,
  WorldOptions
} from "./types";

// World owns entity lifecycle, component stores, and global resources.
// Systems run against this single mutable container each frame.
export class World {
  private nextEid = 1;
  private readonly aliveEntities = new Set<EID>();
  private readonly levelResolver: LevelResolver;

  readonly transforms = new DataStore<Transform>();
  readonly velocities = new DataStore<Velocity>();
  // `controlled` marks input-driven entities. The engine's input system
  // iterates this store, reads each entity's speed, and writes velocity.
  // "Player" doesn't appear in the engine — the game decides which
  // entities to mark.
  readonly controlled = new DataStore<Controlled>();
  // `meshes` binds an entity to a scene primitive; the engine's mesh-sync
  // system writes `transform → SceneObject.setPosition` each frame so the
  // game never has to copy positions itself.
  readonly meshes = new DataStore<SceneObject>();
  readonly persistents = new DataStore<Persistent>();
  readonly sceneRefs = new DataStore<SceneRef>();

  readonly time: TimeResource = {
    dt: 0,
    t: 0,
    frame: 0
  };

  readonly input: InputState = {
    up: false,
    down: false,
    left: false,
    right: false,
    savePressed: false,
    loadPressed: false
  };

  level: LevelResource;
  readonly events = new EventBus();

  constructor(options: WorldOptions = {}) {
    this.level = options.level ?? createOpenLevel();
    this.levelResolver = options.resolveLevel ?? resolveOpenLevel;
  }

  createEntity(): EID {
    const eid = this.nextEid;
    this.nextEid += 1;
    this.aliveEntities.add(eid);
    return eid;
  }

  destroyEntity(eid: EID): void {
    if (!this.aliveEntities.has(eid)) {
      return;
    }

    this.aliveEntities.delete(eid);
    this.transforms.remove(eid);
    this.velocities.remove(eid);
    this.controlled.remove(eid);
    this.meshes.remove(eid);
    this.persistents.remove(eid);
    this.sceneRefs.remove(eid);
  }

  alive(eid: EID): boolean {
    return this.aliveEntities.has(eid);
  }

  entities(): Iterable<EID> {
    return this.aliveEntities.values();
  }

  setLevel(level: LevelResource): void {
    this.level = level;
  }

  resolveLevelSnapshot(snapshot: LevelSnapshot): LevelResource {
    return this.levelResolver(snapshot);
  }

  clear(): void {
    this.aliveEntities.clear();
    this.nextEid = 1;

    this.transforms.clear();
    this.velocities.clear();
    this.controlled.clear();
    this.meshes.clear();
    this.persistents.clear();
    this.sceneRefs.clear();
    this.events.clear();
  }

  *queryTransformVelocity(): Iterable<EID> {
    for (const eid of this.velocities.entries()) {
      if (this.alive(eid) && this.transforms.has(eid)) {
        yield eid;
      }
    }
  }

  *queryTransformControlled(): Iterable<EID> {
    for (const eid of this.controlled.entries()) {
      if (this.alive(eid) && this.transforms.has(eid)) {
        yield eid;
      }
    }
  }

  *queryTransformMesh(): Iterable<EID> {
    for (const eid of this.meshes.entries()) {
      if (this.alive(eid) && this.transforms.has(eid)) {
        yield eid;
      }
    }
  }

  *queryTransformSceneRef(): Iterable<EID> {
    for (const eid of this.sceneRefs.entries()) {
      if (this.alive(eid) && this.transforms.has(eid)) {
        yield eid;
      }
    }
  }

  serialize(): SaveGame {
    return serializeWorld(this);
  }

  deserialize(save: SaveGame): void {
    deserializeWorld(this, save);
  }

  saveToLocalStorage(key = "ecs_demo_save"): void {
    saveWorldToLocalStorage(this, key);
  }

  loadFromLocalStorage(key = "ecs_demo_save"): boolean {
    return loadWorldFromLocalStorage(this, key);
  }
}
