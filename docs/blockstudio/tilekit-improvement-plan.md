# Tilekit generator improvement plan

This plan is self-contained. It assumes no prior conversation context. Read the whole document before starting.

## Why this plan exists

A previous review found that the Blockstudio kit generator architecture (rules → planner → Blender bridge) is sound in shape, but the actual GLB output has three critical gaps that block the stated goal of "perfectly tileable, PBR-nice textured kits for an isometric game":

1. **Meshes have no UVs or tangents** — PBR materials reference baseColor/normal textures but there are no UV coordinates to sample them with. Downstream consumers see either solid albedo or undefined output. The 2.7–9.6 MB of embedded textures in every GLB is currently wasted.
2. **Corner mesh envelopes overlap adjacent wall cells** by half a wall thickness — a tileability bug that violates the project's own "butt joints, no mesh overlap" rule.
3. **No end-to-end tileability validation** — the build never exercises `buildWallExampleRoomScene`, so there's no proof that any two adjacent parts actually compose into a closed room.

Plus four lower-severity issues: texture-budget oversupply, two parallel material pipelines (procedural leftovers from the Blockbench era), incomplete tile vocabulary, and undocumented game-consumer contract.

## Verification receipts (from the review)

Run these to reproduce the findings before starting fixes:

```bash
# 1. Confirm meshes have no UV or TANGENT attributes
python3 -c "
import struct, json
for name in ['greek_island_white','desert_sandstone','ground_tiles']:
    with open(f'tilesets/{name}/artifacts/kit/{name}.glb','rb') as f: d=f.read()
    cl,_ = struct.unpack('<II', d[12:20])
    j = json.loads(d[20:20+cl].decode())
    attrs = set()
    for m in j.get('meshes', []):
        for p in m.get('primitives', []):
            attrs.update(p.get('attributes', {}).keys())
    print(f'{name}: {sorted(attrs)}')
"
# Expected output (bad): each kit shows only ['NORMAL', 'POSITION']
# Target (good): ['NORMAL', 'POSITION', 'TANGENT', 'TEXCOORD_0']

# 2. Confirm corner overlaps walls
python3 -c "
import struct, json
def b(p):
    with open(p,'rb') as f: d=f.read()
    cl,_=struct.unpack('<II', d[12:20])
    j=json.loads(d[20:20+cl].decode())
    for m in j['meshes']:
        for pr in m['primitives']:
            a=j['accessors'][pr['attributes']['POSITION']]
            return a['min'], a['max']
print('corner:', b('tilesets/greek_island_white/artifacts/tiles/corner/corner.glb'))
print('wall:  ', b('tilesets/greek_island_white/artifacts/tiles/wall/wall.glb'))
"
# Expected output (bad):
#   corner: ([-0.125, 0, -1.0], [1.0, 2.1875, 0.125])
#   wall:   ([-0.5, 0, -0.125], [0.5, 2.1875, 0.125])
# Corner width = 1.125 (not 1.0). The 0.125 overhang on each open side is the wallThickness/2 = 16 auth units that overlaps the neighboring cell.

# 3. Confirm geometry.py generates no UVs
grep -n 'uv_layers\|calc_tangents\|uv_layer' blender/geometry.py
# Expected output (bad): no matches
```

## Goal

After this plan lands, `npm run rebuild greek_island_white` should produce:
- A GLB with `POSITION`, `NORMAL`, `TEXCOORD_0`, `TANGENT` per primitive.
- PBR materials that actually sample their texture maps at the expected texel density.
- A corner mesh that fits inside exactly one cell (`1.0 × 2.1875 × 1.0` in glTF units).
- A companion `example_room.glb` proving the kit composes into a closed 3×3 room with zero mesh-envelope overlaps or gaps between adjacent tiles.
- A passing `npm run lint-kit` (new command) that validates every neighbor combination for every kit.
- Documentation (`docs/game-consumer-contract.md`) explaining what downstream loaders should do with the exports.

## Scope and non-goals

**In scope:**
- World-space box-projection UVs on every mesh
- Tangent generation
- Corner geometry fix
- Planner-side tileability lint
- Example room as a standard build artifact
- Removing the dead procedural texture pipeline
- Texture budget review (may remain a flagged TODO if downscaling is non-trivial)
- Game consumer contract doc

