---
name: blockstudio-modeler
description: Use when creating or revising Blockstudio tilesets in Blender. Drives the geometry planner CLI to produce precise scene plans, then uses generic MCP tools to render, apply PBR materials, capture, and export assets.
---

# Blockstudio Modeler

Use this skill when you need to create or revise a versioned tileset in this repo.

## Architecture

There are three layers. You orchestrate them:

1. **Shared rules** (`tilesets/_rules/general.tileset-rules.json`) — fixed geometry contract (base unit, pixel ratios, anchors, required parts). Already defined. Do not re-ask the user for these values.
2. **Geometry planner** (`node src/planner/plan-kit.js`) — deterministic code that turns a kit spec + rules into a precise scene plan with exact coordinates, pivots, and UVs. You run this via bash.
3. **MCP tools** — generic Blender automation. You call these to render scene plans, apply PBR materials, capture viewports, and export GLBs.

## Persistent files

- Shared rules: `tilesets/_rules/general.tileset-rules.json`
- Per-tileset profile: `tilesets/<id>/tileset.json`
- Blender working files: `tilesets/<id>/project/<id>.blend` + `project/captures/`
- Game-ready exports: `tilesets/<id>/artifacts/`
- Game-ready metadata: `tilesets/<id>/artifacts/tileset.game.json`

Treat `artifacts/` as the game-facing copy source. Git is the versioning system.

## MCP tools available

- `bridge.status` — confirm the Blender bridge is connected
- `tileset.init` — create versioned workspace, open Blender project
- `tileset.save_profile` — persist per-tileset metadata
- `project.new`, `project.save`, `project.close` — project lifecycle
- `scene.build` — render a scene plan into Blender geometry
- `scene.inspect` — read current scene state
- `material.list` / `material.resolve` / `material.download` / `material.apply` — PBR material library (Polyhaven); `material.apply` is the only path to assign textures
- `viewport.capture` — screenshot (isometric, front, side, exploded)
- `export.assets` — export GLB/glTF with manifests + game metadata

Before running tools: the Blender bridge must be up. Start it with `blender --background --python blender/server.py` in a separate terminal.

## Interview flow

When the user has not already provided the information, ask concise questions:

### Tileset profile

Ask for:
- Tileset name and stable id
- Style notes, reference images, artistic vision
- Required parts and variants (e.g. "arched windows with casement articulation", "wooden door", "corner pieces")
- Any geometry overrides from the shared rules (wall height, thickness, etc.)
- Which PBR materials to use per role (`wallMaterial`, `trimMaterial`, `accentMaterial` for wall kits; `tileMaterials: { <tile>: <id> }` for ground kits). Browse `materials/registry.json` or pull from Polyhaven via `material.download`.

Save with `tileset.init` or `tileset.save_profile`.

### Shared rules

The shared rules file should already exist with correct values. If it is missing or needs updating, write it directly as JSON to `tilesets/_rules/general.tileset-rules.json`. Do not ask the user to reconfigure values that are already defined there.

## Kit spec format

The planner expects a JSON kit spec. Generate this from the user's description:

```json
{
  "name": "medieval_stone",
  "kind": "wall_kit",
  "wallSpan": 128,
  "wallHeight": 280,
  "wallThickness": 32,
  "floorThickness": 6,
  "door": {
    "width": 90,
    "height": 220
  },
  "windowFamilies": [
    {
      "name": "arrow_slit",
      "middleWidth": 16,
      "openingHeight": 200,
      "sillHeight": 80,
      "variants": [
        { "name": "fixed", "articulation": { "type": "fixed" } }
      ]
    },
    {
      "name": "arched_window",
      "middleWidth": 48,
      "openingHeight": 180,
      "sillHeight": 60,
      "repeatableMiddlePanels": 2,
      "variants": [
        { "name": "fixed", "articulation": { "type": "fixed" } },
        { "name": "casement_left", "articulation": { "type": "casement_left" } }
      ]
    }
  ],
  "includeCorners": true,
  "includeEndCaps": false
}
```

Omitted fields fall back to values from the shared rules file if `--rules` is passed.

When editing a `tileset.json`, the kit spec goes under `kitSpec`. The PBR material choices go under `textures.authoring`:

```json
"textures": {
  "authoring": {
    "wallMaterial": "sandstone_cracks",
    "trimMaterial": "weathered_brown_planks",
    "accentMaterial": "glass"
  }
}
```

For ground kits, use `tileMaterials` instead:

```json
"textures": {
  "authoring": {
    "tileMaterials": {
      "asphalt": "asphalt_04",
      "concrete_walk": "concrete_wall_004",
      "grass": "forrest_ground_01",
      "sandstone": "sandstone_cracks"
    }
  }
}
```

## Build workflow

1. Confirm the Blender bridge is running (`bridge.status` → `connected: true`).
2. Call `tileset.init` to create the versioned workspace and open a Blender project.
3. Write or edit `tilesets/<id>/tileset.json` with the kit spec and material choices.
4. Run the geometry planner to inspect the plan:
   ```bash
   node src/planner/plan-kit.js --spec tilesets/<id>/tileset.json --rules tilesets/_rules/general.tileset-rules.json
   ```
5. Call `scene.build` with the scene plan and manifest from the planner output.
6. Call `material.apply` to apply PBR materials from the kit's `textures.authoring` block. Missing materials can be pulled via `material.download` first.
7. Call `viewport.capture` for `isometric`, `front`, `side`, and `exploded` views.
8. Review captures with the user. Revise geometry or materials as needed.
9. Call `project.save` to persist the `.blend`.
10. Call `tileset.save_profile` if the tileset metadata changed.
11. Call `export.assets` to write GLB files to `tilesets/<id>/artifacts/`.
12. Call `project.close` when the run is finished.

For a non-interactive one-shot rebuild of an existing tileset, use `npm run rebuild <id>` — it runs planner → Blender → artifacts without the MCP/HTTP bridge.

### Adding variants

To add a variant (e.g. an articulated window):
1. Update the kit spec with the new variant in the window family.
2. Run the planner again with the updated spec.
3. Call `scene.build` with the new scene plan.

### Building an example room

```bash
node src/planner/plan-kit.js --spec tilesets/<id>/tileset.json --rules tilesets/_rules/general.tileset-rules.json --room
```

Then call `scene.build` with the room scene plan.

## Modeling guidance

- All precise geometry (tiling, overlaps, chamfers, pivots, anchor coords) is handled by the planner code. Do not attempt to compute these values yourself.
- Keep the root artifact anchor stable and predictable for tiling.
- Use semantic articulation pivots for doors and hinged windows.
- For repeatable window systems, keep `left + middle + right` modular and snap-safe.
- Treat logical footprint, anchor, and mesh envelope as separate concepts. Overlap and chamfer belong to the mesh envelope only.

## Texturing guidance

- Prefer PBR materials from the Polyhaven library (`materials/registry.json`). If a material isn't downloaded yet, use `material.download` to fetch it and populate the registry.
- Each role (wall/trim/accent for wall kits; one per tile for ground kits) gets its own Principled BSDF with baseColor, normal, and ARM (AO/Roughness/Metalness) maps.
- Texture files live under `materials/polyhaven/<id>/` and are gitignored — the GLB embeds them so downstream consumers don't need the registry.
- Tune `roughnessFactor` / `metallicFactor` defaults in `materials/registry.json` if a material looks wrong out-of-the-box.
