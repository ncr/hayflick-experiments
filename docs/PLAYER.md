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
| stroll | 35_01 | 1.40 m stride at 1.25 m/s — starts, stops, slow steps |
| walk | 39_02 | 1.69 m at 1.58 m/s — THE game walk, played at its own cadence |
| brisk | 08_06 | 1.73 m at 1.87 m/s — on the way to a run |
| run | 35_17 | 2.33 m at 3.07 m/s, flight phase |
| sneak | 132_15 "walk with knees bent" | crouched gait (legs and torso; arms come from `walk`) |

plus the ASF of each subject (`<subject>.asf`). URLs:
`http://mocap.cs.cmu.edu/subjects/<subject>/<subject>_<trial>.amc`.
Rejected on review: subject 17's "walk stealthily" (a sideways crab walk),
77_* (duplicates of 139), 143_32 (a jog labelled walk), 07_12 (a power walk,
knees bent), and — after the first playtest — 35_01 as THE walk: a 1.25 m/s
stroll stretched to 1.6 read as "unsure, not confident".

Retargeting is by direction: an ASF bone's global frame is the identity at
rest, so its global rotation IS its rotation from rest; each of our bones gets
a fixed alignment `arc(our rest dir → CMU rest dir)`. The pelvis is placed so
our hip centre follows the actor's (scaled by leg length), which keeps the
actor's foot paths.

Four corrections on top of the direction copy (each found by rendering the
CMU skeleton next to ours, `tools/character/bake.py`'s module doc has the
detail):

- **Loop closure by motion.** Each cycle's end-vs-start residual is spread in
  proportion to how fast each bone turns, not linearly — a linear spread put
  the push-off's 13° foot residual into the whole stance (toes up, a walk on
  the heels).
- **Flat feet.** The foot's mid-stance pitch is taken out per clip and side
  (an actor's calibrated foot is not our flat one), then the clip is lowered
  onto the floor its flattened soles stand on.
- **Neutral bones.** Clavicles, upper arms, hands, neck and head keep only the
  actor's motion around the clip's MEAN pose; the mean itself becomes our bind
  pose. The UPPER ARMS are the exception: they keep the actor's exact
  direction in the chest frame (only the clavicle under them is neutralized,
  compensated), 6° of carry away from the body, and the walk's swing scaled
  to 65 % about its own mean (`ARM_SWING`). Copying absolute directions shrugged the shoulders 5 cm (a CMU
  clavicle rises 19°), flared the wrists ~45°, held a sneaker's arms out like
  wings and tipped the face 20° to the sky.
- **Stroll/walk ladder.** The game walk is a capture AT the game's walking
  speed; stretching a slower one sank the pelvis (see below).

## Runtime (one fixed tick)

1. **Phase from distance** actually covered over the stride for this speed.
2. **Speed blend** idle ↔ stroll ↔ walk ↔ brisk ↔ run, sneak by crouch, all sampled
   at the same phase (every cycle starts at a left heel strike).
3. **Stride warping**: foot fore-aft excursion × (chosen / natural stride);
   for a gait with a flight phase (the run) the extra stride goes into the
   FLIGHT instead — the phase runs at the capture's rate while a foot is
   down and slows in the air — so a 4.2 run on a 3.07 capture does not
   over-reach on the ground.
4. **Foot locking**: a foot the clip marks planted is pinned at its ground
   contact and rolls heel → ball → toe tip (whichever the clip holds lowest)
   — pinning the ankle left it 10–15 cm behind at push-off; two-bone IK
   solves the leg, the animated knee gives the bend plane.
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

- `cargo test -p avatar` pins: a planted foot's ground contact never slides
  (walk, run, curves), the walk and run keep the legs under the body (pelvis
  sink ≤ 3.5 cm at 1.6, the playtested rig sank 19), no forced re-plant on a straight path, soles above uneven ground,
  bone lengths, stops settle, crouch without pops, wall brace, bit-identical
  replay.
- `cargo run -p avatar --example dump -- <start-stop|turns|run|crouch|kerb|wall> f.bin`
  then `python3 tools/character/preview.py f.bin assets/characters/player.skin out.png FIRST STEP COUNT [YAW]`
  — contact sheets without the renderer.
- In game: `PLAY_SCRIPT` (keys `w a s d shift`, `c` crouch, `e`/`q` camera)
  with `DEMO=` records captioned clips; plain `DEMO=` traces hold their
  `move_world` until the next command.

## Playtest 1 (2026-09-24): "arms strange, walk unsure"

Measured, then fixed: the walk (35_01 at 1.25 stretched to 1.6) sank the
pelvis up to 19 cm, because (a) the capture's heel strike was taken for a
landing from a height and the foot spent a third of the stance in a
corrective step, (b) the ankle, not the contact point, was pinned, and (c)
the loop closure tilted the stance foot 11° toes-up. The arms carried the
actor's shrug, wrist flare and forward neck. Now: 3 cm at double support,
~1 cm on average.

## Playtest 2 (2026-09-25): "not masculine — elbows at the body"

Measured on ten CMU walks (`step width, hip sway, pelvis roll, elbow
distance from the midline, hand swing`): 38_02 had the widest pelvis roll
(15.7°), twice the hip sway of the others (5.4 cm) and the smallest hand
swing (0.36 m); with our bind arms hanging against the torso that read
feminine. Now: THE walk is 39_02 (step width 12.7 cm, hip sway 2.7 cm, pelvis
roll 7.5°, hand swing 0.68 m, kept at 80 %), the upper arms' neutral hangs 9°
away from the body (`NEUTRAL_POSE` in `bake.py`), and the torso lost its
hip flare and gained chest and lat width (`build_mesh.py`).

## Playtest 3 (2026-09-25): "hands too high and forward — is that really a normal walk?"

The capture was normal; the retarget was wrong. Measured wrist-vs-shoulder
over the cycle: the capture swings 24 cm forward and hangs under the
shoulder; ours went 39 cm forward, higher, with the whole cycle 10–20 cm
ahead. Two bugs in `neutralize`: the mean was removed as `q · mean⁻¹` (the
swing kept the actor's axes, i.e. the wrong ones for our bind) instead of
`mean⁻¹ · q`, and neutralizing the upper arm at all rotated the actor's mean
arm — slightly behind the body, elbow bent forward — onto our vertical bind,
tipping the whole swing forward. Now the arm tracks the capture's trajectory
(scaled by our longer arm); the side-by-side check is the stick render of the
CMU skeleton over ours at the same phases.

## Playtest 4 (2026-09-28): "the hands look like plates facing forward"

The mesh built the hand like the anatomical pose: wide across the body,
fingers curled forward. Rebuilt hanging palm to the thigh — wide front to
back, fingers curling in, thumb on the front edge (`build_mesh.py`). Measured
over every clip the palm now faces within 0–37° of the thigh; a test pins the
bind palm's orientation.

## Known limits / next

- Linear-blend skinning pinches at a deep knee bend (a dark crease at game
  size, no hole).
- No turn-on-the-spot clip: a standing turn is corrective steps.
- Crouch walk is the knees-bent capture made lower by IK, not a true
  sneak capture.
- BLIND METAL: `metal_backend.rs`'s skinned-run upload/BLAS rebuild is
  unrun (see CLAUDE.md).
