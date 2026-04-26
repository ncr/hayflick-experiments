import type { ExperimentMeta } from "../runtime/meta";

export const meta: ExperimentMeta = {
  id: "pixel-art-tex",
  title: "Pixel-Art Tex POC",
  description:
    "Proof of concept for AI-generated pixel-art textures on tileable meshes. The mesh's world dimensions are a known multiple of screen pixels, so the texture is authored at the matching texel resolution: a grid PNG is sent to gpt-image-2 as a reference, the AI fills each cell with a single colour, post-processing extracts one colour per cell, and the resulting PNG is sampled with NEAREST filter so every texel reads as one (or one large) screen pixel.",
  tags: ["threejs", "pixel-perfect", "texture", "ai", "openai", "wall"],
  status: "draft",
  updatedAt: "2026-04-26"
};
