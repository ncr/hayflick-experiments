# Settlement Builder (FO4-inspired)

## Goal

Prototype an in-game settlement editor with a Fallout-style build flow:

- Click-to-place ghost previews in `EDITOR`
- Core kit: walls/windows/doors + ground paint + saved Forge props
- Prop preview uses transparent real meshes, placement uses Rapier-based drop settling, and prop snap can be toggled on/off
- Prop placement/drop preview always uses simplified proxy collider meshes for fast editor responsiveness
- Contextual build catalog tabs (`Structures` / `Terrain` / `Props`) so only relevant tools are shown
- Visual prop browser with search, thumbnail cards, and quick prop inspector badges (instead of a text dropdown)
- `F5` bake to ECS runtime and walk the result in `GAME`

## Hotkeys

- `F5`: enter `GAME` with current bake.
- `Escape`: return to `EDITOR`.
- `Ctrl+S` (EDITOR): save editor state.
- `Ctrl+Z` / `Ctrl+Y` (EDITOR): undo / redo.
- `K` / `L` (GAME): save / load game save.
- `D` / `X` (EDITOR): Build / Scrap mode.
- `1..8`: wall, window, door closed, floor, grass, door open, road, sidewalk.
- `R` (EDITOR): rotate pending prop placement.
- `N` (EDITOR): toggle prop snap to grid.
- `Q` / `E`: rotate camera in 90° steps.
- `Mouse wheel`: zoom (`Ctrl+wheel` pinch-like zoom).
- `Middle mouse` or `Space + drag`: pan.
- `Right click` (EDITOR): cancel pending prop placement.

## Save Keys

- Editor autosave: `settlement_builder_editor_v1`
- Game save: `settlement_builder_game_v1`
