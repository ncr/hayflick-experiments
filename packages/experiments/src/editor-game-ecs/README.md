# Editor + Game (ECS)

## Goal
Combine level editing and ECS gameplay in one experiment with explicit bake boundaries.

## Hotkeys
- `F5`: bake current `LevelModel` and enter `GAME` mode.
- `Escape`: return to `EDITOR` mode (keeps `LevelModel` intact).
- `Ctrl+S` (EDITOR): save `LevelModel`.
- `K` (GAME): save game save.
- `L` (GAME): load game save.
- `1`/`2`/`3`/`4` (EDITOR): wall / walkable / door / erase door.
- `R` (EDITOR): rotate new door placements (90 deg steps).
- `Q` / `E`: rotate camera in 90 deg steps.
- `Mouse wheel`: zoom (or trackpad pan).
- `Middle mouse` or `Space + drag`: pan.

## Data Flow
`LevelModel` -> `bakeLevel(...)` -> mutable `LevelResource` -> ECS world + systems.

The bake step creates derived walkability arrays and an ECS-facing `isBlocked(x,y)` API. Door toggles at runtime call `levelResource.setBlocked(cellX,cellY,blocked)` so movement systems immediately see changes.

## Save Keys
- Level model: `editor_game_ecs_level_model_v1`
- Game save: `editor_game_ecs_game_save_v1`
