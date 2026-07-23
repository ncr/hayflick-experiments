# HANDOFF — in-game editor ("edit when paused, resume") — 2026-07-23

Status: **directive captured, design open**. Owner: Jacek. For a fresh
context to pick up. Read `docs/VISION.md` (binding), `ARCHITECTURE.md`,
and `docs/AGENT_LEARNINGS.md` before deciding anything.

## The owner's ask (2026-07-23, verbatim intent)

> the game should allow for editing of about everything possible. and the
> ui for that needs to be super easy to use and beautiful. like the map
> editor, i mean place a wall here, etc. perhaps the pause menu can be
> used for that: edit game when it is paused and then just resume. this
> is quite a nice coherent idea - at least i think that.

So: **pause = edit mode**. ESC already owns pause; editing happens in the
frozen world, resume continues play. The owner explicitly likes the
coherence of that framing — treat it as the design anchor, not one option
among many.

## Why this fits everything we already believe

- VISION's process rule: the owner playtests ONLY via in-game menus (ESC),
  never CLI. An editor living inside the pause surface IS that rule taken
  to its conclusion — the owner authors the same way he plays.
- The gym is THE one hand-authored level (owner directive 2026-07-12,
  no generators, no seeds). An editor is the owner's hand-authoring tool —
  it does not reintroduce proc-gen; it replaces agent-mediated level edits
  ("place a wall here" stops being a code change).
- The crack lab (d7c3ec4 + the 2026-07-23 heterogeneous rework) already
  prototyped the whole interaction grammar: click a thing in the world
  (ray-pick), a pretty panel replaces the hamburger, drag knobs, the world
  updates live, click away to dismiss. "Select anything → edit its
  properties" is that pattern generalized.

## Machinery inventory (what exists to build on)

| Piece | Where | Relevance |
|---|---|---|
| ESC game menu + settings sliders | `rt-viewer/src/menu.rs` | The UI shell + widget style; has a test-pin culture (see the look-row pin) — the editor gets the same treatment |
| Ray-pick + knob panel | `rt-viewer/src/crack.rs` (`crack_click`, panel in menu.rs) | Selection + property-panel pattern; `iso_core::window_px_to_ray` |
| Live material stream | `RenderBackend::set_material_pad` | Property edits with zero rebuild cost |
| Full scene rebuild | `RenderBackend::rebuild_scene` + probe rebake | Geometry edits (place/move/delete). Rebake: ~115 ms on RTX/Vulkan, **seconds on the M2/Metal** — per-edit rebake latency on the Mac is a real design constraint (debounce? rebake on resume? incremental?) |
| Rebuild identity check | `LOOK_SWITCH` pattern | The proof template that runtime rebuild == direct boot; an editor edit followed by save/reload must pass the same kind of check |
| The level itself | `house-game::gym::sim::gym_level` + `rt-viewer/src/gym_scene.rs` | Currently hand-authored IN CODE (headless crate + viewer mesh dress); piers carry per-box materials (`add_box_world`), `GymMeta.piers` |
| Grid discipline | `iso-core` (`Projection`, clean-size validator) | Everything placed must sit on the 0.1-wu ARCHITECTURE grid (trimetric is the game projection); the validator exists — use it at edit time, not after |
| Demo/LEVELS plumbing | `rt-viewer/src/demos.rs` | How alternate boot states are declared today |

## The load-bearing design decision: level as data

Today the gym level is Rust code in `house-game` (which must stay headless
and GPU-free — ARCHITECTURE boundary). An editor needs the level to be
**data the game can write back**. Recommended direction (decide in the new
context, don't inherit blindly): a level file (RON or similar) in-repo,
loaded by `gym_level`, saved by the editor, diffed in git like any other
authored asset. That keeps: headless tests (they load the same file),
determinism (the file is the truth, no wall-clock/RNG), and the owner's
edits as reviewable commits. The alternative — editor state living only in
memory / codegen back into Rust — fights git and the headless boundary.

Watch items that fall out of this:
- **Determinism**: gym traces + `state_hash` pins assume the level. An
  edited level invalidates recorded traces — decide policy (traces carry a
  level hash? editor bumps a level version?).
- **Sim/render split**: an edit must update BOTH the sim world (collision,
  in house-game) and the render scene (BLAS + probes, in rt-probe/viewer)
  through the rt-viewer adapter — nothing may make rt-probe and house-game
  see each other (ARCHITECTURE rule).
- **Player validity**: deleting the wall under the player / placing one on
  top of him while paused — define the nudge/respawn rule early.
- **Windows rule**: polana's tinted-glass windows live on even world-cell
  columns with real wall openings (see CLAUDE.md) — the editor must
  preserve that invariant when placing/moving building walls, or defer
  window-bearing walls past v0.

## Scope ladder (proposal, cut where the owner says)

- **v0**: ESC menu gains EDIT. Select / move / delete / place for wall
  piers + lamps + grass tufts, grid-snapped, with the crack knobs as the
  wall's property panel (they already work per-pier). Save to the level
  file; resume returns to play. Owner playtest + clip = the gate.
- **v1**: building walls with doorway/window invariants, spawn point,
  undo (the file format should make undo trivial — keep an edit journal).
- **v2**: "about everything possible" — look knobs per selection, lamp
  light properties, floor/terrain dress, multiple level slots.

## UI bar (the owner set it high)

"Super easy to use and beautiful." The menu.rs widget language + the crack
panel are the seed; the editor must feel like the same product, not a dev
tool bolted on. Fewest possible modes; direct manipulation (click, drag,
ghost preview) over form-filling. Anything the owner must compare gets a
menu row (VISION rule) — e.g. edit-grid on/off, snap size.

## Open Metal duty (context for a Mac session)

The 2026-07-17 crack-lab MSL block AND the 2026-07-23 heterogeneous-aging
rework (per-segment damage field + `faultAt` structural cracks + top-cap
crossing) are blind line-for-line twins verified only on Vulkan — first
Mac session boots `LEVEL="crack lab"` and eyeballs against the Vulkan
SHOTs (see CLAUDE.md). The editor work will also feel the Metal rebake
latency (table above) — measure before designing the edit-loop cadence.
