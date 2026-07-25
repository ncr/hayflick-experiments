# Procedural greybox aging — the 2026-07-25 owner round (plan)

Owner brief (2026-07-25, voice): the direction is **procedural shaders +
geometry on greyboxes** — flat boxes get cracks, scuffs, wear. Because the
render target is LOW-RES, every detail must be BIG enough to resolve and to
let the GI read it. Cracks are "reasonably readable" now; three asks, in
order, and NOT all at once:

1. **The crack ALGORITHM** (mesh deformation): cracks must read like
   LIGHTNING — branching, irregular — not straight/smooth lines. Two kinds:
   the coarse structural break (a wall cracked in half) and the fine
   age crazing. Both must get better.
2. **Spalling** (owner: "the ones whose name starts with Ą" — concrete
   losses that expose the REBAR underneath). Already "reasonably ok";
   improve it and show procedurally generated rebar in the cavity.
3. **New procedural wear kinds** — a proper brainstorm: what people do
   in the wild PLUS something unique to us. Pick, then build.

Process per CLAUDE.md: owner playtests via the LEVELS menu ("crack lab"),
every new dial gets a panel row, host-side work must not add shader-twin
debt while the spawner box is idle.

---

Mid-round addition (owner, same day): **a delicate ANTI-ALIASING on solid
CONTOURS only**, so deep thin crevices stop reading as isolated black
pixels. Queued as task 1.5 below — it is the one thing that would lift
the hairline end of the crack range, which is exactly where round 8 hit
its floor (nothing under ~2 px survives as a line today).

## Task 1 (round 8) — propagation cracks — DONE 2026-07-25 (awaiting owner playtest)

State before: `crack_geom.rs` grows nothing. Both scales are *analytic
lines*:

- the structural fault is `u(y) = ax + tilt·y + wob(y)` — one smooth
  vnoise wander per 6-wu strip, so it renders as a long soft arc; the
  pier is split into u-interval BANDS between successive faults;
- the "lightning" policy is a BSP splitter: each region is cut by one
  wandering line, roots/tapers/forks are *emulated* by shaping the cut's
  open span. Cuts still span whole regions, so plates are big shards and
  the visible cracks are again smooth curves.

Nothing in the model can KINK or BRANCH, which is exactly what the owner
sees. So round 8 replaces both with ONE shared primitive.

### The primitive: `Bolt` — a propagated crack path

A polyline in face coords grown by a deterministic walk:

- step ~0.1-0.25 wu (>= 3 px, so a kink resolves at the low-res target),
- per-step turn from a hash, plus a heavy-tail KINK draw (occasional
  50-75° stair step — the masonry look), plus mean reversion to the
  bolt's bias axis (settlement = vertical),
- FORKS: a child rooted at a parent vertex, angled by `spread`, gated by
  `branch`, budget and width scaled down per depth (a real hierarchy),
- dies on: budget spent, leaving the damage zone (crisp tip), leaving the
  face, or HITTING another bolt (T-junction — the strongest realism cue
  the old model could not express),
- per-arc-length half width: full at the root, tapering to the >= 1 px
  floor at the tip; CLOSED outside the open span.

`Bolt` implements the existing `CutLike` trait, so all the round-4..7
machinery carries over untouched: `cut_clip`, the >= 1 px `px_floor`, the
drooped groove walls, the chamfer, the sink/spall gates. Two changes to
the trait: `t_of(p)` replaces `tangent()`, and cuts may emit their own
wall polyline so kinks survive re-sampling. Side-of-path needs no
distance field and no parity walk: the walker's CORRIDOR clamp keeps the
path a function `u = f(v)` in its launch frame, so the side is the sign
of `u - f(v)` — the same structure the analytic cuts always had.

### Where it lands

- **Structural fault**: presence + the smooth SPINE stay (they mirror the
  shader's `faultAt` lattice float-for-float, which is what lets
  `GEO_BIT` suppress the paint and keeps the painted stain halo on the
  seam). The geometry path becomes a jagged trunk anchored to that spine
  (jag <= 0.15 wu, inside the 0.55-wu halo) plus 1-3 forks.
- **Pier splitting**: bands die. Pieces = the face rect clipped
  sequentially by every THROUGH bolt, each piece extruded to a PRISM
  (front/back planes + perimeter walls); settlement drop accumulates per
  through-cut. Forks are NOT through cuts — see "what actually landed".
