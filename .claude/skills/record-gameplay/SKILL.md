---
name: record-gameplay
description: Record a gameplay walkthrough video of the native rt-viewer town (the iso ray-traced renderer). Use when the user asks to record/capture a gameplay clip, walkthrough, movie, or video of the player walking through the town.
---

# Record a gameplay walkthrough

Renders a deterministic gameplay clip from the `rt-viewer` DEMO harness: a
town-format trace is played one sim tick per frame (the wall clock never
ticks the sim, so it is byte-reproducible), a PNG is dumped per tick, and
ffmpeg encodes them to an iPhone-friendly H.264 mp4. The bundled
`scripts/record.sh` wraps the build + DEMO dump + encode.

## Workflow

1. **Pick the town.** `SEED=<n>` selects the generated town (default 1).
   The player spawns at a district gate on the border ring street.

2. **Author a trace** (`/tmp/town_walk.txt`). One command per line,
   `# comments` allowed. Format (`crates/house-game/src/town/trace.rs`):

   ```
   <tick> move <dx> <dz> [sneak|walk|run]   # one grid step (one axis only)
   <tick> wait
   ```

   **Routing rules:**
   - The sim owns the step cadence: walk lands a step every 8 ticks, run
     every 5, sneak every 14. Space `move` commands at least that far apart
     (earlier ones are silently dropped).
   - Steps into walls are dropped too — the player just stays put. Author
     routes along streets; doors open automatically as you pass.
   - The spawn is on the border ring street: the first useful moves head
     INTO the map (for seed 1's gate try `move 0 1` or check a SHOT first).
   - ~60 ticks = 1 second of video. 600–1200 ticks is a good clip length.

3. **Render + encode:**

   ```bash
   .claude/skills/record-gameplay/scripts/record.sh /tmp/town_walk.txt /tmp/town.mp4
   # SEED=3 WINDOW=1280x800 FPS=60 forwarded; any viewer env passes through
   ```

4. **Verify** — extract a few stills and LOOK at them (the mp4 itself does
   not render in the client):

   ```bash
   ffmpeg -y -i /tmp/town.mp4 -vf "select=eq(n\,0)+eq(n\,300)+eq(n\,599)" -vsync 0 /tmp/still_%d.png
   ```

   Check: the player actually moved along the intended route, doors opened,
   the follow-cam tracked. Then deliver the mp4 (it animates in the client).
