"""
Standalone Blender driver: bake textures onto a base mesh GLB.

Takes a base mesh GLB (from assets/meshes/) plus a per-role texture set and
produces a new GLB with those textures applied, keyed by each mesh object's
`textureRole` custom property.

This is lighter weight than scripts/blockstudio/blender-rebuild-kit.py —
there's no planner, no kit spec, no procedural geometry. The base GLB is
authored upstream; we just swap materials.

Job JSON shape:
    {
      "baseMeshPath": "/abs/path/to/assets/meshes/wall.glb",
      "materials": {
        "wall":   { "baseColor": "/abs/path/...", "normal": "...", "arm": "...",
                    "roughnessFactor": 0.85, "metallicFactor": 0.0 },
        "trim":   { ... },
        "accent": { "synthetic": "glass" }
      },
      "outputPath": "/abs/path/to/assets/textured-meshes/<name>/artifact.glb"
    }

Usage:
    blender --background --python scripts/blockstudio/bake-textured-mesh.py -- \
        --job /path/to/job.json
"""

import sys
import os
import json
from argparse import ArgumentParser


def main():
    if "--" in sys.argv:
        argv = sys.argv[sys.argv.index("--") + 1:]
    else:
        argv = []

    parser = ArgumentParser(description="Bake textures onto a base mesh GLB.")
    parser.add_argument("--job", required=True, help="Path to job JSON.")
    args = parser.parse_args(argv)

    # Make the blender/ package importable (same trick as blender-rebuild-kit.py)
    repo_root = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    blender_dir = os.path.join(repo_root, "blender")
    if blender_dir not in sys.path:
        sys.path.insert(0, blender_dir)

    import bpy
    from materials import apply_textures

    with open(args.job, "r", encoding="utf-8") as fh:
        job = json.load(fh)

    base_mesh_path = job["baseMeshPath"]
    materials = job.get("materials") or {}
    output_path = job["outputPath"]

    if not os.path.isfile(base_mesh_path):
        raise SystemExit(f"Base mesh not found: {base_mesh_path}")

    # Start from an empty scene
    bpy.ops.wm.read_factory_settings(use_empty=True)

    print(f"[bake-textured-mesh] Importing {base_mesh_path}")
    bpy.ops.import_scene.gltf(filepath=base_mesh_path)

    mesh_roles = [
        obj.get("textureRole")
        for obj in bpy.context.scene.objects
        if obj.type == "MESH" and obj.get("textureRole")
    ]
    print(f"[bake-textured-mesh] Imported meshes with roles: {mesh_roles}")

    if materials:
        roles_in_job = list(materials.keys())
        print(f"[bake-textured-mesh] Applying {len(materials)} material(s): {roles_in_job}")
        tex_result = apply_textures({"materials": materials})
        print(f"[bake-textured-mesh] Assigned material to {tex_result.get('assignedCount', 0)} meshes")
    else:
        print("[bake-textured-mesh] No materials provided — exporting bare")

    out_dir = os.path.dirname(output_path)
    os.makedirs(out_dir, exist_ok=True)

    print(f"[bake-textured-mesh] Exporting to {output_path}")
    bpy.ops.export_scene.gltf(
        filepath=output_path,
        export_format="GLB",
        export_extras=True,
        export_yup=True,
        export_apply=True,
    )
    print(f"[bake-textured-mesh] Done.")


if __name__ == "__main__":
    main()
