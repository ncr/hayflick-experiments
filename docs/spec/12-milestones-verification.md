# 12 · Milestones & Verification

> The build plan and the proof bar. All choices locked round 14. Verification follows root
> CLAUDE.md: a change isn't done until `cargo test` + (render-side) `bin/golden` pass and, for
> anything visible in motion, a recorded clip shows the intended behavior.

## v1 scope line (locked — full core loop; defer module-10)

**In v1:** algorithmic *fair* town (03) · full stealing verbs + minigames + use-based skill (07) ·
the **complete crown jewel** — perception, memory, deduction, confrontation (05a/b/c) · identity &
disguise (06) · time, schedules, reactive world (04) · NPC AI (08) · **basic fencing economy** +
greed curve + meta-progression (02/09) · presentation, event log, planning board (11).

**Deferred** (the post-v1 "unfolding" layers, module 10): forgery, smuggling, own-racket, and the
social-warfare quartet (framing, impersonation, blackmail, bribery), plus fencing-network depth.

Rationale: v1 must be the *deduction loop done excellently*, not broad-but-shallow.

## Build strategy (locked — thin vertical slice first)

Get a thin **end-to-end** playable fast (one building, a couple NPCs, the whole spine), then
**widen**. Every layer talks to the next early, so integration risk and the "is it fun?" question
surface immediately — critical for a novel design.

## Risk sequencing (locked — de-risk the scary unknowns first)

Front-load spikes on the three real technical risks before building atop them:

1. **Fair algorithmic generation** — towns that *provably* pass the fairness invariants (03).
2. **Multi-floor auto-reveal** — the iso ray-tracer occlusion across BOTH backends (11).
3. **Deduction determinism** — order-stable correlation, `state_hash`-oracle-able (05b).

## Milestone ladder (indicative)

- **M0 · De-risk spikes.** The three spikes above, each proven headless/golden. Gate: fairness
  oracle passes on M seeds; reveal golden stable on both backends; a deduction toy-scenario hashes
  identically across replays.
- **M1 · The spine, headless.** Greybox: one building, a guard, a civilian. A scripted **trace**:
  player steals → is seen → word spreads → a description forms → the guard hunts the matching
  profile. Gate: a **deduction-scenario test** asserts the Case/heat/hunt form as intended, + a clip.
- **M2 · Playable slice.** Human on the controls in that greybox: real-time stealth read (11), the
  **confrontation ladder** (05c), the **event log**. First **"is it fun?"** checkpoint. **Feel-tests
  land here:** carry model (encumbrance vs. free) and day length.
- **M3 · Widen the town.** Full algorithmic district (10–20 buildings), roles, schedules, day/night,
  reactive world (03/04/08).
- **M4 · Identity depth.** Layered wardrobe, contextual blending, tells; description-heat vs. personal
  recognition fully exercised (06 × 05).
- **M5 · Economy & meta.** Fencing (hot→cool), greed curve, extraction/banking, lair + safehouse +
  meta-progression, use-based skills (09/02/07).
- **M6 · The hunt, full.** Investigator NPCs, forensic traces, punishment ladder + permanent marks,
  full confrontation counterplay (05b/c/08).
- **M7 · Polish & v1 gate.** Planning board, onboarding, feel tuning, look pass.
- **Post-v1 · Unfolding.** Each module-10 system as its own milestone/detail-pass, introduced by the
  mixed unlock routing (notoriety / lair / discovery).

## Verification — the oracle families this game adds

Beyond the standard triad, hold these oracle families. **Portability note (review pass, per
ARCHITECTURE.md):** f32 determinism is same-machine/same-binary — `state_hash` values and PNG
goldens are **machine-local gates**, never portable CI; the portable CI layer is the *logical*
headless assertions (scenario outcomes, invariants, counts).

- **Sim determinism hash oracles** — perception/memory/deduction/AI are `state_hash`-stable; a
  refactor that reorders their floats fails (per CLAUDE.md's goo-oracle precedent).
- **Generation fairness oracles** — generate M seeds; assert every solvability/fairness invariant
  (03) holds. This is how "fully algorithmic" is kept safe.
- **Deduction-scenario tests** — scripted traces assert that a given crime produces the intended
  Case, heat, propagation, and hunt (the behavioural spec, made executable).
- **Render goldens** — `bin/golden` for the auto-reveal; mob/UI-free scenes stay byte-identical;
  GLSL↔Metal lockstep.
- **Clips** — record-gameplay / DEMO path for anything visible in motion, per milestone.
- **Replay identity includes the knobs (review pass)** — every sim-affecting tunable (day length
  04, carry capacity 07, greed-curve constants 09) lives in `LevelSpec` / the trace header, never
  env-only: a replay must carry *everything* that shaped the sim (config seeding is world setup,
  per ARCHITECTURE.md).
