import type { Controlled, EID, Persistent, Transform, Velocity } from "./ecs/types";
import type { System } from "./ecs/systems";
import { World } from "./ecs/world";

export type LevelRuntimeObject<TNode = unknown> = {
  id: string;
  eid: EID;
  node: TNode;
};

export type LevelRuntimeObjectInput<TNode = unknown> = {
  id: string;
  node: TNode;
  transform?: Transform;
  velocity?: Velocity;
  persistent?: Persistent;
  controlled?: Controlled;
};

export type LevelRuntimeOptions<TNode = unknown> = {
  world?: World;
  attach?: (node: TNode, object: LevelRuntimeObject<TNode>) => void;
  detach?: (node: TNode, object: LevelRuntimeObject<TNode>) => void;
  disposeNode?: (node: TNode, object: LevelRuntimeObject<TNode>) => void;
  systems?: System[];
};

export class LevelRuntime<TNode = unknown> {
  readonly world: World;
  private readonly objects = new Map<string, LevelRuntimeObject<TNode>>();
  private readonly systems: System[];
  private readonly attach?: LevelRuntimeOptions<TNode>["attach"];
  private readonly detach?: LevelRuntimeOptions<TNode>["detach"];
  private readonly disposeNode?: LevelRuntimeOptions<TNode>["disposeNode"];

  constructor(options: LevelRuntimeOptions<TNode> = {}) {
    this.world = options.world ?? new World();
    this.systems = options.systems?.slice() ?? [];
    this.attach = options.attach;
    this.detach = options.detach;
    this.disposeNode = options.disposeNode;
  }

  addSystem(system: System): void {
    this.systems.push(system);
  }

  addObject(input: LevelRuntimeObjectInput<TNode>): number {
    if (this.objects.has(input.id)) {
      throw new Error(`LevelRuntime object already exists: ${input.id}`);
    }

    const eid = this.world.createEntity();
    const object: LevelRuntimeObject<TNode> = {
      id: input.id,
      eid,
      node: input.node
    };

    this.world.sceneRefs.add(eid, { id: input.id });

    if (input.transform) {
      this.world.transforms.add(eid, { ...input.transform });
    }
    if (input.velocity) {
      this.world.velocities.add(eid, { ...input.velocity });
    }
    if (input.persistent) {
      this.world.persistents.add(eid, { ...input.persistent });
    }
    if (input.controlled) {
      this.world.controlled.add(eid, { speed: input.controlled.speed });
    }

    this.objects.set(input.id, object);
    this.attach?.(input.node, object);
    return eid;
  }

  getObject(id: string): LevelRuntimeObject<TNode> | undefined {
    return this.objects.get(id);
  }

  removeObject(id: string): boolean {
    const object = this.objects.get(id);
    if (!object) {
      return false;
    }

    this.objects.delete(id);
    this.detach?.(object.node, object);
    this.disposeNode?.(object.node, object);
    this.world.destroyEntity(object.eid);
    return true;
  }

  step(dt: number): void {
    this.world.time.dt = dt;
    this.world.time.t += dt;
    this.world.time.frame += 1;

    for (const system of this.systems) {
      system(this.world);
    }
  }

  dispose(): void {
    for (const id of [...this.objects.keys()]) {
      this.removeObject(id);
    }
    this.systems.length = 0;
    this.world.clear();
  }
}
