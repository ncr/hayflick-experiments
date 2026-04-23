# Outline Walls

Demo of `PixelPerfectOutlinedView` from `@common/render`. Tiles several wall
GLBs and renders them so adjacent segments read as a single mesh — the shared
outline pipeline handles depth + normal edge detection plus id-based
suppression; this experiment just drives it.

## Pipeline (owned by `@common/render`)
1. Color — scene rendered into the color target with PBR materials and
   `ACESFilmicToneMapping`.
2. Normals — scene re-rendered with `MeshNormalMaterial` (geometric normals
   only, texture-level normal maps ignored so crease detection tracks shape,
   not bumps).
3. Linear depth — `LinearDepthMaterial` writes view-z into a HalfFloat
   target (ortho-safe workaround for three.js depth quirks).
4. IDs — meshes swap to per-group `OutlineGroupMaterial` via
   `view.assignOutlineGroup`.
5. Composite — `EdgeDetectionMaterial` reads all four inputs and writes the
   final image; handed to the view as the output source.

Tone mapping is disabled around passes 2–5 so auxiliary buffers keep raw data.
All of this is encapsulated inside `PixelPerfectOutlinedView`; the experiment
just builds scenes and calls `assignOutlineGroup`.

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
- `outlineDebug=<mode>` — one of `final`, `color`, `depth`, `normals`,
  `ids`, `edges`, `depth-edges`, `normal-edges`. Also cycles with `D` at
  runtime (see `EdgeDetectionDebugMode` for the typed equivalent).
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
