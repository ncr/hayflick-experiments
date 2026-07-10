# Thief Game — Spec (working title)

> Modular design spec, built in layers over many interview rounds (general → detailed).
> This index is the **map + decision log**. Each module is its own file so no single
> wall of text. Later rounds add algorithm-level detail inside each module.

## Vision (locked — full text in `01-vision.md`)

A stealth game about **theft as social deduction**. The heist is easy; *getting away
with it over time* is the game. NPCs have memory and reason about evidence — they notice
a stranger casing a house, discover the loss later, and connect the two. Suspicion is a
**persistent social state** attached to your face, your clothes, and your patterns — not a
per-room alert meter that resets on line-of-sight. You manage identity, appearance, timing,
and evidence to keep stealing without becoming *the* thief everyone is hunting.

Seed inspiration: KCD2's theft + NPC-memory loop — canvas by day → steal by night → owner
notices at dawn → guards hunt someone matching your look → you get interrogated/searched if
you show up dressed the same.

## Pillars (rounds 1–2 locked)

1. **Memory & deduction** over alarm meters.
2. **Identity is a resource** you spend and rebuild — appearance, reputation, alibi.
3. **A living, scheduled town** you learn and exploit.
4. **Every town is a fresh puzzle** (procedural roguelike runs); the thief who runs them grows.
5. **Violence is available but expensive** — evidence outlives the act.
6. **The game unfolds** — stealing is the foundation, not the ceiling; new systems keep arriving
   across the whole game (module 10).

## Locked engine constraints (from `../spec-reset-handoff.md` — NOT up for debate)

- Iso 2:1, large pixels, ray-traced GI; the pixel-perfect contract.
- Grid-based, procedural, **no imported assets**. `1 wu = R lowpixels`.
- Headless-deterministic sim: fixed 60 Hz tick, trace replay, hash oracles, byte-exact goldens.
- **Resolved (R4):** cell scale = **architecture, 1 cell = 1 wu ≈ 1 m** (module 03); R unchanged.

## Module map (files filled as rounds close)

| #  | File | Status |
|----|------|--------|
| 00 | `00-index.md` (this) | living |
| 01 | vision & pillars | **drafted (R1)** |
| 02 | run structure, session flow & meta-progression | **drafted (R2)** |
| 03 | world model — cell scale, grid, generation | **drafted (R4)** |
| 04 | time & NPC schedules | **drafted (R10)** |
| 05 | suspicion, memory & deduction ← crown jewel (`05a·05b·05c`) | **drafted (R5–7)** |
| 06 | player, identity & disguise | **drafted (R8)** |
| 07 | stealing mechanics — verbs, loot, carrying, skill | **drafted (R9)** |
| 08 | NPC AI & senses | **drafted (R11)** |
| 09 | economy — loot value, fencing, payoff & greed curve | **drafted (R12)** |
| 10 | the systems catalogue — the unfolding layers (living list) | **drafted (R3)** |
| 11 | presentation, camera & UI | **drafted (R13)** |
| 12 | milestones & verification | **drafted (R14)** |

_(Numbering may shift as modules split; the index is the source of truth.)_

## Status & next steps (2026-07-09)

**Spec CORE is complete** — 14 interview rounds. Drafted: modules 01–09, 11, 12, and the crown jewel
`05a`/`05b`/`05c`. Module 10 (the unfolding systems) is captured at **horizon level** only; each of
its eight systems gets its own detail-pass round(s) when promoted — by design (the game unfolds).

**Recommended next steps:**
1. ~~Consistency / contradiction review pass~~ — **DONE 2026-07-09** (Fable; findings + fixes in
   the decision log below; three forks resolved by user: instant minigames, per-town legend-scaled
   punishments, lair + safehouse split).
2. **Module-10 deep-dives** — one focused round per system (fencing-network → framing → impersonation
   → blackmail → bribery → forgery → smuggling → racket), in roughly that dependency order.
3. ~~Hand M0/M1 to an implementing session~~ — **DONE 2026-07-09** (Fable; see below).
4. ~~M2 · Playable slice~~ — **DONE 2026-07-09** (Fable; see below). Next implementation
   milestone: **M3 · Widen the town** (towngen district into the viewer, roles, schedules,
   day/night routines, reactive world — 03/04/08). The M2 is-it-fun checkpoint + feel-tests
   (day length / carry model) are OPEN for the owner: `SCENE=thief bin/run`.

