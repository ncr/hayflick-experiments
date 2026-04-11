# Game consumer contract

Everything a downstream game loader needs to know about Blockstudio artifacts. Nothing here requires reading Blockstudio source. If you find a field in a manifest that is not listed here, treat it as unstable and do not rely on it.

## 1. Artifact layout

```
tilesets/<id>/artifacts/
  tileset.game.json                         # top-level metadata bundle
  kit/
    <id>.glb                                # whole-kit GLB (all tiles in one scene)
    <id>.manifest.json                      # kit manifest with per-part entries
  tiles/
    tiles.manifest.json                     # index of individual tile directories
    <tile>/<tile>.glb                       # one GLB per reusable tile
    <tile>/<tile>.manifest.json             # per-tile manifest (part + kit context)
```

- **What to ship**: Anything inside `artifacts/`. Do not ship `project/`.
- **Units**: Every GLB is exported with `1 glTF unit = 1 base cell = 128 cm`. Use `artifactTransform.authoringUnitsPerArtifactUnit` (always `128`) if you need to convert back to authoring coordinates.
- **Vertex attributes per primitive**: `POSITION`, `NORMAL`, `TEXCOORD_0`, `TANGENT`. All primitives have PBR materials with baseColor / normal / ARM maps embedded in the GLB.
- **Consumption model**: load the per-tile GLBs and render them at runtime. The pixel-art look is produced by the consumer (nearest-neighbour baseColor sampling + low-res render target + ortho 2:1 iso camera), not by pre-baked sprite frames.
- **Textures**: baseColor is pre-quantized to a small palette PNG for the pixel-art look; normal and ARM maps stay at their source resolution so PBR lighting (specular, AO, normal relief) works at full fidelity.

## 2. `tileset.game.json`

| Field | Type | Source/derived | Purpose |
| --- | --- | --- | --- |
| `schema` | string | source | Always `"blockstudio/tileset-game-metadata@1"`; bump = breaking |
| `generatedAt` | ISO string | derived | Build timestamp |
| `tileset.id` | string | source | Stable directory-name id |
| `tileset.name` | string | source | Human-readable label |
| `tileset.kind` | `"wall_kit"` \| `"ground"` | source | Determines which manifests exist |
| `rules.units.baseUnitCm` | number | source | Always `128` |
| `rules.units.exporterScale` | number | source | Always matches `baseUnitCm`; the GLB was divided by this |
| `rules.render.*` | object | source | Pixel contract — horizontal/vertical game pixels per base unit |
| `rules.defaults.*` | object | source | Canonical dimensions (`wallSpan`, `wallHeight`, `wallThickness`, …) |
| `rules.requiredParts.<kind>` | string[] | source | Minimum parts per kit kind |
| `rules.anchors.*` | object | source | Anchor class per part kind (see §4) |
| `profile.*` | object | source | Full tileset.json payload: geometry, render, textures, style, paths |
| `kit.*` | object | derived | Kit-level export pointers (file path, schema link) |
| `tiles[]` | array | derived | One entry per exported tile (name, kind, file path, anchor class) |

Use `tileset.kind` to pick between wall-kit and ground-kit consumption code paths.

## 3. Kit & tile manifest schema

Every kit GLB and tile GLB has a sibling `*.manifest.json`. Both share the same part-entry shape.

### Top-level fields (kit manifest)

| Field | Type | Notes |
| --- | --- | --- |
| `kitId` | string | Generation-time id; not stable across rebuilds |
| `name` | string | Kit name |
| `styleProfileId` | string | Internal style id |
| `parts` | `Part[]` | One per exported tile |
| `exampleRoom` | object \| null | Present only if example-room mode was used |
| `textures` | array | Currently always empty; reserved |
| `artifactTransform.format` | `"gltf"` | Always |
| `artifactTransform.authoringUnitsPerArtifactUnit` | number | Always `128` |
| `artifactTransform.artifactUnitsPerAuthoringUnit` | number | `1/128` |

### `Part` fields