**Out of scope:**
- Replacing Blender as the renderer
- Changing the base unit (128 auth units = 1 base cell stays)
- Adding new kit types beyond wall_kit and ground
- Multi-material-per-mesh (face-level material assignment)
- Ambient occlusion baking (use Polyhaven ARM maps as-is)
- Interior wall variants, roof tiles, props, furniture
- Runtime three.js / babylon.js integration code

---

## Execution plan

Phases are ordered by dependency. Phase 1 unblocks everything else. Phase 2 is independent of Phase 1. Phases 3–4 depend on the geometry being stable (phases 1+2 done). Phases 5–8 are clean-up / polish / docs.

Each phase has: **objective**, **files**, **approach**, **done criteria**, **gotchas**. Do not skip the done criteria — they are the only way to know a phase is actually finished.

---

### Phase 1 — Add UVs and tangents in the Blender bridge

**Objective:** Every exported GLB primitive has a `TEXCOORD_0` attribute and a `TANGENT` attribute, derived deterministically from world-space dimensions so that adjacent tiles using the same material show continuous texel density.

**Files:**
- `blender/geometry.py` — all mesh builders. The four functions that call `mesh.from_pydata` are:
  - `_create_box_mesh` (line ~165) — axis-aligned boxes
  - `_create_top_chamfered_prism` (line ~201) — obsolete now that chamfers are zero in the rules, but keep it compatible
  - `_create_vertical_edge_chamfered_prism` (line ~239) — same
  - `_create_extruded_polygon` (line ~287) — used by corners (polygon_prism)
- Add a helper `_assign_box_projection_uvs(mesh, uv_scale_auth_units)` and call it from each mesh builder.
- Call `mesh.calc_tangents()` at the end of each builder (must be after UVs exist).

**Approach — world-space box projection:**

For each polygon of the mesh:
1. Compute the polygon normal.
2. Pick the dominant axis (largest `abs(n.x)`, `abs(n.y)`, `abs(n.z)`).
3. For each loop of that polygon, take the vertex's LOCAL coordinate (`mesh.vertices[loop.vertex_index].co` — this is in the mesh's own space, which is relative to the object origin, but for our purposes equivalent to world space up to translation because our objects never rotate and never scale at construction time).
4. Drop the dominant axis, use the remaining two as (U, V).
5. Divide by `uv_scale_auth_units` (constant, default 128 auth units per UV tile = 1 meter per UV tile).

Pseudocode:

```python
UV_SCALE_AUTH_UNITS = 128  # 1 UV tile = 1 base cell = 1 meter physically

def _assign_box_projection_uvs(mesh, uv_scale=UV_SCALE_AUTH_UNITS):
    """Generate world-space box-projection UVs for every loop in the mesh.

    Each face picks its dominant axis by normal, then projects the remaining
    two world coordinates into UV space. UVs are divided by ``uv_scale`` so
    that 1 UV unit maps to ``uv_scale`` authoring units. Tiles using the same
    material show identical texel density regardless of face orientation or
    tile size.
    """
    uv_layer = mesh.uv_layers.get("UVMap") or mesh.uv_layers.new(name="UVMap")
    mesh.calc_loop_triangles()  # ensure polygon normals are current

    for poly in mesh.polygons:
        nx, ny, nz = abs(poly.normal.x), abs(poly.normal.y), abs(poly.normal.z)
        if nx >= ny and nx >= nz:
            # X-facing — project onto (Z, Y) so U runs east-west, V runs up
            axes = (2, 1)
            flip_u = poly.normal.x < 0  # back face mirrors
        elif ny >= nz:
            # Y-facing (top/bottom) — project onto (X, Z)
            axes = (0, 2)
            flip_u = poly.normal.y < 0
        else:
            # Z-facing (front/back) — project onto (X, Y)
            axes = (0, 1)
            flip_u = poly.normal.z < 0

        for loop_index in poly.loop_indices:
            v = mesh.vertices[mesh.loops[loop_index].vertex_index].co
            u = v[axes[0]] / uv_scale
            w = v[axes[1]] / uv_scale
            if flip_u:
                u = -u
            uv_layer.data[loop_index].uv = (u, w)
```

Then after assigning UVs, call `mesh.calc_tangents()` so the glTF exporter can write `TANGENT`.

Wire it into each builder:

```python
def _create_box_mesh(name, fr, to, origin):
    ...
    mesh = bpy.data.meshes.new(name + "_mesh")
    mesh.from_pydata(verts, [], faces)
    mesh.update()
    _assign_box_projection_uvs(mesh)
    mesh.calc_tangents()
    ...
```

