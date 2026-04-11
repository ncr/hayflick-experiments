"""
Export pipeline for Blockstudio Blender bridge.

Exports scene geometry as GLB/glTF with PBR materials.
Handles whole-kit and per-tile export.
"""

import bpy
import os
import json
from datetime import datetime, timezone


# Default: 128 authoring units = 1 base cell. We export 1 base cell = 1 glTF
# unit, so the exporter divides every coordinate by this value.
DEFAULT_EXPORT_SCALE = 128


def export_assets(payload):
    """Export the current scene to GLB/glTF files. Main entry point."""
    output_dir = payload.get("outputDir", "")
    if not output_dir:
        raise ValueError("Missing outputDir.")

    format_ = payload.get("format", "glb").lower()
    file_stem = _slugify(payload.get("fileStem", "blockstudio_kit"))
    export_tiles = payload.get("exportTiles", True)
    kit = payload.get("kit", {})
    manifest = payload.get("manifest")
    workspace = payload.get("workspace")
    export_scale = _get_export_scale(kit)

    os.makedirs(output_dir, exist_ok=True)
    kit_dir = os.path.join(output_dir, "kit")
    os.makedirs(kit_dir, exist_ok=True)

    # Decorate the manifest with artifact-space coordinates before anything
    # touches the file. Downstream consumers (game loader, tile manifests)
    # read these fields.
    decorated_manifest = _decorate_manifest(manifest, export_scale)

    saved = []
    warnings = []

    # Export whole kit
    kit_saved = _export_bundle(
        kit_dir, file_stem, format_, export_scale, decorated_manifest, warnings
    )
    saved.extend(kit_saved)
    # Rebind so the rest of the function uses the decorated copy.
    manifest = decorated_manifest

    tiles = []
    if export_tiles and manifest and manifest.get("parts"):
        tiles_dir = os.path.join(output_dir, "tiles")
        os.makedirs(tiles_dir, exist_ok=True)

        for part in manifest["parts"]:
            if not part or part.get("kind") == "window_preview":
                continue

            part_name = part.get("name", "")
            tile_dir = os.path.join(tiles_dir, _slugify(part_name))
            os.makedirs(tile_dir, exist_ok=True)

            tile_stem = _slugify(part_name)
            tile_saved = _export_tile(
                tile_dir, tile_stem, format_, export_scale,
                part, manifest, kit, warnings
            )
            saved.extend(tile_saved)

            tiles.append({
                "name": part_name,
                "kind": part.get("kind"),
                "role": part.get("role"),
                "directory": tile_dir,
                "files": tile_saved,
                "articulationType": part.get("articulationType"),
                "anchor": part.get("anchorLocal", [0, 0, 0]),
                "anchorClass": part.get("anchorClass"),
                "anchorPolicy": part.get("anchorPolicy"),
                "logicalFootprint": part.get("logicalFootprint"),
                "meshEnvelope": part.get("meshEnvelope"),
            })

        # Write tiles manifest
        tiles_manifest_path = os.path.join(tiles_dir, "tiles.manifest.json")
        _write_json(tiles_manifest_path, {
            "kitId": manifest.get("kitId"),
            "name": manifest.get("name"),
            "generatedAt": datetime.now(timezone.utc).isoformat(),
            "format": format_,
            "tiles": tiles,
        })
        saved.append({"path": tiles_manifest_path, "format": "manifest"})

    return {
        "ok": True,
        "saved": saved,
        "warnings": warnings,
        "exportRoot": output_dir,
        "kitDir": kit_dir,
        "tilesDir": os.path.join(output_dir, "tiles") if export_tiles else None,
        "tiles": tiles,
    }