- **Craze policy `lightning`**: the BSP splitter is replaced by a bolt
  NETWORK seeded in the damage patches; plates are whatever the network
  leaves. `craquelure` keeps the ladder splitter, `mosaic` the Worley
  baseline (both are the owner's A/B references).
- Panel params keep their names (branch/straight/spread) — they are now
  the walker's native dials, not shaping hacks on a BSP cut.

### Verification — done

`cargo test` (35 rt-viewer tests, 5 new: launch-frame monotonicity, the
network kinks + T-junctions, the >= 1 px across-crack floor, one through
break per fault + a jagging trunk, `carve` tiles the face) and
`cargo clippy --all-targets` are clean; `SHOT=` before/after at demo /
hot / max / craze-only; `LOOK_SWITCH=polana` rebuild path exercised
(6.5 s on the M2, bake-bound). Host-side only — **no shader edit, no new
Vulkan/Metal twin debt.**

### What actually landed (vs the sketch above)

- Fault forks do NOT carve pieces — they groove the veneer. A piece
  boundary is as long as whatever it splits, so a fork's invisible
  extension drew a hard line across the wall; three separate leaks made
  that extension visible before the layer move fixed the class. Details
  in docs/AGENT_LEARNINGS.md (2026-07-25 round 8).
- Width follows LENGTH (and forking follows length): uniform widths read
  as scratches no matter how well the path kinked.
- Cracks got their own, wider/earlier slice of the damage field
  (`crack_zone`): gating growth on the stain zone left a mid-aged wall
  visibly pristine.
- Bolt widths floor at ~2 px across the crack, not 1 px: a 1-px groove
  still dot-dashes even with the droop. Task 1.5 (contour AA) is the
  lever that could lower that floor again.

## Task 1.5 (NEXT) — delicate contour anti-aliasing

Owner, 2026-07-25: a gentle AA that only anti-aliases the CONTOURS of
solids, so deep thin crevices read as lines instead of single black
pixels. This one touches the renderer, so it is a shader-twin round
(GLSL + MSL) — the first since the spawner box went idle.

Approach to weigh at the start of that round (not committed yet):

1. **G-buffer edge blend in the tonemap pass** (cheapest): the pass
   already has position/normal/flags per low-res texel, so detect
   silhouette/depth/id discontinuities and blend 2-3 taps at ~30-40%
   only across those. One pass, ~30 lines per twin, keeps interiors
   perfectly aliased (the pixel contract's intent), no extra rays. Risk:
   it blurs an EDGE, it cannot recover a crack the centre ray missed
   entirely — so a sub-pixel groove still dashes, it just dashes softer.
2. **Adaptive corner rays on discontinuity** (true coverage): where the
   4 pixel corners disagree, trace them and average. Recovers missed
   thin features (the real win for hairline cracks), costs rays only on
   contour pixels, stays deterministic (fixed corner offsets, no jitter).
   Risk: the shade pass is where the ROI/glass/cutaway logic lives, so
   the extra taps must reuse it without duplicating it.
3. Both, with a look-level strength knob + an ESC settings row (the
   owner playtests via menus, per docs/VISION.md).

The pixel-perfect contract needs an explicit amendment either way: it
currently forbids jitter and mandates hard pixel edges. Contour-only
coverage does not contradict its INTENT (no crawling, no temporal
shimmer, integer upscale untouched) but the wording must be updated
deliberately, with the owner's sign-off, not silently.

---

## Task 2 (after 1.5) — spalling with exposed rebar

Sketch, not committed: spall craters are currently plates that go
MISSING (chip gate) plus painted chalk. Owner wants the concrete loss to
expose REBAR. Direction: a procedural bar CAGE per wall (vertical bars on
a ~0.2-0.3 wu pitch + horizontal ties), living just under the veneer;
where a crater bites deeper than the cover depth, emit the bar segments
crossing it as real geometry (rusty, matte, round-ish = a few boxes at
this resolution, blocky per the tecta directive), with the crater rim
undercut and the bar casting its own contact shadow into the cavity. The
cage is a pure function of the pier, so it stays deterministic and
rebuild-cheap.

## Task 3 (later) — new wear kinds

Brainstorm to run when tasks 1-2 land. Seeds so far (unvetted): water
staining/runoff below openings and along cracks (we have a hint of it in
paint), efflorescence bloom, biological growth in the damp zone, impact
scars at knee height on corners, patch repairs (a lighter rectangle of
newer render over an old crack), settlement drift of whole piers, edge
rounding/chipping on every arris (cheap, huge readability win at low
res), sun-bleach gradients by orientation, dirt tide-lines from splash
back, graffiti-scale abstract marks, and OUR-own idea candidates: aging
that follows the GI (grime where the probes say it is dark), and a
"history" pass where one event (the settlement fault) CAUSES the
secondary features around it instead of every layer being independent
noise.
