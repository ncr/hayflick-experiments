# Blockstudio → hayflick-26-2 move plan

This plan is **self-contained**. It assumes no prior conversation context. Read the whole document before touching anything. Follow the phases in order; each phase has clearly-defined done criteria.

## Why this plan exists

Blockstudio currently lives at `/Users/ncr/dev/blockstudio/` as a standalone repo. The game that actually consumes its GLB output lives at `/Users/ncr/dev/hayflick-26-2/`. Today the asset flow is:

```
blockstudio/                                hayflick-26-2/
  tilesets/<id>/artifacts/tiles/…   ───►    assets/tilesets/<id>/tiles/…
```

…bridged by `hayflick-26-2/scripts/sync-tileset.sh` (invoked by a Claude slash command `.claude/commands/sync-tilesets.md` that loops through every tileset). This is slow — rebuild in repo A, sync into repo B, reload the game, iterate.

**The goal**: move every part of blockstudio into `hayflick-26-2` so that running a rebuild writes directly into the path the game already reads from. The sync step, and the two-repo context switching, go away. Iteration loop becomes: edit spec → `pnpm rebuild greek_island_white` → reload game.

## Non-goals

- **Not** porting the MCP tool surface to TypeScript. Keep it as plain JS modules (ES Modules, no transpilation). Hayflick tolerates both.
- **Not** rewriting tests. Blockstudio's 47 node-native tests stay as `node --test` for now. A vitest port can happen later if desired — it doesn't block the move.
- **Not** downloading fresh Polyhaven textures. The existing `materials/polyhaven/**` content must be copied over as-is so rebuilds work immediately without network access.
- **Not** touching the Blender-side Python packaging. `blender/*.py` continues to be loaded the same way (`--python path/to/script.py` or `sys.path.insert` of the `blender/` dir).
- **Not** touching `hayflick-26-2/assets/forge*`, the Forge v2 pipeline, common-render, or any other hayflick package. Only the tileset + material pipeline moves.

## The two repos — what's where today

**Source repo: `blockstudio`** (this plan writes from its perspective, but after Phase 0 the agent runs entirely inside hayflick).

```
blockstudio/
├── package.json              # scripts: start, preview:dev, test, plan-kit, lint-kit, rebuild
├── src/
│   ├── planner/plan-kit.js   # CLI: spec + rules → scene plan
│   ├── shared/               # kit normalization, scene-plan, texel-density, tileability-lint
│   └── server/               # MCP server, bridge client, tools, pbr-library, tileset-files, state-store
├── blender/                  # Python: server, geometry, materials, export, capture, project
├── scripts/
│   ├── rebuild-tileset.mjs          # planner + Blender + sprite bake in one shot
│   ├── blender-rebuild-kit.py       # Blender driver called by rebuild-tileset.mjs
│   ├── bake-tile-sprite.py          # single-tile sprite bake
│   ├── bake-sprite-set.mjs          # per-tileset sprite bake orchestrator
│   ├── downscale-materials.mjs      # Polyhaven → 64×64
│   ├── stylize-material-textures.mjs # diffuse → 8-colour palette PNG
│   ├── pixel-art-pass.py            # PIL stylization (sprite mode + texture mode)
│   ├── render-scissor-preview.py    # Blender-rendered debug preview
│   ├── run-kit.js                   # old MCP-driven end-to-end runner (still works; largely unused)
│   └── blender-rebuild-kit.py
├── test/                     # 47 tests, node --test runner
├── tilesets/
│   ├── _rules/general.tileset-rules.json
│   ├── greek_island_white/
│   │   ├── tileset.json               # source spec (kitSpec, tileMaterials, etc.)
│   │   ├── artifacts/
│   │   │   ├── kit/<id>.glb            # whole kit exploded row
│   │   │   ├── tiles/<tile>/<tile>.glb # per-tile GLBs
│   │   │   ├── sprites/                # baked pixel-art sprite PNGs
│   │   │   └── tileset.game.json       # game-facing metadata bundle
│   │   └── project/
│   │       └── example_room.glb        # authoring/debug, not shipped
│   ├── desert_sandstone/      # same shape
│   └── ground_tiles/          # same shape
├── materials/
│   ├── registry.json          # material id → map filenames, factors, style metadata
│   └── polyhaven/             # GITIGNORED. Hundreds of MB of downloaded PBR JPGs.
├── preview/                   # Vite dev preview UI — DEAD CODE tied to a removed tileset. Skip.
├── vendor/
│   └── common-render/         # Copy of hayflick's @common/render — DEAD on hayflick side, skip.
├── docs/
│   ├── tilekit-improvement-plan.md
│   ├── wall-kit-contract.md
│   ├── game-consumer-contract.md
│   └── blockstudio-move-plan.md       # ← this file
├── skills/blockstudio-modeler/SKILL.md
├── CLAUDE.md, README.md
└── .gitignore
```

**Destination repo: `hayflick-26-2`** (pnpm workspaces, `packages/*` and `apps/*`).

```
hayflick-26-2/
├── apps/hub/                     # Vite + React hub, serves assets from ../../assets via /api/assets/read
│   └── plugins/api-proxy.ts      # ASSETS_ROOT = path.resolve(process.cwd(), "../../assets")
├── packages/
│   ├── common-render/            # pixel-perfect rendering (referenced by blockstudio vendor dir too)
│   ├── common-level-editor/      # tile/structure models, wall kit, bake pipeline
│   ├── common-core, common-gameplay, common-input, common-physics-rapier, common-collider-vhacd
│   └── experiments/              # map-editor-2d is the CURRENT tileset consumer
│       └── src/map-editor-2d/tileset-loader.ts   # fetches `tilesets/<id>/tiles/...` via /api/assets/read
├── assets/
│   └── tilesets/                 # ← already stale copies synced from blockstudio
│       ├── greek_island_white/
│       │   ├── tiles/            # per-tile GLBs (flat — no `artifacts/` wrapper)
│       │   ├── kit/              # whole kit GLB
│       │   └── tileset.game.json
│       ├── desert_sandstone/
│       ├── ground_tiles/
│       └── modern_desert_monolith/   # orphan — tileset no longer exists in blockstudio, delete
├── scripts/
│   └── sync-tileset.sh           # ← WILL BE DELETED
├── .claude/commands/
│   ├── sync-tilesets.md          # ← WILL BE DELETED
│   └── dev.md
├── package.json                  # pnpm-managed monorepo root
├── pnpm-workspace.yaml           # packages: apps/*, packages/*
└── CLAUDE.md                     # project conventions + pixel-perfect invariants
```

