# 05b · Crown Jewel, Part 2 — Memory, Propagation & Deduction

> How the `Observation`s from 05a become the town's evolving knowledge and a case against you.
> All choices locked round 6 — the deepest, most emergent option throughout.

## Where knowledge lives — per-NPC memory, emergent case file (locked)

- **Ground truth is per-NPC.** Every NPC owns a memory: the `Observation`s they personally
  perceived, plus ones heard secondhand (tagged reduced confidence + a source).
- **No global omniscience.** What "the town knows" is the union of individual memories —
  always partial, delayed, uneven.
- **The guards' case file is DERIVED**, not primary. It's the aggregate that forms as reports
  reach the authorities; it's what patrols act on, but it lags the true event and can be wrong.
- **Consequence — race the rumor.** A witness who saw you but hasn't yet reported or gossiped is
  a live opportunity: outrun the word, leave the district, or (darkly) make sure they never talk.

## Propagation — gossip + reporting + notices, with latency & distortion (locked)

Knowledge moves along channels, each with delay and fidelity loss:

- **Gossip.** NPCs share memories during social contact, weighted by relationship/proximity.
  Spreads slowly; distorts most.
- **Reporting.** A witness travels to and informs a guard/authority — the main path by which a
  crime becomes "official." Costs the witness time and intent (they must choose to, and get there).
- **Briefing.** Guards propagate to each other and to patrols; feeds the case file.
- **Public broadcast.** Criers and wanted-posters push a *description* to everyone in range — the
  town-wide APB. Keeps a profile alive even as individual memories fade.
- **Latency** = your exploit window (act between the sighting and the report).
- **Distortion** = descriptions mutate/degrade as they pass (telephone effect): confidence
  decays, features drop to `Unknown` or flip. This can save you — or be *seeded deliberately*
  (module 10 framing plants a false detail that then spreads as fact).

## Deduction — correlation engine + investigator NPCs (locked)

- **Correlation engine (substrate).** Clusters `Observation`s sharing subject-features and
  spatiotemporal proximity into a **Case**: an aggregated suspect-profile (a merged
  `AppearanceDescription`) + linked events + a rising **confidence**. "Casing at dusk" ⊕
  "robbery overnight" ⊕ "matching hood" → *one suspect the town now hunts.* Systemic, not
  scripted — the KCD2 dot-connect, generalized.
- **Investigator NPC (serious crimes).** A thief-taker/constable is dispatched for high-salience
  cases and actively *gathers*: walks to the scene (emitting discovery `Observation`s), questions
  witnesses (pulling their memories into the case file), canvasses the neighbourhood. A visible,
  physical agent of the deduction engine — someone you can **surveil, mislead, intercept, bribe,
  blackmail, or (last resort) eliminate.** Their progress *is* the case's clock.

## The suspicion state you manage — description-heat + personal recognition (locked)

Two layered kinds of "the town is onto you":

1. **Description-heat (shakeable).** Heat attaches to **wanted profiles** (description + severity
   + confidence), not to an abstract "player." When a person matching a live profile is seen, they
   draw scrutiny ∝ (match strength × profile confidence × severity). **Shed the matched features**
   — change coat, ditch the mask, drop the sack — and *your* exposure collapses, even though the
   profile still hangs in the world on "someone who looked like that." This is the disguise loop's
   payoff.
2. **Personal recognition (sticky).** An NPC who got a strong personal read — a long look, repeated
   dealings, an interrogation — binds to *you as an individual*, clothes notwithstanding. A new
   coat won't fool them. Undoing it needs other means: avoid them, leave town, or lean on them.
   Personal recognitions are the expensive, dangerous debts.

- **Decay & reinforcement.** Memories and heat **fade over time** (confidence erodes, low-salience
  notices forgotten) unless reinforced by fresh sightings, an open case, or a standing notice.
  High-salience crimes (a body, a big score) decay far slower.

## How the other systems plug in (forward links)

- **Disguise (06):** mutates your live feature-vector to stop matching profiles (attacks layer 1).
- **Framing/misdirection (10):** writes false `Observation`s / plants evidence to spawn or redirect
  a Case onto someone else (attacks the engine's inputs).
- **Impersonation (10):** presents a matching-but-legitimate identity so scrutiny resolves *for* you.
- **Blackmail/bribery (10):** corrupts witnesses and officials — suppress a report, alter a memory,
  close a case, defuse a personal recognition.

## Determinism

Memory, propagation, correlation, and heat are all deterministic functions over sim state at a tick.
Correlation clustering must be **order-stable** (fixed iteration order over NPCs/events) with any
tie-break seeded from `LevelSpec.seed`. This engine is `state_hash`-oracle territory: replaying the
same trace must reproduce the same Cases and heat bit-for-bit.
