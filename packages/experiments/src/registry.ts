import type { ExperimentRegistryEntry } from "./runtime/meta";

// Registry is kept explicit so lazy import boundaries stay obvious.
// AUTO_IMPORTS_START
import { meta as propTestSceneMeta } from "./prop-test-scene/meta";
import { meta as physicsPropDropMeta } from "./physics-prop-drop/meta";
import { meta as mapEditor2dMeta } from "./map-editor-2d/meta";
// AUTO_IMPORTS_END
export const experiments: ExperimentRegistryEntry[] = [
  // AUTO_ENTRIES_START
  {
    ...mapEditor2dMeta,
    load: () => import("./map-editor-2d/index")
  },
  {
    ...physicsPropDropMeta,
    load: () => import("./physics-prop-drop/index")
  },
  {
    ...propTestSceneMeta,
    load: () => import("./prop-test-scene/index")
  }
  // AUTO_ENTRIES_END
];

export function getExperimentById(id: string): ExperimentRegistryEntry | undefined {
  return experiments.find((entry) => entry.id === id);
}
