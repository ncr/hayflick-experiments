"""
Render a pixel-budget scissor preview of a GLB through Blender.

Mirrors the game's ortho 2:1 iso contract (pitch 30°, yaw 45°, 32 game pixels
per base unit horizontal / 16 vertical) so the output shows the materials
roughly as the game would. Writes a low-res PNG that gets upscaled with
nearest-neighbour filtering for inspection.

Usage (via Blender):
    blender --background --python scripts/render-scissor-preview.py -- \\
        --input path/to/example_room.glb \\
        --output path/to/preview.png
"""

import sys
import os
import math
from argparse import ArgumentParser


# Game pixel contract: one base cell (1 glTF unit) = 32 game pixels horizontal
# and 16 vertical. With `pitch=30°` iso (classic 2:1), we want:
#   - horizontal world→screen:   2 * orthoHeight * aspect / width  ≈ 1/32 per px
#   - vertical world→screen:     2 * orthoHeight / height           ≈ 1/16 per px
HORIZONTAL_PX_PER_UNIT = 32
VERTICAL_PX_PER_UNIT = 16
CAMERA_PITCH_DEG = 30.0
DEFAULT_CAMERA_YAW_DEG = 45.0


def parse_argv():
    argv = sys.argv
    if "--" in argv:
        argv = argv[argv.index("--") + 1:]
    else:
        argv = argv[1:]
    parser = ArgumentParser(description="Render a pixel-budget scissor preview of a GLB.")
    parser.add_argument("--input", required=True, help="Input GLB path.")
    parser.add_argument("--output", required=True, help="Output PNG path.")
    parser.add_argument("--padding-cells", type=float, default=0.5, help="Extra cells of padding around the subject.")
    parser.add_argument(
        "--zoom",
        type=float,
        default=1.0,
        help="Multiplier on the native pixel budget. 1 = game target (32 horiz / 16 vert per cell); 8 = reference detail render.",
    )
    parser.add_argument(
        "--background",
        default="dark",
        choices=["dark", "light", "sky"],
        help="World background: dark grey (default), light grey, or pale sky blue. Useful for verifying glass transmission.",
    )
    parser.add_argument(
        "--yaw",
        type=float,
        default=DEFAULT_CAMERA_YAW_DEG,
        help="Camera yaw in degrees (default 45). Try 135 / 225 / 315 for the other three iso quadrants.",
    )
    return parser.parse_args(argv)


