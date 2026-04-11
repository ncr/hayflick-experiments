"""
Viewport capture for Blockstudio Blender bridge.

Renders the scene from preset camera angles and returns base64 PNG images.
Uses Blender's Workbench engine for fast, clean renders.
"""

import bpy
import os
import math
import base64
import tempfile
from mathutils import Vector


# Canonical camera presets (same contract as the original Blockstudio bridge).
PRESETS = {
    "isometric": {"angle_h": math.radians(45), "angle_v": math.radians(30), "distance_scale": 1.35},
    "exploded": {"angle_h": math.radians(45), "angle_v": math.radians(30), "distance_scale": 1.75},
    "front": {"angle_h": 0, "angle_v": 0, "distance_scale": 1.5, "ortho": True},
    "side": {"angle_h": math.radians(90), "angle_v": 0, "distance_scale": 1.5, "ortho": True},
}


def capture_viewport(payload):
    """Capture a rendered image of the scene from a preset camera angle."""
    preset_name = payload.get("preset", "isometric")
    width = int(payload.get("width", 1600))
    height = int(payload.get("height", 900))
    distance_scale = float(payload.get("distanceScale", 1.0))

    preset = PRESETS.get(preset_name, PRESETS["isometric"])

    # Compute scene bounds
    bounds = _get_scene_bounds()
    if bounds is None:
        raise ValueError("No mesh objects in scene to capture.")

    center = bounds["center"]
    radius = bounds["radius"]

    # Set up camera
    camera = _ensure_camera()
    dist = radius * preset["distance_scale"] * distance_scale

    angle_h = preset["angle_h"]
    angle_v = preset["angle_v"]
    is_ortho = preset.get("ortho", False)

    # Camera position: spherical coordinates around center
    cam_x = center[0] + dist * math.cos(angle_v) * math.sin(angle_h)
    cam_y = center[1] - dist * math.cos(angle_v) * math.cos(angle_h)
    cam_z = center[2] + dist * math.sin(angle_v)

    camera.location = (cam_x, cam_y, cam_z)

    # Point camera at center
    direction = Vector(center) - Vector(camera.location)
    rot_quat = direction.to_track_quat('-Z', 'Y')
    camera.rotation_euler = rot_quat.to_euler()

    if is_ortho:
        camera.data.type = "ORTHO"
        camera.data.ortho_scale = radius * 2.5
    else:
        camera.data.type = "PERSP"
        camera.data.lens = 50

    camera.data.clip_start = 0.1
    camera.data.clip_end = dist * 10

    # Ensure scene lighting for PBR
    _ensure_scene_lighting()

    # Render settings
    scene = bpy.context.scene
    scene.camera = camera
    scene.render.resolution_x = width
    scene.render.resolution_y = height
    scene.render.resolution_percentage = 100
    scene.render.film_transparent = True
    scene.render.image_settings.file_format = "PNG"
    scene.render.image_settings.color_mode = "RGBA"

    # Use EEVEE for PBR-aware renders (fast enough for captures)
    if "BLENDER_EEVEE_NEXT" in bpy.context.preferences.addons:
        scene.render.engine = "BLENDER_EEVEE_NEXT"
    else:
        scene.render.engine = "BLENDER_EEVEE"

    # Render to temp file
    with tempfile.NamedTemporaryFile(suffix=".png", delete=False) as tmp:
        tmp_path = tmp.name

    try:
        scene.render.filepath = tmp_path
        bpy.ops.render.render(write_still=True)

        with open(tmp_path, "rb") as f:
            png_data = f.read()
        b64 = base64.b64encode(png_data).decode("ascii")
    finally:
        if os.path.exists(tmp_path):
            os.unlink(tmp_path)

    return {
        "preset": preset_name,
        "mimeType": "image/png",
        "base64": b64,
        "width": width,
        "height": height,
    }


def _ensure_scene_lighting():
    """Add a sun light and ambient world lighting if not already present."""
    # Sun light
    sun = bpy.data.objects.get("blockstudio_sun")
    if not sun:
        light_data = bpy.data.lights.new(name="blockstudio_sun", type="SUN")
        light_data.energy = 3.0
        sun = bpy.data.objects.new("blockstudio_sun", light_data)
        bpy.context.scene.collection.objects.link(sun)
    sun.rotation_euler = (math.radians(50), math.radians(15), math.radians(30))

    # World ambient light
    world = bpy.context.scene.world
    if not world:
        world = bpy.data.worlds.new("blockstudio_world")
        bpy.context.scene.world = world
    world.use_nodes = True
    bg = world.node_tree.nodes.get("Background")
    if bg:
        bg.inputs["Color"].default_value = (0.8, 0.85, 0.9, 1.0)
        bg.inputs["Strength"].default_value = 0.5


def _ensure_camera():
    """Get or create the render camera."""
    for obj in bpy.data.objects:
        if obj.type == "CAMERA" and obj.name == "blockstudio_camera":
            return obj

    cam_data = bpy.data.cameras.new(name="blockstudio_camera")
    cam_obj = bpy.data.objects.new("blockstudio_camera", cam_data)
    bpy.context.scene.collection.objects.link(cam_obj)
    return cam_obj


def _get_scene_bounds():
    """Compute AABB of all mesh objects."""
    bpy.context.view_layer.update()

    min_co = [float("inf")] * 3
    max_co = [float("-inf")] * 3
    found = False

    for obj in bpy.context.scene.objects:
        if obj.type != "MESH":
            continue
        found = True
        for corner in obj.bound_box:
            world_co = obj.matrix_world @ Vector(corner)
            for i in range(3):
                min_co[i] = min(min_co[i], world_co[i])
                max_co[i] = max(max_co[i], world_co[i])

    if not found:
        return None

    center = [(min_co[i] + max_co[i]) / 2 for i in range(3)]
    size = [max_co[i] - min_co[i] for i in range(3)]
    radius = max(Vector(size).length / 2, 1)

    return {
        "min": min_co,
        "max": max_co,
        "center": center,
        "size": size,
        "radius": radius,
    }
