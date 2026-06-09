import type { ExperimentMeta } from "@experiments/runtime";

export const meta: ExperimentMeta = {
  id: "pathtrace-probe",
  title: "Path-Trace Probe",
  description:
    "Spike: realtime GPU path tracing of a DYNAMIC low-res scene. Measures the two numbers that decide viability on this GPU — frame time (GPU-bound ray cost) vs per-frame BVH rebuild time (CPU-bound, the dynamic-geometry killer).",
  tags: ["threejs", "path-tracing", "spike", "performance", "dynamic", "low-res"],
  status: "draft",
  mode: "free",
  updatedAt: "2026-06-09"
};
