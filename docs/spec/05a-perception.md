# 05a · Crown Jewel, Part 1 — Perception & the Observation Atom

> The **input layer** to the suspicion/memory/deduction engine. Everything the town "knows"
> about you begins as a perception recorded here. Memory storage, propagation, and deduction
> live in `05b+` (later rounds). All choices below locked in round 5.

## Two real-time senses (locked)

### Sight
- NPCs have **vision cones** (facing + FOV + range), and seeing you requires **edge-gated
  line-of-sight** through the grid: walls / closed doors / shutters block; open doors, windows,
  and low-walls pass (possibly at reduced confidence).
- **Light & shadow modulate detection — via a SIM-SIDE light field.** The local light level at
  your cell feeds detectability: standing in shadow, or dousing a lamp, materially lowers the
  range/chance a cone resolves you. **Architecture constraint (review pass):** this light level
  comes from a **deterministic CPU light model in `house-game`** (light sources → per-cell light
  levels over the edge-gated grid), NEVER from the renderer — the game must run and test headless
  (ARCHITECTURE.md), and GPU floats are machine-local so they can't feed `state_hash`. The
  ray-traced GI **visualizes** this same light field; keeping the two *perceptually* consistent
  (what looks dark IS dark to the sim) is an explicit tuning duty (module 11, feel-checked at M2).
- Distance, your motion (running reads faster than still), and partial cover degrade an
  observation's **confidence**, not merely its yes/no.

### Hearing
- Sound **propagates through the cell/edge graph**: a noise emits at a cell with a loudness,
  travels along open edges, and is **attenuated/muffled by wall and door edges**. Through a shut
  door two rooms away a footstep is inaudible; a smashed window carries far.
- Player actions have **loudness tiers** (sneak-step ≈ silent → walk → run → force/break → combat
  → a dropped body). Floor material and edge state modulate emission.
- A heard sound yields a *lower-fidelity* observation (a direction/where + "a noise," usually no
  appearance). It makes NPCs **investigate**, which can convert into a sighting.

## The observation atom (locked — rich & structured)

Every notice — a sighting, a sound, or a later-discovered clue — is a **structured record**.
Illustrative shape (final fields deferred to a detail pass):

    Observation {
      observer:    NpcId,
      subject:     AppearanceDescription | Unknown,   // fuzzy features, see below
      action:      ActionKind,   // Loitering, Casing, Climbing, Fleeing, Carrying(loot),
                                  //   Forcing(edge), Fighting, BearingBody, None/"a noise"
      where:       Location,     // cell + building/zone + floor
      when:        Tick,         // sim tick = deterministic time
      confidence:  f32,          // clarity — from distance, light, cover, which sense
      salience:    f32,          // alarmingness — a fleeing masked figure ≫ a passerby
    }

These records are the **only** currency the deduction engine (05b) reasons over — nothing is
"just known." Both live perception and forensic discovery emit `Observation`s.

## Appearance as a fuzzy feature vector (locked — THE foundation mechanic)

`subject` captures **features, not identity.** The player never carries an NPC-visible "it's the
player" flag — only a describable look:

    AppearanceDescription {        // a partial, per-observation snapshot
      build/height, top_color, bottom_color, headwear/hood, mask(y/n),
      distinctive_items (a limp, a scar, a fine dagger, a carried sack), gait, ...
      // any field may be Unknown if the observer didn't get a clear read
    }

- **Recognition is a fuzzy match** of a freshly-seen person against remembered descriptions:
  many shared features + few conflicts ⇒ high match ⇒ high suspicion; a changed coat or an added
  mask breaks the match. Partial match ⇒ partial suspicion.
- This is what **disguise (06)** mutates, what **framing (10)** forges, and what **impersonation
  (10)** satisfies. Build it first and build it well — every identity system is downstream of it.
- A poor read fills fields with `Unknown` ⇒ vague descriptions ("someone hooded, average build")
  that match many townsfolk ⇒ weak, contestable cases. Getting a *good* look at you is exactly
  what the town needs and what you spend the game denying it.

## Forensic traces (locked — rich physical evidence)

Beyond real-time senses, the world **retains physical evidence** discovered later — the delayed,
"next-morning" half of the loop:

- **Trace types:** forced/picked locks, a jimmied or broken window, muddy or bloody footprints,
  blood, moved/missing objects, a dropped tool or item, a hidden-or-found body, a door left ajar.
- **Discovery is delayed & situational** — an owner checking the strongbox at dawn, a patrol
  passing a forced door, a maid entering a room. Discovery emits `Observation`s (often
  `subject: Unknown` but rich in action/where/when) that the engine correlates.
- **Counterplay is first-class:** you can *avoid* leaving traces (pick vs. force; sneak-step on
  stone), *clean them up* (re-latch the window, hide the body, wipe prints), or *plant* them to
  frame another (drop someone's belonging at the scene) — the raw material of module 10's
  framing/misdirection.
- **Traces are backward-looking evidence ONLY** (review-pass clarification). There is no live
  trail-following sense — round 5 explicitly rejected scent/tracking. Discovering a footprint
  emits an `Observation` about *past* presence (feeding the Case); it never hands pursuers your
  current position. This upholds 05c's promise that a broken trail is genuinely broken.

## Determinism

Cones, LOS, sound propagation, the cell light field, confidence/salience, and fuzzy matching are
all pure functions of sim state at a tick — seeded, no wall-clock, CPU-only (no renderer input). They must be `state_hash`-stable: a refactor that
reorders their floats is a determinism regression (root `CLAUDE.md`).