## Implementation status (2026-07-09 — M0 + M1 + M2 COMPLETE)

All code in `crates/house-game/src/thief/` (headless) + the FLOORCUT renderer work; 194 tests
green, 7 Vulkan goldens green.

- **M0 spike A** — module 03 grid: cells-hold-contents / edges-hold-barriers, stacked floors,
  vertical links; integer-exact LOS (supercover + corner rule), sound & light propagation
  (integer Dijkstra). PORTABLE determinism (pure ints, stronger than the f32 discipline).
- **M0 spike B** — towngen + fairness: seeded district (10–20 multi-storey buildings, BSP rooms,
  windows, stairs, climbs, locked targets, gates), mandatory validation (street/extraction
  connectivity, thief-level interior reachability, ≥2 approaches per target, hiding density),
  bounded re-roll. 32-seed oracle; 64 seeds currently pass on attempt 0.
- **M0 spike C** — 05a/05b engine: Observation atom, fuzzy match (base-rate rule: default
  agreements are not evidence), correlation into Cases (conflict veto; salience floor to OPEN a
  case; orphan retry = "the two facts meet"); severity-scaled decay; the scrutiny rule. Pinned
  portable hash oracles.
- **M0 spike D** — FLOORCUT multi-floor reveal: world-Y cut plane in the shade push (GLSL misc2.w
  / Metal misc3.x), all-pixels prefix dissolve loop; SCENE=tower + goldens tower/tower_cut.
  **Metal side ported but unverified** (debt note in `docs/goo-mob-handoff.md` — Mac must pin
  golden-metal tower set).
- **M1 spine** — `ThiefGame` Simulation: cones+LOS+light senses → partial Descriptions, noise,
  per-NPC memory, walk-to-report latency, case file, alertness ladder, guard scrutiny→Pursue.
  Deduction-scenario gate test + counterfactual (outfit change → no hunt) + pinned hashes +
  clips (`clips/thief_m1_spine.mp4`, `…_outfit.mp4` — mapviz projection of the sim; the
  renderer-integrated clip lands with M2).
- **M2 playable slice** — the sim grew the whole 05c ladder (hail → approach → graded stop:
  bluff / bribe / submit / flee; clean search CLEARS the description; catch = fine + seizure +
  case answered; hiding breaks a chase), sim-owned movement cadence (sneak/walk/run + 07
  encumbrance), the 04 day clock + ambient light field, coin, tick-stamped events → the
  module-11 prose log (`thief/log.rs`), and a thief text-trace grammar (`thief/trace.rs`).
  The two FEEL KNOBS live in `ThiefSpec` (`day_len_ticks`, `carry_capacity: Option` — `None`
  = free-carry) per the replay-identity rule. Viewer: `SCENE=thief` builds the greybox from
  the TownGrid (`rt-viewer/src/thief_scene.rs`), `ThiefLoop` drives play
  (`rt-viewer/src/thief_loop.rs`) — WASD + Shift run / Ctrl sneak / Space steal / G drop /
  O outfit / 1–4 answer a stop; FLOORCUT is wired LIVE to the player storey; sky follows the
  sim's day phase; the stealth read is stamp HUD (alert bubbles, exposure plate, event log,
  stop panel). Golden `thief` pinned (Vulkan; Mac must pin golden-metal), clip
  `clips/thief_m2_slice.mp4`. Spine oracle recaptured 0x4418fc21f5bb7d05 (M2 state layout),
  deduction oracle 0x8d78d79655e3a7f6 (`cleared_look`).
- **M2 feel round 1 (owner playtest verdicts, 2026-07-09)** — three verdicts, all landed:
  1. *"No dollhouse effect"* → the module-11 reveal is now two planes: roofs render outdoors
     (buildings read as buildings) and stepping INSIDE drops every occluder wall to sill
     height — a new occluder-only **WALLCUT** primary-ray plane in shade.comp + shade.metal
     (GI-neutral by construction; both twins ported in the same effort). Storey FLOORCUT
     stays for upper floors (M3+). Legacy goldens stayed byte-identical with both planes off.
  2. *"Walking is awkward — mouse movement"* → **LMB click-to-move**: the shell BFS-plans a
     route over the sim's own grid and feeds one Move per tick (the sim still owns the
     cadence; traces stay pure Move/Steal commands). Click the loot to walk-and-lift; a live
     stop turns the panel's outs into clickable buttons (a queued route can never auto-flee).
     WASD remapped to SCREEN-true staircase directions (W = visually up).
  3. *"HUD with a Fallout-1/2 log"* → full-width bottom bar: word-wrapped event log with
     day-clock prefixes (newest bright, older dimmed) beside the status cluster
     (clock/phase, coin, load, exposure, HEAT); scene-setting + controls as opening lines.
  Golden `thief` re-pinned (roofs + bar in frame); sim untouched — oracles unchanged.

