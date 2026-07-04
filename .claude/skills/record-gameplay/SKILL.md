---
name: record-gameplay
description: Record a gameplay walkthrough video of a native rt-viewer scene (the iso ray-traced renderer). Use when the user asks to record/capture a gameplay clip, walkthrough, movie, or video of the player walking through a scene/house/building/rooms.
---

# Record a gameplay walkthrough

Renders a deterministic gameplay clip from the `rt-viewer` DEMO harness: a
CMDS-format trace is played one sim tick per frame (the wall clock never ticks
the sim, so it is byte-reproducible), a PNG is dumped per tick, and ffmpeg
encodes them to an iPhone-friendly H.264 mp4. The bundled
`scripts/record.sh` wraps the build + DEMO dump + encode.

## Workflow

1. **Pick the scene.** Player+wall scenes: `home` `hospital` `office`
   `factory` (procedural floor plans), `village` (buildings on a street),
   `cave` (dungeon), `house` / `game` (hand-built). Floor-plan scenes vary by
   `CAVE_SEED` (default seed is stable).

2. **Get the layout** so the walk routes through real openings:

   ```bash
   .claude/skills/record-gameplay/scripts/record.sh --dump home
   ```

   Prints `START <x> <z>`, `ROOM <id> [xmin zmin xmax zmax]`, and
   `DOOR <id> [xmin zmin xmax zmax]`. Door rects are the wall openings — their
   centres are your through-waypoints. (Procedural scenes clear door *leaves*,
   so doors render as open gaps; the dump still reports where each gap is.)

3. **Author a trace** (`/tmp/<scene>_walk.txt`). One command per line,
   `# comments` allowed. Format (see
   `crates/house-game/traces/replay_game.txt`):

   ```
   <tick> click <ox> <oy> <oz> <dx> <dy> <dz> <gx> <gz>   # walk to floor point (gx,gz)
   <tick> flash                                           # toggle flashlight
   <tick> lights                                          # toggle room lights
   <tick> rotate <dq>                                     # rotate camera a quarter step
   <tick> shoot <ox> <oy> <oz> <dx> <dy> <dz>             # hitscan along a ray
   <tick> use <food|battery>
   ```

   For a walk, only `gx,gz` matters; set the ray straight down through it:
   `click gx 5 gz 0 -1 0 gx gz`.

   **Routing rules:**
   - Start a few ticks in with `0 flash` (lit scenes look better).
   - To enter a room, click the **door-gap centre first**, then the **next
     room's centre** — this threads the player through the opening instead of
     catching the wall corner.
   - **Spacing:** player walks ~3 wu/s (140 px/s) at 60 ticks/s, so budget
     **~30 ticks per world-unit** of straight-line distance between waypoints
     (generous, so each WalkTarget is reached before the next click; clicking
     early redirects mid-stride and can clip a corner). Collision inflates walls
     by the player half-extent (~0.19 wu), so a 1 wu door gap is ~0.62 wu of
     passable width — aim at gap centres.

4. **Render + encode:**

   ```bash
   .claude/skills/record-gameplay/scripts/record.sh home /tmp/home_walk.txt /tmp/home_walk.mp4
   ```

   Then send it with the `SendUserFile` tool (the user reviews on their phone).

## Verify before sending

Spot-check a few dumped frames mid-run (the script's temp dir is cleaned on
exit, so to inspect, re-run with `DEMO_DIR` set to a kept dir, or eyeball the
final mp4). Confirm the player actually reaches the far rooms (watch the minimap
marker) and never stalls on a wall. If it stalls, the gap waypoint was off or
clicks were too close together — widen spacing or re-aim at the door centre.

## Env knobs (forwarded to the viewer)

- `WINDOW=1280x800` capture resolution · `FPS=60` playback rate (60 = real
  speed) · `TICKS=<n>` frame count (default: last trace stamp + 1)
- `ROI_XRAY=ghost` disables the contour x-ray (plain stipple) · `CAVE_SEED=<n>`
  pick a different procedural layout · `STYLE=<preset>`, `LIGHTS=<f>`, etc.
  pass straight through.

## Notes

- Needs `ffmpeg` on PATH and a built `target/release/viewer` (the script
  builds it). DEMO is fully headless — no window required.
- The clip shows the ROI x-ray reveal (ghost stipple + faint wall contours) in
  motion as the front walls dissolve around the moving player.
