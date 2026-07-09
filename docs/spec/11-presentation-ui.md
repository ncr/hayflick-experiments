# 11 · Presentation, Camera & UI

> Connecting the salvaged large-pixel iso GI pipeline to a game whose simulation is largely
> INVISIBLE (perception, memory, deduction). The presentation's hardest job is making that legible
> and fair without betraying the aesthetic. All choices locked round 13.

## Reading the real-time stealth state — diegetic-first + minimal cues (locked)

- **NPC alertness** shows mostly through **in-world cues**: posture, head-turn, a spoken "?"/"!",
  breaking off to investigate, calling out. The alertness ladder (08) is meant to be *watched.*
- **Your visibility** is read from the **rendered light/shadow** — you can *see* you're in the
  dark — plus a **minimal exposure cue** when a read is ambiguous. **Review-pass note:** detection
  itself reads the sim's own CPU light field (05a), never the GPU image; the GI is that field's
  *visualization*. The two must stay **perceptually consistent** — what looks dark must BE dark to
  the sim — which is a standing tuning duty of this module (feel-checked at M2, module 12).
- Backed by **subtle indicators only when needed** for fairness; no always-on bars over every NPC.
  Trusts the GI and animation to carry the read.

## Camera & multi-floor occlusion — fixed iso + auto reveal (locked)

- **Fixed 2:1 iso, no rotation** — preserves the pixel-perfect contract and the golden sets
  (CLAUDE.md). The salvaged look is non-negotiable here.
- **Occlusion via an extended dollhouse-reveal:** walls and roofs above/around the player **fade or
  cut away** so you always see your **current floor** and the action. This generalises the existing
  reveal to the multi-floor interiors of module 03.
- **This is the renderer's single biggest new task** (module 03 flagged it; it's why rooftop-running
  is out for v1). It must be a **deterministic function of player floor/position** and therefore
  **golden-testable**, and ported in **lockstep across the GLSL and Metal backends** (CLAUDE.md).

## Deduction transparency — diegetic signals + a readable event LOG + a planning board (locked)

The invisible engine is surfaced three ways so it's **fair, learnable, masterable** (user: option 1
**plus** a Fallout 1/2-style readable log):

1. **Diegetic in-world signals:** overhear gossip, read a **wanted-poster showing the CURRENT
   description**, watch the investigator work a scene, catch a fence's warning.
2. **An explicit, readable event LOG (Fallout 1/2 style).** A scrolling, plain-language chronicle of
   the world events relevant to you — believable and explicit, e.g.:
   - *"A neighbour noticed a hooded figure lingering by the silversmith at dusk."*
   - *"At dawn the silversmith found his strongbox forced, and reported it to the watch."*
   - *"Word spreads: the watch now seeks a man of your build in a green hood."*
   - *"The fence Hala studied your face a moment too long."*

   The log is a **human-readable projection of the same deterministic sim-event stream** that drives
   traces — nothing in it is invented; it reflects *real* sim events, which is exactly what makes the
   deduction engine feel fair rather than arbitrary. It is the engine's reasoning, rendered as prose.
3. **A "what's known about me" planning board** at your **in-town safehouse** (module 02): active
   **Cases**, your current **wanted description(s)**, and **who personally recognizes** your face —
   the strategic summary. (Reviewable between runs at the persistent lair as a retrospective.)

## UI philosophy — diegetic-first minimalism, pixel-native (locked)

- Keep the HUD **minimal**; push information into the **world** (posters, NPC behavior, the board).
- All HUD and iconography is **pixel-native at the large-pixel scale** — chunky, legible icons,
  sparse text — so UI and world read as **one aesthetic.**
- The **log** and the **planning board** are the primary "screens," both styled pixel-native and
  readable at the render scale.

## Determinism & backend notes

- The auto-reveal is deterministic and **gated by `bin/golden`**; GLSL↔Metal stay in lockstep.
- The event log derives purely from deterministic sim events (no wall-clock, no RNG of its own) — a
  replay reproduces the same log.
- Mob-free/UI-free scenes must remain byte-identical per CLAUDE.md; UI compositing follows the
  existing per-low-res-texel post rules before the integer NEAREST upscale.