- **Greybox look directions (owner request, 2026-07-10)** — the slice's whole aesthetic is
  now data: `ThiefLook` presets (rt-viewer `thief_look.rs`, `LOOK=` env) carry palette,
  body colours, lamp mood, lighting env and shape-kit switches (roof style, fascia, timber
  framing, plinths, cobble checker, body kit). Four presets: `classic` (the pre-look
  greybox, byte-frozen — the pinned golden renders it and stays the default), `gaslight`
  (dark port town, warm gas lamps, standing-seam roofs), `timbered` (cream plaster +
  half-timber, terracotta ridges), `inkwash` (parchment + charcoal ink lines, vermillion
  accent). The three new looks share one Refined kit: tailored bodies (hood + drape;
  guard helm/pauldrons/crest/spear; civilian hat), slim lantern posts, plinths, eave
  fascias. All greybox-lawful (0.0625-lattice boxes, occluder-marked → both dollhouse
  cuts work), NEE-lawful (lamps stay the only named lights — pinned per-look by test).
  No shader/sim changes: oracles + all goldens untouched. **OPEN: owner picks a
  direction** (comparison artifact "Thief — Look Directions"); the winner becomes the
  default and the thief golden is re-pinned then.

- **Look round 2 (owner request, 2026-07-10)** — five more presets (`bastion` medieval
  stone, `adobe` desert kasbah, `edo` machiya lane, `scifi` colony station, `neon`
  cyberpunk backstreet; `guard_polearm` switch keeps spears off sci-fi security) and
  **articulated figures**: every Refined-kit body is now five dynamic runs — core +
  `/legL` `/legR` (boots) + `/armL` `/armR` (hands) — swung by a deterministic walk
  cycle on the fixed sim clock (`Gait` in thief_loop: phase + blend; stride period and
  amplitude follow the movement mode, hunting guards run, arms counter-swing, guards'
  spears ride the carry arm). Hidden-crouch squash and the outfit swap zero/squash all
  five runs. Legacy kit (classic) untouched — the golden still passes byte-exact. The
  loop self-detects articulation by limb-run presence, so no look plumbing crossed the
  adapter.

- **Direction PICKED: scifi (owner, 2026-07-10)** — `LOOK` defaults to `scifi`; the thief
  golden is re-pinned to it (the other 7 goldens regenerated byte-identical, proving the
  change is scoped); the HUD accent swept to the station's safety-orange livery. `classic`
  stays as the byte-frozen museum baseline via `LOOK=classic` (no longer golden-covered).
  Also fixed in the same round, all Refined looks: the "unnatural dark rectangle" under
  every lamp was the lantern head shadowing its OWN overhead light point (NEE shadow rays
  see the fixture run) — lamps are now bracket-arm luminaires with the conceptual light
  hanging BELOW the lantern, leaving clear air to the ground; only the slim post casts a
  thin natural shadow. Clip: `clips/thief_look_scifi_walk.mp4`.

## Decision log

- **2026-07-09 · R1 opened.** Vision seed = thief / NPC-memory-and-deduction. Cell scale
  leaning *architecture*.
- **2026-07-09 · R1 closed.** Locked container shape (see `01-vision.md`):
  - World = **procedural town per run** (roguelike); meta-progression persists between runs.
  - Time = **living continuous day/night with NPC schedules.**
  - Violence = **non-lethal-first, lethal-possible, always costly** (choke/knockout before
    alarm, move/hide bodies, killing spikes town-wide heat via body-as-evidence).
  - Identity = **anonymous; appearance is identity** (disguise = core suspicion-shedding system).
  - **Tension flagged:** roguelike vs. multi-day deduction → a *run spans multiple in-game
    days in one town*; suspicion is a within-run arc; only meta-progression crosses runs.
    Refine in R2 (run anatomy).
