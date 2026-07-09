# 05c · Crown Jewel, Part 3 — Confrontation & Counterplay

> Closes the loop: the town perceives (05a), remembers & deduces (05b), and here it ACTS on you —
> and you push back. All choices locked round 7.

## The confrontation ladder (locked — graded social stop)

Scrutiny (05b) drives a *staged* encounter, not an instant arrest:

1. **Notice → approach.** A guard whose scrutiny crosses a threshold breaks off to approach and
   question — the tense stop-and-search moment.
2. **The stop — your outs** (each with consequences that feed the engine):
   - **Bluff / lie** — a cover story; success depends on your standing, the strength of the
     evidence behind the description, and consistency with what they already know. A *caught* lie
     escalates hard.
   - **Papers** — show identity/passage papers, real or **forged** (module 10). Good papers can
     end the stop; a bad forgery under scrutiny is damning.
   - **Bribe** — pay them off on the spot; a corruptible guard takes it — but that's leverage
     against *them* later, and a fact someone might witness.
   - **Submit to search** — bet you're clean (loot stashed or fenced, tools hidden). **A clean
     search can positively CLEAR you from a description** (strong relief); a dirty one is caught
     red-handed.
   - **Distract / flee / fight** — make an opening, run, or (costly) fight. **Fleeing all but
     confirms guilt** — spikes the Case, converts the stop to pursuit, and usually burns the
     description you're wearing.
3. **Escalation:** a failed or hostile stop → **search** → **detain** → **pursuit** if you break
   away.

## Cooling description-heat (locked — passive decay + active laundering)

- **Passive:** a wanted profile goes **cold over time / once you leave its district**, *if not
  reinforced* by fresh sightings or a standing notice.
- **Active laundering:** change your look to stop matching; establish a **visible alibi & a
  legitimate routine** (be seen being boring); **muddy the description** — get others seen in
  similar garb, or seed a competing rumor (module 10). Skilful heat-management, not just waiting.

## Defusing the sticky stuff (locked — full underworld toolkit)

Against an NPC with **personal recognition** of you, or an **investigator's open Case**:

- **Avoid / wait out** — stay clear until it decays (slowest, safest).
- **Bribe** — buy silence or a lost report.
- **Blackmail** — leverage a secret (learned via theft/eavesdropping) to compel silence or help.
- **Discredit** — frame them so their testimony is worthless (module 10).
- **Misdirect the investigator** — feed the Case a patsy so it *closes on someone else.*
- **Eliminate** — last, costly resort; a body is the loudest evidence (05a) and spikes heat.

These are the same social-warfare systems (module 10) turned against the deduction engine.

## The failure floor (locked — death only; captures escalate)

- **You can always attempt escape**, so a run truly ends only on **death.**
- **Repeated captures/convictions ratchet a punishment ladder:** fine → flogging → **branding** →
  **maiming** → an **execution you must escape.**
- **Ladder scope — per-town, legend-scaled entry (review-pass resolution).** Each town escalates
  only through **its own convictions** of you; but a town that has *connected you to your cross-run
  legend* (notoriety, module 02) **enters the ladder harsher** — a famous ghost-thief isn't fined,
  he's flogged. Marks are permanent to your body across all future runs regardless of where they
  were earned.
- **Systemic hook — punishment writes to your description.** Branding and maiming add a *permanent
  distinctive feature* (a brand, a cropped ear, a limp) to your `AppearanceDescription` that the
  **recognition engine now keys on** — a mark you *cannot* shed by changing clothes, only hide
  (gloves, a hood) or work around. Capture has lasting, systemic teeth without a cheap game-over.

## Pursuit & escape (brief; detail later)

Fleeing starts a **chase**: guards pursue on last-known-position plus the spreading alarm. You
break it by **breaking line-of-sight and hearing**, gaining distance, and going to ground (a hiding
spot, a multi-floor building, a crowd, a disguise-change in cover). No scent/track sense exists
(round 5), so a *broken trail is genuinely broken* — but every witness to the chase is a fresh
`Observation`.

## Determinism

The stop's checks, escalation thresholds, decay, and pursuit are deterministic over sim state; any
randomness (a guard's corruptibility, a bluff outcome) is seeded from `LevelSpec.seed`.
