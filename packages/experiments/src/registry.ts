import type { ExperimentRegistryEntry } from "./runtime/meta";
import { meta as shaderPlaygroundMeta } from "./shader-playground/meta";

// Registry is kept explicit so lazy import boundaries stay obvious.
// AUTO_IMPORTS_START
import { meta as levelBuilderMeta } from "./level-builder/meta";
import { meta as pixelOutlinePostMeta } from "./pixel-outline-post/meta";
// AUTO_IMPORTS_END
export const experiments: ExperimentRegistryEntry[] = [
  // AUTO_ENTRIES_START
  {
    ...levelBuilderMeta,
    load: () => import("./level-builder/index")
  },
  {
    ...pixelOutlinePostMeta,
    load: () => import("./pixel-outline-post/index")
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
