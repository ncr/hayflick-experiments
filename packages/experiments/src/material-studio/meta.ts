import type { ExperimentMeta } from "../runtime/meta";

export const meta: ExperimentMeta = {
  id: "material-studio",
  title: "Material Studio",
  description: "Pick a base mesh from the flat `assets/meshes/` catalog, walk each texturable surface (via the GLB's textureRole extras), author each surface's texture by prompt (generate → adjust → approve), and bake a single GLB into `assets/textured-meshes/<name>/` — ready to drop into the game. Blender handles UV wrapping at bake time.",
  tags: ["editor", "tileset", "pbr", "texture", "ai"],
  status: "draft",
  updatedAt: "2026-04-23"
};
