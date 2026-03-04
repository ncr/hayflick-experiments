import type { ExperimentRegistryEntry } from "./runtime/meta";

// Registry is kept explicit so lazy import boundaries stay obvious.
// AUTO_IMPORTS_START
import { meta as pixelOutlinePostMeta } from "./pixel-outline-post/meta";
import { meta as pixelPerfectCameraZoomMeta } from "./pixel-perfect-camera-zoom/meta";
import { meta as pixelPerfectScissorLabMeta } from "./pixel-perfect-scissor-lab/meta";
import { meta as pixelStableMovingMeshMeta } from "./pixel-stable-moving-mesh/meta";
import { meta as settlementBuilderEcsMeta } from "./settlement-builder-ecs/meta";
import { meta as wallGeneratorMeta } from "./wall-generator/meta";
// AUTO_IMPORTS_END
export const experiments: ExperimentRegistryEntry[] = [
  // AUTO_ENTRIES_START
  {
    ...wallGeneratorMeta,
    load: () => import("./wall-generator/index")
  },
  {
    ...settlementBuilderEcsMeta,
    load: () => import("./settlement-builder-ecs/index")
  },
  {
    ...pixelOutlinePostMeta,
    load: () => import("./pixel-outline-post/index")
  },
  {
    ...pixelPerfectCameraZoomMeta,
    load: () => import("./pixel-perfect-camera-zoom/index")
  },
  {
    ...pixelPerfectScissorLabMeta,
    load: () => import("./pixel-perfect-scissor-lab/index")
  },
  {
    ...pixelStableMovingMeshMeta,
    load: () => import("./pixel-stable-moving-mesh/index")
  }
  // AUTO_ENTRIES_END
];

export function getExperimentById(id: string): ExperimentRegistryEntry | undefined {
  return experiments.find((entry) => entry.id === id);
}
