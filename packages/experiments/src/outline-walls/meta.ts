import type { ExperimentMeta } from "../runtime/meta";

export const meta: ExperimentMeta = {
  id: "outline-walls",
  title: "Outline Walls",
  description:
    "Depth+normal outline postprocess that suppresses seams between adjacent wall segments sharing an outline group id, producing a continuous silhouette. Pixel-perfect iso-2:1 view with pan/zoom/rotate.",
  tags: ["threejs", "pixel-perfect", "outline", "postprocess", "walls"],
  status: "draft",
  updatedAt: "2026-04-20"
};
