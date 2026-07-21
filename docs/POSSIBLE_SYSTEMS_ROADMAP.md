# POSSIBLE SYSTEMS ROADMAP — target systemic-RPG architecture vs Hayflick today

Status: **NON-BINDING** working doc (2026-07-21). `docs/VISION.md` rules; this
only compares an externally-proposed systemic-RPG architecture (KCD2/Fallout-style:
three clocks, crime/memory, GOAP/BT AI, destruction-without-voxels) against the
current `voxel-physics-spike` state and asks what — if anything — moves us closer
without violating the joyful reset. Evidence is from a code map (`sim-core`,
`house-game`, `phys-spike`, `rt-probe`/`rt-viewer`, crack-lab) + the deleted thief
engine in git history.

## Bottom line

The target document is **two architectures stapled together**, with opposite
relationships to this project:

- **Half A — world-simulation / social-AI** (three clocks, fact store,
  crime/memory/reputation, utility→GOAP→BT, quests, schedulers, LOD). We already
  **built this to production quality and deliberately deleted it.** The thief
  deduction engine at `4f8364c^` (= `e6b3182`) is `perception.rs` (403 L) +
  `deduction.rs` (552 L): per-field confidence, severity-scaled *confidence* decay
  (violent stays vivid, trespass cools), second-hand transmission at reduced
  confidence, a `cleared_look` disguise loop, a typed `GameEvent` stream, ~194
  green tests, portable integer hash oracles, 14 interview rounds of design.
  VISION deleted it in one sentence: *"goo-arena, thief/dedukcja brzmiały dobrze
  na papierze, ale były niegrywalne."*
- **Half B — destruction / surface-state / render-bridge** (§5–§9). This **is our
  current trajectory** (phys-spike, crack lab, dynamic GI); for the parts that
  matter the document *describes what we already do*.

So the honest answer to "move us closer to this architecture": **we are already
about as close as we should be for our phase. The remaining distance is closed by
subtraction and discipline, not by building subsystems.** Two small moves close
real distance without re-litigating the reset; everything else is "keep the seam
open, build nothing."

## Three things the document gets wrong *for us*

