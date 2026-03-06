# CLAUDE.md — Project Conventions

## Required Reading

Before making any technical decisions, read:
- `docs/AGENT_LEARNINGS.md` — post-mortems and failure patterns (per `AGENTS.md`)

## Project Structure

Monorepo managed with **pnpm workspaces**.

```
apps/hub          — Vite + React experiment browser (the hub UI)
  src/pages/forge-v2/  — Asset Forge v2 (route: #/forge-v2) — prop pipeline: concept image → mesh → physics colliders
packages/
  common-render   — Pixel-perfect rendering primitives (PixelStage, PixelPerfectController, PixelPerfectIsoView)
  common-render-legacy — Legacy render exports (frozen; 2to1 experiment still uses this)
  common-core     — Generic utilities and data logic
  common-gameplay — Gameplay systems (inventory, state rules)
  experiments     — Individual experiment modules (each in src/<name>/)
docs/             — Architecture docs, learnings, promotion guide
e2e/              — Playwright end-to-end tests
scripts/          — CLI helpers (new-experiment scaffold, HTTPS dev server)
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

## Testing Conventions

- Promoted packages require `test:coverage` script with enforced thresholds
- Browser-level smoke coverage for critical user flows using Playwright
- Run `pnpm typecheck` before committing changes

## Dev Server

On this devbox, use `pnpm dev` (plain HTTP via Vite). No Caddy needed here.

`pnpm dev:s` (Caddy HTTPS reverse proxy) is only for the remote Hetzner machine.
When the `/dev` skill is invoked, run `pnpm dev` — not `pnpm dev:s`.
