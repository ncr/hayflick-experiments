import type { ExperimentMeta } from "../runtime/meta";

export const meta: ExperimentMeta = {
  id: "material-studio",
  title: "Material Studio",
  description: "Pick a base mesh from the flat `assets/meshes/` catalog, walk each texturable surface (via the GLB's textureRole extras), author each surface's texture by prompt (generate → adjust → approve), and bake a single GLB into `assets/textured-meshes/<name>/` — ready to drop into the game. UV islands are detected from the base mesh, packed into a template, painted by gpt-image-2, and stitched into a clean per-mesh atlas; the bake is an in-process @gltf-transform/core pass that writes new UVs and PBR textures into the artifact.",
  tags: ["editor", "tileset", "pbr", "texture", "ai"],
  status: "draft",
  updatedAt: "2026-04-26"
};
