# Vault 42 survivor

The owner chose Fallout's blue vault suit with a yellow 42, retaining the older
face. The editable Blender source now builds a fitted blue cloth torso, two
sleeves, yellow collar/zip/yoke/waist/cuffs, matching blue trousers and boots.
The yellow 42 is original mesh lettering projected onto the curved back, not a
bitmap. Appliques are tessellated across both axes to keep them above the cloth.
Blue twill, worn folds and accumulated soil use the shared procedural shader.

`blender/build_survivor.py` produces `assets/characters/survivor.blend` and the
embedded `survivor.mesh` (485,449 bytes; 15 articulated parts and 15 materials).
The Blender armature has Idle, Walk, Jog, Brace, Turn, Crouch, CrouchWalk,
CrouchBrace and Recover actions exported from the runtime pose solver.
The rebuild sequence is unchanged from `docs/PLAYER_2026-09-05.md`.

## Controls and movement

| Input | Action |
| --- | --- |
| WASD / arrows | Screen-relative movement, including during camera turns |
| Shift | Run |
| C | Toggle crouch |
| Ctrl | Hold crouch (also works alongside the C toggle) |
| Q / E | One camera quarter-turn per fresh press |
| LMB | Follow a route; keyboard movement cancels it |

Neighborhood walk speed rises from 1.65 to 2.2 world units/s; run speed from
3.2 to 4.2. Crouch movement is 1.1, including with Shift held. Braking increases
to 34 units/s²: releasing full neighborhood sprint stops within eight fixed
ticks and less than a quarter metre. The 60 Hz simulation owns stance, speed,
acceleration, collision and braking. `crouch on/off` commands round-trip through
the trace format, persist through idle ticks and participate in the state hash.

Physical key codes now own held input. Shift, Caps Lock or a keyboard layout
cannot change the identity of a release. W/Up and left/right Shift keys track
independently. Releases are processed before modal routing. Menu/IDE transitions
and focus loss clear physical holds and mouse routes; auto-repeat cannot
resurrect a cleared hold. Camera actions ignore repeat. The current animated
camera angle drives movement, clicks and rendering in the same frame.

## Pose and IK

- Crouch smoothly lowers the pelvis by up to 0.4 world units, widens the stance,
  bends the knees, leans the torso and counter-rotates the head. Hand rest and
  bracing targets lower with the body. Descent/recovery takes about 0.27 s.
- Each foot samples its own support, including toe and heel, on slabs/asphalt/
  soil. Planted stance feet keep their world location; stopping and changing
  stance replant one foot at a time with clearance instead of sliding both.
- Stride distance and swing clearance now match brisk walking, running and
  crouch walking. Actual travelled distance advances the cycle.
- Thigh/shin lengths match the authored 0.445/0.425 bind lengths. The pelvis
  lowers for reach; hand targets stay within arm reach. A stable perpendicular
  fallback prevents an aligned pole vector from collapsing a knee/elbow.
- Startup replay prefixes advance the same pose clock as live ticks, so a
  crouched snapshot cannot silently render a standing mesh in SHOT mode.

The renderer still uses rigid bone-weighted parts with overlapping joints.
This is not multi-weight skin deformation or cloth simulation. Crouching changes
the pose and movement speed; the current 2D wall grid keeps the same horizontal
collision footprint and has no separate low-ceiling clearance system.

## Verification

225 workspace tests pass. Red/green regressions cover physical input routing,
camera basis during turns, excessive stopping distance, collapsed IK poles and
replay pose drift. Additional tests cover aliases, both Shift keys, modal/focus
reset, Q/E repeat, crouch replay/speed, independent ground supports, full limb
lengths, and the actual exported mesh across crouch/walk/run/contact/recovery.
The manual Blender motion export passes; Blender's Walk frame 50 matches all
runtime bone transforms within 0.0001.

Release compilation validates GLSL, and native Metal captures validate the
updated asset and shaders on Apple M2 Pro. Review output is in ignored
`output/vault42/`: front/back/crouch PNGs and the recorded walkthrough. Keyboard
regressions inject events into the input logic; the recording replays fixed-tick
simulation commands, rather than pretending to exercise macOS keyboard delivery.
