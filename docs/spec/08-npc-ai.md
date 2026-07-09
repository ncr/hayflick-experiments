# 08 · NPC AI & Senses

> The agent decision model that ties perception (05a), memory (05b), and schedules (04) into
> behavior. Senses themselves are specified in 05a; this module is how NPCs ACT on them.
> All choices locked round 11.

## The behavior ladder (locked — layered alertness with decay)

Each NPC runs a **general alertness ladder** on top of their schedule:

    Routine → Notice → Investigate → Alarm → Pursue (guard-ish) / Flee (civilian-ish)

- **Routine:** follow the schedule (04); ambient perception only.
- **Notice:** a low-confidence stimulus (a half-heard sound, a glimpse) — pause, look, raise guard.
  The player-readable "hmm?" beat.
- **Investigate:** move toward the stimulus' `where` and inspect. May resolve up (a sighting) or
  down (nothing found).
- **Alarm:** confirmed threat/crime — shout (raises neighbors via sound, 05a), then role-branch.
- **Pursue / Flee:** guards & the brave pursue; civilians flee to report or freeze.
- **Decay:** alertness **falls over time** when stimulus fades — but a checked-out scare settles to a
  *heightened* baseline, not full oblivion. **Rising is fast, falling is slow.**
- Alertness is **per-NPC and legible** — the player can read an NPC climbing or relaxing the ladder;
  that feedback IS the core stealth loop.

## Role profiles (locked — distinct kinds of people)

Roles differ across four axes: **sense acuity · courage · authority · reaction tendency.**

| Role          | Senses         | Courage | Authority (stop/search) | Tends to |
|---------------|----------------|---------|-------------------------|----------|
| Watch/Guard   | high, scanning | high    | yes                     | confront, pursue, search |
| Investigator  | high, focused  | high    | yes (+ runs Cases, 05b) | gather, question, track |
| Shopkeeper    | medium         | medium  | no                      | protect goods, shout, report |
| Noble         | low–med        | low     | commands guards         | flee, summon, demand |
| Fence         | medium         | —       | no (illegal themselves) | deal quietly, remember faces |
| Civilian      | medium         | low     | no                      | witness, gossip, report |
| Beggar/Drunk  | low            | low     | no                      | oblivious; bribable eyes |
| Child         | medium         | low     | no                      | notice, tell an adult |

(Illustrative — final roster/tuning in a detail pass.) **Authority matters:** only guards/
investigators lawfully stop and search you; others must *fetch* one, which is latency you exploit.

## Reactions to crime, bodies & evidence (locked — role- & courage-dependent)

- Witnessing a crime emits a **high-salience `Observation`** and forces a decision: **report now,
  flee, freeze, look away, or (brave) intervene** — weighted by role/courage and the odds.
- A **shout** propagates as loud sound (05a), pulling nearby NPCs up the ladder toward the source.
- Finding a **body** is maximal salience → immediate **Alarm** + summons an **investigation** (05b).
- Discovering **evidence** (a forced door, a dropped tool) emits an `Observation` and usually bumps
  the finder to **Investigate/Alarm** and toward reporting.

## Search AI (locked — coordinated, believable, BEATABLE)

When guards actively hunt:

- They **share last-known-position and the case description**, **search likely hiding spots**,
  **cover exits**, and **spread out** rather than clumping.
- After a **timeout with no contact** they **give up** and return to a **heightened routine** (extra
  patrols, jumpier) — not full calm.
- **Fairness is a hard constraint:** search is bound by the generation invariants (module 03) — a
  broken trail is *always* escapable with good play. Guards are **never omniscient**; they act only
  on shared `Observation`s. Smart enough to respect, fair enough to beat.

## The agent tick — arbitration

Each tick an NPC picks behavior by **priority: alertness state overrides schedule** — a pursuing
guard abandons his patrol; when alertness decays he **resumes his schedule** from where it now is.
This single rule blends the living world (04) and the hunt (05) without special-casing.

## Determinism

Ladder transitions, role reactions, target selection, and search coordination are **order-stable,
seeded** functions of shared sim state; replaying a trace reproduces identical NPC behavior. This is
`state_hash`-oracle territory.
