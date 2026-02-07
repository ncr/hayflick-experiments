# Level Builder

## Goal
Prototype an isometric orthographic level editor for 1m terrain tiles and room-building tilesets.

## Current Slice
- Flat terrain with a 1m x 1m construction grid.
- Orthographic isometric camera with pan, zoom, and 90-degree rotation.
- Simple blockout meshes for `wall`, `window`, and `door` brushes.
- Automatic connector posts at wall joins (corners, T-junctions, and crosses).
- Terrain paint brushes for `floor` and `grass`.
- Mouse + touchpad-friendly interaction pass for layout blocking.

## Controls
- `LMB drag`: paint using active brush/tool.
- `RMB drag`: temporary erase.
- `MMB drag` or `Space + LMB drag`: pan.
- `Mouse wheel`: zoom.
- `Trackpad two-finger scroll`: pan.
- `Pinch` / `Ctrl+wheel`: zoom.
- `Q` / `E`: rotate view in 90-degree increments.
- `1` / `2` / `3`: structure brush (wall/window/door).
- `4` / `5`: terrain brush (floor/grass).
- `D` / `X`: switch tool (draw/erase).
- `C`: clear all structures.
- `V`: clear all grass overrides (reset to floor).

## Next Steps
- Add room/floor fill tools and rectangle tools.
- Add parametric wall style sets and true tileset asset loading.
- Add metadata + export format for runtime gameplay use.