**Key observations**:
- Hayflick reads tileset assets at the path `tilesets/<id>/tiles/...`, resolved against `ASSETS_ROOT = hayflick-26-2/assets`. So after the move, rebuilds must write into `hayflick-26-2/assets/tilesets/<id>/…` in a layout the loader already understands.
- The current layout on the hayflick side is **flat** (`assets/tilesets/<id>/tiles/…`) because the sync script unwrapped `artifacts/`. After the move, we have two choices: (A) update the loader to use `assets/tilesets/<id>/artifacts/tiles/…` directly, or (B) have the builder write directly into the flat layout. This plan picks **option A** — keep the layered `artifacts/` structure and update the one consumer file. Rationale: preserves the builder's existing output structure unchanged and keeps the tileset.game.json, per-tile manifests, and sprites all together under one root.
- Polyhaven textures are gitignored in both repos. They must be physically copied during the move, not checked in.

## Target layout after the move

```
hayflick-26-2/
├── blender/                          # ← NEW top-level Python modules (moved from blockstudio/blender)
│   ├── server.py
│   ├── geometry.py
│   ├── materials.py
│   ├── export.py
│   ├── capture.py
│   └── project.py
├── scripts/
│   ├── blockstudio/                  # ← NEW subdirectory for all blockstudio orchestrators
│   │   ├── rebuild-tileset.mjs
│   │   ├── blender-rebuild-kit.py
│   │   ├── bake-tile-sprite.py
│   │   ├── bake-sprite-set.mjs
│   │   ├── downscale-materials.mjs
│   │   ├── stylize-material-textures.mjs
│   │   ├── pixel-art-pass.py
│   │   ├── render-scissor-preview.py
│   │   └── run-kit.js
│   ├── dev-https.sh                  # existing, unchanged
│   ├── new-experiment.mjs            # existing, unchanged
│   └── …                             # rest unchanged
├── packages/
│   ├── blockstudio/                  # ← NEW workspace package
│   │   ├── package.json              # name: @common/blockstudio, type: module
│   │   ├── src/
│   │   │   ├── planner/plan-kit.js
│   │   │   ├── shared/               # kit, scene-plan, tileability-lint, etc.
│   │   │   └── server/               # mcp-server, bridge-client, tools, pbr-library, …
│   │   └── test/                     # moved from blockstudio/test/
│   └── …                             # existing packages unchanged
├── assets/
│   ├── tilesets/
│   │   ├── _rules/
│   │   │   └── general.tileset-rules.json     # ← NEW (from blockstudio/tilesets/_rules)
│   │   ├── greek_island_white/
│   │   │   ├── tileset.json                   # ← source spec (formerly blockstudio/tilesets/<id>/tileset.json)
│   │   │   ├── artifacts/                     # ← layered structure preserved
│   │   │   │   ├── kit/<id>.glb
│   │   │   │   ├── kit/<id>.manifest.json
│   │   │   │   ├── tiles/<tile>/<tile>.glb
│   │   │   │   ├── tiles/<tile>/<tile>.manifest.json
│   │   │   │   ├── tiles/tiles.manifest.json
│   │   │   │   ├── sprites/*.png + sprites.manifest.json
│   │   │   │   └── tileset.game.json
│   │   │   └── project/
│   │   │       └── example_room.glb
│   │   ├── desert_sandstone/                  # same shape
│   │   ├── ground_tiles/                      # same shape
│   │   └── modern_desert_monolith/            # DELETED — no source spec for it in blockstudio anymore
│   └── materials/                             # ← NEW (from blockstudio/materials)
│       ├── registry.json
│       └── polyhaven/                         # gitignored, physically copied from blockstudio
├── docs/
│   ├── blockstudio/                           # ← NEW subfolder
│   │   ├── tilekit-improvement-plan.md
│   │   ├── wall-kit-contract.md
│   │   ├── game-consumer-contract.md
│   │   └── README.md                          # short pointer doc, see Phase 8
│   └── …                                      # existing hayflick docs unchanged
├── skills/                                    # ← NEW (only if hayflick agents use blockstudio-modeler)
│   └── blockstudio-modeler/SKILL.md
├── .claude/commands/
│   ├── dev.md
│   └── sync-tilesets.md                       # ← DELETED
├── pnpm-workspace.yaml                        # ← packages: adds "packages/blockstudio"
├── package.json                               # ← adds top-level `rebuild` script
└── CLAUDE.md                                  # ← appends blockstudio commands to the "Key Commands" table
```

### Why this shape

