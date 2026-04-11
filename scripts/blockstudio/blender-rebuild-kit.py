"""
Standalone Blender driver: rebuild a kit directly from a job JSON.

This bypasses the HTTP bridge. It's used when the MCP bridge is unavailable
or when regenerating artifacts from an existing plan without re-running the
full MCP pipeline.

The job JSON has the shape:
    {
      "plan": {  // planner output — scenePlan, manifest, kit
        "scenePlan": {...},
        "manifest": {...},
        "kit": {...}
      },
      "materials": { "wall": { "baseColor": "...", "normal": "...", "arm": "...", "roughnessFactor": 0.85, "metallicFactor": 0.0 }, ... }  // optional
    }

Usage:
    blender --background --python scripts/blender-rebuild-kit.py -- \
        --job /path/to/job.json \
        --output-dir /path/to/artifacts \
        --file-stem my_kit_name
"""

import sys
import os
import json
from argparse import ArgumentParser


def main():
    # Blender passes script args after '--'
    if "--" in sys.argv:
        argv = sys.argv[sys.argv.index("--") + 1:]
    else:
        argv = []

    parser = ArgumentParser(description="Rebuild a kit in Blender from a job JSON.")
    parser.add_argument("--job", required=True, help="Path to job JSON (plan + materials).")
    parser.add_argument("--output-dir", required=False, default=None, help="Output directory (artifacts/).")
    parser.add_argument("--file-stem", required=False, default=None, help="File stem for the kit GLB.")
    parser.add_argument(
        "--mode",
        default="kit",
        choices=["kit", "room"],
        help="'kit' exports kit + tiles into --output-dir; 'room' exports a single GLB to --output-path.",
    )
    parser.add_argument("--output-path", required=False, default=None, help="Single-file GLB output (room mode).")
    parser.add_argument("--format", default="glb")
    args = parser.parse_args(argv)

    # Make the blender/ package importable
    repo_root = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    blender_dir = os.path.join(repo_root, "blender")
    if blender_dir not in sys.path:
        sys.path.insert(0, blender_dir)

    from geometry import build_scene
    from materials import apply_textures
    from export import export_assets, export_example_room

    with open(args.job, "r", encoding="utf-8") as fh:
        job = json.load(fh)

    plan = job.get("plan") or {}
    scene_plan = plan.get("scenePlan")
    kit = plan.get("kit")
    materials = job.get("materials") or {}

    if args.mode == "kit":
        manifest = plan.get("manifest")
        if not scene_plan or not manifest or not kit:
            raise SystemExit("Job JSON is missing plan.scenePlan, plan.manifest or plan.kit.")
        if not args.output_dir or not args.file_stem:
            raise SystemExit("kit mode requires --output-dir and --file-stem.")

        print(f"[rebuild-kit] Building scene: {len(manifest.get('parts', []))} parts")
        build_result = build_scene({"scenePlan": scene_plan})
        print(f"[rebuild-kit] Built {build_result['partCount']} manifest groups")

        if materials:
            print(f"[rebuild-kit] Applying {len(materials)} PBR materials: {', '.join(materials.keys())}")
            tex_result = apply_textures({"materials": materials})
            print(f"[rebuild-kit] Assigned material to {tex_result.get('assignedCount', 0)} meshes")
        else:
            print("[rebuild-kit] No materials provided — skipping texture application")

        print(f"[rebuild-kit] Exporting to {args.output_dir}")
        export_result = export_assets({
            "outputDir": args.output_dir,
            "format": args.format,
            "fileStem": args.file_stem,
            "exportTiles": True,
            "kit": kit,
            "manifest": manifest,
        })

        saved = export_result.get("saved", [])
        print(f"[rebuild-kit] Wrote {len(saved)} files:")
        for entry in saved:
            print(f"  {entry['format']}: {entry['path']}")

        warnings = export_result.get("warnings", [])
        if warnings:
            print("[rebuild-kit] Warnings:")
            for w in warnings:
                print(f"  - {w}")
    elif args.mode == "room":
        if not scene_plan or not kit:
            raise SystemExit("room mode requires plan.scenePlan and plan.kit in the job JSON.")
        if not args.output_path:
            raise SystemExit("room mode requires --output-path.")

        print(f"[rebuild-kit] Building example room scene")
        build_scene({"scenePlan": scene_plan})

        if materials:
            print(f"[rebuild-kit] Applying {len(materials)} PBR materials to room: {', '.join(materials.keys())}")
            apply_textures({"materials": materials})

        print(f"[rebuild-kit] Exporting room to {args.output_path}")
        export_example_room({
            "outputPath": args.output_path,
            "format": args.format,
            "kit": kit,
        })
        print(f"[rebuild-kit] Wrote example room: {args.output_path}")


if __name__ == "__main__":
    main()
