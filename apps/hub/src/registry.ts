import type { ExperimentRegistryEntry } from "@experiments/runtime";
import type { GameModule } from "@common/gameplay";
import type { GameSource } from "@studios/game-studio";

import { meta as materialStudioMeta } from "@studios/material-studio/meta";
import { meta as mapEditorMeta } from "@studios/map-editor/meta";
import { meta as physicsPropDropMeta } from "@experiments/physics-prop-drop/meta";
import { meta as gridWalkerMeta } from "@experiments/grid-walker/meta";

const experimentSources = import.meta.glob(
  "../../../experiments/*/src/**/*.{ts,tsx}",
  { query: "?raw", import: "default" }
) as Record<string, () => Promise<string>>;

function makeSourceLoader(gameId: string): () => Promise<GameSource[]> {
  return async () => {
    const prefix = `../../../experiments/${gameId}/src/`;
    const entries = Object.entries(experimentSources).filter(([p]) =>
      p.startsWith(prefix)
    );
    const sources = await Promise.all(
      entries.map(async ([p, load]) => ({
        path: p.slice(prefix.length),
        code: await load()
      }))
    );
    sources.sort((a, b) => a.path.localeCompare(b.path));
    return sources;
  };
}

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
  load: () => Promise<{ default: GameModule }>;
  loadSources: () => Promise<GameSource[]>;
};

export const games: GameRegistryEntry[] = [
  {
    id: gridWalkerMeta.id,
    title: gridWalkerMeta.title,
    description: gridWalkerMeta.description,
    tags: gridWalkerMeta.tags,
    load: () => import("@experiments/grid-walker"),
    loadSources: makeSourceLoader(gridWalkerMeta.id)
  }
];

export function getGameById(id: string): GameRegistryEntry | undefined {
  return games.find((entry) => entry.id === id);
}
