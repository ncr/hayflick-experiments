# 04 · Time & NPC Schedules

> Round 1 locked "living continuous day/night." This module details it. All choices locked round 10.

## The clock (locked)

- **Continuous, deterministic.** Sim time = `tick / 60`. A full day = a fixed, **tunable** number of
  ticks (day length is a config knob to feel-test, like carry capacity). Smooth day→dusk→night→dawn.
- Time-of-day drives lighting (the ray-traced GI), population, business hours, and patrol patterns.

## NPC schedules — procedural per-NPC (locked)

- Each NPC is generated with a **home**, a **workplace/role**, and **social habits**; their daily
  **timetable** derives from these: wake → commute → work → meals → leisure (tavern, market, chapel)
  → home → sleep, each step **bound to specific cells/buildings**.
- Schedules are **deterministic** (seeded from `LevelSpec.seed`) and **unique per town** — reading an
  individual's routine ("the silversmith drinks at the tavern every dusk; his shop sits empty an
  hour") is *knowledge you earn by casing and then exploit.* This is the premise's daily engine.
- An NPC's current cell is simply where their schedule + reactions place them at tick *t*.

## Time control — wait, sleep, lie-low (locked)

- You may **pass time deliberately**: sleep at the safehouse (skip to a chosen time, restore), wait
  in a hiding spot, loiter. **The world keeps simulating** — you never freeze the town, you **choose
  your moment by waiting for it.**
- Implemented as **fast-forwarding the deterministic sim** (advance ticks with the player idle); the
  result is identical to living it in real time, so headless replay and `state_hash` are unaffected.
  **No backward scrub** — it would break the living sim and gut the stakes.
- **Minigames are not a freeze exception (review pass):** the lockpick/safecrack pause is
  presentation-only and the action resolves *instantly* in sim time (07) — sim time is never held
  frozen while the world should be moving, so the "world keeps running" rule stands intact.

## Day ↔ night — strong contrast, "two different games" (locked)

- **Night:** darkness (low light → the light/shadow detection coupling makes stealth viable), sparse
  streets, businesses & **fences closed**, and *being out is itself mildly suspicious* (curfew-
  adjacent), more so after a serious crime.
- **Day:** crowds (cover in numbers, but many eyes and many potential witnesses), businesses and
  **fences open**, and *casing a target reads as normal* — the natural time to gather knowledge.
- The intended cadence — **case by day, strike by night** — falls out of this contrast rather than
  being scripted. Both halves are exploitable; a bold player robs in daylight crowds, a patient one
  works the dark.

## Reactive world — routines respond to your crimes (locked)

The town's routine is a **living thing your crimes perturb** (tightly coupled to the deduction
engine — heat literally reshapes the world you move through):

- A **burgled owner stays home and watchful**; a spooked shopkeeper **hires a watchman**.
- Guards **add night patrols** or impose a **curfew** after a serious crime.
- A **killing empties the streets**; a **funeral** reshapes everyone's day.
- Reactions are **deterministic, seeded functions of sim events**, and are a primary source of the
  **open-ended run's continuous escalation** (module 02): the more you do, the harder the town is to
  move through — until you leave.

## Determinism

Clock, schedules, time-skip fast-forward, and reactions are all seeded and replayable; the same trace
reproduces the same world-state at every tick.