**1. Scale mismatch — it's calibrated for KCD2, we're building Jagged Alliance.**
The distinctive machinery (three clocks, simulation LOD, offscreen schedules,
~2,400 NPCs) exists to amortize a *large open world*. Owner tastes (Cannon Fodder,
Fallout 1/2, Jagged Alliance, point-n-click, Alien Breed; few games/year, short
sessions) point to **bounded, hand-authored, small-cast** scenes. Direct evidence:
the Faza-0 town testbed reached KCD scale (40k GI probes, 48 lamps), intermittently
blew the Metal GPU watchdog, and was deleted (AGENT_LEARNINGS 2026-07-12).
**Inherit the doc's epistemics — `actual ≠ witnessed ≠ believed ≠ case ≠
reputation`, typed events, CPU authority — not its scale architecture.**

**2. Determinism silence — the doc is quietly incompatible with our spine.** It
never mentions determinism. Every dynamic it prescribes — a "0.2–10 Hz world
clock," GOAP "replan on timeout," "memory decay *over time*" — is a **wall-clock
assumption illegal below our shell** (fixed 60 Hz tick, seeded Pcg32, `state_hash`,
trace replay). Our own deleted engine already solved this: `day_phase()` was
tick-derived, confidence decay was severity-scaled tick counters. The doc's
dynamics are portable only after re-expression as tick-derived seeded state folded
into `state_hash`.

**3. The maturity paradox — code maturity ≠ game maturity.** The pillar we built to
the *highest* maturity (crime/memory) is the one we *deleted*. The pillar the doc
treats as description-not-proposal (CPU-authority / RT-bridge) is worth continued
investment. "It had 194 tests, just restore it" conflates the two: it was deleted
for being unfun, not for being broken.

## Where we actually are, pillar by pillar

Maturity is 0–5 vs the doc; alignment is *"does moving toward it now serve or fight
VISION."*

| Target pillar | We have | Maturity | Verdict |
|---|---|---|---|
| §9 **Semantic on CPU / visual on GPU; GPU derived** | The workspace boundary *is* this: headless `house-game` ⊥ GPU `rt-probe`, joined only by plain-data `FrameState` | **4/5** | ✅ Already embodied — *preserve* |
| §7 **RT: prebuild clusters, transform-only, never rebuild BLAS** | BLAS built once; destruction = TLAS instance-mask + prebuilt zero-scaled brick instances driven by physics transforms | **4/5** | ✅ Accidentally correct — *keep* |
| §2 **Command/event journal** | Tick-stamped `InputQueue` + lossless text trace + `state_hash` replay (bit-exact, *zero* cross-run noise on Vulkan) | **3/5 (command half)** | ✅ We're *ahead* of the doc |
| §5B/§6 **Surface damage field / crack ladder** | Crack lab: 4 CPU knobs → GPU procedural cracks, cheapest normal/roughness tier | **2/5** | ⚠️ Right *plumbing*, cosmetic *semantics*, tier-capped on purpose |
| §5A **Semantic structural object** | None. Wall = pre-decomposed rigid bricks; *no* integrity/stress/connectivity | **1/5** | 🚫 Defer (destruction unadopted) |
| §8 **Gameplay & destruction share events** | Smash is render-only; grid never mutates; player still collides the vanished wall | **1/5** | 🚫 Defer |
| §2 **Typed fact store / blackboard** | Absent. `Events<E>` primitive exists but has **zero call-sites** | **1/5** | 🚫 Defer (it's the deleted thief substrate) |
| §3 **Crime / memory / reputation** | Deleted at `4f8364c` | **1/5 live** (was 5/5) | 🚫 Defer — *the rejected direction* |
| §4 **AI stack (utility/GOAP/HTN/BT)** | Never existed — only an FSM alertness ladder (also deleted) | **0–1/5** | 🚫 Defer — starts from zero |
| §1/§6 **Three clocks + scheduler + LOD** | One 60 Hz tick; no world clock, nothing to schedule/LOD | **1/5** | 🚫 Defer (no content to run) |

Everything worth continued investment, we already have. Everything the doc would
have us build, VISION either just deleted or defers to a Faza-3 design interview
(*"wywiadem, nie kodem"*).

> Irony: the doc opens *"do not build one giant game loop; build several
> simulations connected by typed events… a command+event journal for replays,
> debugging, saves, causality."* We **already have the best version of that** — a
> bit-exact, cross-machine-deterministic tick journal. The only missing piece is
> *domain* events (`WallBreached`, `WitnessSaw`), gated on having a domain = Faza 3.

## The roadmap

Distance to this architecture is closed by **subtraction and discipline**, not by
building subsystems.

### 1. Build now — the two moves that close real distance and pay Faza-2 rent

**(a) Land the render/gameplay clock split via interpolation.** The only legitimate,
legal piece of "three clocks" — and it buys the miodny feel Faza 2 exits on. When
wiring the continuous-mover primitives (`collide_and_slide`, `iso_input_dir` in
`house-game/lib.rs` — pure, tested, currently unwired) into a `Simulation`, route
the authoritative continuous pose through the existing `FrameState.instances`
bridge and **formalize presentation interpolation**: lerp the render-frame pose
between the two bracketing 60 Hz authoritative snapshots. Sim stays
authoritative/deterministic/hashed; presentation interpolates a *derived* pose.
That is §1's render-vs-gameplay split landing cleanly under §9. (Watch the hard
256 B push-constant cap — an interpolation alpha goes in a uniform buffer, not the
push block.)

**(b) In that same mover, collide against grid *edges*, not AABBs.** Walls live on
grid edges with shared storage — one source of truth for mover *and* renderer
(`grid.rs`). `collide_and_slide` already takes a `blocked` closure built to run
against the grid. Keep it that way. This is a movement decision, but it's exactly
what makes future breach-walkability *free*. The anti-move is colliding against
AABBs, which forks the source of truth and closes the destruction seam.

That's the entire "build" list — both are Faza-2 work anyway; the only addition is
doing them with CPU-authority discipline in mind.

### 2. Leave these seams open — zero cost, because they're *already* open

- **Breach → walkable** is one hashable call away: `Grid::set_edge(p, dir, Open)`
  exists with **zero runtime callers**. A future breach is that one line + it flows
  through mover collision and renderer mesh derivation automatically. Don't
  pre-build it.
- **Domain-event bus** has its primitive (`Events<E>`) and its precedent (the old
  `audio_system` mapped `DoorOpened`→cue). When Faza-2 movement genuinely needs a
  presentation cue (footfall, wall-scuff), give `Events<E>` its *first real
  consumer* with a **house-game-local** event type, *outside* `state_hash` exactly
  like the physics spike and cpal audio already do. Validates the systemic seam at
  near-zero cost — only if movement needs the cue. Never wire it speculatively.
- **CPU-authoritative surface state** is already the crack-lab pattern
  (`CrackLab.knobs` on CPU → GPU derives all detail). A future damage field is a
  *data-shape* change, not a plumbing rebuild.

### 3. Preserve now — the one genuinely urgent, near-zero-cost action

**The archive safety net does not exist.** VISION cites `archive/pre-joyful-reset`
and `archive/town-testbed` as the recovery net — but `git tag` is **empty** in this
clone. The ~5/5 crime/memory engine and the entire `docs/spec/` blueprint
(05a/05b/05c crime+memory, 04 schedules, 08 npc-ai, 10 systems catalogue) are
recoverable **only by memorized SHA**. Verified recovery points:

```
git tag archive/pre-joyful-reset 4f8364c^   # = e6b3182, last commit WITH the full thief engine
git tag archive/town-testbed     2c4f4d4^   # = f5d56db, last commit WITH the town
git push origin --tags                       # (optional) so the net survives this machine
```

Grows the sim by nothing, preserves the Faza-3 option, and stops one disk failure
from erasing 194 tests and 14 interview rounds.

### 4. Defer — with the reason, and "restore, don't reinvent"

All of Half A — fact store, crime/memory, AI stack, quests, world clock, scheduler,
LOD — **is deferred to Faza 3, entered by owner design-interview, not
architecture-first code.** Building any of it now inverts VISION's binding order
(aesthetics → feel → gameplay; *"owner musi być zadowolony z każdej warstwy, zanim
powstanie następna"*) and re-opens the rejected direction — before Faza 1 has even
exited (the polana look-lock is the open gate; goldens suspended until it lands).

When Faza 3 arrives and *if* the owner chooses a systemically-reactive direction:
**restore from `4f8364c^`, don't reinvent.** The deleted perception/deduction engine
+ `docs/spec` is a determinism-clean, integer-exact, portable-hash blueprint for
three of the four Half-A pillars. §4 (utility/GOAP/HTN/BT) is the exception — only
an FSM ever existed, so it's genuine greenfield. Anything restored must be
re-expressed as fixed-tick / seeded-Pcg32 / hashed.

### 5. Traps

- **"Destruction is 80% done — just fire a `WallBreached` event."** It looks done
  and even honors §7/§9, but §8's payoff (wake NPCs, relink nav, trespass evidence)
  is worthless without the NPC/nav/perception layer we deleted.
- **"The engine had 194 tests — restore it."** Code maturity ≠ game maturity;
  deleted for being unfun, out of phase order.
- **Growing frozen `sim-core`.** Adding event-journal/fact-store/scheduler to the
  frozen public surface (`public_api_snapshot`) mints more dead framework — the
  unused `Events<E>` / `AudioCue` / hecs surface is the warning. Prove it in
  `house-game`; promote only when a *second* game demands it.
- **Climbing §6's crack ladder** toward vertex displacement / tessellation /
  boolean-cut. Threatens the pixel-perfect wall contract ("world-vertical projects
  screen-vertical"; `Projection::derive` rejects stairs) and doubles GLSL/MSL twin
  cost. Cheapest normal/roughness tier is the ceiling until the look locks.
- **Growing `GymGame.next_move_at` into a scheduler.** The interim mover is to be
  *replaced*, not grown; anything bolted on is dead by design.

## Sequenced against the actual gates

```
NOW (blocking gate)   ── Owner ESC playtest: polana look-lock → un-suspend goldens (Faza 1 exit)
   │  parallel, non-blocking: create the two archive tags (item 3)
   ▼
