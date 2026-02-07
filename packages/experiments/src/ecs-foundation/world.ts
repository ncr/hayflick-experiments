import { EventBus } from "./events";
import { DataStore, TagStore } from "./store";
import type { EID, InputState, LevelResource, Persistent, SaveGame, TimeResource, Transform, Velocity } from "./types";
import {
  createDemoLevel,
  deserializeWorld,
  loadWorldFromLocalStorage,
  saveWorldToLocalStorage,
  serializeWorld
} from "./save-load";

// World owns entity lifecycle, component stores, and global resources.
// Systems run against this single mutable container each frame.
export class World {
  private nextEid = 1;
  private readonly aliveEntities = new Set<EID>();

  readonly transforms = new DataStore<Transform>();
  readonly velocities = new DataStore<Velocity>();
  readonly playerTags = new TagStore();
  readonly persistents = new DataStore<Persistent>();

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

  constructor(level: LevelResource = createDemoLevel()) {
    this.level = level;
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
    this.playerTags.remove(eid);
    this.persistents.remove(eid);
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

  clear(): void {
    this.aliveEntities.clear();
    this.nextEid = 1;

    this.transforms.clear();
    this.velocities.clear();
    this.playerTags.clear();
    this.persistents.clear();
    this.events.clear();
  }

  *queryTransformVelocity(): Iterable<EID> {
    for (const eid of this.velocities.entries()) {
      if (this.alive(eid) && this.transforms.has(eid)) {
        yield eid;
      }
    }
  }

  *queryTransformPlayer(): Iterable<EID> {
    for (const eid of this.playerTags.entries()) {
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
