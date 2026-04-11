"""
Bake one tile GLB into a pixel-perfect sprite PNG at the game pixel budget.

The game contract is ortho 2:1 iso with 32 horizontal / 16 vertical game pixels
per base cell. This script:

1. Loads a tile GLB (per-tile export, anchor at origin).
2. Frames it in an orthographic Blender camera at pitch=30°, yaw=45°.
3. Computes the exact sprite width × height in pixels from the tile's world
   bounding box so the render is crisp — no scaling, no mipmaps, every pixel
   is a deliberate projection of the mesh.
4. Renders to PNG with a transparent background (alpha enabled).
5. Also computes the pixel position of the tile's logical anchor (world
   origin) and writes a sidecar JSON with sprite dimensions + anchor offset.

Usage:
    blender --background --python scripts/bake-tile-sprite.py -- \\
        --input path/to/tile.glb \\
        --output path/to/sprite.png
"""

import sys
import os
import math
import json
from argparse import ArgumentParser


# Game pixel contract — strict 2:1 iso.
CAMERA_PITCH_DEG = 30.0
CAMERA_YAW_DEG = 45.0
GAME_PX_PER_CELL_HORIZONTAL = 32
# Isotropic pixels-per-camera-unit: horizontal world extent of a 1x1 cell
# is 2 * cos(45°) = √2 camera units, which must map to 32 pixels.
PIXELS_PER_CAMERA_UNIT = GAME_PX_PER_CELL_HORIZONTAL / math.sqrt(2)  # ≈ 22.627
# Safety padding around the sprite so the mesh never touches the edge pixels.
DEFAULT_PADDING_PX = 1


def parse_argv():
    argv = sys.argv
    if "--" in argv:
        argv = argv[argv.index("--") + 1:]
    else:
        argv = argv[1:]
    parser = ArgumentParser(description="Bake one tile GLB into a pixel-perfect sprite.")
    parser.add_argument("--input", required=True, help="Input tile GLB path.")
    parser.add_argument("--output", required=True, help="Output PNG path (+ .json sidecar).")
    parser.add_argument("--padding-px", type=int, default=DEFAULT_PADDING_PX)
    parser.add_argument(
        "--background",
        default="transparent",
        choices=["transparent", "sky", "dark", "light"],
        help="Sprite background. `transparent` (default) uses alpha=0 outside the tile.",
    )
    return parser.parse_args(argv)


