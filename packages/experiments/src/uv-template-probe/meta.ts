import type { ExperimentMeta } from "../runtime/meta";

export const meta: ExperimentMeta = {
  id: "uv-template-probe",
  title: "UV Template Probe",
  description:
    "Probe for AI-aware UV unwraps: send a multi-island grid template to gpt-image-2 and check whether the model paints inside the outlined regions, leaves the background untouched, and respects per-cell pixel-art structure. Validates 'approach 3' before scaling to real mesh unwraps.",
  tags: ["ai", "openai", "texture", "uv", "probe"],
  status: "draft",
  updatedAt: "2026-04-26"
};
