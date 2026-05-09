# Wall Kit Contract

This is the source-of-truth contract for wall-kit pivots, part composition, and geometry ownership.

For the current procedural greybox level pieces, use
`docs/greybox-level-rules.md` instead. This document remains the historical
Blockstudio/GLB wall-kit contract.

## Required Parts

The minimal kit is:

- `wall`
- `door`
- `window_left`
- `window_middle`
- `corner`

Optional parts (on a per-tileset basis, gated by flags in `tileset.json`):

- `floor_tile` — enabled with `kitSpec.includeFloorTile: true`. Disable for wall-only kits whose ground uses a dedicated ground tileset.
- `window_right` — enabled with `kitSpec.includeWindowRight: true`. Omit when the window family is symmetric (`leftWidth == rightWidth` and the same trim on both sides) — the consumer can mirror `window_left` 180° around its depth axis.
- `end_cap` — enabled with `kitSpec.includeEndCaps: true`. Omit when wall runs are always terminated by corners and never end in free space.

### Tile vocabulary per kit (current state)

| kit id | `floor_tile` | `window_right` | `end_cap` | rationale |
| --- | :---: | :---: | :---: | --- |
| `greek_island_white` | ✓ | — | — | Symmetric `vertical_panel` window family; rooms are closed by corners, so no end caps needed |
| `desert_sandstone`   | — | — | — | Ground uses the shared `ground_tiles` kit; otherwise same rationale as greek |
| `ground_tiles`       | n/a (every tile is a floor) | n/a | n/a | Ground kit has a different vocabulary model |

Disabled parts are deliberate choices, not placeholders. When adding a new kit with an asymmetric window family or open-ended walls, flip the relevant flag back on and rebuild.

## Anchor Rules

These are logical anchors. Overlap and chamfer never move them.

- `floor_tile`: center of the first logical cell
- `wall`: midpoint of the first logical edge segment
- `door`: midpoint of the first logical edge segment
- `window_left`: midpoint of the first logical edge segment
- `window_middle`: midpoint of the first logical edge segment
- `window_right`: midpoint of the first logical edge segment
- `corner`: owning grid vertex

`anchorLocal` must stay `[0, 0, 0]` for every exported tile.

## Child Pivot Rules

Tile root pivots are the logical anchors above. Child element pivots are not the tile anchor unless the child itself is anchored there.

- floor body: same as tile root, at the bottom-center under the slab
- wall body: same as tile root
- door frame pieces: bottom-center of each piece
- door leaf group: hinge edge
- door leaf body: same as hinge group
- window wall strips: bottom-center of each strip
- window glass: bottom-center of the pane
- corner body: same as tile root because the whole part is anchored on the owning vertex

Current pivot-first implementation:

- `wall` uses a single cube
- door frame pieces use cubes
- window wall strips use cubes
- corner uses one filled corner body

If chamfers are reintroduced later, they must preserve the same local origins and local envelopes.

## Geometry Rules

- Logical wall span is `128`
- Wall height is `280`
- Wall thickness is `32`
- Floor thickness is `6`
- Wall overlap is `1`
- Wall chamfer is `2`
- Floor overlap is `1`
- Floor chamfer is `2`

Overlap and chamfer affect only the mesh envelope. They do not change logical occupancy or pivots.

Floor base `y=0` is the same level as wall base `y=0`.
The floor slab grows upward from that plane.

## Window Composition

Each window tile is exactly one wall unit wide.

- `window_left`: wall strip on the left, glass on the right
- `window_middle`: full glass
- `window_right`: glass on the left, wall strip on the right

For the current profile:

- left/right wall strip width: `16`
- glass thickness: `4`
- full tile width: `128`

Expected local x-ranges relative to the tile root:

- `window_left_left_wall`: `-65..-48`
- `window_left` glass: `-48..64`
- `window_middle` glass: `-64..64`
- `window_right` glass: `-64..48`
- `window_right_right_wall`: `48..65`

## Door Composition

The door tile is one wall unit wide and stays anchored like a wall tile.

- left frame strip local x-range: `-65..-44`
- right frame strip local x-range: `44..65`
- header local x-range: `-46..46`
- hinge pivot: `[-45, 0, -10.5]`

## Corner Composition

The corner is a single filled L-prism anchored on the owning grid vertex.

The outside vertex of the L sits at the cell corner (anchor point). Both legs run inward into one quadrant of the owning cell — by convention, the +X / +Z quadrant. Each leg is `wallThickness` wide and `baseUnit` long. The inner elbow sits at `(wallThickness, wallThickness)` relative to the anchor; it is not cut back to a triangle.

Expected local envelope, relative to the tile anchor (where `baseUnit = 128`, `wallThickness = 32`):

- x: `0..128`
- z: `0..128`

No geometry extends into neighbouring cells.

## Architecture

The geometry contract must not be interpreted inside the Blender bridge.

Pipeline:

1. `src/shared/kit.js`
   Normalizes the kit spec and part catalog.
2. `src/shared/scene-plan.js`
   Resolves the spec into explicit geometry, group origins, child origins, and manifest seed data.
3. `src/server/tools.js`
   Builds the scene plan and sends it to the bridge.
4. `blender/geometry.py` + `blender/export.py`
   Renders the scene plan, applies materials, captures, and exports. The Blender bridge stays geometry-agnostic.

## Regression Guardrails

The executable contract lives in:

- `test/scene-plan.test.js`
- `test/tools.test.js`

If a pivot or placement changes, these tests should fail before the GLB output drifts again.
