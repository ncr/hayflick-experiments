# CLAUDE.md — @common/level-editor

Shared level-editor package: tile/structure data models, 3D mesh factories, collision baking, and editor UI scaffolding. Consumed by editor-mode experiments and the top-down map editor.

## Package Overview

```
src/
  constants.ts           — World-unit scale constants (1.28 units = 64px H / 32px V)
  model.ts               — Tile-grid level model (LevelModel) — legacy cell-based
  grid-level.ts          — Mutable grid resource (Uint8Array collision/nav)
  bake.ts                — Bake LevelModel → MutableGridLevelResource (legacy path)
  autotile.ts            — Cardinal-mask → shape+rotation (N=1 E=2 S=4 W=8)
  builder-bake.ts        — Builder-system bake: structures + terrain + colliders (v3 schema)
  structure-meshes.ts    — THREE.js mesh kit: walls, windows, doors, join posts
  editor-hud.ts          — Reusable editor HUD scaffold (panels, buttons, stats)
  editor-controls.ts     — Promoted editor toolbar (brush/tool/rect modes, keyboard hints)
  index.ts               — Barrel re-export of all modules
```

## Two Model Systems

There are two parallel level representations — understand which one you're touching:

| | **LevelModel** (model.ts + bake.ts) | **LevelBuilder** (builder-bake.ts) |
|---|---|---|
| Grid | `width * height` flat tile array (`TileType[]`) | `tiles * tiles` grid with `tileSize` + `origin` |
| Structures | Implicit — walls are tiles (`TILE_WALL = 1`) | Explicit edge segments between nodes (`ax,az → bx,bz`) |
| Structure types | Only wall/walkable | Wall, window, door (with open/closed state) |
| Terrain | None | Ground base (floor/grass/road/sidewalk/building) + overrides |
| Colliders | Derived from blocked cells | Derived from structure segments (rect for walls, door-specific for doors) |
| Schema | Raw JSON serialize/parse | Versioned (`schemaVersion: 3`) with strict parsing |
| Bake output | `BakedTileLevel` (grid resource + placements) | `LevelBuilderBake` (grid + terrain + structures + colliders) |

**LevelBuilder is the active system** for the top-down map editor. LevelModel is the legacy tile-grid system still used by some experiments.

## Coordinate Systems

- **World units:** `LEVEL_EDITOR_WORLD_UNIT = 1.28` (maps to 128 cm in-game)
- **Pixel mapping:** 64 px/unit horizontal, 32 px/unit vertical (2:1 isometric ratio)
- **Builder structures:** Defined as edges between integer grid nodes: `(ax, az) → (bx, bz)` — these are world-space X/Z, not pixel coords
- **Tile cells:** Integer grid coords `(x, z)` where each cell spans one `tileSize` in world space
- **Wall dimensions:** Height = `2.8 * worldUnit`, Thickness = `0.18 * worldUnit`

## Structure Mesh Kit

`createEditorStructureMeshKit()` returns a factory object (`EditorStructureMeshKit`) that shares geometry/material instances across all meshes it creates. Call `dispose()` to free GPU resources.

Key mesh types:
- **Wall segment** — Box geometry, oriented along X, supports trim at start/end
- **Window segment** — Lower wall + upper accent + transparent glass pane
- **Door segment** — Pivoting leaf on a group; `setDoorVisualOpen(door, bool)` animates
- **Join post** — L/T/+ shaped extrusions for wall intersections; selected by a 4-bit cardinal mask (`JOIN_MASK_NORTH|EAST|SOUTH|WEST`)
- **Wall block** — Isolated standalone wall tile (4 trimmed walls + 4 corner posts)

Wall material has a custom shader stripe band (orange accent at specific Y-pixel range). The `applyStripeBand` function patches the standard MeshStandardMaterial via `onBeforeCompile`.

## Baking Pipeline (Builder)

```
editor state (structures + terrain + grid config)
  → bakeLevelForEcs(input)
    → marks blocked cells from structure adjacency (skips open doors)
    → derives collider descriptors from structure segments
    → outputs LevelBuilderBake (schemaVersion: 3)
      → createEcsLevelResourceFromBake(bake) → LevelResource for ECS
```

Collider derivation (`deriveColliderDescs`):
- Solid segments (wall/window) → `"rect"` collider with wall thickness
- Door segments → `"door"` collider with placement ID, always `closed: true`
- Deduplication via edge keys (`levelBuilderEdgeKey`)

## Editor UI

The HUD (`editor-hud.ts`) and controls (`editor-controls.ts`) are decoupled:
- **EditorHud** provides layout scaffolding: left/right panels, createRow/createButton helpers
- **PromotedEditorControls** wires specific tool/brush/rect mode buttons into the HUD
- Both are DOM-only (inline styles, no CSS framework) — experiments own the 3D scene

Keyboard shortcuts: D=draw, X=erase, 1-8=brushes, Q/E=rotate camera, G=grass rect, 9=footprint rect, B=bake, F5=exit editor

## Testing

Coverage gated at 90/85/90/90 (statements/branches/functions/lines).

```
pnpm --filter @common/level-editor test              # run tests
pnpm --filter @common/level-editor test:coverage      # with coverage check
```

Every module has a co-located `.test.ts` file. The structure-meshes tests use THREE.js directly (no DOM mocking needed for geometry validation).

## Key Invariants

1. **Edge key normalization** — `levelBuilderEdgeKey` always orders nodes so `(a < b)` to prevent duplicate segments
2. **Door placement IDs** derive deterministically from node coordinates: `door:<edgeKey>`
3. **Open doors don't block** — `bakeLevelForEcs` skips open doors when marking blocked cells
4. **Join post mask** must use exactly the same cardinal bit values as `autotile.ts` (N=1 E=2 S=4 W=8)
5. **Shared geometry/materials** — the mesh kit creates instances once; callers get new Group wrappers. Always call `dispose()` on teardown
6. **Schema version** — builder bake is locked to `schemaVersion: 3`. Increment and add migration if the shape changes

## Dependencies

- `@common/gameplay` — `LevelResource`, `LevelSnapshot` types (interface only)
- `three` — Mesh generation in `structure-meshes.ts`

No other packages depend on this one via source imports yet (only declared as workspace dependency by experiments).
