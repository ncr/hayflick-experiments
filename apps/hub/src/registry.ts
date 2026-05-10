import type { ExperimentRegistryEntry } from "@experiments/runtime";
import type { GameModule } from "@common/gameplay";
import type * as THREE from "three";

import { meta as materialStudioMeta } from "@studios/material-studio/meta";
import { meta as mapEditorMeta } from "@studios/map-editor/meta";
import { meta as physicsPropDropMeta } from "@experiments/physics-prop-drop/meta";
import { meta as gridWalkerMeta } from "@experiments/grid-walker/meta";

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

export type GameRegistryEntry = {
  id: string;
  title: string;
  description: string;
  tags: readonly string[];
  load: () => Promise<{ default: GameModule<THREE.Object3D> }>;
};

export const games: GameRegistryEntry[] = [
  {
    id: gridWalkerMeta.id,
    title: gridWalkerMeta.title,
    description: gridWalkerMeta.description,
    tags: gridWalkerMeta.tags,
    load: () => import("@experiments/grid-walker")
  }
];

export function getGameById(id: string): GameRegistryEntry | undefined {
  return games.find((entry) => entry.id === id);
}
