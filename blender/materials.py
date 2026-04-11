"""
PBR material creation for Blockstudio Blender bridge.

Creates Principled BSDF materials from PBR texture maps (albedo, normal, ARM).
Assigns materials to objects based on their textureRole custom property.
"""

import bpy
import os


def apply_textures(payload):
    """Apply PBR materials to scene objects based on texture role assignments.

    Expected payload:
    {
        "materials": {
            "wall": {
                "baseColor": "/abs/path/to/diff.jpg",
                "normal": "/abs/path/to/nor.jpg",
                "arm": "/abs/path/to/arm.jpg",
                "roughnessFactor": 0.8,
                "metallicFactor": 0.0
            },
            "trim": { ... },
            "accent": { ... }
        }
    }
    """
    material_defs = payload.get("materials", {})
    if not material_defs:
        raise ValueError("No materials provided.")

    created = {}
    assigned_count = 0

    # Create Blender materials for each role
    for role, mat_def in material_defs.items():
        mat = _create_pbr_material(role, mat_def)
        created[role] = mat.name

    # Assign materials to objects based on textureRole
    for obj in bpy.context.scene.objects:
        if obj.type != "MESH":
            continue
        role = obj.get("textureRole", "wall")
        if role in created:
            mat = bpy.data.materials.get(created[role])
            if mat:
                _assign_material(obj, mat)
                assigned_count += 1

    return {
        "ok": True,
        "created": created,
        "assignedCount": assigned_count,
    }


def _create_pbr_material(role, mat_def):
    """Create a Principled BSDF material with PBR texture maps.

    If ``mat_def`` carries a ``synthetic`` key, dispatch to the synthetic
    material builder instead — used for glass and other shader-driven
    surfaces that don't come from Polyhaven.
    """
    if isinstance(mat_def, dict) and mat_def.get("synthetic"):
        return _create_synthetic_material(role, mat_def["synthetic"])

    mat_name = f"blockstudio_{role}"

    # Remove existing material with same name
    existing = bpy.data.materials.get(mat_name)
    if existing:
        bpy.data.materials.remove(existing)

    mat = bpy.data.materials.new(name=mat_name)
    mat.use_nodes = True
    nodes = mat.node_tree.nodes
    links = mat.node_tree.links

    # Clear default nodes
    nodes.clear()

    # Create output and Principled BSDF
    output = nodes.new("ShaderNodeOutputMaterial")
    output.location = (400, 0)

    bsdf = nodes.new("ShaderNodeBsdfPrincipled")
    bsdf.location = (0, 0)
    links.new(bsdf.outputs["BSDF"], output.inputs["Surface"])

    # Set scalar defaults
    roughness = mat_def.get("roughnessFactor", 0.5)
    metalness = mat_def.get("metallicFactor", 0.0)
    bsdf.inputs["Roughness"].default_value = roughness
    bsdf.inputs["Metallic"].default_value = metalness

    x_offset = -600

    # Base color texture
    base_color_path = mat_def.get("baseColor")
    if base_color_path and os.path.isfile(base_color_path):
        tex_node = _add_image_texture(nodes, base_color_path, non_color=False)
        tex_node.location = (x_offset, 300)
        links.new(tex_node.outputs["Color"], bsdf.inputs["Base Color"])

    # Normal map
    normal_path = mat_def.get("normal")
    if normal_path and os.path.isfile(normal_path):
        normal_tex = _add_image_texture(nodes, normal_path, non_color=True)
        normal_tex.location = (x_offset, -100)

        normal_map = nodes.new("ShaderNodeNormalMap")
        normal_map.location = (x_offset + 300, -100)

        links.new(normal_tex.outputs["Color"], normal_map.inputs["Color"])
        links.new(normal_map.outputs["Normal"], bsdf.inputs["Normal"])

    # ARM texture (AO=R, Roughness=G, Metalness=B)
    arm_path = mat_def.get("arm")
    if arm_path and os.path.isfile(arm_path):
        arm_tex = _add_image_texture(nodes, arm_path, non_color=True)
        arm_tex.location = (x_offset, -500)

        separate = nodes.new("ShaderNodeSeparateColor")
        separate.location = (x_offset + 300, -500)

        links.new(arm_tex.outputs["Color"], separate.inputs["Color"])
        links.new(separate.outputs[1], bsdf.inputs["Roughness"])    # G = Roughness
        links.new(separate.outputs[2], bsdf.inputs["Metallic"])     # B = Metalness

        # AO via multiply with base color (if base color exists)
        if base_color_path and os.path.isfile(base_color_path):
            # Use a MixRGB in Multiply mode to apply AO to base color
            # This is the standard approach since glTF AO is baked into the export
            pass  # glTF exporter handles AO channel from the ARM texture automatically

    return mat


