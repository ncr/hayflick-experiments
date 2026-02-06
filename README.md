# Hayflick Experiments Hub

Monorepo for many independent game experiments with a single browser hub.

## Stack

- React + Vite shell app (`apps/hub`)
- Three.js-first experiments (`packages/experiments`)
- Shared code promotion packages (`@common/core`, `@common/render`, `@common/gameplay`)
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
- `pnpm test` - run all tests
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
