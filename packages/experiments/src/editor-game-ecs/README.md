# Editor + Game (ECS)

## Goal

Combine level editing and ECS gameplay in one experiment with explicit bake boundaries.

## Hotkeys

- `F5`: bake current editor state and enter `GAME` mode.
- `Escape`: return to `EDITOR`.
- `Ctrl+S` (EDITOR): save full editor state (terrain + edge structures).
- `K` (GAME): save game save.
- `L` (GAME): load game save.
- `D` / `X`: draw / erase tool.
- `1..8`: wall, window, door closed, floor, grass, door open, road, sidewalk.
- `G`: grass-fill rectangle mode.
- `9`: building-footprint rectangle mode.
- `Shift + drag` (EDITOR): temporary grass-fill rectangle.
- `Q` / `E`: rotate camera in 90 deg steps.
- `Mouse wheel`: zoom (or trackpad pan).
- `Middle mouse` or `Space + drag`: pan.
- `Right mouse drag` (EDITOR): temporary erase stroke.

## Data Flow

Terrain overrides + edge structure segments -> `bakeLevelForEcs(...)` -> mutable `LevelResource` -> ECS world + systems.

The bake step creates derived walkability arrays and an ECS-facing `isBlocked(x,y)` API. Door toggles at runtime call `levelResource.setBlocked(...)` for both cells adjacent to the door edge so movement systems immediately see changes.

## Shared Core

This experiment now uses `@common/level-editor` for:

- Shared bake types/helpers (`LevelBuilderStructureSegment`, `bakeLevelForEcs`).
- Mutable grid `LevelResource` construction.
- Shared editor structure meshes (walls/windows/doors) so visuals stay consistent with level-builder.

## Save Keys

- Level model: `editor_game_ecs_level_model_v4`
- Game save: `editor_game_ecs_game_save_v4`
