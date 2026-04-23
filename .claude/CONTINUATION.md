# Continuation Prompt — Material Studio + Iso RPG/Survival Tooling

Paste this into Claude Code on the dev laptop to continue.

---

## Context

I'm picking up from yesterday's session on the devbox (last two commits: `055d807` Rebuild tileset artifacts, `8268121` Retire prop-test-scene + primitive-views; add AI-first material-studio).

I'm building an **isometric RPG / survival** game. The repo is a monorepo with a pixel-perfect iso-2:1 engine, a prop editor (Forge v2), a tileset pipeline (Blockstudio), a level editor (map-editor-2d), and a handful of experiments under `packages/experiments/`. Yesterday I decided to do one more bounded round of tooling consolidation before pivoting to gameplay.

## What just landed

**Phase A — cleanup**
- Deleted `packages/experiments/src/prop-test-scene/` (its README was literally `## Goal\nTODO`; AA decisions already made)
- Deleted `packages/experiments/src/primitive-views/` (superseded by the declarative pane config in `@common/render` from commit `27fad8b`)
- Cleaned up stale pointers to both in CLAUDE.md and `@common/render` JSDoc/README

**Phase B — Material Studio (scaffolded, not yet verified)**
- `packages/experiments/src/material-studio/` — AI-first merge of `texture-workshop` + `tile-viewer`
- Design principle: tileset geometry is strictly parametric; materials are prompt-driven. **No manual PBR sliders** — iteration happens by editing the prompt and regenerating.
- Stripped all 5 slider controls (strength / roughness / rough-range / ao floor / ao mult) and the `onSliderChange` callback. Uses `DEFAULT_PBR_PARAMS` as fixed defaults.
- Added 6 prompt-delta quick buttons (`+weathered`, `+pristine`, `+warmer`, `+cooler`, `+darker`, `+lighter`) — one-click prompt modifiers.
- Dual-pane rendering, orbiting key light, Sobel-based PBR derivation, imagegen call, texture-swap, and save-to-registry ported verbatim from `texture-workshop`.
- `texture-workshop` + `tile-viewer` are still registered alongside `material-studio` until the browser smoke test confirms the new experiment works.

## What I need to do next (priority order)

### 1. Smoke-test material-studio in the browser

```
pnpm dev     # NOT pnpm dev:s — plain HTTP Vite, no Caddy on this laptop/devbox
```

Then open `http://localhost:5173/#/exp/material-studio` and walk through:
- Pick a kit (`desert_sandstone` / `greek_island_white` / `ground_tiles`)
- Pick a role (e.g. `wall` → materialId `sandstone_cracks`)
- Edit the pre-filled prompt or leave it as-is
- Click **Generate** — should produce a 64×64 baseColor → auto-derive normal + ARM → apply to the tile in both viewports (normal/target panes) with the orbiting key light
- Try a delta button (e.g. `+weathered`), hit Generate again — should iterate by re-prompting
- Click **Save to Registry** — writes the 3 PNGs under `assets/materials/polyhaven/<materialId>/` and patches `assets/materials/registry.json`
- Reload `#/exp/map-editor-2d` — new texture should be on the walls (no `pnpm run rebuild` needed; textures load at runtime from the registry)

### 2. Retire `texture-workshop` + `tile-viewer`

Only after the smoke test passes:
- `rm -rf packages/experiments/src/texture-workshop packages/experiments/src/tile-viewer`
- Remove their imports + entries from `packages/experiments/src/registry.ts`
- Check nothing else references them: `grep -rn "texture-workshop\|tile-viewer\|textureWorkshop\|tileViewer" --include="*.ts" --include="*.tsx" --include="*.md"`
- `pnpm --filter @experiments/catalog typecheck` + registry test should stay green
- Note: pre-existing lint errors in `texture-workshop/` will disappear; some stale ones in `map-editor-2d/scene-builder.ts` (unused `Selection`) and `common-collider-vhacd/src/vhacd.ts` (unused `SplitWorkerRequest`) will remain — not my issue

### 3. Decide the next tooling phase vs. gameplay pivot

From yesterday's plan (`/home/ncr/.claude/plans/analyze-the-current-experiments-dreamy-acorn.md` on the devbox — NOT synced to laptop, but the key decisions are below), the recommended next step is:

