# Level Builder

## Goal
Prototype an isometric orthographic level editor for 1m terrain tiles and room-building tilesets.

## Current Slice
- Flat terrain with a 1m x 1m construction grid.
- Orthographic isometric camera with pan, zoom, and 90-degree rotation.
- Simple but recognizable meshes for walls, windows, and doors.
- Doors support explicit `closed` and `open` representation.
- Automatic connector posts at wall joins (corners, T-junctions, and crosses).
- Terrain paint brushes for `floor` and `grass`.
- ECS-ready bake payload + `LevelResource` adapter helpers for future runtime experiments.

## Controls
- `LMB drag`: paint using active brush/tool.
- `RMB drag`: temporary erase.
- `MMB drag` or `Space + LMB drag`: pan.
- `Mouse wheel`: zoom.
- `Trackpad two-finger scroll`: pan.
- `Pinch` / `Ctrl+wheel`: zoom.
- `Q` / `E`: rotate view in 90-degree increments.
- `1` / `2`: wall / window brushes.
- `3` / `6`: door closed / door open brushes.
- `4` / `5`: terrain brushes (floor / grass).
- `D` / `X`: switch tool (draw/erase).
- `B`: bake current layout for ECS preview (logs JSON payload + probes).
- `C`: clear all structures.
- `V`: clear all grass overrides (reset to floor).

## Bake Notes
- `bake.ts` defines `LevelBuilderBake` schema and conversion helpers.
- `createEcsLevelResourceFromBake(...)` produces an ECS `LevelResource` shape.
- This is a compatibility prep step; final runtime baking pipeline can be built in a dedicated experiment.
