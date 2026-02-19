# Convex Hull Collider Next Steps

## Goal
Improve Rapier collider reliability and runtime cost by optimizing convex hull inputs and decomposition, without topology-remeshing work.

## Plan

1. Hull point-set conditioning
- Add deterministic coplanar-point pruning before hull generation.
- Add tiny-feature suppression based on model-scale threshold.
- Keep sharp/support corners by curvature + extremal-point retention.

2. Hull complexity budgeting
- Add explicit max-vertex budget per hull part (hard clamp + graceful fallback).
- Add post-hull vertex reduction for near-collinear/near-coplanar triples.
- Track per-part vertex counts in stats and regression snapshots.

3. Split/decomposition objective tuning
- Extend split score to penalize unnecessary extra hull parts.
- Add gap/overlap penalty between neighboring hulls.
- Add stability-oriented heuristic: prefer flatter support-contact surfaces.

4. Validation loop
- Add regression fixtures for key props (PET, desk, chair, lamp).
- Add metrics report for each fixture: part count, hull vertex counts, outside ratio, overfill ratio.
- Gate future changes with deterministic signature + metrics thresholds.

5. Optional editor UX
- Add a compact "Hull Cost" panel (parts, total vertices, max vertices/part) in collider lab.
- Keep toggles focused on physics-relevant metrics; avoid topology-only controls.