Do the same in `_create_top_chamfered_prism`, `_create_vertical_edge_chamfered_prism`, and `_create_extruded_polygon`.

**Done criteria:**

1. `npm run rebuild greek_island_white && npm run rebuild desert_sandstone && npm run rebuild ground_tiles` succeeds.
2. Rerun the verification script from the receipts section — every kit now shows `['NORMAL', 'POSITION', 'TANGENT', 'TEXCOORD_0']`.
3. Open one of the GLBs in a glTF viewer (three.js editor at https://threejs.org/editor/ works, or use any local glTF viewer). The wall tile shows a seamless plaster/sandstone texture with correct scale — one base cell of geometry should show roughly one repeat of the texture (or some other clearly-tileable ratio). Normal map relief is visible under lighting.
4. Unit tests pass: `npm test`.

**Gotchas:**

- `mesh.calc_tangents()` requires UVs to exist first. Order matters.
- The `flip_u` mirroring for back faces is important — otherwise normal maps look inverted on one side of the wall.
- Vertex coordinates are in LOCAL space (the mesh builders subtract origin before building vertices). Since our objects never rotate or scale, local space has the same axis alignment as world space, so box projection on local coords is equivalent to on world coords. If this invariant ever changes (e.g., if someone rotates a group empty), this assumption breaks.
- `mesh.polygons` iterates the polygon list, `poly.loop_indices` gives the loops for that polygon, `mesh.loops[li].vertex_index` gets the vertex. Don't confuse loop index with vertex index.
- Blender's glTF exporter handles TEXCOORD_0 and TANGENT automatically once they exist on the mesh. No exporter config change needed.

---

### Phase 2 — Fix corner mesh overlap

**Objective:** The corner tile's world-space bounds should be exactly `1.0 × 2.1875 × 1.0` glTF units (one base cell), not `1.125 × 2.1875 × 1.125`. A wall placed in an adjacent cell must not overlap the corner's mesh.

**Files:**
- `src/shared/scene-plan.js` — `buildCornerOutline` (~line 1186) and `buildCornerGroupPlan` (~line 783).
- `test/scene-plan.test.js` — add/update assertions for corner bounds.

**Current outline (L-shape with overhang):**

```js
function buildCornerOutline({ x, z, halfThickness, runLength }) {
  return [
    [x - halfThickness, z - halfThickness],   // overhangs into neighbor cell by halfThickness
    [x - halfThickness, z + runLength],
    [x + halfThickness, z + runLength],
    [x + halfThickness, z + halfThickness],
    [x + runLength,     z + halfThickness],
    [x + runLength,     z - halfThickness],
  ];
}
```

With `halfThickness = wallThickness/2 = 16` and `runLength = baseUnit = 128`, this produces a 144×144 envelope that sticks out `halfThickness` past the corner vertex on each open leg.

**Fix:** Shift the L so the corner vertex sits at the cell's outside corner, and both legs run inward. The new outline is:

```js
function buildCornerOutline({ x, z, thickness, runLength }) {
  // Corner anchor (x, z) is the outside vertex of the cell.
  // Two walls of width `thickness` run inward from there, each `runLength` long.
  return [
    [x,             z            ],
    [x,             z + runLength],
    [x + thickness, z + runLength],
    [x + thickness, z + thickness],
    [x + runLength, z + thickness],
    [x + runLength, z            ],
  ];
}
```

Callers must pass `thickness: spec.wallThickness` (not halfThickness) and `runLength: spec.baseUnit`. With `thickness=32` and `runLength=128`, the envelope is exactly 128×128 inside one cell.

The corner's `sceneAnchor` and `anchorClass: "vertex"` in the manifest stay as-is — they still describe the corner's logical anchor being a cell vertex. The mesh just no longer extends past that vertex.

**Update `buildCornerGroupPlan`** at line 783 to pass the new parameter shape. Grep for any other caller of `buildCornerOutline`.

**Update `buildCornerGuideNodes`** (used in debug visualization) to match the new dimensions if it references `halfThickness`.

**Update `tilesets/_rules/general.tileset-rules.json`** — no change needed, the dimensions contract is already the source of truth. Just verify the rules note still says "butt joints, no chamfers, no mesh overlap" (it does).

**Done criteria:**

1. Re-run the corner bounds probe from the receipts:
   ```bash
   python3 -c "
   import struct, json
   with open('tilesets/greek_island_white/artifacts/tiles/corner/corner.glb','rb') as f: d=f.read()
   cl,_=struct.unpack('<II', d[12:20])
   j=json.loads(d[20:20+cl].decode())
   for m in j['meshes']:
       for p in m['primitives']:
           a=j['accessors'][p['attributes']['POSITION']]
           print(a['min'], a['max'])
   "
   ```
   Expected: min = `[0, 0, -1]`, max = `[1, 2.1875, 0]` (or equivalent cell-sized box — the exact axis orientation depends on which corner of the cell the anchor sits on). Size must be `1.0 × 2.1875 × 1.0`.
2. `test/scene-plan.test.js` has a regression assertion that the corner envelope never exceeds `spec.baseUnit` in either horizontal axis.
3. `npm test` passes.

**Gotchas:**

- Check that `sceneAnchor` for the corner in the generated manifest is still at the same cell vertex it used to be — the shift only changes the mesh, not the anchor semantics.
- The Blender bridge renders `polygon_prism` nodes, which go through `_create_extruded_polygon` in `blender/geometry.py`. After Phase 1's UV work, that function must handle polygons with up to ~6 vertices (the corner L has a 6-vertex contour). Make sure box projection picks a reasonable dominant axis per triangulated face — the L-shape is in the XZ plane with triangulated top/bottom caps, which is fine.
- The "inside" of the corner (where the two walls meet at 90°) should share the wall material. If anything assigns a different textureRole there, the UV projection will still be consistent — but double-check the `_infer_texture_role` logic in `geometry.py:_infer_texture_role`.

---

### Phase 3 — Planner-side tileability lint

**Objective:** A new validator that, given a kit spec, enumerates all adjacent-part combinations and verifies that the mesh envelopes produce butt joints (no overlap, no gap) at every shared seam. Runs automatically as part of `plan-kit.js` (and fails the build on violation).

**Files:**
- New: `src/shared/tileability-lint.js` — pure function `lintKitTileability(kit) → string[]` returning issue descriptions.
- `src/planner/plan-kit.js` — call `lintKitTileability(kit)` alongside `validateModularKitSpec` and fold results into the `issues` array.
- New: `test/tileability-lint.test.js` — unit tests covering clean kits and known-bad kits (construct synthetic ones).

**What to check (wall kits):**

Enumerate these neighbor pairs:
- `wall + wall` end-to-end along a single wall run
- `wall + door` end-to-end (door is an edge run like wall)
- `wall + window_left`, `window_left + window_middle`, `window_middle + window_middle`, `window_middle + window_right`, `window_right + wall`
- `wall + corner` at every possible corner orientation (4 rotations)
- `corner + wall` in both axis directions
- `corner + corner` at a shared edge (two corners meeting back-to-back)
- `floor_tile + floor_tile` edge-to-edge and corner-to-corner

For ground kits:
- Every pair of `floor_tile`-kind parts edge-to-edge and corner-to-corner (any material combination).

**For each pair:**
1. Pick a canonical adjacency (e.g., wall at cell (0,0), neighbor at cell (1,0)).
2. Compute each part's mesh envelope in world space by taking its manifest `meshEnvelope` and `sceneAnchor`.
3. Compute the shared seam plane (the boundary between cell (0,0) and cell (1,0) is the plane X = baseUnit).
4. Check that each envelope reaches the seam plane (otherwise: **gap issue**).
5. Check that each envelope does not cross the seam plane (otherwise: **overlap issue**).
6. Tolerance: 0.001 authoring units (floating-point slop).

**Return shape:**

```js
export function lintKitTileability(kit) {
  const issues = [];
  // for each adjacency in catalog:
  //   ... compute bounds ...
  //   if (overlap) issues.push(`corner+wall: overlap of 16 auth units at X=128 seam`);
  //   if (gap) issues.push(`...`);
  return issues;
}
```

**Integration:**

```js
// src/planner/plan-kit.js — inside main()
import { lintKitTileability } from "../shared/tileability-lint.js";
// ...
const kit = createModularKitDefinition({ spec });
const lintIssues = lintKitTileability(kit);
const combinedIssues = [...issues, ...lintIssues];

if (combinedIssues.length > 0) {
  process.stderr.write(`[plan-kit] Validation issues:\n${combinedIssues.map((i) => `  - ${i}`).join("\n")}\n`);
}
```

Add a new npm script `"lint-kit": "node src/planner/plan-kit.js --spec"` that exits non-zero if `combinedIssues.length > 0` in validate mode.

**Done criteria:**

1. After Phase 2, running lint against all three committed kits produces **zero** issues. Before Phase 2, running lint against greek should produce at least one `corner+wall: overlap` issue.
2. `test/tileability-lint.test.js` has at least 6 unit tests: clean wall kit, clean ground kit, wall-corner overlap, wall-wall gap, window sequence gap, floor edge-to-edge.
3. `npm test` passes.

**Gotchas:**

- The manifest's `meshEnvelope` is `[width, height, depth]` as a tuple. It does NOT include the position of the envelope's origin. The envelope is centered on `sceneAnchor + anchorLocal` for most parts, but some parts (corners) anchor at a vertex so the envelope extends asymmetrically. You'll need a helper that returns the `[minX, minY, minZ, maxX, maxY, maxZ]` axis-aligned bounding box for a part given its anchor and envelope.
- Use `kit.partCatalog` entries (they have `anchorClass`, `meshEnvelope`, `logicalFootprint`) as the source of truth, not the scene plan. The scene plan is laid-out for display in the catalog, not for tileability math.
- Consider parameterizing the lint by "which adjacencies to check" so it's easy to extend (e.g., adding articulated doors or interior walls later).

---

### Phase 4 — Example room as a standard build artifact

**Objective:** Every `npm run rebuild <id>` also produces `tilesets/<id>/project/example_room.glb` — a closed 3×3 room using that kit, exported through the same pipeline. This proves the kit composes end-to-end and gives a visual reference for style reviews.

**Files:**
- `src/shared/scene-plan.js` — `buildWallExampleRoomScene` already exists. Verify it still works after the Phase 2 corner fix.
- `scripts/rebuild-tileset.mjs` — extend to run a second pass: planner `--room` mode, build in Blender, export.
- `scripts/blender-rebuild-kit.py` — accept a `--room-mode` flag or take a `job.mode = "room"` field, and export the room GLB to a different path (`<tileset>/project/example_room.glb`).

**Approach:**

Run the planner twice per tileset: once in catalog mode (current behavior) and once with `--room`:

```bash
node src/planner/plan-kit.js --spec <path> --rules <rules> --room
```

This returns a scene plan for an example room. Pipe it through the existing Blender pipeline with `exportTiles: false` and `fileStem: "example_room"`, output to `tilesets/<id>/project/example_room.glb`.

Put the room GLB under `project/` (not `artifacts/`) because it's a test artifact for the authoring team, not a game-facing output. The game should not ship the example room.

**Non-wall kits:** `buildGroundKitCatalogScene` exists for ground, but there's no `buildGroundExampleRoomScene`. For ground kits, a reasonable "example" is a 4×4 layout showing every tile twice in different adjacencies. Write `buildGroundExamplePatchScene({ kit })` in `scene-plan.js`, mirror the wall-room layout pattern.

**Done criteria:**

1. `npm run rebuild greek_island_white` produces `tilesets/greek_island_white/project/example_room.glb`.
2. Same for desert_sandstone and ground_tiles.
3. Open each example GLB in a viewer. The walls meet corners flush. Floor tiles tile edge-to-edge. Ground kit patch shows all 4 materials without gaps.
4. Run Phase 3 lint against the room plans — zero issues.
5. `npm test` passes (no existing tests broken).

**Gotchas:**

- Keep example rooms OUT of `artifacts/` so the game-consumer copy doesn't accidentally ship test content. Use `project/` or a new `project/examples/` directory.
- `buildWallExampleRoomScene` uses the kit's window family — make sure the disabled `window_right` in greek/desert still produces a valid room (the planner should default to fixed windows in the middle of a wall section).
- The example room is a good candidate for automated visual regression testing later — render an isometric capture of it, hash the image, and fail CI if the hash drifts unexpectedly. Out of scope for this plan but worth noting.

---

### Phase 5 — Remove the procedural texture pipeline

**Objective:** Delete the Blockbench-era procedural texture code that parallels the PBR material pipeline. One way to paint a scene, not two.

**Files to delete:**
- `src/server/procedural-textures.js` (626 lines — confirmed unused by the Blender bridge; `blender/materials.py` reads from the `materials` payload key, not `generatedImages`)
- `test/procedural-textures.test.js` (42 lines)

**Files to edit:**
- `src/server/tools.js` — remove `generatedImages` from:
  - `project.save` tool input schema and payload
  - `scene.build` tool input schema, handler, and state-store update
  - `texture.apply` tool handler (the `generatedImages` forwarding)
  - Anywhere else that references `generatedImages`
- `scripts/run-kit.js` — remove the `buildGeneratedTextureImages` import and call; remove the `textures` argument from the `scene.build` handler call
- `test/tools.test.js` — remove tests that assert `generatedImages` wiring (there is one for `texture.apply` at line ~189 that checks `generatedImages.length === 2`)

**Approach:**

1. Delete the two procedural-textures files (`git rm`).
2. Grep for `generatedImages` across the repo. Every match needs to be removed or replaced.
3. Grep for `procedural-textures`, `buildGeneratedTextureImages`, `procedural` — catch all imports and references.
4. The `texture.apply` MCP tool should now ONLY accept PBR material paths (baseColor/normal/arm). Simplify its schema.
5. The `scene.build` tool loses the `textures` input entirely — scene.build becomes geometry-only. Materials are applied in a separate `material.apply` step. This matches the intended pipeline.
6. Update `scripts/run-kit.js` to call `tools["material.apply"].handler(...)` after `scene.build` instead of passing procedural textures into `scene.build`.

**Done criteria:**

1. `grep -r "generatedImages\|procedural-textures\|buildGeneratedTextureImages" src/ scripts/ test/` returns no matches.
2. `npm test` passes.
3. `npm run rebuild greek_island_white` still produces a textured GLB (the standalone rebuild already uses `material.apply` exclusively, so it's unaffected).
4. `scripts/run-kit.js` successfully runs end-to-end against a live Blender bridge and produces a textured kit (this needs Blender open with `blender/server.py` loaded).

**Gotchas:**

- `test/tools.test.js` has tests that check `texture.apply` forwards an array of image items. After removing the procedural path, `texture.apply` can be repurposed to forward PBR material paths OR removed entirely in favor of `material.apply`. Check if any MCP client relies on `texture.apply` — if not, mark it deprecated and remove in a follow-up.
- `buildGroundKitCatalogScene` may pass `textureRole: tile.name` when building scene plan nodes. This is unrelated to procedural textures and must stay — it's how the Blender materials layer knows which mesh gets which material.
- Don't delete `blender/materials.py::apply_textures` — that's the Blender-side entry point for `material.apply` and is load-bearing.

---

### Phase 6 — Texture budget review

**Objective:** Document and optionally reduce the texture resolution to match the isometric game pixel budget. The render contract specifies 32 horizontal game-pixels per base unit. 1K Polyhaven downloads are ~32× oversupply for that budget.

**Files:**
- `src/server/pbr-library.js` — `downloadFromPolyhaven(id, resolution)` already takes a resolution parameter, currently hard-coded to `"1k"` at the call site.
- `materials/registry.json` — tracks resolution per material (`"resolution": "1k"`).
- `docs/tilekit-improvement-plan.md` — this file; add a "Texture budget rationale" section.

**Approach:**

This phase is partly research, partly code. Two paths forward:

**Path A (minimal change, ship now):** Keep 1K textures but explicitly decide the quality is deliberate (e.g., "we target 2× zoom level and want headroom for higher-density display modes"). Document the choice in the readme and move on.

**Path B (optimize):** Downscale on-disk to 256 or 512. Polyhaven's smallest preset is 1K, so you need a local resize step. Options:
1. Node-side resize using `sharp` (adds dependency, ~5 MB node_modules bump).
2. On-the-fly resize using Blender's own image loader (`bpy.ops.image.resize`) at texture application time.
3. Offline one-time resize with ImageMagick / sips and commit downscaled files.

**Recommended:** Do the research first — render one of the current 1K-texture kits in an isometric viewer at the intended game zoom (e.g., the hayflick-26-2 engine if it's set up, or three.js with an isometric camera at the expected pixel budget). If 1K looks oversupplied (MIPs getting heavily downsampled, clearly wasted detail), do Path B. Otherwise Path A.

**Path B implementation sketch (if chosen):**

```js
// In pbr-library.js, after download:
async function downloadAndResize(url, filePath, targetPx) {
  await downloadFile(url, filePath);
  // Requires sharp: npm install --save sharp
  const sharp = (await import("sharp")).default;
  const buf = await sharp(filePath).resize(targetPx, targetPx, { fit: "inside" }).toBuffer();
  fs.writeFileSync(filePath, buf);
}
```

Then update the registry to reflect the actual on-disk resolution.

**Done criteria:**

- Either:
  - (Path A) Readme has a one-paragraph explanation of the texture resolution choice, and this plan's Phase 6 is marked as "deferred — 1K accepted as final".
  - (Path B) `npm run rebuild greek_island_white` produces a kit GLB that is at least 4× smaller than before, with no visible quality regression at the intended game render zoom.

**Gotchas:**

- Don't blindly downscale normal maps — downscaling normal maps naively introduces gradient artifacts. Use a "fit: inside" + resample with high-quality filter. Even better: re-download the normal map at the target resolution if Polyhaven offers it.
- Test at multiple zoom levels. A kit that looks fine at 1× might look mushy at 0.5× if you were too aggressive.

---

### Phase 7 — Tile vocabulary completeness review

**Objective:** Decide per-kit whether each currently-disabled tile variant is deliberately omitted (stylistic choice) or accidentally missing (vocabulary gap). Document the decisions.

**Files:**
- `tilesets/greek_island_white/tileset.json` — currently has `includeWindowRight: false`
- `tilesets/desert_sandstone/tileset.json` — currently has `includeWindowRight: false`, `includeEndCaps: false`
- `tilesets/ground_tiles/tileset.json` — ground kit, different vocabulary model

**Questions to answer:**

1. **Greek / desert `includeWindowRight: false`:** Why? Is the window family symmetric (`vertical_panel`) so left == right and a dedicated right tile is redundant? If so, document it. If not, enable it and regenerate.
2. **Desert `includeEndCaps: false`:** What terminates a wall run? If walls end with a plain wall tile and that's acceptable (the side face is visible), document it. If not, add an end-cap variant.
3. **Ground kit:** Each tile type is independently placed on the grid. There's no "end-cap" concept. But check: can the game compose asphalt + grass adjacently without a visible hard seam? If not, do you need transition tiles (asphalt_grass_edge_N, etc.)? This may be out of scope for now — flag as future work.

**Done criteria:**

- `docs/wall-kit-contract.md` has a new "Tile vocabulary" section listing which variants are required per kit type and the rationale for any omissions.
- If any kit had an accidental omission, it's fixed (enable the flag, regenerate, verify Phase 3 lint still passes).

**Gotchas:**

- Don't add variants "just in case" — each new variant adds planner math and lint surface area. Only add what the kit actually needs for the example room to look right.

---

### Phase 8 — Game consumer contract documentation

**Objective:** A downstream game engine developer should be able to read one doc and understand exactly what to do with every file Blockstudio produces. No code-diving required.

**Files:**
- New: `docs/game-consumer-contract.md`

**Approach:**

Write the doc covering:

1. **Artifact layout recap** — what lives in `artifacts/kit/`, `artifacts/tiles/<tile>/`, and `artifacts/tileset.game.json`.
2. **`tileset.game.json` schema** — every field, its type, its purpose, whether it's derived or source data.
3. **Per-part manifest schema** — `sceneAnchor`, `anchorLocal`, `artifactAnchor`, `artifactSceneAnchor`, `anchorClass`, `anchorPolicy`, `logicalFootprint`, `meshEnvelope`, `articulationPivot`, `articulationType`, `hingeSide`. For each, explain what a game loader does with it.
4. **Unit contracts** — 1 glTF unit = 1 base cell = 128 cm. `artifactTransform.authoringUnitsPerArtifactUnit` = 128 is the conversion factor if a consumer needs authoring coordinates.
5. **Placement pseudocode** — show how to place a wall tile on a grid given its anchor class:
   ```
   cell_center:    world_pos = (cell_x + 0.5, 0, cell_y + 0.5) * cell_size
   edge_midpoint:  world_pos = edge_midpoint of the target grid edge
   vertex:         world_pos = grid vertex
   ```
6. **Articulation usage** — for hinged doors: `articulationPivot` (in artifact units) is the hinge axis; rotate the tile around it by angle X to open/close. `hingeSide` tells you which side the hinge is on.
7. **Consumption patterns** — discuss at least two: runtime glTF loading (three.js / babylon.js / godot) and offline sprite atlas baking (render each tile from isometric angle, pack into an atlas). Explain which fields matter for each pattern.
8. **Gotchas** — the `artifactTransform` exists so consumers can go back to authoring coordinates if needed. The `meshEnvelope` can differ from `logicalFootprint` (e.g., corners used to have L-shape overhang; after Phase 2 they don't). Always use `logicalFootprint` for grid placement, never `meshEnvelope`.

**Done criteria:**

- `docs/game-consumer-contract.md` exists and covers all fields in both `tileset.game.json` and the per-part manifests.
- Someone who has never touched Blockstudio can read it and write a prototype loader without asking questions.
- Verify by re-reading `tilesets/greek_island_white/artifacts/kit/greek_island_white.manifest.json` and checking every field is explained in the doc.

**Gotchas:**

- Keep the doc format-first, not narrative. Developers will skim for field names. Use tables and nested sections, not prose.
- If you find a field in a manifest that has no clear purpose, flag it for removal — dead fields in public artifacts confuse consumers.

---

## Recommended commit order

Each phase should be one or more atomic commits. Suggested sequence:

1. `Phase 1: add world-space box UVs and tangents in Blender mesh builders`
2. `Phase 1: regenerate all three tilesets with UVs` (big binary commit)
3. `Phase 2: shrink corner mesh to fit inside one base cell`
4. `Phase 2: regenerate tilesets with fixed corners`
5. `Phase 3: add tileability lint to planner`
6. `Phase 3: wire lint into plan-kit and add tests`
7. `Phase 4: add example room export to rebuild-tileset pipeline`
8. `Phase 4: regenerate example room GLBs`
9. `Phase 5: delete procedural texture pipeline`
10. `Phase 6: texture budget decision (Path A or B)`
11. `Phase 7: document tile vocabulary per kit`
12. `Phase 8: write game consumer contract doc`

Run `npm test` after every phase. Run `npm run rebuild <id>` for at least one kit after every geometry-affecting phase.

## Reference: current receipts (for sanity-checking "done" state)

These should all hold true *before* this plan starts. If any of them fail, the plan assumptions are wrong — stop and investigate.

```bash
# 1. Test suite green
npm test
# Expected: 43 pass

# 2. All three kits have world-correct dimensions (wall = 1.0 × 2.1875 × 0.25)
python3 << 'PY'
import struct, json
def s(p):
    with open(p,'rb') as f: d=f.read()
    cl,_ = struct.unpack('<II', d[12:20])
    j = json.loads(d[20:20+cl].decode())
    for m in j['meshes']:
        a = j['accessors'][m['primitives'][0]['attributes']['POSITION']]
        print(p, [round(a['max'][k]-a['min'][k],4) for k in range(3)])
        break
for t in ['greek_island_white', 'desert_sandstone']:
    s(f'tilesets/{t}/artifacts/tiles/wall/wall.glb')
PY
# Expected: both walls print [1.0, 2.1875, 0.25]

# 3. All three kits have materials wired but no UVs (the bug Phase 1 fixes)
python3 -c "
import struct, json
for name in ['greek_island_white','desert_sandstone','ground_tiles']:
    with open(f'tilesets/{name}/artifacts/kit/{name}.glb','rb') as f: d=f.read()
    cl,_ = struct.unpack('<II', d[12:20])
    j = json.loads(d[20:20+cl].decode())
    attrs = set()
    for m in j.get('meshes', []):
        for p in m.get('primitives', []):
            attrs.update(p.get('attributes', {}).keys())
    print(name, sorted(attrs), 'materials:', len(j.get('materials',[])))
"
# Expected: each prints ['NORMAL', 'POSITION'] with materials > 0
```

## Notes for the next agent

- This plan was written after a session that (a) fixed a unit-scale bug when the Blender pipeline was introduced, (b) regenerated all three tilesets with proper PBR materials and correct 1 base cell = 1 glTF unit scaling, and (c) did the Blockbench-to-Blender rename cleanup. Git log reference: find commits that mention "Blender" and "unit".
- The MCP-side and Blender-side protocols are already stable. Don't change them in this plan unless a phase explicitly requires it.
- The `npm run rebuild <id>` command in `scripts/rebuild-tileset.mjs` is the fastest way to iterate — it runs the planner, invokes Blender in background mode, and regenerates a tileset in ~3 seconds. Use it as your inner loop.
- If a phase's done-criteria fails, do not mark the phase complete and move on. Figure out why. A failing done-check usually means the earlier phase was misunderstood.
- Blender is required for Phases 1, 2, 4, 5's final verification. You can run the planner-only phases (3, 7, 8) without Blender.
