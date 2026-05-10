# Hayflick Experiments Hub

Monorepo for many independent game experiments with a single browser hub.

## Stack

Three layers (see `CLAUDE.md` for layer rules):

- **Engine** (`packages/common-*`) — `@common/render`, `@common/core`, `@common/gameplay`, `@common/input`, `@common/level-editor`, `@common/physics-rapier`, `@common/collider-vhacd`
- **Studios** (`studios/*`) — authoring tools: `forge`, `material-studio`, `map-editor`, `blockstudio`
- **Experiments** (`experiments/*`) — game prototypes + free-form playground; per-experiment `mode: "strict" | "free"` flag controls which deps are allowed
- **Hub app** (`apps/hub`) — Vite shell that hosts studios + experiments
- GitHub Actions CI + GitHub Pages deployment

## Quick start

```bash
pnpm install
pnpm dev
```

## Commands

- `pnpm dev` - run hub app
- `pnpm build` - build all workspaces
- `pnpm typecheck` - typecheck all workspaces
- `pnpm lint` - lint all workspaces
- `pnpm check:layers` - validate package.json deps against the engine / studios / experiments layer rules
- `pnpm test` - run all tests
- `pnpm test:promoted` - enforce coverage thresholds for promoted shared modules
- `pnpm test:e2e` - run Playwright browser smoke tests
- `pnpm exp:new <experiment-id>` - scaffold a new experiment

## Experiment flow

1. Build feature/system in one experiment.
2. Validate in at least one other experiment.
3. Promote stable code into a shared package (`docs/promotion.md`).

## Routing

- Default hub route loads first experiment.
- `#/exp/<id>` opens a specific experiment route.

## GitHub Pages

`apps/hub/vite.config.ts` sets `base` from `GITHUB_REPOSITORY` in production builds so Pages assets resolve under `/<repo-name>/`.

## Codespaces

- Open repo in Codespaces.
- Run `pnpm dev --host`.
- Use forwarded port URL from laptop or iPhone.
