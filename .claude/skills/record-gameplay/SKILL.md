---
name: record-gameplay
description: Record a gameplay walkthrough video of the native rt-viewer gym level (the iso ray-traced renderer). Use when the user asks to record/capture a gameplay clip, walkthrough, movie, or video of the player walking around.
---

# Record a gameplay walkthrough

Renders a deterministic gameplay clip from the `rt-viewer` DEMO harness: a
gym-format trace is played one sim tick per frame (the wall clock never
ticks the sim, so it is byte-reproducible), a PNG is dumped per tick, and
ffmpeg encodes them to an iPhone-friendly H.264 mp4. The bundled
`scripts/record.sh` wraps the build + DEMO dump + encode.

## Workflow

1. **Know the level.** There is ONE hand-authored level
   (`house_game::gym::sim::gym_level`, 18×14 cells): the player spawns at
   (10, 11); the building interior spans x 3–7 / z 3–7 with its doorway at
   cell (5, 7) opening south; freestanding walls run along the z=10 line
   (x 10–15) and the x=12 line (z 2–5).

2. **Author a trace** (`/tmp/gym_walk.txt`). One command per line,
   `# comments` allowed. Format (`crates/house-game/src/gym/trace.rs`):

   ```
   <tick> move <dx> <dz> [walk|run]   # one grid step (one axis only)
   <tick> wait
   ```

   **Routing rules:**
   - The sim owns the step cadence: walk lands a step every 8 ticks, run
     every 5. Space `move` commands at least that far apart (earlier ones
     are silently dropped).
   - Steps into walls are dropped too — the player just stays put. The only
     way into the building is the (5, 7) doorway from the south.
   - Walking indoors triggers the WALLCUT dollhouse cutaway — good clip
     material.
   - ~60 ticks = 1 second of video. 300–900 ticks is a good clip length.

3. **Render + encode:**

   ```bash
   .claude/skills/record-gameplay/scripts/record.sh /tmp/gym_walk.txt /tmp/gym.mp4
   # WINDOW=1280x800 FPS=60 forwarded; any viewer env passes through
   ```

4. **Verify** — extract a few stills and LOOK at them (the mp4 itself does
   not render in the client):

   ```bash
   ffmpeg -y -i /tmp/gym.mp4 -vf "select=eq(n\,0)+eq(n\,150)+eq(n\,299)" -vsync 0 /tmp/still_%d.png
   ```

   Check: the player actually moved along the intended route, the cutaway
   opened indoors, the follow-cam tracked. Then deliver the mp4 (it
   animates in the client).
