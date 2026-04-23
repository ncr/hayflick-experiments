# CLAUDE.md — Project Conventions

## Required Reading

Before making any technical decisions, read:
- `docs/AGENT_LEARNINGS.md` — post-mortems and failure patterns (per `AGENTS.md`)

## Project Structure

Monorepo managed with **pnpm workspaces**.

```
apps/hub          — Vite + React experiment browser (the hub UI)
  src/pages/forge/     — Asset Forge v2 (route: #/forge-v2) — prop pipeline: concept image → mesh → physics colliders
  src/pages/forge-core/ — Forge shared processing (colliders, export, textures)
packages/
  common-render       — Pixel-perfect iso-2:1 rendering pipeline (IsoGameView, SharedScissorStage, outlines, lighting preset)
  common-core         — Generic utilities and data logic
  common-gameplay     — Gameplay systems (inventory, state rules)
  common-level-editor — Tile/structure models, wall/door mesh kit, editor UI, bake pipeline
  common-input        — Input handling
  common-physics-rapier — Rapier physics integration
  common-collider-vhacd — V-HACD convex decomposition for colliders
  experiments         — Active experiment modules (physics-prop-drop, prop-test-scene, prop-physics-3d, auto-collider)
docs/               — Architecture docs, learnings, promotion guide
e2e/                — Playwright end-to-end tests
scripts/            — CLI helpers (new-experiment scaffold, HTTPS dev server)
```

## Key Commands

| Command | Description |
|---|---|
| `pnpm dev` | Start Vite dev server (HTTP) |
| `pnpm dev:s` | Start HTTPS dev server via Caddy reverse proxy |
| `pnpm build` | Build all packages |
| `pnpm typecheck` | TypeScript check across all packages |
| `pnpm lint` | Lint all packages |
| `pnpm test` | Run all tests |
| `pnpm test:promoted` | Run coverage-gated tests for promoted packages |
| `pnpm test:e2e` | Run Playwright end-to-end tests |
| `pnpm exp:new` | Scaffold a new experiment |
| `pnpm run rebuild <id>` | Rebuild one tileset through Blender (planner + export + sprite bake). Writes to `assets/tilesets/<id>/artifacts/`. Requires `$BLENDER_BIN` and `assets/materials/polyhaven/` populated. |
| `pnpm run rebuild:all` | Rebuild all three checked-in tilesets in sequence. |

## Experiment Flow

Experiments follow a **build → validate → promote** lifecycle.
See `docs/promotion.md` for full process.

1. Build locally in `packages/experiments/src/<name>/`
2. Validate with at least one additional usage scenario
3. Extract stable API into `@common/render`, `@common/core`, or `@common/gameplay`
4. Add tests with coverage gates in the shared package
5. Replace local experiment logic with shared package imports

## Pixel-Perfect Rendering

See `docs/PIXEL_PERFECT_FOUNDATION.md` for full architecture.

**Critical invariants — do not break these:**
1. Canvas CSS size tracks mount size; does not change while zooming
2. Low-res render target derived from viewport + DPR baseline (zoom=1); zoom must not recompute it
3. 1 world tile edge (128cm) = 32 game pixels horizontal, 16 vertical — holds at all zoom levels
4. Final scene upscaled by integer render scale (`round(zoom * dpr)`)
5. Pan advances in whole low-res pixel steps with carried remainder
6. Zoom changes corrected by pan so world point under cursor stays fixed
7. Overscan guard band prevents edge bars under remainder shifts

## Tileset Pipeline (Blockstudio)

The isometric wall / ground tileset pipeline lives in three places:

- `packages/blockstudio/` — planner, shared kit logic, pbr-library, tileset-files, vitest unit tests
- `scripts/blockstudio/` — orchestrators that shell out to Blender for the actual mesh build and export
- `blender/*.py` — Blender-side Python (geometry, materials, export, capture, project)

Source specs are `assets/tilesets/<id>/tileset.json`. The rebuild pipeline writes outputs under `assets/tilesets/<id>/artifacts/` (per-tile GLBs, whole-kit GLB, manifests) and the authoring-debug `assets/tilesets/<id>/project/example_room.glb`. The map editor renders these GLBs directly at runtime — there is no sprite bake step.

Material registry and Polyhaven downloads live under `assets/materials/`. The `polyhaven/` subdirectory is gitignored.

Iteration loop: edit `assets/tilesets/<id>/tileset.json` → `pnpm run rebuild <id>` → reload the map editor in the hub.

See `docs/blockstudio/` for the full contract (game consumer, wall kit, tilekit improvement plan).

## Testing Conventions

- Promoted packages require `test:coverage` script with enforced thresholds
- Browser-level smoke coverage for critical user flows using Playwright
- Run `pnpm typecheck` before committing changes

## Dev Server

On this devbox, use `pnpm dev` (plain HTTP via Vite). No Caddy needed here.

`pnpm dev:s` (Caddy HTTPS reverse proxy) is only for the remote Hetzner machine.
When the `/dev` skill is invoked, run `pnpm dev` — not `pnpm dev:s`.