| Field | Type | Space | What the loader does with it |
| --- | --- | --- | --- |
| `name` | string | — | Matches the sibling GLB filename under `tiles/<name>/<name>.glb` |
| `kind` | string | — | One of `wall`, `door_wall`, `window_module`, `corner`, `end_cap`, `floor_tile` |
| `role` | string \| null | — | Semantic role; mirrors `kind` for most parts (e.g. `window_left`, `window_right`) |
| `anchorClass` | `cell_center` \| `edge_midpoint` \| `vertex` | — | Grid placement class (see §4) |
| `anchorPolicy` | string | — | Always `first_logical_unit`; the anchor sits on the first logical unit the part occupies |
| `anchorLocal` | `[x, y, z]` | authoring units | Position of the tile's anchor within its own local space. **Always `[0, 0, 0]`** — every per-tile GLB is exported so the anchor sits at the origin |
| `sceneAnchor` | `[x, y, z]` | authoring units | Original position inside the catalog scene; useful as a debugging breadcrumb but ignore for gameplay placement |
| `logicalFootprint` | object | — | See §5. Use this for grid reasoning; never use `meshEnvelope` |
| `meshEnvelope` | `[width, height, depth]` | authoring units | Axis-aligned bounding box of the mesh. Use for culling and preview, never for placement |
| `dimensions` | `[w, h, d]` | authoring units | Logical dimensions; currently always equals `meshEnvelope` |
| `articulationType` | `"hinged"` \| `"fixed"` \| null | — | Hinges present if `"hinged"` |
| `hingeSide` | `"left"` \| `"right"` \| null | — | Which side the hinge is on (mirrors the door leaf accordingly) |
| `articulationPivot` | `[x, y, z]` \| null | authoring units | Hinge axis position relative to the tile anchor |
| `artifactAnchor` | `[x, y, z]` | **glTF units** | `anchorLocal / 128`; always `[0, 0, 0]` |
| `artifactSceneAnchor` | `[x, y, z]` | **glTF units** | `sceneAnchor / 128` |
| `artifactArticulationPivot` | `[x, y, z]` \| null | **glTF units** | `articulationPivot / 128` |

