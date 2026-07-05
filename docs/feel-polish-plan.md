# Feel & Differentiation Polish Plan (2026-07-05)

Continuation of the M5.x game-feel rounds (docs/AGENT_LEARNINGS.md M5–M5.7).
Companion to docs/gameplay-directions.md (the WARDEN/DRAIN direction) and
docs/goo-mob-handoff.md (systems inventory). Everything below is polish on
SHIPPED systems — no new weapons, no new species, no engine work (the
directions doc's "refuse new content" rule stands).

## The determinism cost model (read first)

Every item below is tagged with its cheapest safe implementation lane:

- **[SHELL]** — presentation-only in rt-viewer (tick_fx / instance pools /
  spotlights / audio / HUD). Zero sim impact, zero oracle risk, goldens
  can't move (mob-free scenes carry none of it). Cheapest lane; prefer it.
- **[ARENA-SIM]** — hashed sim change gated on `res.arsenal`/`spec.arena`
  (the M1–M5 pattern). Goo oracles + cave replay + goldens untouched by
  construction. Needs a headless trace test.
- **[KIND-SIM]** — sim change gated on `kind != Green` (species branch).
  The four goo oracles are all-Green, so they stand untouched. Needs a
  kind-specific behavior test.
- **[TUNE]** — pure WeaponSpec/const retune. Hashes move only on arena
  levels (not oracle-pinned); zero code risk, pure playtest iteration.

## 1. Weapon weight

The five weapons differ in ballistics but share one recoil kick, one
muzzle pop, one shake formula scaled per class, and near-identical tracer
language. Weight = the body of the gun, not its numbers.

- **W1. Per-weapon recoil profile [SHELL]** — replace the single `recoil`
  scalar with per-class (kick_px, recover_rate, pitch): slug = deep kick,
  slow ~20-tick recover (the gun REMEMBERS the shot through the cooldown);
  uzi = 2px jitter, instant recover; shotgun = biggest single kick + a
  1-tick whole-gun-ring shove; harpoon = sharp linear slide-back on the
  rail; grenade = vertical toss bob, no back-kick.
- **W2. Shotgun self-knockback [ARENA-SIM]** — firing shoves the droid
  back ~6 screen-px along −aim through the existing `walk_vel_px` momentum
  channel (it already hashes under the arena gate). Newton for free:
  point-blank volleys reposition you. Also the first weapon FELT in the
  legs, not the hands.
- **W3. Weapon raise/swap time [ARENA-SIM]** — selecting a slot arms a
  ~12-tick raise before the gun can fire (cooldown component already
  shared; extend it on swap). Shell lerps the gun ring up during it.
  Kills swap-scumming AND gives each pull-out a moment of mass.
- **W4. Per-weapon muzzle signature [SHELL]** — the M5.6 downward pop is
  one shape for all five. Differentiate: slug = single big warm pop +
  brief barrel-glow decay on the gun; uzi = small strobe (alternating
  2-tick pops); shotgun = wide short fan flash; harpoon = cyan rail
  streak (line of emissive motes along the first 1.5 wu); grenade = no
  flash, launcher thunk + a faint smoke mote.
- **W5. Hit-side weight scaling [SHELL]** — spark count / droplet burst /
  impact-flash power already exist; scale them by the projectile's
  knockback so slug impacts visibly OUTRANK uzi ticks (6 sparks vs 2,
  flash power ×2). The fluid already carries the physics; the light
  should agree.
- **W6. Micro-hitstop on slug hits [SHELL]** — hitstop currently fires on
  kill/solidify/detonate only. Add 1–2 frames on a surviving SLUG hit
  (`MobHit` where class==Slug). The heaviest round should chunk time.
- **W7. Low-freq audio layer [SHELL]** — one shared sub-thud voice mixed
  under every fire cue, gain ∝ weapon damage (slug/grenade boom the
  chest, uzi barely tickles it). audio.rs voices are code-generated;
  this is a ~20-line voice.

## 2. Weapon differentiation (role clarity)

Ballistics already differ well (12 vs 30 wu/s, arcs, fans). What's missing
is READ-AT-A-GLANCE identity and the reasons to switch mid-wave.

- **D1. Tracer identity [SHELL]** — per-class tracer tint + shape:
  slug fat amber bolt, uzi thin white needle, shotgun 7 short orange
  sparks, grenade matte shell w/ blinking fuse glow (blink accelerates
  as max_age approaches — bank shots become readable timers), harpoon
  cyan line w/ trailing wire glint.
- **D2. Teach the Tank resist [SHELL]** — resisted hits (Tank vs
  uzi/shotgun: damage floored to 1–2) currently flash the same hot white
  as real hits. Give resisted hits a grey/dim flash + a dull "thunk" cue
  variant. The player learns ×¼ from the color, not the wiki.
- **D3. Cure-stack legibility [SHELL]** — `MobRender.cure` already
  crosses the boundary; render stiffening: per-stack desaturate + slow
  the gait-driven wobble (vscale/glow channels exist). At CHUNK
  threshold −1, a crackle shimmer = "one more slug solidifies it".
  Makes the slug's whole strategic identity visible.
- **D4. Harpoon pin telegraph [SHELL]** — pinned blobs (`Goo.pinned`
  hashes; expose pin ticks remaining in MobRender) get a visible bolt
  prim at pin_pt + strained stretch toward escape dir + a countdown
  flicker in the last second. Sets up slug follow-up shots explicitly.
- **D5. Grenade fuse + bounce audio [SHELL]** — bounce cue per Solid
  bounce (restitution arm already distinguishes), fuse hiss pitch rising
  through max_age. The geometry weapon becomes an instrument.
- **D6. Spec retunes worth testing [TUNE]** — uzi bloom 0.055→0.075
  (sharpen the planted-vs-moving skill gap now that aim is turret-driven);
  shotgun pellets 7→9 with damage 2→1 + knockback 5→6 (more WALL, less
  delete); slug muzzle_speed 12→11 (lead it even harder). One knob per
  playtest, seeds pinned.

## 3. Goo species differentiation

Multipliers exist (Runner 1.6/2.5/3.0, Tank 0.6/0.7 + resists) and
doctrine differs (flank / ambush / anchor), but all three SPECIES share
one body language, one gait, one light personality. Species should read
in silhouette + motion before tint.

- **G1. Per-kind body language [SHELL]** — vscale/squash are presentation
  channels: Tank squat + wide (vscale ~0.8, +8% radius), Runner lean +
  tall with a forward tilt while sprinting (vscale ~1.15), Green
  baseline. Zero sim risk, biggest identity payoff per line.
- **G2. Per-kind gait period [KIND-SIM]** — Runner gait_phase cycles
  ~40% faster (twitchy inchworm), Tank ~30% slower with a longer bunch
  (ominous heave). Kind-gated branch in the gait clock; all-Green
  oracles stand.
- **G3. Runner sprint anticipation [KIND-SIM]** — 10-tick pre-sprint
  bunch (spine compress) before the tactics Sprint state fires, plus a
  [SHELL] rising two-note cue. The fastest threat becomes the most
  readable — the roguelite contract from the directions doc.
- **G4. Per-tier/kind viscosity [KIND-SIM]** — the handoff's proposal #2:
  Smalls runnier (splashier under fire), Tanks thick (barely ripple
  under uzi — reinforces D2's resist lesson through the fluid itself).
- **G5. Light personality [SHELL]** — goo_lights: Runner light flickers
  agitated ∝ speed; Tank deep steady slow-breathing glow; Green baseline.
  In the blackout act the species read by their GLOW behavior — light as
  gameplay, again.
- **G6. Per-kind splat/step audio [SHELL]** — slither loop pitch by tier,
  timbre by kind (Runner wet-fast, Tank tar-slow).

## 4. The level (arena + drain)

Both pits are correct but mute: flat light, identical walls, quiet floor.

- **L1. Wave landing telegraph [ARENA-SIM + SHELL]** — 60 ticks before a
  squad lands, emit `WaveIncoming(ring_slots)`; shell pulses the three
  entrance-ring pads amber→red + klaxon swell. The lull gets a countdown
  the body can feel (draft-pick urgency, repositioning play).
- **L2. Drain current [SHELL]** — the drain zone should VISIBLY pull:
  slow-scroll emissive strip decals pointing at the sieve slots +
  positional gurgle loop from the drain rect + LEAK-meter red wash on
  the strips past half. Sells "the goo wants OUT" without a sim change.
- **L3. Sieve slots as gates [SHELL — game_scene]** — the three slot
  widths are the drain game's grammar but render as wall gaps. Add
  grate-bar prims over each slot (non-colliding, purely visual) sized to
  the slot class: slit = 3 thin bars, slot = 2, main = one broken bar.
  Squeeze-through stays physical; the reading becomes instant.
- **L4. Low cover tier [ARENA-SIM]** — authored knee-high solids via a
  `low_solids` spec field reusing the CHUNK height band (blocks goo +
  low shots, muzzle-height shots fly over). The player gains shoot-over
  cover the goo must flow around; chunk masonry gets architectural
  precedent. One field + one occluder chain extension, chunk tests
  already cover the height-band logic.
- **L5. Light zoning [SHELL — game_scene]** — corner service lamps +
  dimmer mid-field on the arena (risk gradient toward the middle);
  drain end lit cold-cyan, player end warm — orientation at a glance in
  rotation and blackout.
- **L6. Kill confirmation → BIO [SHELL]** — on terminal kill/solidify,
  2–3 biomass motes fly from the death point to the HUD BIO counter +
  counter blip. The economy becomes something you SEE feed.

## 5. Suggested order

- **P0 (one session, all [SHELL]/[TUNE]):** W1 W4 W5 D1 D2 G1 G5 — the
  per-weapon/per-kind identity pass. Biggest feel delta, zero sim risk,
  one DEMO clip verifies all of it.
- **P1 (one session each):** W2+W3 (arena-sim weight trio + trace
  tests), G2+G3+G4 (species motion pass + kind tests), L1+L2+L3 (the
  drain stage dressing + telegraph).
- **P2:** W6 W7 D3 D4 D5 L4 L5 L6 D6 — layered once P0/P1 prove out in
  playtests.

Verification per CLAUDE.md: cargo test + goldens for every step; a
record-gameplay clip for anything visible in motion; goo-render changes
diffed via SCENE=goonursery SHOT frames. [ARENA-SIM]/[KIND-SIM] items
land with headless trace tests; the four goo oracles are never
recaptured for polish (if one moves, the change leaked outside its gate).
