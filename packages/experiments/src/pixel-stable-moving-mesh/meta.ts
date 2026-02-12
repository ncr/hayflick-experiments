import type { ExperimentMeta } from "../runtime/meta";

export const meta: ExperimentMeta = {
  id: "pixel-stable-moving-mesh",
  title: "Pixel Stable Moving Mesh",
  tags: ["pixel", "isometric", "rendering", "prototype"],
  description:
    "Compares screen-space pixel dithering against object-local dithering so moving meshes can stay visually stable while translating.",
  status: "draft",
  updatedAt: "2026-02-12"
};
