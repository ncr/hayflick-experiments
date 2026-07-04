# Gameplay Directions — analysis & plan (2026-07-04)

Four independent design proposals (judge-panel workflow, one designer per
angle), synthesized against the codebase as it stands on the `rust` branch.
Companion to `docs/goo-mob-handoff.md` (systems inventory).

## What we actually have, stated as design assets

1. **Readable-mind enemies.** Thinking bubbles + telegraphed comm pacts mean
   every threat is pre-announced. Deaths can always be the player's fault —
   the roguelite contract — and counterplay design (interrupt the SYNC pair,
   punish the PEEK) is possible in a way hidden-state AI never allows.
2. **Conserved-mass enemies.** Shooting splits (more, weaker, faster);
   touching merges (fewer, stronger); mothers bud on a 3.3 s clock. The enemy
   population is an ecosystem, not a spawner: neglect = growth, spray =
   fragmentation chaos, slug discipline = permanent removal. This is a
   resource system that already ships.
3. **Fluid vs geometry.** Real PBF squeezing makes gap width a time-cost dial
   (squeeze slots are interceptable choke points); cure-solidify turns kills
   into permanent terrain (chunks block walking + low shots — for BOTH sides,
   as the squeeze film accidentally proved when a Small took cover behind its
   parent's corpse).
4. **Light as gameplay.** Every blob is a real ray-traced light with soft
   shadows; room lights can die; the flashlight exists. "The horde
   illuminates its own ambush" is physics here, not a scripted vignette.
5. **Determinism.** Every run is a trace; every trace renders to MP4. Daily
   seeds, death reels, and shareable clips are nearly free.

**The gap:** no fail state (the completed rush ends in a harmless hug), no
economy sink, no session arc, and **no audio at all** (`AudioSink` is a
stub — the single cheapest juice lever in the codebase).

## The four proposals (full JSON in the panel output; summarized)

### A. THE WARDEN PIT — biomass-economy arena roguelite
Devil-Daggers-compression on the existing pit. **Integrity bar** drained by
contact (tier-scaled; the engulf is the death animation we already render).
**Biomass** as the one currency — paid only when mass leaves the board
(Small dies = 1×, cure-solidify = 2× since it also removes the escapee).
**Mutation draft** in the existing wave lull: 3 deterministic cards
(hash(seed, wave)), pure WeaponSpec/droid data deltas, picked as traced ops.
**Cure-sculpting** elevated to the signature layer (chunks join `pick_cover`
so the horde uses your terrain against you; per-run chunk cap).
**Lights-out** as third-act texture. **Death reel** auto-MP4.
Avoids: proc arenas, new species/weapons, metaprogression, servers.
*M1 "It can kill you" is days-sized and the cheapest falsification of the
whole combat loop.*

### B. THE LAST LIT HOUSE — infestation campaign
The dormant proc buildings + survival + darkness are the treasure. Clear
infested floorplans room by room; cleared rooms **relight** (diegetic
progress; minimap shades dark/contested/lit). **Integrity** as a third
survival meter (hunger/battery pattern). Infestation **spreads** to adjacent
rooms if unchecked (budding = growth clock). Campaign arc: home (tutorial)
→ hospital (Runner corridors) → factory (Tank dark). Scouting dark rooms by
goo-glow bleed under the door is the signature image.
Risks: NavField scale on full floors; light-slot caps; the most new surface
area of the four.

### C. WARDEN: HOLD THE DRAIN — the goo is a flood, not a horde
The boldest re-read of "no fail state": **the goo doesn't want you, it wants
OUT.** A drain grate with tier-gated slots; goo that escapes fills a breach
meter — that's the loss condition, no player HP at all. Weapons become
routing tools: herd-to-merge (upcycle leaky Smalls into a jamming Medium),
**cure masonry** (seal a slot with a corpse placed exactly right), harpoon
pins, deployable gravity well during the lull. Engulf = a 2 s pin that costs
time, not life. Avoids: HP, buildings, new anything.
Risks: two attractors (drain + player) may hollow the tactics brain;
turtling; every mechanic touches hashed sim state (oracle churn).

### D. GLOWHERD — goo ranching in the dark (contrarian)
Inverts the premise: the goo is the only light left, and **being caught is
the capture mechanic** — a completed rush imprints the blob into your herd;
herd size = view radius. Wild goo steals livestock via merge; slug-culling
fortifies doorways (cure masonry again); pen a mother and ranch her buds.
The most charming and most shareable; the highest tuning risk; explicitly
designed to be killed cheaply if herding tests worse than shooting.

## What the convergence says (stronger signal than any one pitch)

Independently, all four proposals:
- **Anchor on the engulf moment** — as death animation (A), death scene (B),
  time-theft pin (C), or capture (D). The "harmless hug" is unanimously the
  fulcrum of the design; the disagreement is only about what it costs.
- **Elevate cure masonry** — solidify-as-terrain appears in all four as a
  signature strategic layer. This is the most under-exploited shipped
  mechanic in the game.
- **Treat mass conservation as the economy** (A, C, D explicitly).
- **Use lights-out + goo-glow** as a core texture (A, B, D).
- **Refuse new weapons, new species, and engine work.** The verbs exist;
  the game is missing consequences, not content.
- **Lean on determinism for the social loop** (death reels, daily seeds,
  auto-MP4) — no servers.

## Recommendation

**Trunk: THE WARDEN PIT.** It is the shortest path to "a game that can be
lost," its M1 falsifies the core combat question in days, and everything it
builds (integrity, biomass, cure-sculpting, lights-out, death reel) is
load-bearing for B later — the infested house is "the pit, roomified."

**Graft from C:** the drain grate is too good to lose. Build it as a second
arena variant once the Pit's M1 proves combat (both are pure LevelSpec data;
A/B-testing stage types is cheap). If the breach meter outplays the
integrity bar, the trunk can pivot without waste.

