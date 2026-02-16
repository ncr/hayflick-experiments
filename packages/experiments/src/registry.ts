import type { ExperimentRegistryEntry } from "./runtime/meta";

// Registry is kept explicit so lazy import boundaries stay obvious.
// AUTO_IMPORTS_START
import { meta as ecsFoundationMeta } from "./ecs-foundation/meta";
import { meta as editorGameEcsMeta } from "./editor-game-ecs/meta";
import { meta as levelBuilderMeta } from "./level-builder/meta";
import { meta as physicsRapierMeta } from "./physics-rapier/meta";
import { meta as pixelOutlinePostMeta } from "./pixel-outline-post/meta";
import { meta as pixelPerfectCameraZoomMeta } from "./pixel-perfect-camera-zoom/meta";
import { meta as pixelStableMovingMeshMeta } from "./pixel-stable-moving-mesh/meta";
import { meta as propDropEdgeTestMeta } from "./prop-drop-edge-test/meta";
import { meta as settlementBuilderEcsMeta } from "./settlement-builder-ecs/meta";
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
    ...settlementBuilderEcsMeta,
    load: () => import("./settlement-builder-ecs/index")
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
    ...pixelPerfectCameraZoomMeta,
    load: () => import("./pixel-perfect-camera-zoom/index")
  },
  {
    ...pixelStableMovingMeshMeta,
    load: () => import("./pixel-stable-moving-mesh/index")
  },
  {
    ...propDropEdgeTestMeta,
    load: () => import("./prop-drop-edge-test/index")
  }
  // AUTO_ENTRIES_END
];

export function getExperimentById(id: string): ExperimentRegistryEntry | undefined {
  return experiments.find((entry) => entry.id === id);
}