**Rule of thumb**: fields that start with `artifact*` are in glTF units (what you'll see when you load the GLB). All other coordinate fields are in authoring units. Multiply by `artifactTransform.artifactUnitsPerAuthoringUnit` (`1/128`) to convert.

### Per-tile manifest

Per-tile manifests have the same `artifactTransform` as the kit manifest and a single `part` object with the same shape as the entries in `kit.manifest.json#parts`, plus:

| Field | Purpose |
| --- | --- |
| `kitId`, `kitName` | The kit this tile belongs to |
| `generatedAt` | Build timestamp |
| `format` | Always `"glb"` |
| `textures` | Reserved; currently empty |

## 4. Anchor classes (grid placement)

The anchor class tells you where a tile sits in the grid. All three classes produce an `(x, y, z)` world position that becomes the tile's **world-space origin** after you load the GLB — remember: the tile's mesh is exported so `anchorLocal = [0, 0, 0]`, so setting the node's world position directly places the anchor.

| `anchorClass` | Grid element | World-space position for grid coordinates `(gx, gz)` |
| --- | --- | --- |
| `cell_center` | Center of a cell | `(gx * cellSize + cellSize/2, 0, gz * cellSize + cellSize/2)` — used by `floor_tile` |
| `edge_midpoint` | Midpoint of a cell edge | Midpoint of the edge between two adjacent cells — used by `wall`, `door`, `window_*`, `end_cap` |
| `vertex` | Grid vertex | `(gx * cellSize, 0, gz * cellSize)` — used by `corner` |

`cellSize = 1` in glTF units (equals one base cell == 128 cm).

### Rotation

Corners and walls come in a single canonical orientation. You rotate them at placement time:

- **Walls running along the X axis**: place as-is. The wall's width is along X, depth (thickness) is along Z, anchor at the edge midpoint.
- **Walls running along the Z axis**: rotate 90° around the Y axis.
- **Corners**: the canonical corner has its outside vertex at the origin, with the two legs running into the `+X / +Z` quadrant. Rotate 0°/90°/180°/270° around Y to place at any of the four room corners.

## 5. `logicalFootprint` shapes

| `type` | Fields | Meaning |
| --- | --- | --- |
| `cell` | `widthUnits`, `depthUnits`, `widthCells`, `depthCells`, `baseUnit` | Occupies `widthCells × depthCells` cells. `floor_tile` is always 1×1 |
| `edge_run` | `runUnits`, `runCells`, `baseUnit` | Occupies `runCells` edge segments along its orientation axis. Walls, doors, windows are all `runCells: 1` |
| `corner_vertex` | `xRunUnits`, `zRunUnits`, `xRunCells`, `zRunCells`, `baseUnit` | Occupies a single cell vertex; legs run one cell each in +X and +Z |

Always use `logicalFootprint` for grid math. The `meshEnvelope` is an axis-aligned bounding box of the rendered mesh and can be larger or smaller than the logical footprint depending on the part (for corners the L's bounding box equals one cell, but the filled area is only two `wallThickness × baseUnit` arms).

## 6. Articulation usage

Hinged parts (`articulationType: "hinged"`) carry an `articulationPivot` that is the hinge axis position relative to the tile anchor. The hinge runs parallel to the Y axis (vertical).

To animate a door:

1. Isolate the door leaf subtree inside the tile. In the kit GLB, the leaf is its own node named `door_leaf` — check the scene graph for a child whose name starts with `door_leaf`.
2. Translate the leaf so the hinge axis passes through the origin, rotate around Y, translate back. Or set the node's pivot directly if your engine supports it.
3. Use `artifactArticulationPivot` (in glTF units) as the hinge position.
4. `hingeSide` tells you which edge the hinge is on (`"left"` mirrors the leaf to the left side of the door tile).

Fixed windows (`articulationType: "fixed"`) don't animate. Non-articulated parts (`articulationType: null`) have no articulation data.

## 7. Consumption pattern

Runtime glTF loading (three.js, babylon.js, godot):

1. Load `tileset.game.json`.
2. For each entry in `tiles[]`, load the corresponding tile GLB.
3. For each grid cell/edge/vertex you want to populate, look up the part by `kind`/`role`, instantiate the loaded GLB, and set the instance transform according to the anchor rules in §4.
4. For hinged parts, wire up the leaf rotation as in §6.

Fields you care about: `name`, `kind`/`role`, `anchorClass`, `logicalFootprint`, articulation fields, file paths.

Fields you ignore: `sceneAnchor`, `artifactSceneAnchor`, `styleProfileId`, `profile.*` (authoring metadata).

### Pixel-art look at runtime

The "pixel-art with realistic PBR lighting" look is produced by the consumer, not by pre-baked sprites:

- Render to a low-resolution integer-scale render target, then upscale with nearest-neighbour.
- Set `mat.map.magFilter = mat.map.minFilter = NearestFilter` on the baseColor texture of every loaded mesh. Leave normal / ARM / roughness / metallic maps at their native filtering so PBR lighting stays crisp.
- Use an orthographic 2:1 iso camera (pitch 30°, yaw 45°) if you want the canonical Blockstudio camera.
- Light the scene with tone-mapped PBR lights (ACES / AgX + sRGB output) — the baked baseColor palette is small on purpose, so the lighting layer is what gives tiles their form.

The reference implementation is the map editor under `packages/experiments/src/map-editor-2d/` — see its `tileset-loader.ts` (texture filtering) and `index.ts` (lighting rig).

## 8. Gotchas

- **Always place by `logicalFootprint`, never by `meshEnvelope`.** A corner's `meshEnvelope` is `128 × 280 × 128` but its filled L only occupies `2 × wallThickness × baseUnit − wallThickness²`. Placement math must use the logical footprint so neighbours join cleanly.
- **`anchorLocal` is always `[0, 0, 0]`.** The tile is re-centered at export time. Don't compensate for it.
- **`sceneAnchor` / `artifactSceneAnchor` are catalog positions only.** They tell you where the tile sat in the catalog scene used for authoring previews. They have no game-side meaning.
- **Authoring vs artifact units**: fields named `artifact*` are in glTF units; everything else is in authoring units (`cm`). Convert with `artifactTransform.artifactUnitsPerAuthoringUnit = 1/128`.
- **Window symmetry**: some kits ship only `window_left` and `window_middle` (not `window_right`). If the kit's window family has `leftWidth == rightWidth` and the same trim on both sides, you can mirror `window_left` along its depth axis to get the right-end variant. See `docs/wall-kit-contract.md` Tile vocabulary per kit.
- **Textures at 1K are intentional.** You can downscale on import to your target; the source is deliberately oversized to leave headroom for zoomed-in / high-density presets.
- **The embedded materials are loadable but not necessarily final.** They use Polyhaven PBR maps chosen by the authoring team; if your game wants different materials, swap the glTF materials at load time. The embedded ones are placeholders with correct UVs and tangents.

## 9. Stability contract

Schema fields in this document are versioned by `schema: "blockstudio/tileset-game-metadata@1"`. A breaking change bumps the suffix. Fields not listed here are considered unstable and may be removed or renamed without a version bump.
