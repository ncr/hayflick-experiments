import type { ExperimentRegistryEntry } from "./runtime/meta";

// Registry is kept explicit so lazy import boundaries stay obvious.
// AUTO_IMPORTS_START
import { meta as falloutWaystationMeta } from "./fallout-waystation/meta";
import { meta as physicsPropDropMeta } from "./physics-prop-drop/meta";
import { meta as mapEditor2dMeta } from "./map-editor-2d/meta";
import { meta as materialStudioMeta } from "./material-studio/meta";
import { meta as outlineWallsMeta } from "./outline-walls/meta";
import { meta as pixelArtTexMeta } from "./pixel-art-tex/meta";
import { meta as uvTemplateProbeMeta } from "./uv-template-probe/meta";
import { meta as isoScaleProbeMeta } from "./iso-scale-probe/meta";
// AUTO_IMPORTS_END
export const experiments: ExperimentRegistryEntry[] = [
  // AUTO_ENTRIES_START
  {
    ...isoScaleProbeMeta,
    load: () => import("./iso-scale-probe/index")
  },
  {
    ...falloutWaystationMeta,
    load: () => import("./fallout-waystation/index")
  },
  {
    ...uvTemplateProbeMeta,
    load: () => import("./uv-template-probe/index")
  },
  {
    ...pixelArtTexMeta,
    load: () => import("./pixel-art-tex/index")
  },
  {
    ...outlineWallsMeta,
    load: () => import("./outline-walls/index")
  },
  {
    ...materialStudioMeta,
    load: () => import("./material-studio/index")
  },
  {
    ...mapEditor2dMeta,
    load: () => import("./map-editor-2d/index")
  },
  {
    ...physicsPropDropMeta,
    load: () => import("./physics-prop-drop/index")
  }
  // AUTO_ENTRIES_END
];

export function getExperimentById(id: string): ExperimentRegistryEntry | undefined {
  return experiments.find((entry) => entry.id === id);
}
