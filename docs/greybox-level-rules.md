# Greybox Level + Render Rules

This is the consolidated source-of-truth contract for semantic greybox
levels, grid placement, official units, and game-render texel scale.

Executable sources:

- Greybox catalog: `packages/common-level-editor/src/greybox-catalog.json`
- Unit constants: `packages/common-level-editor/src/constants.ts`
- Render contract: `packages/common-render/src/iso-contract.ts`
- Historical GLB rules: `assets/tilesets/_rules/general.tileset-rules.json`

## Coordinate Vocabulary

- `u` is the official level unit.
- `1u = 128cm = 1.28m`.
- `1u` is exactly one grid cell edge.
- Ground plane axes are `X` and `Z`.
- Vertical/up axis is `Y`.
- In the current Three.js greybox/editor scene, `1u = 1.28` Three.js world units, so `1` Three.js world unit = `100cm`.

Conversions:

| Quantity | In `u` | In cm | In Three.js scene units |
| --- | ---: | ---: | ---: |
| `1u` | `1` | `128` | `1.28` |
| `1cm` | `1/128 = 0.0078125` | `1` | `0.01` |
| `1` Three.js scene unit | `0.78125` | `100` | `1` |

## Grid

- Grid cells are `1u × 1u`.
- Grid coordinates are integer `(x, z)` cell indices on the ground plane.
- `grid.origin` is the world position of grid vertex `(0, 0)`.
- `grid.tileSize` is `1u` in the active world coordinate system.
- In `map-editor-2d`, `grid.tileSize = 1.28` because the editor stores Three.js world positions.

Placement formulas in official `u` coordinates:

| Anchor class | Grid element | World position |
| --- | --- | --- |
| `cell_center` | cell `(x, z)` | `(x + 0.5, 0, z + 0.5)` |
| `edge_midpoint` horizontal | edge `(ax, az) -> (bx, bz)` | `((ax + bx) / 2, 0, az)` |
| `edge_midpoint` vertical | edge `(ax, az) -> (bx, bz)` | `(ax, 0, (az + bz) / 2)` |
| `vertex` | vertex `(x, z)` | `(x, 0, z)` |

Placement formulas with `grid.origin` and `grid.tileSize`:

```ts
cell_center = origin + (cell + 0.5) * tileSize
edge_midpoint = origin + ((a + b) / 2) * tileSize
vertex = origin + vertex * tileSize
```

## Game Render Projection

The game render path uses the locked `ISO_VIEW_CONTRACT`.

- Projection: orthographic isometric 2:1.
- Pitch: `π/6` (`30°`).
- Base yaw: `π/4` (`45°`), with quarter-turn rotations around Y.
- Scale constant: `R = 32√2` low-resolution pixels per `1u` before axis projection.
- Reference pair: `fixedRenderHeight = 256`, `baseOrthoHeight = 4√2`.
- The low-resolution sampling grid is stable across zoom. Zoom scales/crops the output; it must not rebuild the low-res grid.

Ground-plane projection of one grid unit:

| World movement | Low-res game pixels |
| --- | ---: |
| `1u` along `X` or `Z` | `32px` horizontal, `16px` vertical |
| `1u` along `Y` | `16√6px ≈ 39.1918px` vertical |

Top-down tool views and side tool views may use `PixelPerfectPane` with
custom framing. They are tools, not the canonical game render path.

## Texel Scale

In this document, one render texel means one low-resolution game pixel in
the pixel-perfect render target. Atlas texels intended to map 1:1 to the
game render should use these same scales.

Canonical iso game-render texel scale:

| Axis | `px` per `1u` | `u` per texel | cm per texel |
| --- | ---: | ---: | ---: |
| Ground `X` | `32` horizontal | `1/32 = 0.03125u` | `4cm` |
| Ground `Z` | `32` horizontal | `1/32 = 0.03125u` | `4cm` |
| Vertical `Y` | `16√6 ≈ 39.1918` vertical | `1/(16√6) ≈ 0.0255155u` | `8/√6 ≈ 3.266cm` |

Ground-plane vertical screen foreshortening is separate from texture density:
the same `1u` ground edge appears as `16px` on the screen vertical axis in
the 2:1 iso projection, but the ground material texel scale still derives
from the `32px` horizontal contract: `1 texel = 4cm = 0.03125u`.

Minimum authored greybox detail:

- Minimum: `2` ground-axis texels.
- In official units: `2/32u = 0.0625u`.
- In centimeters: `8cm`.

Current executable catalog note:

- `greybox-catalog.json` currently validates `minDetailCm = 4cm`, which is
  one ground-axis render texel. Author new gameplay-facing greybox details at
  `8cm` or larger unless deliberately testing sub-detail behavior.

## Greybox Piece Rules

- Greybox pieces are semantic placeholders first, final-art meshes later.
- The same geometry can appear as different pieces if gameplay semantics differ.
  Example: grass and asphalt use the same slab geometry but are separate
  definitions because their terrain semantics differ.
- Placement must use anchor class and logical footprint, not visual envelope.
- Collision derives from semantic state and authored collision boxes.

## Wall Tile

`wall_solid` is one edge-anchored wall tile.

Official-unit dimensions:

- Length: `1u`
- Height: `2.1875u`
- Thickness: `0.25u`

Centimeter dimensions:

- Length: `128cm`
- Height: `280cm`
- Thickness: `32cm`

Three.js scene dimensions:

- Length: `1.28`
- Height: `2.8`
- Thickness: `0.32`

Anchor and local placement:

- Anchor class: `edge_midpoint`
- Local center: `[0u, 1.09375u, 0u]`
- Local size: `[1u, 2.1875u, 0.25u]`
- Horizontal walls run along local `+X`; vertical walls are rotated `90°` around Y.

Gameplay semantics:

- `kind`: `wall`
- `blocksMovement`: `true`
