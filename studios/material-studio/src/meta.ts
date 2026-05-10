import type { ExperimentMeta } from "@experiments/runtime";

export const meta: ExperimentMeta = {
  id: "material-studio",
  title: "Material Studio",
  description: "Paint pixel-art textures directly into a per-surface UV atlas, with optional gpt-image-2 fill for unpainted cells. UV islands are detected on mesh load and packed into both a small atlas (256², one cell per pixel — what the GLB samples) and a large grid template (1024² — what the AI paints). NEAREST sampling end-to-end so one atlas pixel = one game pixel. Bake is an in-process @gltf-transform/core pass that writes the remapped UVs and per-role PBR textures into `assets/textured-meshes/<name>/artifact.glb`.",
  tags: ["editor", "paint", "pbr", "texture", "ai"],
  status: "draft",
  updatedAt: "2026-04-27"
};