def main():
    import bpy

    args = parse_argv()
    input_path = os.path.abspath(args.input)
    output_path = os.path.abspath(args.output)
    os.makedirs(os.path.dirname(output_path), exist_ok=True)

    if not os.path.exists(input_path):
        raise SystemExit(f"GLB not found: {input_path}")

    # Clean slate.
    bpy.ops.wm.read_factory_settings(use_empty=True)

    # Import the GLB (preserves embedded materials and UVs).
    print(f"[scissor-preview] Importing {input_path}")
    bpy.ops.import_scene.gltf(filepath=input_path)

    scene = bpy.context.scene

    # World background. "dark" makes light plaster stand out; "light" makes
    # transmissive glass read clearly; "sky" gives a plausible outdoor look.
    bg_presets = {
        "dark": ((0.04, 0.05, 0.07, 1.0), 1.0),
        "light": ((0.82, 0.85, 0.90, 1.0), 1.2),
        "sky": ((0.58, 0.72, 0.90, 1.0), 1.4),
    }
    bg_color, bg_strength = bg_presets[args.background]
    world = scene.world or bpy.data.worlds.new("World")
    scene.world = world
    world.use_nodes = True
    bg = world.node_tree.nodes.get("Background")
    if bg:
        bg.inputs[0].default_value = bg_color
        bg.inputs[1].default_value = bg_strength

    # Compute the imported subject's world-space bounds.
    mesh_objs = [obj for obj in scene.objects if obj.type == "MESH"]
    if not mesh_objs:
        raise SystemExit("No mesh objects imported from GLB.")
    depsgraph = bpy.context.evaluated_depsgraph_get()
    min_corner = [math.inf, math.inf, math.inf]
    max_corner = [-math.inf, -math.inf, -math.inf]
    for obj in mesh_objs:
        eval_obj = obj.evaluated_get(depsgraph)
        mat_world = obj.matrix_world
        for corner in eval_obj.bound_box:
            world_corner = mat_world @ _v(corner)
            for i in range(3):
                min_corner[i] = min(min_corner[i], world_corner[i])
                max_corner[i] = max(max_corner[i], world_corner[i])
    size = [max_corner[i] - min_corner[i] for i in range(3)]
    center = [(max_corner[i] + min_corner[i]) / 2 for i in range(3)]
    print(f"[scissor-preview] subject bounds: size={_fmt(size)} center={_fmt(center)}")

    # ---- Ortho camera at iso 2:1 -----------------------------------------
    #
    # Blender uses Z-up; glTF is Y-up, but the importer already rotates the
    # scene into Blender's convention, so the "ground plane" is XY and the
    # vertical axis is Z. The camera pitch is measured from horizontal.
    pitch = math.radians(CAMERA_PITCH_DEG)
    yaw = math.radians(float(args.yaw))
    horizontal = math.cos(pitch)
    direction = (
        math.sin(yaw) * horizontal,
        -math.cos(yaw) * horizontal,  # negative Y = toward the camera
        math.sin(pitch)
    )
    distance = max(size) * 4 + 10

    cam_data = bpy.data.cameras.new("iso_cam")
    cam_data.type = "ORTHO"
    cam_obj = bpy.data.objects.new("iso_cam", cam_data)
    bpy.context.collection.objects.link(cam_obj)

    # Place the camera and aim it at the subject center. Using track_to via
    # explicit matrix math so we don't depend on a constraint that would
    # require a dependency graph update.
    from mathutils import Vector, Matrix
    target = Vector(center)
    cam_pos = target + Vector(direction) * distance
    cam_obj.location = cam_pos
    look = (target - cam_pos).normalized()
    # Camera looks down its local -Z axis in Blender.
    rot_matrix = _look_at_quaternion(look)
    cam_obj.rotation_euler = rot_matrix.to_euler()

    # Compute the ortho viewport sized so that subject + padding fits.
    # Project the bounding box into the camera's image-plane basis (right /
    # up vectors) and measure min/max along each axis.
    up_world = Vector((0, 0, 1))
    right = look.cross(up_world)
    if right.length < 1e-6:
        right = Vector((1, 0, 0))
    right = right.normalized()
    up = right.cross(look).normalized()

    min_u = math.inf
    max_u = -math.inf
    min_v = math.inf
    max_v = -math.inf
    for corner_index in range(8):
        corner = Vector((
            min_corner[0] if corner_index & 1 else max_corner[0],
            min_corner[1] if corner_index & 2 else max_corner[1],
            min_corner[2] if corner_index & 4 else max_corner[2]
        ))
        offset = corner - target
        u = offset.dot(right)
        v = offset.dot(up)
        min_u = min(min_u, u)
        max_u = max(max_u, u)
        min_v = min(min_v, v)
        max_v = max(max_v, v)

    pad = float(args.padding_cells)
    width_world = (max_u - min_u) + 2 * pad
    height_world = (max_v - min_v) + 2 * pad

    # Native pixel budget — the "scissor" low-res output — scaled by --zoom
    # for inspection. zoom=1 matches the game's canonical target; zoom=8 is
    # useful for seeing PBR detail that's being crushed at the game budget.
    zoom = float(args.zoom)
    native_width = max(32, int(round(width_world * HORIZONTAL_PX_PER_UNIT * zoom)))
    native_height = max(32, int(round(height_world * VERTICAL_PX_PER_UNIT * zoom)))
    print(f"[scissor-preview] native render: {native_width}x{native_height} @ ortho w={width_world:.3f} h={height_world:.3f} zoom={zoom}")

    # Recenter the camera target at the true u/v midpoint so the padding
    # lands symmetrically.
    mid_u = (min_u + max_u) / 2
    mid_v = (min_v + max_v) / 2
    recentered_target = target + right * mid_u + up * mid_v
    cam_pos = recentered_target + Vector(direction) * distance
    cam_obj.location = cam_pos

    # Ortho scale is the LONGEST edge of the frustum in world units. Blender
    # fits the ortho_scale into the LARGER dimension, so we pick max(w, h).
    cam_data.ortho_scale = max(width_world, height_world)
    scene.camera = cam_obj

    # ---- Render settings --------------------------------------------------
    scene.render.engine = "BLENDER_EEVEE_NEXT" if "BLENDER_EEVEE_NEXT" in {e.identifier for e in scene.render.bl_rna.properties["engine"].enum_items} else "BLENDER_EEVEE"
    scene.render.resolution_x = native_width
    scene.render.resolution_y = native_height
    scene.render.resolution_percentage = 100
    scene.render.film_transparent = False
    scene.render.image_settings.file_format = "PNG"
    scene.render.image_settings.color_mode = "RGBA"
    scene.render.image_settings.color_depth = "8"

    # Disable any anti-aliasing / TAA so pixels stay crisp.
    try:
        scene.eevee.taa_render_samples = 1
        scene.eevee.taa_samples = 1
    except AttributeError:
        pass
    try:
        scene.eevee.use_bloom = False
    except AttributeError:
        pass
    # Enable screen-space refraction so the transmissive glass actually lets
    # the background show through.
    try:
        scene.eevee.use_ssr = True
        scene.eevee.use_ssr_refraction = True
    except AttributeError:
        pass
    # Blender 4.x EEVEE Next: enable raytraced refraction.
    try:
        scene.eevee.use_raytracing = True
    except AttributeError:
        pass

    # Add a sun light so PBR materials have something to shade with.
    sun_data = bpy.data.lights.new("sun", type="SUN")
    sun_data.energy = 5.0
    sun_obj = bpy.data.objects.new("sun", sun_data)
    bpy.context.collection.objects.link(sun_obj)
    sun_obj.rotation_euler = (math.radians(55), math.radians(-15), math.radians(30))

    # Fill light to avoid pure black shadows.
    fill_data = bpy.data.lights.new("fill", type="SUN")
    fill_data.energy = 1.5
    fill_data.color = (0.72, 0.78, 0.9)
    fill_obj = bpy.data.objects.new("fill", fill_data)
    bpy.context.collection.objects.link(fill_obj)
    fill_obj.rotation_euler = (math.radians(-30), math.radians(20), math.radians(140))

    # Render at the native pixel budget. Upscaling stays out of Blender
    # (its image.scale is bilinear); downstream tools do nearest-neighbour
    # upscales if needed for inspection.
    scene.render.filepath = output_path
    print(f"[scissor-preview] rendering to {output_path}")
    bpy.ops.render.render(write_still=True)
    print(f"[scissor-preview] wrote {output_path}")


def _v(corner):
    from mathutils import Vector
    return Vector((corner[0], corner[1], corner[2]))


def _fmt(vec):
    return "[" + ", ".join(f"{x:.3f}" for x in vec) + "]"


def _look_at_quaternion(look):
    """Build a rotation matrix whose -Z axis points along `look`."""
    from mathutils import Vector, Matrix
    forward = (-look).normalized()
    up = Vector((0, 0, 1))
    if abs(forward.dot(up)) > 0.999:
        up = Vector((0, 1, 0))
    right = up.cross(forward).normalized()
    up_corrected = forward.cross(right).normalized()
    matrix = Matrix((
        (right.x, up_corrected.x, forward.x, 0.0),
        (right.y, up_corrected.y, forward.y, 0.0),
        (right.z, up_corrected.z, forward.z, 0.0),
        (0.0, 0.0, 0.0, 1.0)
    ))
    return matrix


if __name__ == "__main__":
    main()
