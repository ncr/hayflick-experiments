# 03 · World Model — Cell Scale, Grid & Generation

## Cell scale (locked — round 4) — resolves the handoff's open question

- **Architecture scale, fine granularity: 1 grid cell = 1 wu ≈ 1 metre.**
- Pixel consequence (salvaged `R = 32·√2 ≈ 45` lowpixels/wu, 2:1 iso): a 1×1 cell renders as a
  ~64×32-lowpixel ground diamond; a human ≈ 80 lowpixels tall — chunky, readable figures.
- **R is UNCHANGED** from the salvaged contract. A bedroom ≈ 4×5 cells; furniture occupies
  cells; the player slips *between* a table and a wall. Sub-room stealth granularity is the point.

## The grid data model — cells hold contents, EDGES hold barriers

The load-bearing modelling decision for a stealth game:

- **A cell** carries: floor/ground material, at most one actor occupant, optional furniture/prop,
  and derived flags (cover, walkable, noise-on-step).
- **An edge** (boundary between two adjacent cells, or a cell and the outside) carries the
  *barrier*: `open | wall | door(open/closed/locked) | window(shut/open/shuttered/broken) |
  low-wall/railing`.
- **Why edges:** movement, line-of-sight, and sound are all **edge-gated**. A wall on a cell's
  N edge blocks you, blocks sight, and muffles sound between those two cells — one model serves
  all three. Doors and windows are the *controllable* edges a thief manipulates. This is what
  makes interiors legible to both the player and the perception engine (module 05).

## Verticality (locked — round 4) — stacked floors, no roof-running (v1)

- The world is a stack of grid **z-layers**: basements (−1…−m), ground (0), upper floors (1…n).
- Buildings have 2–3 interior floors + basements you move through. Vertical connections: stairs,
  ladders, and *climbable exterior features* (drainpipe, trellis, crates) that link a ground/
  street cell to an upper-floor **window edge** — the "climb to the unlatched second-floor
  window" break-in.
- **No rooftop traversal layer in v1.** Roofs are occluding caps, not a movement surface. (Full
  rooftop-running is a staged aspiration — module 11 owns the iso multi-floor occlusion problem
  it depends on.)

## The town (locked — round 4) — intimate, one dense district (v1)

- One district, **~10–20 enterable buildings**, streets/alleys, and an outer boundary with a few
  **gates/edges that are the extraction points** (leaving = banking the run, module 02).
- Population sized so "the town remembers you" stays *legible* — small enough that the deduction
  engine (module 05) can reason about who-saw-what without turning to mush.
- Buildings vary by wealth/function (homes, a tavern, workshops, a strongbox-bearing target),
  which drives loot value and guard density.

## Generation (locked — round 4) — FULLY ALGORITHMIC, with mandatory validation

Pure algorithmic generation (BSP / wave-function-collapse style) over authored templates, for
maximum variety and engine flex. Powerful **and risky for stealth fairness** — so validation is
not optional:

- **Seeded & deterministic.** All generation from `Pcg32` seeded by the run's `LevelSpec.seed`.
  Same seed → same town, bit-identical (fits the determinism discipline; headless-testable).
- **Mandatory solvability & fairness validation pass.** A generated town is *rejected and
  re-rolled* (or repaired) unless it satisfies invariants such as:
  - every building interior is reachable, and every locked target has **≥ 2 distinct approaches**;
  - no target sits in an *unavoidable* sightline — a stealable path provably exists;
  - minimum density of hiding spots / cover / shadow near valuables;
  - patrol routes and schedules leave exploitable gaps (co-designed with module 04);
  - extraction is reachable from anywhere without a *forced* detection.
- These invariants are **headless test oracles**: generate M seeds, assert all invariants hold.
  This is how "fully algorithmic" is made safe (and CI-able) rather than a fairness gamble.
- Exact algorithms (district layout, building interiors, patrol synthesis) are deferred to a
  later detail pass; this module fixes the **approach and the contract they must satisfy.**

## Determinism note

Cells, edges, floors, actors, and generation are all part of the fixed-tick, seeded, replayable
sim (root `CLAUDE.md`). No wall-clock, no unseeded RNG. Generation + validation run headless.
