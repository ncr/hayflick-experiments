import {
  createControlledInputSystem,
  createEventSystem,
  createInputSystem,
  createMeshSyncSystem,
  createMovementSystem,
  type SystemPipeline
} from "../ecs/systems";
import { World } from "../ecs/world";
import type { Scene, SceneObject } from "./scene";
import type { GameInstance, GameModule, GameStudioContext, KnobRegistry } from "./types";

// `defineGame` is the high-level entry point a game module uses. The
// engine bakes in the iso pixel-perfect render path, the default system
// pipeline (input → controlled → movement → meshSync → events), and
// auto-disposal of every scene primitive spawned during `setup`. The
// game writes only intent: what entities exist, what they look like,
// what knobs they expose, and what happens each frame.
//
// ECS stays first-class on the `world` handle — the game still writes
// `world.createEntity()`, `world.transforms.add(...)`, etc. The engine
// is not hiding the ECS, only removing the wiring noise around it.

export type GameSetupContext = {
  scene: Scene;
  world: World;
  knobs: KnobRegistry;
  width: number;
  height: number;
};

export type GameSetupResult = {
  /** Game logic per frame, after the engine pipeline has run. */
  step?: (dt: number) => void;
};

export type DefineGameOptions = {
  id: string;
  title: string;
  description?: string;
  setup(ctx: GameSetupContext): GameSetupResult | Promise<GameSetupResult>;
};

// Wraps a Scene so every `spawn*` return value is recorded in a disposal
// scope. The disposal is reverse-order on teardown so child resources go
// before their parents in any future hierarchical primitive.
function withDisposeScope(scene: Scene): {
  scene: Scene;
  disposeAll(): void;
} {
  const tracked: SceneObject[] = [];
  const track = <T extends SceneObject>(obj: T): T => {
    tracked.push(obj);
    return obj;
  };
  return {
    scene: {
      spawnFloor: (opts) => track(scene.spawnFloor(opts)),
      spawnGrid: (opts) => track(scene.spawnGrid(opts)),
      spawnBox: (opts) => track(scene.spawnBox(opts)),
      getScreenPixelBasis: () => scene.getScreenPixelBasis()
    },
    disposeAll() {
      for (let i = tracked.length - 1; i >= 0; i--) {
        try {
          tracked[i].dispose();
        } catch {
          // Continue disposing remaining handles even if one throws.
        }
      }
      tracked.length = 0;
    }
  };
}

export function defineGame(opts: DefineGameOptions): GameModule {
  return {
    id: opts.id,
    title: opts.title,
    description: opts.description,
    async create(ctx: GameStudioContext): Promise<GameInstance> {
      const scope = withDisposeScope(ctx.scene);

      const systems: SystemPipeline = {
        inputSystem: createInputSystem(ctx.keyboard),
        controlledInputSystem: createControlledInputSystem(() =>
          ctx.scene.getScreenPixelBasis()
        ),
        movementSystem: createMovementSystem(),
        meshSyncSystem: createMeshSyncSystem(),
        eventSystem: createEventSystem(ctx.debug)
      };

      const result = await Promise.resolve(
        opts.setup({
          scene: scope.scene,
          world: ctx.world,
          knobs: ctx.knobs,
          width: ctx.width,
          height: ctx.height
        })
      );

      return {
        systems,
        step: result.step,
        dispose() {
          scope.disposeAll();
        }
      };
    }
  };
}
