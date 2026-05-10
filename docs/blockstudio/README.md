# Blockstudio tileset pipeline

This directory holds the blockstudio design docs, folded into hayflick-26-2 on 2026-04-11 from the standalone blockstudio repo.

- `wall-kit-contract.md` — source of truth for wall-kit anchors, pivots, geometry, tile vocabulary per kit.
- `game-consumer-contract.md` — what the game engine needs to know to load tileset artifacts.

**Pipeline entry point**: `pnpm run rebuild <tileset-id>` from the repo root.
**Source specs**: `assets/tilesets/<id>/tileset.json`.
**Outputs**: `assets/tilesets/<id>/artifacts/{kit,tiles}/…` and `.../artifacts/tileset.game.json`.
**Materials**: `assets/materials/{registry.json,polyhaven/}`.
**Code**: `studios/blockstudio/src/{planner,shared,server}` + `scripts/blockstudio/` + `blender/`.

The MCP server surface from the old blockstudio repo was stripped during the move — this package keeps only the standalone-rebuild path (no `cli.js`, `mcp-server.js`, `tools.js`, `bridge-client.js`, `state-store.js`, `project-workspace.js`). Tests were ported from `node --test` to vitest.