**Phase C — Forge → map-editor bridge (~1 week)**
- Add a "Prop" placeable type to `map-editor-2d`
- Source: list of Forge-exported `AssetMeta.glb` bundles (confirm path via `apps/hub/src/pages/forge-core/ExportPanel.tsx`)
- Extend `LevelBuilder` schema (`packages/common-level-editor/src/builder-bake.ts`) with `props: [{ refGlbId, position, rotation, scale }]`; bump `schemaVersion` to 4
- Render props in the map editor's 3D preview via existing `IsoGameView` machinery from `@common/render`

**STOP-LINE — define tooling "done" before pushing further on it.** Stop building tools when ALL THREE of these are true:
- Can author a material, apply to tileset, rebuild, see in map editor — one iteration loop
- Can drop a Forge prop into a level, save, reload, prop still there
- Can produce a showable 1-room scene in <30 min using only these tools

After Phase C, the stop-line will be reached (assuming material-studio smoke test passed).

**Phase D — Gameplay vertical slice (after stop-line)**
- One new experiment: `gameplay-slice`
- Character controller (Rapier capsule, iso nav)
- Camera follow using existing pan/zoom machinery
- ONE interaction verb — for survival RPG that's likely "pick up resource" or "open container"
- Save/load of the scene

## Durable conventions (don't re-discover these)

- **Game direction**: iso RPG / survival. Materials should trend weathered, environmental, outdoor/indoor variety. Props are survival-relevant (containers, crafting stations, pickups). Don't expand to interior furniture tiles — use Forge props instead.
- **AI-first materials**: prompt-driven end-to-end, NO manual PBR sliders. Iterate by re-prompting. The Year 2200 style preamble is hard-coded in `material-studio/api-client.ts`.
- **Tileset geometry is strict** (parametric spec in `tileset.json`). **Materials are AI-prompted.** Don't mix the paradigms.
- **Dev server**: `pnpm dev` on this machine. `pnpm dev:s` (Caddy HTTPS) is only for the remote Hetzner box.
- **Render regressions**: `e2e/render-invariants/` Playwright suite with `maxDiffPixels: 0` is the ship gate.
- **Blockstudio asset issues** get fixed upstream in the kit project, not via runtime workarounds in `tileset-loader.ts`.
- **Forge-v2 export**: `exportObjectToGlb` bakes world transforms into geometry; `detectColliderBaseScale()` handles old raw-scale collider data.

## Known pre-existing issues (not to fix right now)

- `packages/common-collider-vhacd/src/vhacd.ts:278` — unused `SplitWorkerRequest` (lint)
- `packages/blockstudio/test/scene-plan.test.js` + `tileability-lint.test.js` — corner contour width=144 exceeds baseUnit=128 (2 failing tests — corner overhang geometry)
- `packages/experiments/src/auto-collider/ammo-crate.test.ts:99` — containment assertion failing

These existed before yesterday's session. Not caused by Phase A/B work. Don't fix pre-emptively — wait until they block something.

## Task list from the previous session

```
#1 [done]    Phase A: Remove prop-test-scene + primitive-views experiments
#2 [done]    Phase A: Verify cleanup — typecheck, lint, tests, hub smoke
#3 [done]    Phase B: Explore texture-workshop + tile-viewer internals
#4 [done]    Phase B: Scaffold material-studio experiment
#5 [done]    Phase B: Wire AI generator flow — prompt → imagegen → auto PBR derivation
#6 [done]    Phase B: Wire preview panel — canonical tile + orbiting key light
#7 [done]    Phase B: Wire save-to-registry + bind-to-tileset-slot actions
#8 [pending] Phase B: Retire texture-workshop + tile-viewer  ← do this after smoke test
#9 [pending] Phase B: End-to-end verification                ← browser-only, not automatable
```

## Start here

1. `git pull`
2. `pnpm install` (if there are lockfile/node_modules drift)
3. `pnpm dev` → open `http://localhost:5173/#/exp/material-studio` → run through smoke-test above
4. If it works → retire `texture-workshop` + `tile-viewer` and commit
5. Then pick: Phase C (bridge Forge → map-editor) or Phase D (gameplay slice)