def main():
    import bpy
    from mathutils import Vector

    args = parse_argv()
    input_path = os.path.abspath(args.input)
    output_path = os.path.abspath(args.output)
    os.makedirs(os.path.dirname(output_path), exist_ok=True)

    if not os.path.exists(input_path):
        raise SystemExit(f"tile GLB not found: {input_path}")

    # Clean slate.
    bpy.ops.wm.read_factory_settings(use_empty=True)

    # Import the tile.
    bpy.ops.import_scene.gltf(filepath=input_path)

    scene = bpy.context.scene

    # Background + world.
    world = scene.world or bpy.data.worlds.new("World")
    scene.world = world
    world.use_nodes = True
    bg_node = world.node_tree.nodes.get("Background")
    if args.background == "transparent":
        # World background is irrelevant when film_transparent=True, but we
        # still set a neutral value so the ambient contribution is calm.
        if bg_node:
            bg_node.inputs[0].default_value = (0.5, 0.5, 0.5, 1.0)
            bg_node.inputs[1].default_value = 0.5
    else:
        bg_presets = {
            "sky":   ((0.58, 0.72, 0.90, 1.0), 1.4),
            "dark":  ((0.04, 0.05, 0.07, 1.0), 1.0),
            "light": ((0.82, 0.85, 0.90, 1.0), 1.2),
        }
        color, strength = bg_presets[args.background]
        if bg_node:
            bg_node.inputs[0].default_value = color
            bg_node.inputs[1].default_value = strength

    # Collect imported meshes and their world bbox.
    mesh_objs = [obj for obj in scene.objects if obj.type == "MESH"]
    if not mesh_objs:
        raise SystemExit("no mesh objects imported from GLB")
    depsgraph = bpy.context.evaluated_depsgraph_get()
    min_corner = [math.inf] * 3
    max_corner = [-math.inf] * 3
    for obj in mesh_objs:
        eval_obj = obj.evaluated_get(depsgraph)
        mat_world = obj.matrix_world
        for corner in eval_obj.bound_box:
            v = mat_world @ Vector((corner[0], corner[1], corner[2]))
            for i in range(3):
                min_corner[i] = min(min_corner[i], v[i])
                max_corner[i] = max(max_corner[i], v[i])

    # Build iso camera vectors in Blender Z-up world coords.
    pitch = math.radians(CAMERA_PITCH_DEG)
    yaw = math.radians(CAMERA_YAW_DEG)
    horizontal = math.cos(pitch)
    direction = Vector((
        math.sin(yaw) * horizontal,
        -math.cos(yaw) * horizontal,
        math.sin(pitch),
    ))
    world_up = Vector((0.0, 0.0, 1.0))
    x_cam = world_up.cross(direction)
    if x_cam.length < 1e-6:
        x_cam = Vector((1.0, 0.0, 0.0))
    x_cam.normalize()
    y_cam = direction.cross(x_cam).normalized()

    # Project the 8 bbox corners to camera-plane (u, v) in world units.
    min_u, max_u = math.inf, -math.inf
    min_v, max_v = math.inf, -math.inf
    for corner_index in range(8):
        world_point = Vector((
            min_corner[0] if (corner_index & 1) == 0 else max_corner[0],
            min_corner[1] if (corner_index & 2) == 0 else max_corner[1],
            min_corner[2] if (corner_index & 4) == 0 else max_corner[2],
        ))
        u = world_point.dot(x_cam)
        v = world_point.dot(y_cam)
        min_u = min(min_u, u)
        max_u = max(max_u, u)
        min_v = min(min_v, v)
        max_v = max(max_v, v)

    # Pad in pixel space (convert back to world units).
    pad_world = args.padding_px / PIXELS_PER_CAMERA_UNIT
    min_u -= pad_world
    max_u += pad_world
    min_v -= pad_world
    max_v += pad_world

    width_world = max_u - min_u
    height_world = max_v - min_v

    sprite_width = max(1, int(round(width_world * PIXELS_PER_CAMERA_UNIT)))
    sprite_height = max(1, int(round(height_world * PIXELS_PER_CAMERA_UNIT)))

    # Recenter the frustum: camera target sits at the middle of the (u, v)
    # window we computed, back-projected into world space. The world-space
    # target is any point whose camera-projection equals the midpoint; the
    # simplest choice is the bbox center shifted so the center lines up.
    mid_u = (min_u + max_u) / 2.0
    mid_v = (min_v + max_v) / 2.0
    target = x_cam * mid_u + y_cam * mid_v

    # Build the camera.
    cam_data = bpy.data.cameras.new("iso_cam")
    cam_data.type = "ORTHO"
    cam_obj = bpy.data.objects.new("iso_cam", cam_data)
    bpy.context.collection.objects.link(cam_obj)

    distance = max(width_world, height_world) * 4 + 10
    cam_obj.location = target + direction * distance

    # Orient camera so its -Z axis points toward `target`. Build a rotation
    # matrix with the known right / up / forward axes.
    from mathutils import Matrix
    forward = (cam_obj.location - target).normalized()  # camera +Z (away from target)
    rot = Matrix((
        (x_cam.x, y_cam.x, forward.x, 0.0),
        (x_cam.y, y_cam.y, forward.y, 0.0),
        (x_cam.z, y_cam.z, forward.z, 0.0),
        (0.0, 0.0, 0.0, 1.0),
    ))
    cam_obj.rotation_euler = rot.to_euler()

    # Ortho frustum: Blender's ortho_scale is the LONGER of the two extents;
    # the shorter is scaled by aspect ratio resolution_x/resolution_y.
    cam_data.ortho_scale = max(width_world, height_world)
    scene.camera = cam_obj

    # Lighting — sun + fill + ambient so the material has something to shade.
    sun_data = bpy.data.lights.new("sun", type="SUN")
    sun_data.energy = 4.0
    sun_obj = bpy.data.objects.new("sun", sun_data)
    bpy.context.collection.objects.link(sun_obj)
    sun_obj.rotation_euler = (math.radians(55), math.radians(-15), math.radians(30))

    fill_data = bpy.data.lights.new("fill", type="SUN")
    fill_data.energy = 1.5
    fill_data.color = (0.72, 0.78, 0.9)
    fill_obj = bpy.data.objects.new("fill", fill_data)
    bpy.context.collection.objects.link(fill_obj)
    fill_obj.rotation_euler = (math.radians(-30), math.radians(20), math.radians(140))

    # Render settings.
    engines = {e.identifier for e in scene.render.bl_rna.properties["engine"].enum_items}
    scene.render.engine = "BLENDER_EEVEE_NEXT" if "BLENDER_EEVEE_NEXT" in engines else "BLENDER_EEVEE"
    scene.render.resolution_x = sprite_width
    scene.render.resolution_y = sprite_height
    scene.render.resolution_percentage = 100
    scene.render.film_transparent = args.background == "transparent"
    scene.render.image_settings.file_format = "PNG"
    scene.render.image_settings.color_mode = "RGBA"
    scene.render.image_settings.color_depth = "8"
    try:
        scene.eevee.taa_render_samples = 1
        scene.eevee.taa_samples = 1
    except AttributeError:
        pass
    try:
        scene.eevee.use_bloom = False
    except AttributeError:
        pass
    # Enable refraction so transmissive glass renders correctly.
    try:
        scene.eevee.use_ssr = True
        scene.eevee.use_ssr_refraction = True
    except AttributeError:
        pass
    try:
        scene.eevee.use_raytracing = True
    except AttributeError:
        pass

    # Force nearest-neighbour texture sampling for pixel-art output.
    for image in bpy.data.images:
        if hasattr(image, "use_interpolation"):
            image.use_interpolation = False

    # Compute anchor pixel coordinates. The tile's logical anchor is the
    # world origin (tiles are exported so anchor == (0,0,0)). Project it.
    anchor_world = Vector((0.0, 0.0, 0.0))
    anchor_u = anchor_world.dot(x_cam)
    anchor_v = anchor_world.dot(y_cam)
    # pixel_x: left-origin, right-positive
    anchor_px_x = (anchor_u - min_u) * PIXELS_PER_CAMERA_UNIT
    # pixel_y: top-origin, down-positive (PNG convention)
    anchor_px_y = sprite_height - (anchor_v - min_v) * PIXELS_PER_CAMERA_UNIT

    scene.render.filepath = output_path
    bpy.ops.render.render(write_still=True)
    print(f"[bake-tile] {output_path} {sprite_width}x{sprite_height} anchor=({anchor_px_x:.2f}, {anchor_px_y:.2f})")

    # Sidecar metadata. The runtime/game reads this to place the sprite
    # correctly on the grid: subtract (anchor_px_x, anchor_px_y) from the
    # tile's on-screen anchor position.
    sidecar = {
        "schema": "blockstudio/tile-sprite@1",
        "source": os.path.basename(input_path),
        "size": [sprite_width, sprite_height],
        "anchorPx": [round(anchor_px_x, 3), round(anchor_px_y, 3)],
        "projection": {
            "kind": "ortho_iso_2_to_1",
            "pitchDeg": CAMERA_PITCH_DEG,
            "yawDeg": CAMERA_YAW_DEG,
            "pixelsPerBaseCellHorizontal": GAME_PX_PER_CELL_HORIZONTAL,
            "pixelsPerCameraUnit": round(PIXELS_PER_CAMERA_UNIT, 6),
        },
        "orthoFrustum": {
            "minU": round(min_u, 6),
            "maxU": round(max_u, 6),
            "minV": round(min_v, 6),
            "maxV": round(max_v, 6),
        },
    }
    sidecar_path = os.path.splitext(output_path)[0] + ".sprite.json"
    with open(sidecar_path, "w", encoding="utf-8") as fh:
        json.dump(sidecar, fh, indent=2)
    print(f"[bake-tile] sidecar → {sidecar_path}")


if __name__ == "__main__":
    main()