**Park D** as a one-card experiment later (a "tame the next rush" draft
card), exactly as its own proposal suggests — killable cheaply.

**Cross-cutting, before or during M2: audio.** Every proposal ignored it;
none of them work without it. `AudioSink` already carries cues through the
deterministic sim — a minimal backend (even 8-bit blips for shot / splash /
split / pact-blink / engulf) is the largest single perceived-quality jump
available per hour spent. The pact blink NEEDS a sound.

## Proposed milestones

- **M1 — It can kill you (days).** Integrity bar (arena-gated hashed fields,
  the tactics.rs pattern; oracles untouched): tier-scaled contact drain off
  the existing `goo_solid` overlap, engulf = fast drain + the existing
  visual, droid contact-nudge knockback, death → run-summary stamps (wave /
  biomass / ticks) → keypress restart. Biomass counter (Small death = tier
  chain ×1, solidify ×2). Headless trace test pinning a scripted death tick.
  *Proves: is dodging pre-announced fluid attacks tense? If no — stop here.*
- **M2 — The draft + the sound (≈1 week).** Wave-lull mutation cards
  (deterministic, traced picks, WeaponSpec deltas + bane cards), wave
  composition tables, chunk-as-cover registration + chunk cap, minimal audio
  backend wired to existing GameEvents.
- **M3 — Third act (≈1 week).** Lights-out escalation event, death reel
  (auto-save trace, render last 20 s on demand), run summary polish, daily
  seed display. First A/B: the drain-grate arena variant from C.
- **M4 — decision gate.** Pit is fun → ship it tight, then roomify (B).
  Pit is flat → the breach meter (C) or the inversion (D) are the pivots,
  both already specced.

## Standing constraints (unchanged by any direction)

Arena-gated hashed fields only (the four goo oracles stay green without
recapture); mob-free goldens byte-identical; all randomness id-hashed or
Pcg32; every feature lands with a headless trace test; renderer-visible
changes verified by SHOT/DEMO capture.
