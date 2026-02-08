# Editor + Game (ECS)

## Goal
Combine level editing and ECS gameplay in one experiment with explicit bake boundaries.

## Hotkeys
- `F5`: bake current `LevelModel` and enter `GAME` mode.
- `Escape`: return to `EDITOR` mode (keeps `LevelModel` intact).
- `Ctrl+S` (EDITOR): save full editor state (`LevelModel` + terrain overrides/default/seed).
- `K` (GAME): save game save.
- `L` (GAME): load game save.
- `D` / `X`: draw / erase tool.
- `1..8`: wall, window, door closed, floor, grass, door open, road, sidewalk.
- `G`: grass-fill rectangle mode.
- `9`: building-footprint rectangle mode.
- `Shift + drag` (EDITOR): temporary grass-fill rectangle.
- `R` (EDITOR): rotate new door placements (90 deg steps).
- `Q` / `E`: rotate camera in 90 deg steps.
- `Mouse wheel`: zoom (or trackpad pan).
- `Middle mouse` or `Space + drag`: pan.
- `Right mouse drag` (EDITOR): temporary erase stroke.

## Data Flow
`LevelModel` + terrain overrides -> `bakeTileLevel(...)` -> mutable `LevelResource` -> ECS world + systems.

The bake step creates derived walkability arrays and an ECS-facing `isBlocked(x,y)` API. Door toggles at runtime call `levelResource.setBlocked(cellX,cellY,blocked)` so movement systems immediately see changes.

## Shared Core
This experiment now uses `@common/level-editor` for:
- `LevelModel` types + editing helpers.
- Tile-level bake helpers that generate mutable grid `LevelResource`.
- Shared editor structure meshes (walls/windows/doors) so visuals stay consistent with level-builder.

## Save Keys
- Level model: `editor_game_ecs_level_model_v3`
- Game save: `editor_game_ecs_game_save_v3`
