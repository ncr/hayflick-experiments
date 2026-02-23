import type { ExperimentMeta } from "../runtime/meta";

export const meta: ExperimentMeta = {
  id: "tripo-face-limit-compare",
  title: "Tripo Face Limit Compare",
  tags: ["tripo", "mesh", "pixel", "rendering", "comparison"],
  description:
    "Compares Tripo image-to-model outputs for the same three Forge V2 prompts across 1k/3k/5k/10k face limits using shared scissor normal + pixel preview panes.",
  status: "draft",
  updatedAt: "2026-02-23"
};
