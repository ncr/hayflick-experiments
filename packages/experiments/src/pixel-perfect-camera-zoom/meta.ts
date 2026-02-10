import { ExperimentMeta } from "../runtime/meta";

export const meta: ExperimentMeta = {
  id: "pixel-perfect-camera-zoom",
  title: "Pixel Perfect Camera Zoom",
  tags: ["pixel", "isometric", "rendering", "prototype"],
  description:
    "Explores camera-based zoom with a fixed low-res render target to keep GPU cost predictable while zooming around the cursor.",
  status: "draft",
  updatedAt: "2026-02-10"
};