def _create_synthetic_material(role, kind):
    """Build a procedural Principled BSDF for synthetic materials.

    Currently supports ``kind="glass"`` — a physically-plausible tinted
    glass with high transmission, low roughness, IOR 1.45, and a subtle
    cool tint. No textures are read; everything is shader-driven, so the
    glass reads the same at any pixel budget and actually refracts light
    instead of sampling a noisy photographic source.
    """
    mat_name = f"blockstudio_{role}"
    existing = bpy.data.materials.get(mat_name)
    if existing:
        bpy.data.materials.remove(existing)

    mat = bpy.data.materials.new(name=mat_name)
    mat.use_nodes = True
    nodes = mat.node_tree.nodes
    links = mat.node_tree.links
    nodes.clear()

    output = nodes.new("ShaderNodeOutputMaterial")
    output.location = (400, 0)
    bsdf = nodes.new("ShaderNodeBsdfPrincipled")
    bsdf.location = (0, 0)
    links.new(bsdf.outputs["BSDF"], output.inputs["Surface"])

    if kind == "glass":
        # Slight cool tint; mostly clear.
        bsdf.inputs["Base Color"].default_value = (0.72, 0.82, 0.92, 1.0)
        bsdf.inputs["Roughness"].default_value = 0.05
        bsdf.inputs["Metallic"].default_value = 0.0
        if "IOR" in bsdf.inputs:
            bsdf.inputs["IOR"].default_value = 1.45
        # Blender 4.x exposes transmission either as "Transmission Weight"
        # (Principled BSDF v2) or "Transmission" (v1). Set whichever exists.
        for key in ("Transmission Weight", "Transmission"):
            if key in bsdf.inputs:
                bsdf.inputs[key].default_value = 1.0
                break
        bsdf.inputs["Alpha"].default_value = 0.35

        # Tell the glTF exporter this is a BLENDed material.
        mat.blend_method = "BLEND" if hasattr(mat, "blend_method") else None
        if hasattr(mat, "surface_render_method"):
            mat.surface_render_method = "BLENDED"
        if hasattr(mat, "use_backface_culling"):
            mat.use_backface_culling = False
        mat.use_screen_refraction = True if hasattr(mat, "use_screen_refraction") else False
    else:
        # Unknown synthetic: fall back to a neutral grey so we at least
        # emit a visible placeholder instead of null.
        bsdf.inputs["Base Color"].default_value = (0.5, 0.5, 0.5, 1.0)
        bsdf.inputs["Roughness"].default_value = 0.8

    return mat


def _add_image_texture(nodes, filepath, non_color=False):
    """Add an image texture node, loading the image from disk."""
    tex_node = nodes.new("ShaderNodeTexImage")

    # Check if image already loaded
    img_name = os.path.basename(filepath)
    existing_img = bpy.data.images.get(img_name)
    if existing_img and existing_img.filepath == filepath:
        tex_node.image = existing_img
    else:
        img = bpy.data.images.load(filepath, check_existing=True)
        tex_node.image = img

    if non_color and tex_node.image:
        tex_node.image.colorspace_settings.name = "Non-Color"

    return tex_node


def _assign_material(obj, material):
    """Assign a material to all faces of a mesh object."""
    obj.data.materials.clear()
    obj.data.materials.append(material)
