import type { ExperimentMeta } from "../runtime/meta";

export const meta: ExperimentMeta = {
  id: "iso-scale-probe",
  title: "Iso Scale Probe",
  description:
    "Calibration harness for IsoGameView pixel scale. Two tile-aligned reference boxes (128cm cube and 128x256x64 cm tall) under a preset switcher for the iso scale ratio R = referenceLowHeight / baseOrthoHeight. Used to lock the canonical 2:1 iso scale before changing PixelPerfectDefaults.",
  tags: ["threejs", "pixel-perfect", "iso", "calibration", "tooling"],
  status: "draft",
  updatedAt: "2026-05-07"
};
