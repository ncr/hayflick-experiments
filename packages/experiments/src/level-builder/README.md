# Level Builder

## Goal
Prototype an isometric orthographic level editor for 1m terrain tiles and room-building tilesets.

## Current Slice
- Flat terrain with a 1m x 1m construction grid.
- Orthographic isometric camera with pan, zoom, and 90-degree rotation.
- Brush-based wall placement (`wall`, `window`, `door`) on grid edges.
- Automatic connector/junction meshes at joins (corners, T-junctions, and crosses).
- Mouse + touchpad-friendly interaction pass for layout blocking.

## Controls
- `LMB drag`: draw using active brush/tool.
- `RMB drag`: temporary erase.
- `MMB drag` or `Space + LMB drag`: pan.
- `Mouse wheel`: zoom.
- `Trackpad two-finger scroll`: pan.
- `Pinch` / `Ctrl+wheel`: zoom.
- `Q` / `E`: rotate view in 90-degree increments.
- `1` / `2` / `3`: switch brush (wall/window/door).
- `D` / `X`: switch tool (draw/erase).
- `C`: clear layout.

## Next Steps
- Add room/floor fill tools and tile painting.
- Add parametric wall style sets and true tileset asset loading.
- Add metadata + export format for runtime gameplay use.
