"""
Project lifecycle for Blockstudio Blender bridge.

Handles project_new, project_save, project_close commands.
"""

import bpy
import os
import json


def project_new(payload):
    """Create a new empty Blender scene."""
    name = payload.get("name", "blockstudio_project")
    workspace = payload.get("workspace")

    # Reset to factory defaults (clears everything)
    bpy.ops.wm.read_factory_settings(use_empty=True)

    saved = []
    if workspace and workspace.get("rootDir"):
        root_dir = workspace["rootDir"]
        os.makedirs(root_dir, exist_ok=True)
        for subdir in ["textures", "exports", "captures"]:
            d = workspace.get(f"{subdir}Dir") or os.path.join(root_dir, subdir)
            os.makedirs(d, exist_ok=True)

        if payload.get("saveNow", True):
            blend_path = os.path.join(root_dir, f"{_slugify(name)}.blend")
            bpy.ops.wm.save_mainfile(filepath=blend_path)
            saved.append({"path": blend_path, "format": "blend"})

    return {
        "ok": True,
        "project": _project_status(),
        "saved": saved,
    }


def project_save(payload):
    """Save the current Blender project."""
    workspace = payload.get("workspace", {})
    root_dir = workspace.get("rootDir") or payload.get("projectDir", "")
    file_stem = payload.get("fileStem", "blockstudio_project")

    if not root_dir:
        raise ValueError("Missing workspace rootDir or projectDir.")

    os.makedirs(root_dir, exist_ok=True)
    for subdir in ["textures", "exports", "captures"]:
        d = workspace.get(f"{subdir}Dir") or os.path.join(root_dir, subdir)
        os.makedirs(d, exist_ok=True)

    saved = []

    # Save .blend file
    blend_path = os.path.join(root_dir, f"{_slugify(file_stem)}.blend")
    bpy.ops.wm.save_mainfile(filepath=blend_path)
    saved.append({"path": blend_path, "format": "blend"})

    # Save manifest if provided
    if payload.get("manifest"):
        manifest_path = os.path.join(root_dir, f"{_slugify(file_stem)}.manifest.json")
        with open(manifest_path, "w") as f:
            json.dump(payload["manifest"], f, indent=2, default=str)
        saved.append({"path": manifest_path, "format": "manifest"})

    return {
        "ok": True,
        "project": _project_status(),
        "saved": saved,
    }


def project_close(payload):
    """Close the current project (reset to empty)."""
    bpy.ops.wm.read_factory_settings(use_empty=True)
    return {
        "ok": True,
        "project": _project_status(),
    }


def _project_status():
    return {
        "open": bool(bpy.data.filepath) or len(list(bpy.data.objects)) > 0,
        "name": os.path.basename(bpy.data.filepath) if bpy.data.filepath else None,
        "filepath": bpy.data.filepath or None,
    }


def _slugify(text):
    import re
    return re.sub(r"[^a-z0-9_]+", "_", str(text).lower().strip()).strip("_")
