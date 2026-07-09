# 07 · Stealing Mechanics — Verbs, Minigames, Loot, Carrying & Skill

> The Tier-0 core activity: what you actually DO. Must feel excellent on its own, before any
> upper-tier system. Choices locked round 9 (including two deliberate "prototype both / feel-test"
> flags the user called out).

## The verb set & interaction model (locked — contextual verbs + a few time-frozen minigames)

- **Rich, context-sensitive verbs**, surfaced by what you're near: sneak-move, pickpocket, pick
  lock, force (door/window/lock), climb (drainpipe/trellis/crates → window), grab & carry, stash,
  hide (in cover / container / shadow), douse a light, choke/knock-out, kill, move/hide a body,
  eavesdrop, case (study a target/schedule), plant/drop (evidence), clean (a trace).
- **Mostly flow-state:** most verbs resolve from *situation* — your position, timing, LOS/sound
  state, tool, and skill — with no menu, keeping you in the world watching the guard.
- **A FEW signature MINIGAMES** (lockpicking, safecracking, maybe a delicate pickpocket) — and
  **during a minigame sim-time is PAUSED.** No guard can walk in on you mid-pick (user's explicit call).
  - *Design consequence:* the risk of these actions lives in the **approach** — reaching the lock
    unseen and holding a defensible spot — not in real-time vulnerability during the fiddle. Balance
    the minigames as pure skill/puzzle beats; make *reaching* them the tense part.
  - *Sim-time cost — INSTANT (review-pass resolution):* the attempt resolves **at the tick it
    starts (≤ 1 tick)**. No exposure window exists, so nobody can *ever* arrive mid-fiddle — the
    purest reading of the "world is stopped" intent. The absent clock-pressure is compensated:
    **failed attempts emit noise at that tick** (a snapped pick clatters — a heard `Observation`,
    05a) **and consume the pick/tool.**
  - *Determinism:* the pause is a **presentation / real-time-input** layer only. A minigame commits
    a single deterministic **outcome** (success + quality + noise-on-fail) as a command at its
    tick. In headless/trace replay there is no interactive minigame — the trace records the
    outcome, so `state_hash` and goldens are unaffected.

## Loot model (locked — layered, with real tradeoffs)

Loot differs along **value / traceability / bulk / heat**:

- **Coin** — safe, fungible, low value-per-bulk. The baseline.
- **Portable valuables** (jewelry, plate, art) — high value but often **distinctive & traceable**: a
  described unique piece is *evidence* (05) that must be **fenced and left to cool** (module 09), and
  fencing it too fast / to the wrong buyer points back at you.
- **Tools & consumables** — lockpicks, chloroform, a glass-cutter, oil, disguise pieces.
- **Information** — documents, letters, ledgers, overheard secrets: fuel for **blackmail,
  impersonation (papers), and forgery** (module 10). Stealing *knowledge*, not just goods.
- **Unique big-score items** — the opt-in high-value targets (module 02); hottest of all.

## Carrying & extraction (locked — BUILD BOTH, feel-test)

User wants to **prototype both** encumbrance and free-carry and compare game feel:

- **Primary model — encumbrance + stashing:** carry limited by weight/bulk; heavy/bulky loot slows
  you, fills space, may rattle/print. You **stage caches, make trips, or fence en route** (fences
  trade by day, 04/09 — overnight hauls must be held or cached, which is part of the loop). The
  greed curve made physical — the richest score is the hardest to walk out with.
- **Comparison model — free/abstract carry:** no meaningful limit.
- **Implementation:** carry capacity is a **single tunable parameter** (∞ = free-carry). Ship with
  encumbrance ON as the intended feel, but keep the knob to **A/B the feel via playtest** (fits the
  repo's clip/feel-polish practice). Determinism is unaffected — capacity is config.

## Skill & progression (locked — use-based growth + gear unlocks, married to the minigames)

User loves **learn-by-doing** (get better at climbing by climbing, at pickpocketing by
pickpocketing) **and** gear-based unlocks. Synthesis:

- **Use-based skills.** Each activity has a skill that grows by **doing it** (deterministic
  XP-by-use). Skills are part of the **persistent thief** (meta-progression, module 02) — a
  career-long climb, not reset per run.
- **What skill does — access & technique, not blind hit-%.** A skill sets the **difficulty band**:
  it gates *which* targets you can attempt (a novice can't touch a master lock), unlocks new
  *techniques*, and modestly widens tolerance / reduces fumble. It must not silently inflate a
  to-hit number in a vacuum.
- **The marriage with minigames.** Your **character skill sets the minigame's parameters**
  (difficulty, tolerance, whether a trivial lock auto-opens or a master lock is even attemptable);
  your **player execution within those parameters** decides the outcome. Stat = the band; you = the
  shot within it. Gear/tools **shift the band or unlock verbs** (a fine pick widens tolerance; a
  glass-cutter adds a silent entry).
- **Result:** early runs feel *challenging-because-of-you* (you can attempt things, you just have to
  be good), while long-term growth is felt as **new options and eased friction**, not stat-gate
  walls.

## Determinism

Every verb, skill-XP gain, difficulty-band selection, and minigame outcome is deterministic over
seeded sim state; interactive minigames exist only in the live client and always reduce to a recorded
outcome for headless replay and goldens.