- `packages/blockstudio/` is a proper pnpm workspace package, named `@common/blockstudio`. This matches the repo convention, lets other packages import from it if ever needed, and puts its own `test` script under `pnpm -r test`.
- `blender/` stays top-level because it's Python, not a JS package. Matches how repos with mixed-language tooling usually do it.
- `scripts/blockstudio/` keeps the orchestrators out of the package (they shell out to Blender and coordinate multiple files; they're not library code). Parallel to the existing `scripts/new-experiment.mjs` pattern.
- `assets/tilesets/<id>/tileset.json` co-locates the source spec with the artifacts. The builder already treats `tilesets/<id>/tileset.json` as the input file — this just moves the root.
- `assets/materials/` lives next to `assets/tilesets/` because they're both build inputs/outputs and neither belongs in a package.

## Execution plan

Phases 0–6 are mandatory. Phase 7 is cleanup on the blockstudio side. Phase 8 is docs. Do not skip done criteria — they are the gate between phases.

---

### Phase 0 — Pre-flight: snapshot both repos

**Objective**: make the move reversible and have a clean baseline to diff against.

**Actions**:
1. In `blockstudio/`:
   ```bash
   git status --short        # must be clean
   git log --oneline -1      # record current HEAD
   npm test                  # must be green (47/47)
   npm run rebuild greek_island_white && npm run rebuild desert_sandstone && npm run rebuild ground_tiles
   # verify each rebuild wrote the tileset.game.json and sprites
   ```
2. In `hayflick-26-2/`:
   ```bash
   git status --short        # must be clean
   git log --oneline -1
   pnpm install              # if stale
   pnpm test                 # baseline — record pass/fail counts
   pnpm typecheck            # baseline
   ```
3. Create a working branch in hayflick: `git switch -c blockstudio-move`.
4. Do **not** create a branch in blockstudio — Phase 7 will delete blockstudio entirely, so whatever you do there is throwaway.

**Done criteria**:
- Both repos clean.
- Both repos build / test green on their current HEADs.
- Branch `blockstudio-move` exists in hayflick.

**Gotchas**:
- If `materials/polyhaven/**` doesn't exist in blockstudio, rebuilds will fail silently (no materials to embed). Verify at least `cobblestone_floor_04`, `aerial_grass_rock`, `asphalt_04`, and `white_plaster_02` exist under `blockstudio/materials/polyhaven/` before starting.

---

### Phase 1 — Copy code, Blender, scripts, and docs into hayflick

**Objective**: every `.js` / `.mjs` / `.py` / `.md` file that blockstudio owns lives at its target path in hayflick. Nothing is deleted from blockstudio yet. No path rewrites yet — those are Phase 3.

**Actions** (run from `hayflick-26-2/`):

1. **Create the package skeleton**:
   ```bash
   mkdir -p packages/blockstudio/src packages/blockstudio/test
   mkdir -p blender
   mkdir -p scripts/blockstudio
   mkdir -p docs/blockstudio
   ```

2. **Copy source**:
   ```bash
   cp -R ../blockstudio/src/planner   packages/blockstudio/src/planner
   cp -R ../blockstudio/src/shared    packages/blockstudio/src/shared
   cp -R ../blockstudio/src/server    packages/blockstudio/src/server
   cp -R ../blockstudio/test/.        packages/blockstudio/test/
   ```

3. **Copy Blender modules**:
   ```bash
   cp ../blockstudio/blender/*.py     blender/
   ```

4. **Copy orchestrator scripts**:
   ```bash
   cp ../blockstudio/scripts/rebuild-tileset.mjs          scripts/blockstudio/
   cp ../blockstudio/scripts/blender-rebuild-kit.py       scripts/blockstudio/
   cp ../blockstudio/scripts/bake-tile-sprite.py          scripts/blockstudio/
   cp ../blockstudio/scripts/bake-sprite-set.mjs          scripts/blockstudio/
   cp ../blockstudio/scripts/downscale-materials.mjs      scripts/blockstudio/
   cp ../blockstudio/scripts/stylize-material-textures.mjs scripts/blockstudio/
   cp ../blockstudio/scripts/pixel-art-pass.py            scripts/blockstudio/
   cp ../blockstudio/scripts/render-scissor-preview.py    scripts/blockstudio/
   cp ../blockstudio/scripts/run-kit.js                   scripts/blockstudio/
   ```

5. **Copy docs**:
   ```bash
   cp ../blockstudio/docs/tilekit-improvement-plan.md   docs/blockstudio/
   cp ../blockstudio/docs/wall-kit-contract.md          docs/blockstudio/
   cp ../blockstudio/docs/game-consumer-contract.md     docs/blockstudio/
   cp ../blockstudio/docs/blockstudio-move-plan.md      docs/blockstudio/
   ```

6. **Copy skills** (if the modeler skill is still referenced by agents):
   ```bash
   mkdir -p skills && cp -R ../blockstudio/skills/blockstudio-modeler skills/
   ```
   If hayflick's agents don't load blockstudio-modeler, skip this step and note it in Phase 7.

7. **Do NOT copy**: `blockstudio/preview/` (dead), `blockstudio/vendor/common-render/` (it's a stale copy of hayflick's own package), `blockstudio/node_modules/`, `blockstudio/package.json`, `blockstudio/package-lock.json`, `blockstudio/.git/`, `blockstudio/CLAUDE.md`, `blockstudio/README.md`.

**Done criteria**:
- `find packages/blockstudio -name '*.js' | wc -l` matches `find ../blockstudio/src -name '*.js' | wc -l`.
- `find packages/blockstudio/test -name '*.test.js' | wc -l` == 7 (or whatever the current count is).
- `ls blender/*.py` lists all six Python modules (server, geometry, materials, export, capture, project).
- `ls scripts/blockstudio/` lists all nine orchestrators.
- Nothing removed from blockstudio yet.

**Gotchas**:
- Use `cp -R src/. dst/` (with trailing `.`) so hidden files propagate correctly.
- On macOS, `cp -R` follows symlinks by default; blockstudio has no symlinks so this is fine.

---

### Phase 2 — Move data (tilesets + materials) into `assets/`

**Objective**: every tileset source spec, every artifact, and every material (including gitignored Polyhaven downloads) is under `hayflick-26-2/assets/`.

**Actions**:

1. **Wipe the stale sync copies** on the hayflick side:
   ```bash
   rm -rf assets/tilesets/greek_island_white
   rm -rf assets/tilesets/desert_sandstone
   rm -rf assets/tilesets/ground_tiles
   rm -rf assets/tilesets/modern_desert_monolith   # orphan — no source spec anywhere
   ```

2. **Copy tileset sources + artifacts** from blockstudio, preserving the `tileset.json` + `artifacts/` + `project/` structure exactly:
   ```bash
   mkdir -p assets/tilesets/_rules
   cp ../blockstudio/tilesets/_rules/general.tileset-rules.json  assets/tilesets/_rules/

   for kit in greek_island_white desert_sandstone ground_tiles; do
     mkdir -p assets/tilesets/$kit
     cp -R ../blockstudio/tilesets/$kit/tileset.json  assets/tilesets/$kit/
     cp -R ../blockstudio/tilesets/$kit/artifacts     assets/tilesets/$kit/
     if [ -d ../blockstudio/tilesets/$kit/project ]; then
       cp -R ../blockstudio/tilesets/$kit/project     assets/tilesets/$kit/
     fi
   done
   ```

3. **Copy materials** (this is the gitignored Polyhaven data plus the tracked registry):
   ```bash
   mkdir -p assets/materials
   cp ../blockstudio/materials/registry.json  assets/materials/
   cp -R ../blockstudio/materials/polyhaven   assets/materials/polyhaven
   ```

4. **Update `.gitignore`** in hayflick to exclude Polyhaven downloads but track the registry and artifacts:
   ```gitignore
   # blockstudio inherited rules
   assets/materials/polyhaven/
   ```
   Append to existing `hayflick-26-2/.gitignore`. Do not add `assets/tilesets/` — we want those tracked.

5. **Verify byte counts**:
   ```bash
   find assets/tilesets/greek_island_white  -type f | wc -l
   find ../blockstudio/tilesets/greek_island_white -type f | wc -l
   # must match
   ```

**Done criteria**:
- `assets/tilesets/<kit>/tileset.json` exists for all three kits.
- `assets/tilesets/<kit>/artifacts/kit/<kit>.glb` exists and matches blockstudio's byte-for-byte (`shasum`).
- `assets/tilesets/_rules/general.tileset-rules.json` exists.
- `assets/materials/registry.json` exists.
- `assets/materials/polyhaven/` contains at minimum the 9 material subdirectories (`aerial_grass_rock`, `asphalt_04`, `blue_painted_planks`, `cobblestone_floor_04`, `concrete_wall_004`, `forrest_ground_01`, `sandstone_cracks`, `weathered_brown_planks`, `white_plaster_02`).
- `git check-ignore -v assets/materials/polyhaven/foo.jpg` prints the rule — i.e. the gitignore is picking up the new location.
- The four orphan `assets/tilesets/*/` directories that were synced copies are gone.

**Gotchas**:
- `cp -R` of `polyhaven/` may take a while — it's ~300 MB of JPG.
- Double-check the `.gitignore` rule applies. Accidentally committing `polyhaven/**` would fatten the repo by hundreds of megabytes.

---

### Phase 3 — Rewrite internal paths

**Objective**: every moved script / source file resolves its paths relative to the hayflick root instead of the old blockstudio root. Nothing is rebuilt yet — this phase is edits only.

This is the highest-risk phase. Take it seriously. Edit each file, grep for the listed symbols, and fix every match.

**Files to edit**:

#### `scripts/blockstudio/rebuild-tileset.mjs`

Open it. Find the constants near the top:

```js
const REPO_ROOT = path.resolve(__dirname, "..");
const RULES_FILE = path.join(REPO_ROOT, "tilesets/_rules/general.tileset-rules.json");
```

Rewrite to:

```js
const REPO_ROOT = path.resolve(__dirname, "..", "..");
const RULES_FILE = path.join(REPO_ROOT, "assets/tilesets/_rules/general.tileset-rules.json");
```

Also find:

```js
const tilesetDir = path.join(REPO_ROOT, "tilesets", tilesetId);
```

Rewrite to:

```js
const tilesetDir = path.join(REPO_ROOT, "assets/tilesets", tilesetId);
```

And:

```js
const DRIVER = path.join(REPO_ROOT, "scripts/blender-rebuild-kit.py");
```

Rewrite to:

```js
const DRIVER = path.join(REPO_ROOT, "scripts/blockstudio/blender-rebuild-kit.py");
```

Find the import:

```js
import { buildBlenderMaterialMap } from "../src/server/pbr-library.js";
import { writeTilesetGameMetadata } from "../src/server/tileset-files.js";
import { bakeSpriteSet } from "./bake-sprite-set.mjs";
```

Rewrite to (note: packages/blockstudio/src):

```js
import { buildBlenderMaterialMap } from "../../packages/blockstudio/src/server/pbr-library.js";
import { writeTilesetGameMetadata } from "../../packages/blockstudio/src/server/tileset-files.js";
import { bakeSpriteSet } from "./bake-sprite-set.mjs";
```

#### `scripts/blockstudio/bake-sprite-set.mjs`

Find:

```js
const REPO_ROOT = path.resolve(__dirname, "..");
const BAKER = path.join(REPO_ROOT, "scripts/bake-tile-sprite.py");
const PIXEL_ART_PASS = path.join(REPO_ROOT, "scripts/pixel-art-pass.py");
```

Rewrite:

```js
const REPO_ROOT = path.resolve(__dirname, "..", "..");
const BAKER = path.join(REPO_ROOT, "scripts/blockstudio/bake-tile-sprite.py");
const PIXEL_ART_PASS = path.join(REPO_ROOT, "scripts/blockstudio/pixel-art-pass.py");
```

And the tileset dir resolution inside `bakeSpriteSet`:

```js
const tilesetDir = path.join(REPO_ROOT, "tilesets", tilesetId);
```

→

```js
const tilesetDir = path.join(REPO_ROOT, "assets/tilesets", tilesetId);
```

#### `scripts/blockstudio/downscale-materials.mjs`

Find:

```js
const REPO_ROOT = path.resolve(__dirname, "..");
const MATERIALS_DIR = path.join(REPO_ROOT, "materials");
const REGISTRY_PATH = path.join(MATERIALS_DIR, "registry.json");
const POLYHAVEN_DIR = path.join(MATERIALS_DIR, "polyhaven");
```

Rewrite:

```js
const REPO_ROOT = path.resolve(__dirname, "..", "..");
const MATERIALS_DIR = path.join(REPO_ROOT, "assets/materials");
const REGISTRY_PATH = path.join(MATERIALS_DIR, "registry.json");
const POLYHAVEN_DIR = path.join(MATERIALS_DIR, "polyhaven");
```

#### `scripts/blockstudio/stylize-material-textures.mjs`

Same MATERIALS_DIR / REGISTRY_PATH / POLYHAVEN_DIR block. Same fix.

Also fix the PASS path:

```js
const PASS = path.join(REPO_ROOT, "scripts/pixel-art-pass.py");
```

→

```js
const PASS = path.join(REPO_ROOT, "scripts/blockstudio/pixel-art-pass.py");
```

#### `scripts/blockstudio/run-kit.js`

Find:

```js
const repoRoot = resolve(__dirname, "..");
const rulesPath = resolve(repoRoot, "tilesets/_rules/general.tileset-rules.json");
```

Rewrite:

```js
const repoRoot = resolve(__dirname, "..", "..");
const rulesPath = resolve(repoRoot, "assets/tilesets/_rules/general.tileset-rules.json");
```

Find:

```js
import { BridgeClient } from "../src/server/bridge-client.js";
import { StateStore } from "../src/server/state-store.js";
import { createToolRegistry } from "../src/server/tools.js";
```

Rewrite (two levels up, then into the package):

```js
import { BridgeClient } from "../../packages/blockstudio/src/server/bridge-client.js";
import { StateStore } from "../../packages/blockstudio/src/server/state-store.js";
import { createToolRegistry } from "../../packages/blockstudio/src/server/tools.js";
```

Also find `resolve(repoRoot, "src/planner/plan-kit.js")`:

```js
const plannerOutput = execFileSync("node", [
  resolve(repoRoot, "src/planner/plan-kit.js"),
```

→

```js
const plannerOutput = execFileSync("node", [
  resolve(repoRoot, "packages/blockstudio/src/planner/plan-kit.js"),
```

#### `packages/blockstudio/src/server/pbr-library.js`

Find:

```js
const MATERIALS_DIR = path.resolve(
  new URL(".", import.meta.url).pathname,
  "../../materials"
);
```

The module lives at `packages/blockstudio/src/server/pbr-library.js`. From there, the materials dir is at `../../../../assets/materials` — i.e., four levels up:

```js
const MATERIALS_DIR = path.resolve(
  new URL(".", import.meta.url).pathname,
  "../../../../assets/materials"
);
```

**Verify with a one-liner** before moving on:

```bash
node -e 'import("./packages/blockstudio/src/server/pbr-library.js").then(m => console.log(m.listMaterials().length))'
```

Should print the number of entries in `assets/materials/registry.json` (at least 9).

#### `packages/blockstudio/src/server/tileset-files.js`

Check whether it has any hardcoded `tilesets/` or `materials/` paths. If it does, they likely take `repoRoot` as a parameter from the caller — no change needed. If it resolves internally, apply the same adjustment as pbr-library.

#### `scripts/blockstudio/blender-rebuild-kit.py`

Find the block that adds `blender/` to `sys.path`:

```python
repo_root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
blender_dir = os.path.join(repo_root, "blender")
```

After the move, this script lives at `hayflick-26-2/scripts/blockstudio/blender-rebuild-kit.py`. `os.path.abspath(__file__)` → `…/scripts/blockstudio/blender-rebuild-kit.py`. `dirname` once → `…/scripts/blockstudio`. `dirname` twice → `…/scripts`. That's wrong — we need `…/hayflick-26-2`.

Rewrite:

```python
repo_root = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
blender_dir = os.path.join(repo_root, "blender")
```

Three `dirname` calls instead of two — one for the extra `blockstudio/` level.

#### `scripts/blockstudio/render-scissor-preview.py`, `scripts/blockstudio/bake-tile-sprite.py`, `scripts/blockstudio/pixel-art-pass.py`

These take `--input` / `--output` CLI arguments and don't resolve paths relative to themselves. Verify with:

```bash
grep -nE 'os\.path\.dirname\(.*__file__|os\.path\.abspath' scripts/blockstudio/*.py
```

If nothing prints, they're path-independent — no edits needed. If something does print, review the match and apply the same "add one more dirname" adjustment.

#### `packages/blockstudio/src/planner/plan-kit.js`

Grep for any `fs.readFileSync` or `path.resolve` with a literal segment. It should only read spec / rules files passed via `--spec` / `--rules`. No edits needed unless grep finds surprises.

#### `packages/blockstudio/src/shared/**`

Pure logic, no file I/O. No edits needed.

#### `packages/blockstudio/test/*.test.js`

Grep for `tilesets/` or `materials/` inside tests. Most tests are pure unit tests over the shared modules. The one exception might be `tileability-lint.test.js` which uses `buildWallKitCatalogScene` — that's pure JS, no file reads.

If a test does read a file from disk, it's probably reading a test fixture under `test/fixtures/` (which will have moved to `packages/blockstudio/test/fixtures/`). Relative imports (`../../src/...`) will still work because the directory structure inside the package is unchanged.

**Done criteria**:
- `grep -rn 'blockstudio/tilesets' packages/blockstudio scripts/blockstudio blender` returns nothing.
- `grep -rn '"../../src"' scripts/blockstudio` returns nothing (old blockstudio-relative import).
- `node -e 'import("./packages/blockstudio/src/server/pbr-library.js").then(m => console.log(m.listMaterials().length))'` prints >= 9.
- No changes have been made to `assets/tilesets/**` or `assets/materials/**` during this phase (paths rewrite, not content change).

**Gotchas**:
- Don't rename `src/` → anything. The package structure inside `packages/blockstudio/` should mirror `blockstudio/` so relative imports inside the package continue to work. Only the top level changes.
- Watch out for `new URL(".", import.meta.url).pathname` — it resolves relative to the module's file location, which is now one level deeper than before.

---

### Phase 4 — Wire up the workspace package and root scripts

**Objective**: `@common/blockstudio` is a real pnpm workspace member. The hayflick root `package.json` gains a `rebuild` script. `pnpm install` succeeds. `pnpm test` picks up the 47 blockstudio tests.

**Actions**:

1. **Create `packages/blockstudio/package.json`**:

   ```json
   {
     "name": "@common/blockstudio",
     "private": true,
     "version": "0.1.0",
     "type": "module",
     "description": "Blender bridge, planner, and MCP tooling for modular isometric tileset generation.",
     "scripts": {
       "test": "node --test test/*.test.js",
       "lint-kit": "node src/planner/plan-kit.js --validate --rules ../../assets/tilesets/_rules/general.tileset-rules.json --spec"
     }
   }
   ```

   No dependencies block is needed — the package has no external JS deps today (ES modules, three is only imported in the dead preview dir which didn't move).

2. **Register the package** in `pnpm-workspace.yaml`:

   ```yaml
   packages:
     - apps/*
     - packages/*
   ```

   The `packages/*` glob already catches it — no edit needed. **Verify**: `pnpm ls --depth 0 --filter @common/blockstudio` prints the package after step 3.

3. **Install**:

   ```bash
   pnpm install
   ```

   This updates `pnpm-lock.yaml` to register `@common/blockstudio` as a workspace package.

4. **Add a root-level rebuild script** in `hayflick-26-2/package.json` — the existing `scripts` block:

   ```json
   {
     "scripts": {
       "dev": "pnpm --filter @apps/hub dev",
       "dev:s": "bash scripts/dev-https.sh",
       "build": "pnpm -r build",
       "typecheck": "pnpm -r typecheck",
       "lint": "pnpm -r lint",
       "test": "pnpm -r test",
       ...
     }
   }
   ```

   Add two new lines:

   ```json
       "rebuild": "node scripts/blockstudio/rebuild-tileset.mjs",
       "rebuild:all": "for id in greek_island_white desert_sandstone ground_tiles; do node scripts/blockstudio/rebuild-tileset.mjs $id; done"
   ```

   (The `rebuild:all` shell syntax won't work on Windows but matches how the rest of hayflick's `dev:s` already shells out.)

5. **Sanity check**:

   ```bash
   pnpm install        # should succeed, new package linked
   pnpm test           # should run blockstudio tests too — 47 new tests expected to pass
   pnpm typecheck      # should still pass (blockstudio has no TS, so nothing new to check)
   ```

**Done criteria**:
- `pnpm install` exits 0.
- `pnpm -r test` includes `@common/blockstudio` and reports 47 blockstudio tests passing on top of whatever hayflick had before. Total pass count = old baseline + 47.
- `pnpm ls --depth 0` lists `@common/blockstudio`.
- `pnpm rebuild greek_island_white` (at repo root) starts the rebuild pipeline. It may fail at the Blender step if the bridge isn't reachable — that's fine. The relevant check is that the Node-side script loads and resolves paths correctly. Look for the log line `[rebuild-tileset] Planning greek_island_white...` — if you see that, path wiring is correct.

**Gotchas**:
- If `pnpm install` complains about a workspace name collision, make sure no existing package is named `@common/blockstudio`. The convention in hayflick is `@common/<name>` for packages and `@apps/<name>` for apps.
- The blockstudio tests use `node --test` not vitest. The hayflick root `pnpm test` runs `pnpm -r test`, which delegates to each package's own `test` script — so as long as `packages/blockstudio/package.json` has `"test": "node --test test/*.test.js"`, it just works without any vitest integration.

---

### Phase 5 — Rebuild a real tileset end-to-end to prove the pipeline works

**Objective**: run `pnpm rebuild greek_island_white` inside hayflick and land at the same byte output that blockstudio produces today. Then reload the game and see it use the freshly-built assets directly.

**Actions**:

1. **Ensure Blender is reachable**: the rebuild script launches Blender in background mode (`--background --python`). Set `BLENDER_BIN` if needed (default is `/opt/homebrew/bin/blender` on macOS):

   ```bash
   export BLENDER_BIN=/opt/homebrew/bin/blender   # adjust for your platform
   ```

2. **Rebuild all three kits**:

   ```bash
   pnpm rebuild greek_island_white
   pnpm rebuild desert_sandstone
   pnpm rebuild ground_tiles
   ```

3. **Hash-compare the primary artifacts** against the pre-move versions (captured in Phase 0 before you touched anything):

   ```bash
   for kit in greek_island_white desert_sandstone ground_tiles; do
     shasum assets/tilesets/$kit/artifacts/kit/$kit.glb
     shasum assets/tilesets/$kit/artifacts/tiles/wall/wall.glb 2>/dev/null || true
   done
   ```

   Compare against the hashes that `blockstudio/tilesets/<kit>/artifacts/...` had at the start of Phase 0. They should match or differ only in timestamps (glTF export embeds no timestamps, so byte-equality is the expected state). If they differ visibly, the path rewiring is wrong somewhere — do not proceed; go back to Phase 3 and find the bad resolver.

4. **Run the game and check the tileset loader**:

   ```bash
   pnpm dev
   ```

   Open `http://localhost:5173/#/<experiment that loads tilesets>` — the map-editor-2d experiment at `packages/experiments/src/map-editor-2d/` is the current consumer.

5. **Update the loader path** if it's still pointing at the flat layout. Open `packages/experiments/src/map-editor-2d/tileset-loader.ts`. Line ~107:

   ```ts
   const tilesDir = `tilesets/${kitId}/tiles`;
   ```

   Change to:

   ```ts
   const tilesDir = `tilesets/${kitId}/artifacts/tiles`;
   ```

   Also update any references to `tileset.game.json`:

   ```ts
   // find
   const meta = await fetchJson<...>(`tilesets/${kitId}/tileset.game.json`);
   // change to
   const meta = await fetchJson<...>(`tilesets/${kitId}/artifacts/tileset.game.json`);
   ```

   Verify by grepping:

   ```bash
   grep -rn 'tilesets/\${.*}/\(tiles\|tileset\.game\.json\|kit\)' packages/experiments/src/map-editor-2d/
   ```

   Every match should now include `artifacts/` in the path.

6. **Reload the game** and confirm the map editor renders. If it doesn't, check the browser console and dev-server log — the api-proxy serves `/api/assets/read?path=...` from `ASSETS_ROOT = hayflick-26-2/assets`, which is correct, so any 404 is almost certainly a loader path bug, not an asset bug.

7. **Edit-test**: change `assets/tilesets/greek_island_white/tileset.json` — e.g. flip `includeCorners: true` → `false`, or rename the kit. Run `pnpm rebuild greek_island_white`. Reload the game. Confirm the change shows up. This is the "quicker iteration loop" the move is for — it must work before Phase 6 begins.

**Done criteria**:
- All three kits rebuild cleanly with no errors.
- The game loads and renders tiles from the rebuilt GLBs.
- A spec change → rebuild → game-reload cycle shows the change, end-to-end, without any sync step.
- `pnpm test` still green (47 blockstudio tests + hayflick baseline).
- `pnpm typecheck` still green.

**Gotchas**:
- The first rebuild may be slow because it has to build materials from the Polyhaven files — if you get "material not found" errors, check that `assets/materials/polyhaven/<id>/` contains the JPGs for every material referenced in the kit's `tileset.json`.
- The Blender driver path is `scripts/blockstudio/blender-rebuild-kit.py` — Blender has to find it. If it errors with "Unable to open file" verify the `DRIVER` constant in `rebuild-tileset.mjs` was updated in Phase 3.
- The loader path update is the one consumer-side change. If other hayflick packages ever load tileset assets, grep for `tilesets/` across the whole repo and update each one the same way. Phase 0 baseline shows only one file (tileset-loader.ts) as the consumer, but confirm before Phase 6.

---

### Phase 6 — Remove `sync-tileset.sh` and the `/sync-tilesets` slash command

**Objective**: the sync bridge is dead code and must be deleted so nobody ever invokes it again.

**Actions**:

```bash
git rm scripts/sync-tileset.sh
git rm .claude/commands/sync-tilesets.md
```

Verify nothing else references them:

```bash
grep -rn "sync-tileset\|sync-tilesets" . --exclude-dir=node_modules --exclude-dir=.git
```

Expected: no matches, except possibly in `docs/AGENT_LEARNINGS.md` or `CLAUDE.md` where a past note mentions them — if so, leave a one-line strikethrough in those docs: "~~sync-tileset~~ removed 2026-04-11; assets build directly into `assets/tilesets/`."

**Done criteria**:
- Both files are deleted.
- Grep comes up clean.

---

### Phase 7 — Delete the old blockstudio repo

**Objective**: `blockstudio/` no longer exists on disk. The move is committed to.

**Actions**:

1. **One last confidence check**: in hayflick, `pnpm test && pnpm typecheck && pnpm rebuild greek_island_white`. All three green.
2. **Commit the hayflick branch**: split into logical commits as the work progresses — suggested order:
   - `Vendor blockstudio tooling into scripts/blockstudio and packages/blockstudio`
   - `Move tilesets and materials into assets/`
   - `Rewire blockstudio paths for hayflick layout`
   - `Register @common/blockstudio workspace package and rebuild script`
   - `Update map-editor-2d loader to new artifacts/ path`
   - `Remove sync-tileset bridge`
3. Merge `blockstudio-move` into `main` in hayflick (or push and open a PR, whatever the project convention is).
4. **Archive and delete blockstudio**:
   ```bash
   cd ..
   mv blockstudio blockstudio.archive
   # Sanity test: does the hayflick rebuild still work with blockstudio renamed away?
   cd hayflick-26-2
   pnpm rebuild greek_island_white
   # If yes, remove the archive.
   cd ..
   rm -rf blockstudio.archive
   ```

   Alternatively, push blockstudio's final state to a tag on its GitHub remote for historical record, then delete the local working copy. Do **not** continue committing to blockstudio after Phase 4.

**Done criteria**:
- `ls /Users/ncr/dev/blockstudio` errors with "no such file".
- `pnpm rebuild greek_island_white` inside hayflick still works (proves no lingering dependency on the old path).
- Any GitHub remotes for blockstudio are either archived or deleted by the user (not the agent's call).

**Gotchas**:
- Don't delete blockstudio while hayflick is using it as a relative path — Phase 7 step 4 only runs after the move is fully committed and tested.
- If another project beyond hayflick-26-2 uses blockstudio, pause here and ask the user. Search for references: `grep -rn 'blockstudio' /Users/ncr/dev/ --include='*.md' --include='*.json' --include='*.sh' 2>/dev/null | grep -v 'hayflick-26-2' | grep -v 'blockstudio/'`.

---

### Phase 8 — Docs and convention updates

**Objective**: anyone who opens the hayflick repo tomorrow understands where the tileset pipeline lives and how to use it. This matters because the blockstudio slash command and README are gone.

**Actions**:

1. **Append to `hayflick-26-2/CLAUDE.md`** — extend the existing "Key Commands" table:

   ```markdown
   | `pnpm rebuild <id>` | Rebuild one tileset through Blender (planner + export + sprite bake). Writes to `assets/tilesets/<id>/artifacts/`. Requires `$BLENDER_BIN` and `assets/materials/polyhaven/` populated. |
   | `pnpm rebuild:all`  | Rebuild all three checked-in tilesets in sequence. |
   ```

   Also add a new section after "Pixel-Perfect Rendering":

   ```markdown
   ## Tileset Pipeline (Blockstudio)

   The isometric wall / ground tileset pipeline lives in two places:

   - `packages/blockstudio/` — planner, shared kit logic, MCP tool surface, unit tests
   - `scripts/blockstudio/` — orchestrators that shell out to Blender for the actual mesh build and sprite bake
   - `blender/*.py` — Blender-side Python (geometry, materials, export, capture, project)

   Source specs are `assets/tilesets/<id>/tileset.json`. The rebuild pipeline writes outputs under `assets/tilesets/<id>/artifacts/` (GLBs, manifests, sprites) and the authoring-debug `assets/tilesets/<id>/project/example_room.glb`.

   Material registry and Polyhaven downloads live under `assets/materials/`. The `polyhaven/` subdirectory is gitignored.

   See `docs/blockstudio/` for the full contract (game consumer, wall kit, tilekit improvement plan).
   ```

2. **Create `docs/blockstudio/README.md`** — a one-page pointer doc:

   ```markdown
   # Blockstudio tileset pipeline

   This directory holds the blockstudio design docs, moved from the standalone blockstudio repo in April 2026.

   - `tilekit-improvement-plan.md` — the 8-phase improvement plan (UVs, corner fix, lint, example room, procedural cleanup, texture budget, vocabulary, consumer contract). Historical — everything is landed.
   - `wall-kit-contract.md` — source of truth for wall-kit anchors, pivots, geometry, tile vocabulary per kit.
   - `game-consumer-contract.md` — what the game engine needs to know to load tileset artifacts.
   - `blockstudio-move-plan.md` — the move plan itself (this directory exists because of it).

   **Pipeline entry point**: `pnpm rebuild <tileset-id>` from the repo root.
   **Source specs**: `assets/tilesets/<id>/tileset.json`.
   **Outputs**: `assets/tilesets/<id>/artifacts/{kit,tiles,sprites}/…` and `.../artifacts/tileset.game.json`.
   **Materials**: `assets/materials/{registry.json,polyhaven/}`.
   **Code**: `packages/blockstudio/src/{planner,shared,server}` + `scripts/blockstudio/` + `blender/`.
   ```

3. **Append a line to `docs/AGENT_LEARNINGS.md`** (hayflick convention, see `AGENTS.md`):

   ```markdown
   2026-04-11 - Blockstudio repo folded into hayflick-26-2
   Root cause: two-repo sync bridge made every asset iteration slow and easy to forget.
   Detection signal: any mention of scripts/sync-tileset.sh or the /sync-tilesets slash command.
   Preventive checklist: never re-introduce a sync bridge. Rebuild pipelines must write directly under assets/ in the same repo the consumer lives in.
   ```

**Done criteria**:
- CLAUDE.md includes both new entries.
- `docs/blockstudio/README.md` exists and points at the other four docs.
- `docs/AGENT_LEARNINGS.md` has the new dated entry.

---

## Post-move: what the new iteration loop looks like

```bash
# edit source spec
$EDITOR assets/tilesets/greek_island_white/tileset.json

# rebuild (planner + Blender + sprite bake + game metadata, ~5 seconds)
pnpm rebuild greek_island_white

# game is already watching assets/ via the vite dev server — just reload
```

No sync step. No second repo. Same file gets edited, built, and consumed.

## Risks and rollback

**If Phase 3 (path rewiring) goes wrong**, symptoms will show up in Phase 5 as:
- `ENOENT` errors naming the old blockstudio root
- `material not found` errors in the Blender log
- `Cannot find module '../src/server/pbr-library.js'` when running rebuild

Rollback: `git switch main` in hayflick and investigate. Blockstudio is untouched at this point (Phase 1 is a copy, not a move).

**If Phase 5 rebuild produces different byte output** (same kit, different hash), the most likely causes:
- Registry file points at old material filenames (e.g. `_diff_pix.png` not found because materials weren't copied)
- Rules file not loaded → planner uses defaults that differ from what the blockstudio version did
- Blender driver's `sys.path` doesn't include the new `blender/` dir, so it imports old cached modules

Rollback: same as above.

**If Phase 7 (delete blockstudio) happens too early**, running a rebuild that still depends on a relative path into `../blockstudio` will error. Don't delete until Phase 5 has the "edit → rebuild → game reload" loop working end-to-end.

## Open questions for the user (ask BEFORE executing)

Answer these before Phase 0. They shape minor details of the plan.

1. **Do you want the blockstudio MCP server kept?** `src/server/` implements an MCP tool surface that an AI agent can call (`scene.build`, `material.apply`, `viewport.capture`, etc.). If nothing in hayflick currently talks to it over MCP, we can delete `src/server/mcp-server.js`, `src/server/cli.js`, and the tool registry and keep only the standalone rebuild path. Keeping it is cheap (few hundred lines of JS, already tested). Default answer: keep.
2. **Do you want the `blockstudio-modeler` skill file moved?** If an agent reads skills from hayflick's skills directory, yes. If skills are scoped to a different agent config, no. Default answer: move it — it's a single markdown file.
3. **Do you want blockstudio tests ported to vitest?** Keeping them as `node --test` works today and runs under `pnpm -r test`. Vitest is hayflick's convention. Default answer: keep as `node --test` for Phase 0; port later as a separate task.
4. **Do you want the `example_room.glb` debug artifact kept under `assets/tilesets/<id>/project/`?** It's authoring-only, not shipped, but it's small and useful for visual review. Default answer: keep.
5. **Is anything else in `/Users/ncr/dev/` consuming blockstudio?** If yes, pause at Phase 7 and address the other consumer first.

## Appendix: files NOT to move

To make the "what gets copied" list unambiguous:

- `blockstudio/.git` — new repo
- `blockstudio/node_modules` — regenerated by pnpm in hayflick
- `blockstudio/package.json`, `package-lock.json` — superseded by `packages/blockstudio/package.json`
- `blockstudio/preview/` — dead UI code, Vite preview shell tied to a removed tileset
- `blockstudio/vendor/common-render/` — stale copy of hayflick's own `@common/render`
- `blockstudio/CLAUDE.md` — hayflick has its own CLAUDE.md; the blockstudio-specific notes are already in the per-pipeline docs
- `blockstudio/README.md` — blockstudio's standalone README; the content is reproduced in `docs/blockstudio/README.md`
- `blockstudio/scripts/build-blockbench-plugin.mjs` — doesn't exist (deleted in Blockbench removal). Listed here only so the reader doesn't wonder where it went.

## Appendix: final directory tree in hayflick-26-2 after the move

Only the new/moved paths are shown. Everything else in hayflick stays exactly as it was.

```
hayflick-26-2/
├── assets/
│   ├── materials/                      # NEW
│   │   ├── registry.json               # NEW
│   │   └── polyhaven/                  # NEW, gitignored
│   └── tilesets/
│       ├── _rules/                     # NEW
│       │   └── general.tileset-rules.json
│       ├── greek_island_white/
│       │   ├── tileset.json            # NEW at this path (was blockstudio-side)
│       │   ├── artifacts/              # STRUCTURE CHANGED: now nested under tileset.json's sibling
│       │   │   ├── kit/
│       │   │   ├── tiles/
│       │   │   ├── sprites/
│       │   │   └── tileset.game.json
│       │   └── project/
│       │       └── example_room.glb
│       ├── desert_sandstone/           # same shape
│       └── ground_tiles/               # same shape
├── blender/                            # NEW top-level dir
│   ├── server.py, geometry.py, materials.py, export.py, capture.py, project.py
├── scripts/
│   ├── blockstudio/                    # NEW subdir
│   │   └── (9 orchestrators)
│   └── (old scripts unchanged, minus sync-tileset.sh)
├── packages/
│   ├── blockstudio/                    # NEW workspace package @common/blockstudio
│   │   ├── package.json
│   │   ├── src/{planner,shared,server}
│   │   └── test/*.test.js
│   └── (existing packages unchanged)
├── docs/
│   └── blockstudio/                    # NEW subdir
│       ├── README.md                   # NEW pointer doc
│       ├── tilekit-improvement-plan.md
│       ├── wall-kit-contract.md
│       ├── game-consumer-contract.md
│       └── blockstudio-move-plan.md
├── skills/                             # NEW (only if Q2 answer is yes)
│   └── blockstudio-modeler/SKILL.md
├── .claude/commands/                   # sync-tilesets.md REMOVED
├── package.json                        # EDITED: adds rebuild + rebuild:all scripts
├── pnpm-workspace.yaml                 # unchanged (packages/* already catches new package)
├── CLAUDE.md                           # EDITED: appends rebuild commands + Tileset Pipeline section
└── .gitignore                          # EDITED: adds assets/materials/polyhaven/
```
