# The player's body (2026-09-24 rebuild)

Owner verdict on the previous rig: "IK and animations look weak and
unnatural. Let's do it from zero and focus on it." Owner choices (asked
before building): a genuinely **skinned** mesh, motion from **motion
capture** (CMU), walk slowed from 2.2 to **1.6** wu/s (run stays 4.2), the
Vault 42 suit on a man of about **45** (younger than the old grey-haired
survivor).

The old rig (15 rigid parts from `blender/build_survivor.py`, procedural
stance/swing IK in `rt-viewer/src/survivor.rs`, docs
`PLAYER_2026-09-05.md` / `PLAYER_VAULT42_2026-09-05.md`) is deleted; the tag
`archive/survivor-rig` (commit 9ba8865) is the last tree that has it. What was
wrong with it, measured on clips before the rebuild: the walk was a fencer's
lunge (feet planted up to 0.5 wu fore and aft, the reach clamp dropping the
pelvis so both knees stayed bent), the run the same lunge deeper with no
flight phase, a stop froze in a wide split for half a second and then
re-planted one foot per 14 ticks, the elbows were held bent forward as if
carrying something, the heading snapped 7° per tick, and the rigid parts
showed ball shoulders and knee seams.

## Pieces

| Where | What |
|---|---|
| `tools/character/skeleton.py` | THE skeleton (21 bones, rest rotations identity, 1.80 m) and the heel/ball contact points. Both tools import it and write it into their asset; Rust reads it from there. |
| `tools/character/cmu.py` | CMU ASF/AMC reader + forward kinematics (metres, Y up). |
| `tools/character/bake.py` | Retargets the captures onto the skeleton, cuts and loops the cycles → `assets/characters/player.anim`. `--report` writes stick-figure review sheets. |
| `tools/character/build_mesh.py` | The skinned mesh (lofts with per-ring bone weights, 15 materials keeping `survivor.inc`'s slots) → `assets/characters/player.skin`. `--preview out.png` renders four views. |
| `tools/character/preview.py` | numpy z-buffer preview; also renders contact sheets of `avatar`'s `dump` example. |
| `crates/avatar` | Runtime (glam only, headless): asset parsing, clip sampling/blending, the locomotion controller (`body.rs` — its module doc is the design), two-bone IK, CPU skinning. |
| `crates/rt-viewer/src/player.rs` | Adapter: the mesh as ONE dynamic run `player`, re-skinned every fixed tick into `FrameState::skin`. |
| `rt-probe` `SceneGpu::record_skin` / `metal_backend.rs` | Upload the skinned vertices over the run's slice of the vertex buffer, rebuild the run's BLASes, mark the TLAS dirty. |

## Motion capture

The data used here was obtained from mocap.cs.cmu.edu (CMU Graphics Lab
Motion Capture Database; created with funding from NSF EIA-0196217; free
for any use). Raw files are NOT checked in; download them into one folder
and run `python3 tools/character/bake.py <folder>`:

| Clip | CMU file | Use |
|---|---|---|
| idle | 139_02 "shifting weight", frames 40–880 | time-looped idle (7 s) |
| walk | 35_01 | walk cycle, 1.40 m stride at 1.25 m/s |
| brisk | 07_12 "brisk walk" | 1.81 m at 2.03 m/s — only on the way to a run |
| run | 35_17 | 2.33 m at 3.07 m/s, flight phase |
| sneak | 132_15 "walk with knees bent" | crouched gait (legs and torso; arms come from `walk`) |

plus the ASF of each subject (`<subject>.asf`). URLs:
`http://mocap.cs.cmu.edu/subjects/<subject>/<subject>_<trial>.amc`.
Rejected on review: subject 17's "walk stealthily" (a sideways crab walk),
77_* (duplicates of 139), 143_32 (a jog labelled walk).

Retargeting is by direction: an ASF bone's global frame is the identity at
rest, so its global rotation IS its rotation from rest; each of our bones gets
a fixed alignment `arc(our rest dir → CMU rest dir)`. The pelvis is placed so
our hip centre follows the actor's (scaled by leg length), which keeps the
actor's foot paths.

## Runtime (one fixed tick)

1. **Phase from distance** actually covered over the stride for this speed.
2. **Speed blend** idle ↔ walk ↔ brisk ↔ run, sneak by crouch, all sampled
   at the same phase (every cycle starts at a left heel strike).
3. **Stride warping**: foot fore-aft excursion × (chosen / natural stride).
4. **Foot locking**: a foot the clip marks planted is pinned where it
   landed; two-bone IK solves the leg, the animated knee gives the bend plane.
   A turn or a reversal that leaves a planted foot out of reach (>0.3 from
   where the clip wants it, or >0.6 horizontally from its hip) re-plants it
   with a quick step instead of sinking the pelvis into a lunge.
5. **Starts** begin at mid-stance (feet side by side = the gait's passing
   position), the rear foot swinging first. **Stops** finish the step in
   the air (phase keeps running in time until a foot lands), then idle
   corrective steps bring the feet under the body one at a time.
6. **Ground**: soles never go below the terrain (heel and ball sampled);
   the pelvis rides the average of the two supports and lowers when a leg
   cannot reach.
7. **Weight**: lean into acceleration and bank into turns through an
   underdamped spring (overshoot, then settle); head counter-rotates.
8. **Crouch**: sneak gait + pelvis drop + torso lean; standing crouched
   widens the base. **Wall**: pushing into a blocking surface puts both palms
   on it (arm IK).

Facing is the body's, not the sim's: it follows velocity at up to 10 rad/s.
Speeds are the sim's (`SPEED_WALK` 1.6, `SPEED_RUN` 4.2, `SPEED_CROUCH` 1.1),
the same on every level; the body is also used on the greybox gym levels.

## Checking motion

- `cargo test -p avatar` pins: a planted foot never slides (walk, run,
  curves), no forced re-plant on a straight path, soles above uneven ground,
  bone lengths, stops settle, crouch without pops, wall brace, bit-identical
  replay.
- `cargo run -p avatar --example dump -- <start-stop|turns|run|crouch|kerb|wall> f.bin`
  then `python3 tools/character/preview.py f.bin assets/characters/player.skin out.png FIRST STEP COUNT [YAW]`
  — contact sheets without the renderer.
- In game: `PLAY_SCRIPT` (keys `w a s d shift`, `c` crouch, `e`/`q` camera)
  with `DEMO=` records captioned clips; plain `DEMO=` traces hold their
  `move_world` until the next command.

## Known limits / next

- Linear-blend skinning pinches at a deep knee bend (a dark crease at game
  size, no hole).
- No turn-on-the-spot clip: a standing turn is corrective steps.
- Crouch walk is the knees-bent capture made lower by IK, not a true
  sneak capture.
- BLIND METAL: `metal_backend.rs`'s skinned-run upload/BLAS rebuild is
  unrun (see CLAUDE.md).
