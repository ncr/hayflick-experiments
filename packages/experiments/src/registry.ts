import type { ExperimentRegistryEntry } from "./runtime/meta";
import { meta as shaderPlaygroundMeta } from "./shader-playground/meta";

// Registry is kept explicit so lazy import boundaries stay obvious.
// AUTO_IMPORTS_START
import { meta as ecsFoundationMeta } from "./ecs-foundation/meta";
import { meta as editorGameEcsMeta } from "./editor-game-ecs/meta";
import { meta as levelBuilderMeta } from "./level-builder/meta";
import { meta as physicsRapierMeta } from "./physics-rapier/meta";
import { meta as pixelOutlinePostMeta } from "./pixel-outline-post/meta";
import { meta as pixelPerfect2to1Meta } from "./pixel-perfect-2to1/meta";
// AUTO_IMPORTS_END
export const experiments: ExperimentRegistryEntry[] = [
  // AUTO_ENTRIES_START
  {
    ...ecsFoundationMeta,
    load: () => import("./ecs-foundation/index")
  },
  {
    ...editorGameEcsMeta,
    load: () => import("./editor-game-ecs/index")
  },
  {
    ...levelBuilderMeta,
    load: () => import("./level-builder/index")
  },
  {
    ...physicsRapierMeta,
    load: () => import("./physics-rapier/index")
  },
  {
    ...pixelOutlinePostMeta,
    load: () => import("./pixel-outline-post/index")
  },
  {
    ...pixelPerfect2to1Meta,
    load: () => import("./pixel-perfect-2to1/index")
  },
  {
    ...shaderPlaygroundMeta,
    load: () => import("./shader-playground/index")
  }
  // AUTO_ENTRIES_END
];

export function getExperimentById(id: string): ExperimentRegistryEntry | undefined {
  return experiments.find((entry) => entry.id === id);
}
