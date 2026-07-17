# Weekend plan — 2026-07-18/19 (working doc, non-binding; VISION.md rules)

Written 2026-07-17 after phase 3 of the voxel-physics-spike (wall smash,
`40ddd58`) landed and the spawner duty was discharged. Checked against
docs/VISION.md, CLAUDE.md, `bin/golden` and the code — check notes at the
bottom, including the two conflicts the check caught.

## Saturday morning — the gate everything waits on (OWNER, ~45 min, no code)

`bin/run`, ESC menus only:

- the **polana look lock** decision (CLAUDE.md still says: CZEKA playtest +
  lock + goldeny) — with the look-row A/B vs `dusk`;
- the three LEVELS demos: *dusk flood*, *day to dusk*, *wall smash*;
- decision two: is **destructibility** a keeper — shelf as tech, or promote
  into the game's direction?

Faza 1 cannot exit and goldens stay suspended until the lock happens.

## Saturday midday — re-pin goldens (agent, ~2 h, ONLY if polana locks)

`bin/golden` documents its own resurrection: restore the byte-compare loop
from `archive/pre-joyful-reset`, pin gym frames per machine/backend
(`SHOT=` + `WINDOW=`, `LIGHT_ANIM=0`). The 2026-07-17 hardware session makes
this stronger than planned: the RTX/Vulkan cross-run noise floor is ZERO, so
strict byte goldens are valid on the spawner. Metal pins wait for the Mac
(±1-LSB tolerance rule).

## Saturday afternoon → evening — Faza 2 kickoff: continuous mover, headless-first (agent)

`house-game` builds and tests without a GPU — ideal weekend agent work:

- continuous player position + **collide-and-slide** against the grid's wall
  edges, fixed tick, `state_hash` extended, replay tests re-pinned
  deliberately in the same commit;
- acceleration/brake ramps + a turn-rate limit (masa, bezwładność);
- the cell-stepper stays UNTOUCHED as the A/B reference behind an ESC menu
  row ("movement: continuous / stepped") — owner compares from the menu,
  never CLI;
- first input: WASD screen-relative via `Projection::pixel_basis` (exists,
  test-pinned in iso-core).

## Sunday morning — mouse click-to-move (agent)

VISION's top-priority input: point-n-click + pathfinding. Hand-rolled A* +
string-pulling/steering over the 18×14 grid (NO new dependency at this
size), sharing Saturday's mover core. Input-scheme menu row for the A/B.

## Sunday afternoon — feel pass + tooling

- tune walk/run speeds against the ~67 px/s pixel-snap perceptual threshold
  (2026-05-16 learning), recomputed for trimetric's px/wu — pick speed bands
  that don't shimmer;
- the VISION-mandated movement **debug overlay** (velocity vector, path,
  key-toggled).

## Sunday evening — the phase-gate ritual

Owner playtest of the new mover from the ESC rows, record a clip
(record-gameplay), AGENT_LEARNINGS entry if anything bit, commit + push.
Green tests close nothing — the clip and the playtest do.

## Explicitly parked

- pad support (VISION: "później, brak pada pod ręką"; `gilrs` is not a dep);
- Faza 3 gameplay interview (gated on 1+2 being miodne);
- breach walkability in the sim (only if destructibility is promoted);
- foot-planting IK-lite (after the core mover feels right);
- ALL Metal-side duties — the wall-smash eyeball and Metal golden pins need
  the Mac, not the spawner.

## Check notes (what was verified, what the check caught)

Verified against the repo: `pixel_basis` exists with a per-preset test pin;
the golden-restore procedure is written into `bin/golden` itself; the
zero-noise-floor fact is pinned in CLAUDE.md; every A/B above goes through a
menu row (process rule); the plan REPLACES the interim mover rather than
growing it (CLAUDE.md rule).

Conflicts caught and resolved:

1. **Input ordering vs VISION** — VISION prioritizes mouse/trackpad first,
   WASD second; the plan does WASD Saturday anyway, but only because it is
   the thinnest same-day exercise of the shared mover core. Mouse gets prime
   Sunday time and MUST be in the Sunday playtest. Swapping the two is fine
   if the literal priority is preferred — the mover core doesn't care.
2. **Trace-format ripple** — gym traces (`<tick> move dx dz [walk|run]`) are
   load-bearing (DEMO playback, record-gameplay, replay tests). The
   continuous mover's new trace command must be ADDITIVE: old traces keep
   parsing, demo timeline tests stay green.

Dependency decision: no `pathfinding` crate — hand-rolled A* keeps
house-game at hecs + glam.

The only block where the owner is the critical path is Saturday morning's
45 minutes. Everything else degrades gracefully: if polana doesn't lock,
goldens stay parked and the mover work proceeds unaffected.
