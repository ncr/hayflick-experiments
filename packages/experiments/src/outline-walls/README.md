# Outline Walls

## Goal
Tile several wall GLBs and render them so that adjacent segments read as a
single mesh — depth + normal edge detection outlines the shared silhouette
while seams between segments that share an outline group id are suppressed.
The color pass keeps the original PBR materials from the GLBs (base color,
normal map, metallic-roughness) so the wall reads as a textured material
rather than a flat fill, and an orbiting point light sweeps across the face
so the normal-map relief and roughness response are visible.

## Passes
1. Color — scene rendered into `colorTarget` with the GLB's PBR materials
   and `ACESFilmicToneMapping` on the renderer.
2. Normals — scene rendered with `MeshNormalMaterial` into `normalTarget`
   (geometric normals only; the normal map is intentionally ignored here so
   crease detection tracks geometry, not texture bumps).
3. IDs — wall meshes swapped to per-group id materials, rendered into
   `idTarget`.
4. Composite — edge-detect post shader reads color + depth + normal + id and
   writes to `postTarget`, which is handed to the view as the output source.

Tone mapping is disabled around passes 2–4 so auxiliary buffers keep raw data.

## Edge kinds
The composite shader fires an edge when any of three tests match:

- **Depth edge** — silhouettes and deep creases (large `dC − dN`).
- **Normal edge** — geometric creases where neighbouring normals disagree
  (the corner column's convex outer edge lives here — two faces at 90°
  are enough to fire this, regardless of outline group id).
- **Id edge** — coplanar, same-normal seams between *different* outline
  groups. Available as a tool for scenes that want piece-boundary seams
  drawn even when the geometry is flush, but not used by either built-in
  scene: same-id, same-normal neighbours are suppressed so tiled walls
  read as one continuous silhouette.

## Outline groups
Every room tile shares one outline id so the tile boundaries (wall-to-corner,
wall-to-door, corner-to-window) stay invisible and only genuine geometric
creases and silhouettes draw. The strip scene shares one id too, or one id
per instance with `?outlineGroups=split` to verify the mask is at work.

## URL params
- `outlineDebug=N` — 0=final, 1=color, 2=depth, 3=normal, 4=id, 5=edgeOnly,
  6=depthEdgeOnly, 7=normalEdgeOnly. Also toggled with `D` at runtime.
- `outlineZoom=N` — initial pixel zoom (1–8).
- `outlineTileset=greek_island_white|desert_sandstone` — which wall kit.
- `outlineScene=strip|room` — `strip` (default) = 3 adjacent wall segments for
  the minimal outline-suppression test; `room` = 3×3 mockup using every kit
  piece (floor, wall, door, windows, corners) to showcase PBR + outline on a
  complete structure.
- `outlineGroups=split` — (strip only) give each wall a distinct id so internal
  seams stop being suppressed (confirms the mask is doing work).
- `outlineStagger=1` — push the middle wall 8 cm forward to create a real
  depth discontinuity at the wall interface.
- `outlineMask=0` — disable the id suppression to show all seams.
- `outlineReadback=1` — enable GPU read-back of the low-res post target for
  pixel-accurate test inspection.

## Visual confirmation
`scripts/screenshot-outline-walls.mjs` captures the running experiment via
Playwright. Flags: `--port`, `--zoom`, `--debug`, `--tileset`, `--wait`, `--out`.
