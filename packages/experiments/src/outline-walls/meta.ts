import type { ExperimentMeta } from "../runtime/meta";

export const meta: ExperimentMeta = {
  id: "outline-walls",
  title: "Outline Walls",
  description:
    "Depth+normal outline postprocess on tiled wall GLBs. Shared-id seams are suppressed so adjacent segments read as one silhouette; the color pass keeps the kit's PBR materials (base color, normal map, metallic-roughness) and an orbiting point light sweeps the face so the material response is visible.",
  tags: ["threejs", "pixel-perfect", "outline", "postprocess", "walls", "pbr"],
  status: "draft",
  updatedAt: "2026-04-21"
};
