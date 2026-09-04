# Procedural material review — 2026-09-04

The playable result is **weathered courtyard**, available in the existing level
menu. Tab opens the wall editor; its edits persist in `courtyard.wear`. The
clean spur at (12, 4) is the comparison surface. The scene has no automatic aging
beat, so the authored composition stays put while walking or editing.

## Recovered intent

Read the recent 65-commit history, the rendering learnings, the vision and
concept notes, the key geometry/material commit descriptions and diffs, and
the local Claude project's user messages. The July 25 messages explicitly
approved the branching-crack result and then asked for selective AA, exposed
reinforcement, more greybox modifications and independently inspectable effects.
The July 26 feedback rejected thick reinforcement, oval holes and confusing
effect controls. The target is bright, simple architecture made believable by
selective wear that survives the low-resolution camera.

The existing geometry work is valuable: propagated cracks, chamfered grooves,
faceted spall and thin reinforcement. This pass concentrates on the weak material
read and its composition. It does not replace that geometry engine.

## Changes

- Rain marks now have seeded source positions, varied lengths, tapered tails,
  slow lateral wander and a faint surrounding wash. They use the existing
  per-wall region and variant. The old stain leaked outside its mask and used
  another noise threshold that made the actual marks nearly invisible.
- Fine glaze web integrates approximate line coverage over the surface texel.
  The connected web remains visible without a per-cell visibility lottery.
  Geometry still uses deterministic pixel-centre primary rays and scoped AA.
- Exposed concrete gets pale binder and sparse darker aggregate. Dry mud gets
  density variation; mud and stains interrupt the ceramic sheen.
- The checkerboard lawn is replaced by continuous world-space clumps and subtle
  ground grain. The original box tufts, green palette and matte response remain.
- The courtyard composes these with the existing cracks, chips and spall, while
  retaining clean surfaces. The catalogue remains the isolated comparison bench.

Both Metal and GLSL carry the same material expressions, covered by a parity
test. No new ray passes, material channels or external texture assets were added.

## Evidence

Local generated artifacts (under ignored `output/material-review/`):

- `catalogue-before.png` and `catalogue-after.png`: matching view and light.
- `courtyard-overview.png`: full composition.
- `courtyard-walk.mp4`: 360 deterministic ticks, six seconds, walking toward and
  through the doorway; `walk.trace` and `walk-frames/` retain the source capture.

Validation: 194 workspace tests pass, including the red-to-green stain mask
regression, complete material-expression parity, canonical wear data and the
courtyard's unchanged clean control. The release build compiles GLSL; the Metal
shader compiled and ran on the Apple M2 Pro. Two idle frame pairs in the walk
(20/50 and 320/350) have exactly equal RGB images within the process.

A 240-frame headless Metal run at 1440×900, default integer zoom and scoped AA
averaged **11.10 ms** of blocking CPU frame time. Excluding the first 20 frames,
the mean is 11.10 ms and p95 is 11.49 ms. This is a render harness measurement,
not a fullscreen presentation FPS claim. The first courtyard GI bake took about
4.8 seconds; subsequent launches use the cache.

Limits: GLSL was compiled, not run on an RTX device. As with the existing paint
effects, the new fine material detail is evaluated in the camera shade pass;
the irradiance bake sees geometry and base material colors, not the fine paint.
The runoff source height follows the existing fixed 2.1875-wu wall contract.
Final aesthetic acceptance belongs to the owner's playtest.

## Playtest crash follow-up

The first windowed playtest crashed when the owner selected a level. The initial
direct-boot and walk checks did not exercise scene rebuilding. `CrackLab` carried
old core/spall material IDs into a fresh scene; the new rebuild regression
reproduced the owner's exact out-of-bounds panic (index 126, length 126).

Generated material addresses are now cleared before stamping fresh geometry,
with selection re-stamped after the new materials exist. Menu transitions load
the selected layout and reset wear state when demo identity changes. All 112
viewer tests pass. A Metal run through courtyard → courtyard → catalogue → crack
lab → courtyard completed and captured `menu-roundtrip.png`; `LEVEL_SWITCH`
retains that transition harness for future checks.
