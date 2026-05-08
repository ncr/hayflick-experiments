# CLAUDE.md — Project Conventions

## Required Reading

Before making any technical decisions, read:
- `docs/AGENT_LEARNINGS.md` — post-mortems and failure patterns (per `AGENTS.md`)

## Project Structure

Monorepo managed with **pnpm workspaces**.

```
apps/hub          — Vite + React experiment browser (the hub UI)
  src/pages/forge/        — Asset Forge (route: #/forge) — prop pipeline: concept image → mesh → physics colliders
  src/pages/forge/shared/ — Forge-local shared APIs, processing helpers, and narrow viewport-state types
packages/
  common-render       — Pixel-perfect iso-2:1 rendering pipeline (IsoGameView, SharedScissorStage, outlines, lighting preset)
  common-core         — Generic utilities and data logic
  common-gameplay     — Gameplay systems (inventory, state rules)
  common-level-editor — Tile/structure models, wall/door mesh kit, editor UI, bake pipeline
  common-input        — Input handling
  common-physics-rapier — Rapier physics integration
  common-collider-vhacd — V-HACD convex decomposition for colliders
  experiments         — Active experiment modules and local experiment-only helpers
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
3. 1 world tile edge (128 cm) = **32 game pixels horizontal × 16 vertical**, locked at `R = 32·√2` lowpixels per world unit. Sourced from `ISO_VIEW_CONTRACT` in `@common/render` — do NOT override `fixedRenderHeight` / `baseOrthoHeight` / `cameraYaw` / `cameraPitch` on the game render path; they are the cornerstone of the view aesthetic. Vertical world-Y projects irrationally (cos π/6 = √3/2): 1.28 m of vertical world = `16·√6 ≈ 39.19` lowpixels. Tools that need different framing (forge prop preview, tileset inspector) construct `PixelPerfectPane` directly with custom values, not `IsoGameView`.
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

## Textured-Mesh Catalog (Material Studio)

Separate from the procedural tileset pipeline above. Uses a flat, two-layer model:

- **Base meshes** — `assets/meshes/<id>.glb`. Pre-authored geometry with `textureRole` extras on each mesh node. Input side; grown in Blender when new geometry is needed.
- **Textured meshes** — `assets/textured-meshes/<name>/`. The atomic game-ready unit: one base mesh + authored textures baked into a single `artifact.glb`, plus a `manifest.json` (provenance: base mesh id, prompts, timestamp) and the per-role texture PNGs under `textures/<role>/`.

The `material-studio` experiment is the authoring UI: pick a base mesh; for each PBR surface, paint pixels into a small UV atlas and/or call gpt-image-2 to fill unpainted cells; bake. UV islands are detected at mesh-load time by `uv-template/prepare.ts` (atlas: 256² with `cellPx=1`; template: 1024² with `cellPx=16` — same `cellsX × cellsY` per island in both, so AI output extracts 1:1 into the atlas). The bake endpoint (`/api/textured-mesh/bake` in `apps/hub/plugins/api-proxy.ts`) calls in-process `apps/hub/plugins/build-artifact.ts`, which uses `@gltf-transform/core` to replace `TEXCOORD_0` with the remapped UVs and attach baseColor/normal/MR/occlusion textures with NEAREST samplers.

NEAREST sampling end-to-end is load-bearing: `material-studio/texture-swap.ts` uses `THREE.NearestFilter` (no mipmaps), and the baked GLB sets `TextureInfo.MagFilter/MinFilter.NEAREST`. One atlas pixel must equal one game pixel under the iso pixel-perfect renderer — never insert LinearFilter anywhere along this chain.

`accent` roles (glass) are synthetic — shader-driven transmission/IOR, not AI-generated.

## Testing Conventions

- Promoted packages require `test:coverage` script with enforced thresholds
- Browser-level smoke coverage for critical user flows using Playwright
- Run `pnpm typecheck` before committing changes

## Verification — UI changes are not complete without a passing Playwright test

If you touch UI, browser-running code, an experiment view, or anything visible in the page, **write or update a Playwright e2e spec that proves the change works** and run it. Without that, "it typechecks" is not "it works".

- Spec files live in `e2e/`. Run them with `pnpm test:e2e` or `npx playwright test e2e/<file>.spec.ts`.
- **Use the dev server (`pnpm dev`) for tests that hit backend APIs.** The Vite preview server (the default `webServer` in `playwright.config.ts`) does **not** run plugins like `api-proxy`, so any test that needs `/api/assets/read`, `/api/textured-mesh/*`, `/api/openai/*`, etc. will silently fail to load data. Override `baseURL` to the dev server (e.g. `http://localhost:5174`) — see `e2e/pixel-art-tex.spec.ts` for the pattern.
- **For pixel-exact tests, expose internals via a `window.__<expName>` handle.** The test then calls into the experiment to read framebuffer pixels, force frames, etc. — see `pixel-art-tex.spec.ts` for the canonical NEAREST/no-MSAA proof.
- **When you rename a class or restructure layout, search for it in `e2e/` and fix the selectors.** Tests using stale selectors fail with confusing "Timed out waiting for selector" errors that look like product bugs.
- Don't mark a UI task complete based on "the dev server compiled" — Vite happily serves broken modules until React mounts and crashes. Only a Playwright run answers "does it work?".
- The Chrome MCP browser is unreliable in agent runs (extension may not be connected). Playwright is the source of truth.

## Dev Server

On this devbox, use `pnpm dev` (plain HTTP via Vite). No Caddy needed here.

`pnpm dev:s` (Caddy HTTPS reverse proxy) is only for the remote Hetzner machine.
When the `/dev` skill is invoked, run `pnpm dev` — not `pnpm dev:s`.
