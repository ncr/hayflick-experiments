# VHACD Unity Lab

This experiment is a UI/workflow shell around the promoted VHACD collider package.

Promoted module:
- `@common/collider-vhacd`
  - VHACD decomposition core
  - worker entrypoints (`vhacd.worker.ts`, `vhacd.split.worker.ts`)
  - reusable worker runner (`createVhacdWorkerRunner`)

Experiment-local responsibilities:
- prop loading/picker UX
- card grid layout with one WebGL context + scissor rendering
- synchronized orbit controls across panes
- overlay rendering and debug/status panels
- heuristic furniture classification display