FAZA 2 (current work) ── Continuous miodny mover replaces the cell-stepper
   │                       • collide against grid EDGES (leaves breach seam open)     [1b]
   │                       • render/gameplay clock split via pose interpolation        [1a]
   │                       • presentation cue via Events<E>, house-game-local, IF feel needs it  [2]
   ▼
OWNER DECISION        ── "Is destructibility a keeper?" (WEEKEND_PLAN open question)
   │                       If promoted → breach = one grid.set_edge call + one authoritative
   │                       edge bit the renderer mask DERIVES from (fixes the one live §9 violation)
   ▼
FAZA 3 (interview)    ── Gameplay discovered by interview. IF systemic/reactive is chosen →
                          restore thief engine + docs/spec from 4f8364c^, re-express deterministic
```

**One live §9 violation to name:** after a wall smash, the only record that the wall
is gone is GPU state (instance mask + mutated probe buffer + viewer bools) — the CPU
grid still says the wall stands. That's the doc's central anti-pattern, live in our
code. The fix is trivial and already seamed (one authoritative edge bit). **Don't
build it now** — just don't accrete *more* GPU-only destruction state, and don't
hardcode more piers into the renderer, so the fix stays a one-liner when
destructibility is promoted.

---

**Net:** distance to this architecture is closed by keeping the CPU/GPU authority
split honest, doing Faza-2 movement with two small disciplines, tagging the archive,
and *refusing* to rebuild the beautiful thing we already proved isn't fun until the
owner's interview asks for it. Inherit the doc's epistemics, not its scale.