def export_example_room(payload):
    """Export the current scene to a single GLB (no tile splitting, no manifest).

    Used by the standalone rebuild path for example rooms — a closed kit
    demo that proves the parts compose end-to-end. No artifact-space metadata
    is written; the room is an authoring/debug artifact, not a game-facing
    export. The same 1/baseUnit root scale is applied so the room's glTF
    units match the kit exports.
    """
    output_path = payload.get("outputPath", "")
    if not output_path:
        raise ValueError("Missing outputPath.")
    kit = payload.get("kit", {})
    export_scale = _get_export_scale(kit)
    format_ = payload.get("format", "glb").lower()

    os.makedirs(os.path.dirname(output_path), exist_ok=True)

    bpy.ops.object.select_all(action="DESELECT")
    for obj in bpy.context.scene.objects:
        if obj.type in {"MESH", "EMPTY"}:
            obj.select_set(True)

    _gltf_export(output_path, format_, export_scale)

    return {
        "ok": True,
        "saved": [{"path": output_path, "format": format_}],
        "exportRoot": os.path.dirname(output_path),
    }


def _export_bundle(output_dir, file_stem, format_, export_scale, manifest, warnings):
    """Export the full scene as a single GLB/glTF + manifest."""
    saved = []

    # Write manifest JSON
    if manifest:
        manifest_path = os.path.join(output_dir, f"{file_stem}.manifest.json")
        _write_json(manifest_path, manifest)
        saved.append({"path": manifest_path, "format": "manifest"})

    ext = "glb" if format_ == "glb" else "gltf"
    output_path = os.path.join(output_dir, f"{file_stem}.{ext}")

    # Deselect all, then select all mesh objects for export
    bpy.ops.object.select_all(action="DESELECT")
    for obj in bpy.context.scene.objects:
        if obj.type in {"MESH", "EMPTY"}:
            obj.select_set(True)

    _gltf_export(output_path, format_, export_scale)
    saved.append({"path": output_path, "format": format_})

    return saved


def _export_tile(output_dir, file_stem, format_, export_scale, part, kit_manifest, kit, warnings):
    """Export a single tile (manifest part) as a separate file."""
    saved = []
    part_name = part.get("name", "")

    # Write tile manifest
    tile_manifest = {
        "kitId": kit_manifest.get("kitId"),
        "kitName": kit_manifest.get("name"),
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "format": format_,
        "artifactTransform": kit_manifest.get("artifactTransform"),
        "part": part,
        "textures": kit_manifest.get("textures", []),
    }
    manifest_path = os.path.join(output_dir, f"{file_stem}.manifest.json")
    _write_json(manifest_path, tile_manifest)
    saved.append({"path": manifest_path, "format": "manifest"})

    # Find the group Empty for this part
    group_obj = _find_manifest_group(part_name)
    if not group_obj:
        warnings.append(f'Tile group "{part_name}" not found in scene.')
        return saved

    # Collect all descendants (used for the selection set only — we don't
    # translate them individually; the parent-local transform already does
    # that for us).
    descendants = _collect_descendants(group_obj)
    all_tile_objects = [group_obj] + descendants

    # Temporarily move ONLY the group empty so the tile anchor ends up at the
    # world origin. Children inherit the translation through the parent
    # transform. Coordinates are scene Y-up → Blender Z-up.
    scene_anchor = part.get("sceneAnchor", [0, 0, 0])
    anchor_local = part.get("anchorLocal", [0, 0, 0])
    shift_scene = (
        -(scene_anchor[0] + anchor_local[0]),
        -(scene_anchor[1] + anchor_local[1]),
        -(scene_anchor[2] + anchor_local[2]),
    )
    offset_blender = (shift_scene[0], shift_scene[2], shift_scene[1])

    original_location = tuple(group_obj.location)
    group_obj.location = (
        original_location[0] + offset_blender[0],
        original_location[1] + offset_blender[1],
        original_location[2] + offset_blender[2],
    )
    bpy.context.view_layer.update()

    # Select only tile objects
    bpy.ops.object.select_all(action="DESELECT")
    for obj in all_tile_objects:
        obj.select_set(True)

    ext = "glb" if format_ == "glb" else "gltf"
    output_path = os.path.join(output_dir, f"{file_stem}.{ext}")
    _gltf_export(output_path, format_, export_scale, use_selection=True)
    saved.append({"path": output_path, "format": format_})

    # Restore the group empty's position
    group_obj.location = original_location
    bpy.context.view_layer.update()

    return saved


