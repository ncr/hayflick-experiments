import type { ExperimentMeta } from "@experiments/runtime";

export const meta: ExperimentMeta = {
  id: "grid-walker",
  title: "Grid Walker",
  description:
    "Smallest ECS demo: a player on a flat tile floor with arrow-key movement. Exercises the GameStudio shell end-to-end (input → systems → world → mesh → debug log + tweakable speed knob).",
  tags: ["ecs", "starter", "studio"],
  status: "draft",
  mode: "strict",
  updatedAt: "2026-05-10"
};
