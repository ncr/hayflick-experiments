# Collider Pipeline Lab V2

## Objective
Build a second-generation collider experiment that evaluates multiple collider-generation strategies side-by-side, compares predicted-vs-actual strategy ranking quality, and exposes tuning controls for fast iteration.

## Why V2
Prior collider exploration produced useful signals but made side-by-side comparison and classifier validation difficult. V2 isolates the full workflow in one new experiment and standardizes scoring/ranking output.

## Scope
- Local-only collider pipeline implementation in `packages/experiments/src/collider-pipeline-lab-v2`.
- Raw prop GLB normalization.
- Automatic shape classification.
- Multi-strategy collider generation.
- Two ranking systems:
  - Actual quality ranking.
  - Classification-based predicted ranking.
- 4-pane UI with synchronized strategy viewports.
- Initial regression framework focused on deterministic reporting (no strict quality gates yet).

## Pipeline
1. Normalize
- Canonicalize each prop mesh into stable analysis space:
  - center in X/Z
  - base at `Y=0`
  - scale longest axis to `1.0`

2. Classify
- Compute descriptors:
  - size and aspect
  - complexity
  - slenderness
  - concavity proxy
  - flat/support indicators

3. Generate
- Run all strategies:
  - `AABB`
  - `OBB (PCA)`
  - `Layered Y`
  - `Layered X`
  - `Layered Z`
  - `Voxel Greedy`
  - `Split Fit`
  - `Support Columns`

4. Evaluate
- Actual quality score (fit-first):
  - underfill
  - overfill
  - thin-part penalty
  - primitive-count penalty
  - flat-base bonus
- Predicted suitability score from classification-only heuristics.
- Rank-correlation output (`Spearman`) and top-1 agreement.

## UI Layout
- Top bar: horizontal prop list with thumbnails.
- Left pane: classification metrics/labels and rank-agreement summary.
- Middle pane: one live 3D card per strategy, shown simultaneously.
- Right pane: knobs for each strategy.
- Synchronized camera controls: rotating one strategy view rotates all.

## Testing Strategy (Phase 1)
- Unit coverage for:
  - classification
  - scoring
  - ranking prediction
  - strategy invariants
- Integration-style report checks over fixture props:
  - deterministic output shape
  - finite scores and valid ranks
- No strict quality-threshold gates yet; thresholds will be introduced after tuning stabilizes.

## Definition of Done
- Experiment registered as `collider-pipeline-lab-v2`.
- All four panes functional and wired.
- All five strategies run and show both rank systems.
- Shared viewport rotation works across strategy cards.
- Regression tests pass for deterministic report generation.

## Follow-up
- After tuning settings on real props, convert report checks into strict regression thresholds to protect quality while iterating.
