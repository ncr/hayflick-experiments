import type { ExperimentRegistryEntry } from "@experiments/runtime";

import { meta as materialStudioMeta } from "@studios/material-studio/meta";
import { meta as mapEditorMeta } from "@studios/map-editor/meta";
import { meta as physicsPropDropMeta } from "@experiments/physics-prop-drop/meta";

export const experiments: ExperimentRegistryEntry[] = [
  {
    ...materialStudioMeta,
    load: () => import("@studios/material-studio")
  },
  {
    ...physicsPropDropMeta,
    load: () => import("@experiments/physics-prop-drop")
  },
  {
    ...mapEditorMeta,
    load: () => import("@studios/map-editor")
  }
];

export function getExperimentById(id: string): ExperimentRegistryEntry | undefined {
  return experiments.find((entry) => entry.id === id);
}