- **2026-07-09 · R2 opened.** Run anatomy: horizon, objective, failure cost, meta-progression.
- **2026-07-09 · R2 closed.** Run anatomy (see `02-run-structure.md`):
  - Horizon = **open-ended until too hot** (no fixed length; continuous escalation;
    extraction is a greed-vs-heat judgement call).
  - Objective = **layered** (freeform survive-and-build + opt-in big scores).
  - Getting caught = **lose loot, spike heat, play on** (not a game-over; being hunted is content).
  - Meta-progression = **skills & tools + home base + notoriety-as-legend** (all three).
  - **New pillar (#6): the game unfolds** — stealing is the foundation, not the ceiling; new
    systems keep arriving (systems catalogue = module 10).
- **2026-07-09 · R3 opened.** Systems horizon: enumerate & prioritize the major system-layers
  the game unfolds, and how they unlock.
- **2026-07-09 · R3 closed.** Systems horizon (see `10-systems-catalogue.md`):
  - **Lone wolf** — crew/guild/rival cluster CUT. Player operates alone.
  - Underworld economy = **all four** (fencing, forgery, smuggling, own racket).
  - Social/information warfare = **all four** (impersonation, framing, blackmail, bribery) —
    these *write into* the deduction engine ⇒ module 05 must be attackable, not just evadable.
  - Unlock = **mix** (notoriety tiers · home-base investment · world discovery).
- **2026-07-09 · R4 opened.** World model & spatial scale: confirm cell scale, town composition,
  verticality, generation approach. (Resolves the handoff's last open question.)
- **2026-07-09 · R4 closed.** World model (see `03-world-model.md`):
  - Cell scale = **1 cell = 1 wu ≈ 1 m** (architecture scale, fine granularity). R unchanged.
    *Handoff open question resolved.*
  - Grid model = **cells hold contents, edges hold barriers** (movement/LOS/sound all edge-gated).
  - Verticality = **stacked floors + window entry, NO rooftop-running** in v1.
  - Town = **one intimate district, ~10–20 buildings**, gates = extraction points.
  - Generation = **fully algorithmic** + **mandatory headless solvability/fairness validation**
    (seeded, re-roll-until-fair; invariants are test oracles). Risk consciously accepted.
- **2026-07-09 · R5 opened.** Crown jewel, part 1 — **perception & the observation atom**: what
  NPCs sense, and the memory record that feeds deduction.
- **2026-07-09 · R5 closed.** Perception (see `05a-perception.md`) — all deep options:
  - Senses = **sight (cones + edge-gated LOS + light/shadow) + hearing (sound over edge graph).**
    Light level from the GI feeds detectability — renderer couples to gameplay.
  - Memory atom = **rich structured `Observation`** {observer, subject, action, where, when,
    confidence, salience}; the only currency deduction reasons over.
  - Recognition = **fuzzy feature-vector match** (appearance = features, never an "it's-the-player"
    flag). THE foundation for disguise/framing/impersonation.
  - Evidence = **rich forensic traces** you can avoid / clean / plant.
- **2026-07-09 · R6 opened.** Crown jewel, part 2 — **memory, knowledge propagation & deduction**:
  where knowledge lives, how it spreads, how facts become a case, the suspicion/heat state.
- **2026-07-09 · R6 closed.** Memory & deduction (see `05b-memory-deduction.md`) — all deep options:
  - Knowledge locus = **per-NPC memory**; the guards' **case file is a derived aggregate**
    (⇒ "race the rumor" — silence/outrun a witness before they report).
  - Propagation = **gossip + reporting + briefing + public notices**, with **latency** (exploit
    window) and **distortion** (telephone effect, plantable).
  - Deduction = **correlation engine** (Observations → a rising-confidence **Case**/suspect-profile)
    **+ investigator NPCs** on serious crimes (a physical agent you can mislead/intercept/coerce).
  - Suspicion state = **description-heat (shakeable)** + **personal recognition (sticky)**; both
    **decay** unless reinforced.
- **2026-07-09 · R7 opened.** Crown jewel, part 3 — **the confrontation ladder & your counterplay**:
  the stop/search/arrest encounter, reducing heat, defusing recognitions/cases, the failure floor.
- **2026-07-09 · R7 closed.** Confrontation & counterplay (see `05c-confrontation-counterplay.md`)
  — all deep options. **Crown jewel (05) COMPLETE.**
  - Confrontation = **graded social stop** (bluff / papers / bribe / submit-to-search / distract /
    flee / fight); a **clean search can clear a description**, fleeing confirms guilt → pursuit.
  - Cooling heat = **passive decay + active laundering** (change look, alibi/routine, muddy/compete).
  - Sticky counterplay = **full underworld toolkit** (avoid, bribe, blackmail, discredit, misdirect
    the investigator onto a patsy, eliminate).
  - Failure floor = **death only; captures escalate** (fine→flog→brand→maim→execution-escape).
    **Systemic hook:** branding/maiming writes a *permanent feature* into your description that the
    recognition engine keys on — unshakeable by clothes.
- **2026-07-09 · R8 opened.** **Player, identity & disguise** (module 06) — the counterpart the
  recognition engine feeds on: appearance model, acquiring/changing disguises, contextual blending,
  disguise tells.
- **2026-07-09 · R8 closed.** Identity & disguise (see `06-identity-disguise.md`) — all recs:
  - Appearance = **layered slots** (headwear/face/torso/legs/feet/accessory) **over hard traits**
    (build/height/gait) + **permanent marks**; concealment → `Unknown` features.
  - Wardrobe = **acquire + carry-limited + change only in cover** (changing in view is witnessable).
  - Blending = **context-sensitive social roles** (right place lowers suspicion & grants access;
    wrong place raises it) — the impersonation on-ramp.
  - Tells = **pierceable** (inspection, wrong behavior, stains/ill-fit, seen donning, personal
    recognition). Disguise beats description-heat, **NOT** personal recognition — the deliberate limit.
- **2026-07-09 · R9 opened.** **Stealing mechanics** (module 07) — the core verbs, the loot model,
  carrying/encumbrance, and where difficulty lives (player vs character skill).
- **2026-07-09 · R9 closed.** Stealing mechanics (see `07-stealing-mechanics.md`):
  - Verbs = **rich contextual verbs + a few minigames**; **sim-time PAUSES during a minigame**
    (never caught mid-pick) — risk moves to the *approach*. Minigames reduce to a deterministic
    recorded outcome for headless replay.
  - Loot = **layered** (coin / traceable valuables / tools / information / big-score) along
    value·traceability·bulk·heat.
  - Carrying = **build BOTH** encumbrance+stashing (default) and free-carry, as a tunable capacity
    knob, to **feel-test**.
  - Skill = **use-based learn-by-doing + gear unlocks**; character skill sets the **minigame's
    difficulty band / what's attemptable**, player execution decides the shot. Softened vision
    non-goal accordingly.
- **2026-07-09 · R10 opened.** **Time & NPC schedules** (module 04) — schedule authoring, time
  control/waiting, day↔night contrast, and how routines react to your crimes.
- **2026-07-09 · R10 closed.** Time & schedules (see `04-time-schedules.md`) — all recs:
  - Clock = **continuous deterministic**, day length a tunable knob.
  - Schedules = **procedural per-NPC** (home/work/habits → location-bound timetable); casing a
    routine = earned, exploitable knowledge.
  - Time control = **wait/sleep/lie-low, world keeps running** (fast-forward the sim; no backward scrub).
  - Day/night = **strong contrast** (night: dark/sparse/curfew/fences-closed; day: crowds/open) →
    case-by-day, strike-by-night emerges.
  - **Reactive world** = routines & patrols respond to crimes (watchful owners, curfews, hired
    watchmen); primary driver of the open-ended run's escalation.
- **2026-07-09 · R11 opened.** **NPC AI & senses** (module 08) — the agent model: behavior-state
  ladder, role differentiation, crime/body reactions, and search intelligence/coordination.
- **2026-07-09 · R11 closed.** NPC AI (see `08-npc-ai.md`) — all recs:
  - Behavior = **alertness ladder** (Routine→Notice→Investigate→Alarm→Pursue/Flee) with **fast-rise,
    slow-decay** to a heightened baseline; legible to the player.
  - Roles = **distinct profiles** (senses·courage·authority·reaction); only guards/investigators can
    lawfully stop-and-search — others must fetch one (exploitable latency).
  - Reactions = **role/courage-dependent** (report/flee/freeze/intervene); shouts raise neighbors;
    a body → alarm+investigation.
  - Search = **coordinated (shared last-seen + description, cover exits) but BEATABLE** (bound by
    module-03 fairness invariants; never omniscient); gives up to a heightened routine.
  - Arbitration: **alertness overrides schedule**, then resumes it on decay.
- **2026-07-09 · R12 opened.** **Economy** (module 09) — loot valuation, the fencing system (hot→cool,
  specialists, traceability), the payoff/greed curve, and what wealth is spent on.
- **2026-07-09 · R12 closed.** Economy (see `09-economy.md`) — all recs:
  - Valuation = **contextual** (base × condition × buyer_fit × coolness × 1/saturation).
  - Fencing = **specialist fences + hot→cool laundering** (fence too soon/wrong buyer → reopens a
    Case; fences remember faces → personal recognition; break items down to launder).
  - Greed curve = **escalating risk / diminishing safety** (tunable) — the numeric spine of the run.
  - Money sinks = **growth (meta) AND in-run survival** (tools, bribes, info, buying off heat/cases).
- **2026-07-09 · R13 opened.** **Presentation, camera & UI** (module 11) — reading the sim in
  large-pixel iso: NPC alertness/your visibility, multi-floor camera/occlusion, deduction
  transparency (learnability), and overall UI philosophy.
- **2026-07-09 · R13 closed.** Presentation (see `11-presentation-ui.md`):
  - Stealth read = **diegetic-first** (posture/`?`/`!`, real GI light/shadow) + minimal cues.
  - Camera = **fixed 2:1 iso + auto dollhouse-reveal** for multi-floor (renderer's biggest new task;
    golden-tested; GLSL↔Metal lockstep).
  - Transparency = diegetic signals **+ a Fallout 1/2-style readable event LOG** (a prose projection
    of the deterministic sim-event stream — real events only, hence fair) **+ a hideout planning board**.
  - UI = **diegetic-first minimalism, pixel-native**.
- **2026-07-09 · R14 opened.** **Milestones & verification** (module 12) — v1 scope line, the build
  order, and per-milestone verification (tests / goldens / clips).
- **2026-07-09 · R14 closed.** Milestones (see `12-milestones-verification.md`) — all recs:
  - v1 = **full core loop; module-10 systems deferred** (v1 = the deduction loop done excellently).
  - Strategy = **thin vertical slice first**, then widen.
  - Risk = **de-risk the three scary unknowns early** (fair generation, multi-floor reveal, deduction
    determinism).
  - **M1 = headless crime→deduction→hunt spine** (deduction-scenario test + clip). Ladder M0–M7 + post-v1.
- **2026-07-09 · SPEC CORE COMPLETE.** 14 rounds. See "Status & next steps" above. Open work:
  spec review pass, module-10 deep-dives, then M0/M1 implementation handoff.
- **2026-07-09 · REVIEW PASS (Fable) — done.** Full-spec consistency review against root
  `CLAUDE.md`, `ARCHITECTURE.md`, `AGENT_LEARNINGS.md`. Findings, all fixed in place:
  1. **(critical)** 05a coupled the renderer's GI to detection — violated the headless boundary
     ("the game must run without the renderer"; GPU floats are machine-local). Fixed: detection
     reads a **deterministic CPU light field in `house-game`**; the GI *visualizes* it (05a, 11);
     perceptual match is an explicit M2 tuning duty.
  2. Minigame sim-time was unspecified (a time-cost window would re-admit "walked in mid-pick") →
     **user choice: INSTANT (≤1 tick), failed attempts emit noise + consume the tool** (07; 04
     notes minigames are not a freeze exception).
  3. Punishment-ladder scope was unspecified → **user choice: per-town ladder, legend-scaled
     entry; marks permanent everywhere** (05c).
  4. "Home base" (02) vs "safehouse" (04/06/11) never reconciled → **user choice: persistent
     lair outside towns + per-run in-town safehouse; lair upgrades empower safehouses** (02, 11).
  5. 02 still said hard-loss = "death or heat saturating, modules 08/09" — stale numbering AND
     contradicted R7's death-only decision → fixed to point at 05c.
  6. Stale pre-renumber module refs in 01-vision (03→04, 06/07→07/08, 05→06); index pillars
     lacked #6; index cell-scale bullet still said "provisional". All fixed.
  7. Forensic traces clarified as **backward-looking evidence only** — no live trail-following
     (upholds R5's rejection of tracking + 05c's broken-trail promise) (05a).
  8. 12 called hashes/goldens "CI-able" — per ARCHITECTURE they're **machine-local gates**; the
     portable CI layer is logical headless assertions. Also added: **replay identity must include
     all sim-affecting knobs** (day length, carry capacity, curve constants → LevelSpec).
  9. v1-vs-module-10 fencing line drawn: module 09 = v1; network *depth* is post-v1 (09).
  10. 02 skills wording harmonized with R9's use-based model; 07 "fence en route" reconciled with
      day-only fence hours.
