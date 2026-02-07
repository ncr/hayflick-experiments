import type { ExperimentMeta } from "../runtime/meta";

export const meta: ExperimentMeta = {
  id: "editor-game-ecs",
  title: "Editor + Game (ECS)",
  description:
    "Single-page editor/game loop: paint tile walls, place doors, bake to ECS LevelResource, then play with runtime door toggles and save/load.",
  tags: ["threejs", "editor", "ecs", "level-bake", "save-load"],
  status: "draft",
  updatedAt: "2026-02-07"
};