def _gltf_export(filepath, format_, export_scale, use_selection=False):
    """Call Blender's glTF exporter.

    Blender's glTF addon does NOT honor ``scene.unit_settings.scale_length``
    for vertex coordinates — it writes raw Blender units. To get 1 base cell
    = 1 glTF unit in the output we temporarily scale all root objects by
    ``1 / export_scale``. Children inherit the parent transform, so this
    scales the entire scene uniformly.
    """
    export_format = "GLB" if format_ == "glb" else "GLTF_SEPARATE"

    scaled_state = _apply_export_scale(export_scale)
    try:
        bpy.context.view_layer.update()
        bpy.ops.export_scene.gltf(
            filepath=filepath,
            export_format=export_format,
            export_texcoords=True,
            export_normals=True,
            export_tangents=True,
            export_materials="EXPORT",
            export_image_format="AUTO",
            export_apply=True,  # apply modifiers
            use_selection=use_selection,
            export_extras=True,  # custom properties like textureRole
            export_yup=True,  # glTF convention: Y-up (Blender converts Z-up → Y-up)
            export_animations=False,
            export_cameras=False,
            export_lights=False,
        )
    finally:
        _restore_export_scale(scaled_state)
        bpy.context.view_layer.update()


def _apply_export_scale(export_scale):
    """Apply a uniform 1/export_scale scale to every top-level object so the
    exported glTF has 1 unit = 1 base cell. Returns state for restore."""
    if not export_scale or export_scale == 1:
        return []
    factor = 1.0 / export_scale
    saved = []
    for obj in bpy.context.scene.objects:
        if obj.parent is None:
            saved.append((obj, tuple(obj.location), tuple(obj.scale)))
            obj.location = (
                obj.location[0] * factor,
                obj.location[1] * factor,
                obj.location[2] * factor,
            )
            obj.scale = (
                obj.scale[0] * factor,
                obj.scale[1] * factor,
                obj.scale[2] * factor,
            )
    return saved


def _restore_export_scale(saved):
    for obj, location, scale in saved:
        obj.location = location
        obj.scale = scale


def _decorate_manifest(manifest, export_scale):
    """Return a copy of the manifest decorated with artifact-space fields.

    ``artifactAnchor``, ``artifactSceneAnchor`` and ``artifactArticulationPivot``
    are each the corresponding authoring coordinates divided by
    ``export_scale`` — i.e. positions expressed in glTF units where 1 unit =
    1 base cell."""
    if not manifest:
        return manifest
    decorated = json.loads(json.dumps(manifest, default=str))
    decorated["artifactTransform"] = {
        "format": "gltf",
        "authoringUnitsPerArtifactUnit": export_scale,
        "artifactUnitsPerAuthoringUnit": round(1.0 / export_scale, 6),
    }
    for part in decorated.get("parts") or []:
        part["artifactAnchor"] = _scale_vector(part.get("anchorLocal"), export_scale)
        part["artifactSceneAnchor"] = _scale_vector(part.get("sceneAnchor"), export_scale)
        part["artifactArticulationPivot"] = _scale_vector(
            part.get("articulationPivot"), export_scale
        )
    return decorated


def _scale_vector(vector, export_scale):
    if not isinstance(vector, (list, tuple)):
        return None
    scaled = []
    for value in vector:
        try:
            scaled.append(round(float(value) / export_scale, 6))
        except (TypeError, ValueError):
            return None
    return scaled


def _find_manifest_group(part_name):
    """Find an Empty object by name (manifest group)."""
    for obj in bpy.context.scene.objects:
        if obj.type == "EMPTY" and obj.name == part_name:
            return obj
    return None


def _collect_descendants(obj):
    """Recursively collect all children of an object."""
    result = []
    for child in obj.children:
        result.append(child)
        result.extend(_collect_descendants(child))
    return result


def _get_export_scale(kit):
    spec = kit.get("spec", {}) if kit else {}
    rc = spec.get("renderContract", {})
    return rc.get("baseUnitCm") or spec.get("baseUnit") or DEFAULT_EXPORT_SCALE


def _slugify(text):
    import re
    return re.sub(r"[^a-z0-9_]+", "_", str(text).lower().strip()).strip("_")


def _write_json(path, data):
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2, default=str)
