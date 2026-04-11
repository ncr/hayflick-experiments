"""
Geometry primitives for Blockstudio Blender bridge.

Converts scene plan nodes (cubes, chamfered solids, polygon prisms, groups)
into Blender objects. Scene plans use Y-up coordinates; Blender uses Z-up.
"""

import bpy
import bmesh
from mathutils import Vector


# ---------------------------------------------------------------------------
# UV parameterization
# ---------------------------------------------------------------------------

# 1 UV tile repeat == 1 base cell (1 authoring unit == 1/128 UV units, so a
# 128-unit cube's flat face covers exactly one UV tile). Tiles using the same
# material therefore show continuous texel density regardless of their size or
# orientation.
UV_SCALE_AUTH_UNITS = 128


# ---------------------------------------------------------------------------
# Coordinate transform: scene plan (Y-up) → Blender (Z-up)
# ---------------------------------------------------------------------------

def s2b(x, y, z):
    """Scene plan coords → Blender coords. Swaps Y and Z."""
    return (x, z, y)


def s2b_vec(v):
    return s2b(v[0], v[1], v[2])


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

def build_scene(payload):
    """Build a scene from a scene plan. Entry point for kit_create_wall_set
    and scene_build_example_room commands."""
    scene_plan = payload.get("scenePlan")
    if not scene_plan or "root" not in scene_plan:
        raise ValueError("Missing scene plan root.")

    clear_scene()

    manifest_groups = {}
    # Parent world origin starts at (0,0,0). Coordinates are in Blender (Z-up)
    # space throughout the recursion.
    render_node(scene_plan["root"], None, (0.0, 0.0, 0.0), manifest_groups)

    return {
        "ok": True,
        "partCount": len(manifest_groups),
        "manifestGroups": {name: obj.name for name, obj in manifest_groups.items()},
    }


def clear_scene():
    """Remove all objects from the scene."""
    for obj in list(bpy.data.objects):
        bpy.data.objects.remove(obj, do_unlink=True)
    for mesh in list(bpy.data.meshes):
        if mesh.users == 0:
            bpy.data.meshes.remove(mesh)


# ---------------------------------------------------------------------------
# Scene plan node rendering (recursive)
# ---------------------------------------------------------------------------

def render_node(node, parent, parent_world_blender, manifest_groups):
    node_type = node.get("type")
    if node_type == "group":
        return _render_group(node, parent, parent_world_blender, manifest_groups)
    elif node_type == "cube":
        return _render_cube(node, parent, parent_world_blender)
    elif node_type == "solid":
        return _render_solid(node, parent, parent_world_blender)
    elif node_type == "polygon_prism":
        return _render_polygon_prism(node, parent, parent_world_blender)
    else:
        raise ValueError(f'Unsupported node type "{node_type}"')


def _render_group(node, parent, parent_world_blender, manifest_groups):
    name = node.get("name", "group")
    origin = node.get("origin", [0, 0, 0])
    world_blender = s2b_vec(origin)

    empty = bpy.data.objects.new(name, None)
    empty.empty_display_type = "PLAIN_AXES"
    empty.empty_display_size = 10
    empty.location = _sub(world_blender, parent_world_blender)
    bpy.context.scene.collection.objects.link(empty)

    if parent is not None:
        _attach_to_parent(empty, parent)

    if node.get("manifestPartName"):
        manifest_groups[node["manifestPartName"]] = empty

    for child in node.get("children", []):
        render_node(child, empty, world_blender, manifest_groups)

    return empty


def _render_cube(node, parent, parent_world_blender):
    name = node.get("name", "cube")
    fr = node.get("from", [0, 0, 0])
    to = node.get("to", [0, 0, 0])
    origin = node.get("origin", _default_origin(fr, to))

    obj = _create_box_mesh(name, fr, to, origin)
    _localize_object(obj, origin, parent, parent_world_blender)

    obj["textureRole"] = node.get("textureRole") or _infer_texture_role(name)
    return obj


def _render_solid(node, parent, parent_world_blender):
    """A solid is a cube with optional chamfer."""
    fr = node.get("from", [0, 0, 0])
    to = node.get("to", [0, 0, 0])
    origin = node.get("origin", _default_origin(fr, to))
    chamfer = _resolve_chamfer(fr, to, node.get("chamfer", 0))

    if chamfer <= 0.001:
        return _render_cube(node, parent, parent_world_blender)

    chamfer_mode = node.get("chamferMode", "vertical_edges")
    chamfer_corners = _resolve_chamfer_corners(node.get("chamferCorners"))
    name = node.get("name", "solid")

    if chamfer_mode == "top_perimeter":
        obj = _create_top_chamfered_prism(name, fr, to, origin, chamfer)
    else:
        obj = _create_vertical_edge_chamfered_prism(
            name, fr, to, origin, chamfer, chamfer_corners
        )

    _localize_object(obj, origin, parent, parent_world_blender)

    obj["textureRole"] = node.get("textureRole") or _infer_texture_role(name)
    return obj


def _render_polygon_prism(node, parent, parent_world_blender):
    contour = node.get("contour", [])
    if len(contour) < 3:
        raise ValueError("polygon_prism requires at least 3 contour points.")

    name = node.get("name", "polygon_prism")
    origin = node.get("origin", [0, 0, 0])
    bottom_y = node.get("bottomY", 0)
    top_y = node.get("topY", 0)

    obj = _create_extruded_polygon(name, contour, bottom_y, top_y, origin)
    _localize_object(obj, origin, parent, parent_world_blender)

    obj["textureRole"] = node.get("textureRole") or _infer_texture_role(name)
    return obj


# ---------------------------------------------------------------------------
# UV generation
# ---------------------------------------------------------------------------

def _assign_box_projection_uvs(mesh, world_offset=(0.0, 0.0, 0.0), uv_scale=UV_SCALE_AUTH_UNITS):
    """Assign world-space box-projection UVs to every loop of ``mesh``.

    For each polygon we pick the dominant axis by absolute normal, drop it,
    and use the remaining two world coordinates as (U, V). Vertex positions
    are LOCAL to the mesh; we add ``world_offset`` (the mesh's eventual
    world position, already in Blender coords) so two adjacent meshes sharing
    a seam produce continuous UV coordinates across the seam instead of both
    starting at (0, 0). The two coords are divided by ``uv_scale`` so 1 UV
    tile == 1 base cell == ``uv_scale`` authoring units. Back-facing polygons
    mirror along U so normal maps read the same way on opposing wall faces.

    Must be called before ``mesh.calc_tangents()`` — tangents need UVs.
    Polygon normals are populated automatically by Blender once the mesh has
    been updated from ``from_pydata``.
    """
    uv_layer = mesh.uv_layers.get("UVMap") or mesh.uv_layers.new(name="UVMap")
    ox, oy, oz = world_offset

    for poly in mesh.polygons:
        nx, ny, nz = abs(poly.normal.x), abs(poly.normal.y), abs(poly.normal.z)
        if nz >= nx and nz >= ny:
            # Z-facing (top/bottom in Blender's Z-up) — project onto (X, Y)
            axes = (0, 1)
            flip_u = poly.normal.z < 0
        elif nx >= ny:
            # X-facing — project onto (Y, Z)
            axes = (1, 2)
            flip_u = poly.normal.x < 0
        else:
            # Y-facing — project onto (X, Z)
            axes = (0, 2)
            flip_u = poly.normal.y < 0

        for loop_index in poly.loop_indices:
            v = mesh.vertices[mesh.loops[loop_index].vertex_index].co
            world_x = v[0] + ox
            world_y = v[1] + oy
            world_z = v[2] + oz
            world = (world_x, world_y, world_z)
            u = world[axes[0]] / uv_scale
            w = world[axes[1]] / uv_scale
            if flip_u:
                u = -u
            uv_layer.data[loop_index].uv = (u, w)


def _finalize_mesh(mesh, world_offset=(0.0, 0.0, 0.0)):
    """Generate UVs + tangents for a freshly-built mesh.

    Call this at the end of every mesh builder so the glTF exporter writes
    ``TEXCOORD_0`` and ``TANGENT`` for each primitive. ``world_offset`` is
    the mesh origin's eventual position in Blender world coordinates and is
    added to each vertex before UV projection so adjacent tiles sampling
    the same material show continuous texels across their shared seam.
    """
    _assign_box_projection_uvs(mesh, world_offset=world_offset)
    try:
        mesh.calc_tangents()
    except RuntimeError:
        # calc_tangents fails on degenerate or non-triangulated faces. Fall
        # back to a triangulated copy so we still get tangents on the mesh
        # used by the exporter.
        bm = bmesh.new()
        bm.from_mesh(mesh)
        bmesh.ops.triangulate(bm, faces=bm.faces[:])
        bm.to_mesh(mesh)
        bm.free()
        mesh.update()
        _assign_box_projection_uvs(mesh, world_offset=world_offset)
        mesh.calc_tangents()


# ---------------------------------------------------------------------------
# Geometry builders
# ---------------------------------------------------------------------------

def _create_box_mesh(name, fr, to, origin):
    """Create an axis-aligned box mesh."""
    o = s2b_vec(origin)
    f = s2b_vec(fr)
    t = s2b_vec(to)

    x1 = min(f[0], t[0]) - o[0]
    y1 = min(f[1], t[1]) - o[1]
    z1 = min(f[2], t[2]) - o[2]
    x2 = max(f[0], t[0]) - o[0]
    y2 = max(f[1], t[1]) - o[1]
    z2 = max(f[2], t[2]) - o[2]

    verts = [
        (x1, y1, z1), (x2, y1, z1), (x2, y2, z1), (x1, y2, z1),
        (x1, y1, z2), (x2, y1, z2), (x2, y2, z2), (x1, y2, z2),
    ]
    faces = [
        (0, 3, 2, 1),  # bottom
        (4, 5, 6, 7),  # top
        (0, 1, 5, 4),  # front
        (1, 2, 6, 5),  # right
        (2, 3, 7, 6),  # back
        (3, 0, 4, 7),  # left
    ]

    mesh = bpy.data.meshes.new(name + "_mesh")
    mesh.from_pydata(verts, [], faces)
    mesh.update()
    _finalize_mesh(mesh, world_offset=o)

    obj = bpy.data.objects.new(name, mesh)
    obj.location = o
    bpy.context.scene.collection.objects.link(obj)
    return obj


def _create_top_chamfered_prism(name, fr, to, origin, chamfer):
    """Prism with chamfer on top perimeter edges."""
    x1, y1, z1 = min(fr[0], to[0]), min(fr[1], to[1]), min(fr[2], to[2])
    x2, y2, z2 = max(fr[0], to[0]), max(fr[1], to[1]), max(fr[2], to[2])
    c = chamfer

    o = s2b_vec(origin)

    # Bottom 4 corners + top 4 (inset by chamfer)
    # Scene coords relative to origin, then convert
    def rel(sx, sy, sz):
        return s2b(sx - origin[0], sy - origin[1], sz - origin[2])

    verts = [
        rel(x1, y1, z1), rel(x2, y1, z1), rel(x2, y1, z2), rel(x1, y1, z2),      # b0-b3
        rel(x1 + c, y2, z1 + c), rel(x2 - c, y2, z1 + c),                          # t0-t1
        rel(x2 - c, y2, z2 - c), rel(x1 + c, y2, z2 - c),                          # t2-t3
    ]

    faces = [
        (0, 3, 2, 1),  # bottom
        (4, 5, 6, 7),  # top
        (0, 1, 5, 4),  # front
        (1, 2, 6, 5),  # right
        (2, 3, 7, 6),  # back
        (3, 0, 4, 7),  # left
    ]

    mesh_data = bpy.data.meshes.new(name + "_mesh")
    mesh_data.from_pydata(verts, [], faces)
    mesh_data.update()
    _finalize_mesh(mesh_data, world_offset=o)

    obj = bpy.data.objects.new(name, mesh_data)
    obj.location = o
    bpy.context.scene.collection.objects.link(obj)
    return obj


def _create_vertical_edge_chamfered_prism(name, fr, to, origin, chamfer, corners):
    """Prism with chamfers on vertical edges (selectable per corner)."""
    x1, y1, z1 = min(fr[0], to[0]), min(fr[1], to[1]), min(fr[2], to[2])
    x2, y2, z2 = max(fr[0], to[0]), max(fr[1], to[1]), max(fr[2], to[2])

    if not _has_any_chamfer_corner(corners):
        return _create_box_mesh(name, fr, to, origin)

    o = s2b_vec(origin)

    bottom_outline = _build_vertical_chamfer_outline(
        x1, z1, x2, z2, y1, chamfer, corners
    )
    top_outline = _build_vertical_chamfer_outline(
        x1, z1, x2, z2, y2, chamfer, corners
    )

    def rel(sx, sy, sz):
        return s2b(sx - origin[0], sy - origin[1], sz - origin[2])

    bottom_verts = [rel(*p) for p in bottom_outline]
    top_verts = [rel(*p) for p in top_outline]
    n = len(bottom_verts)

    verts = bottom_verts + top_verts

    faces = []
    # Bottom cap — fan triangulation (reversed winding for outward normal)
    for i in range(1, n - 1):
        faces.append((0, i + 1, i))
    # Top cap
    for i in range(1, n - 1):
        faces.append((n, n + i, n + i + 1))
    # Side quads
    for i in range(n):
        ni = (i + 1) % n
        faces.append((i, ni, n + ni, n + i))

    mesh_data = bpy.data.meshes.new(name + "_mesh")
    mesh_data.from_pydata(verts, [], faces)
    mesh_data.update()
    _finalize_mesh(mesh_data, world_offset=o)

    obj = bpy.data.objects.new(name, mesh_data)
    obj.location = o
    bpy.context.scene.collection.objects.link(obj)
    return obj


def _create_extruded_polygon(name, contour, bottom_y, top_y, origin):
    """Extrude a 2D contour (XZ plane) between bottom_y and top_y."""
    o = s2b_vec(origin)
    n = len(contour)

    def rel(sx, sy, sz):
        return s2b(sx - origin[0], sy - origin[1], sz - origin[2])

    bottom_verts = [rel(pt[0], bottom_y, pt[1]) for pt in contour]
    top_verts = [rel(pt[0], top_y, pt[1]) for pt in contour]

    verts = bottom_verts + top_verts

    faces = []
    # Bottom cap — fan triangulation (reversed winding)
    for i in range(1, n - 1):
        faces.append((0, i + 1, i))
    # Top cap
    for i in range(1, n - 1):
        faces.append((n, n + i, n + i + 1))
    # Side quads
    for i in range(n):
        ni = (i + 1) % n
        faces.append((i, ni, n + ni, n + i))

    mesh_data = bpy.data.meshes.new(name + "_mesh")
    mesh_data.from_pydata(verts, [], faces)
    mesh_data.update()
    _finalize_mesh(mesh_data, world_offset=o)

    obj = bpy.data.objects.new(name, mesh_data)
    obj.location = o
    bpy.context.scene.collection.objects.link(obj)
    return obj


# ---------------------------------------------------------------------------
# Chamfer helpers
# ---------------------------------------------------------------------------

def _resolve_chamfer(fr, to, chamfer):
    amount = max(0, chamfer or 0)
    if amount <= 0:
        return 0
    width = abs(to[0] - fr[0])
    height = abs(to[1] - fr[1])
    depth = abs(to[2] - fr[2])
    return max(0, min(amount, width / 2 - 0.01, depth / 2 - 0.01, height - 0.01))


def _resolve_chamfer_corners(input_corners):
    default = {"leftFront": True, "rightFront": True, "rightBack": True, "leftBack": True}
    if not input_corners or not isinstance(input_corners, dict):
        return default
    return {
        "leftFront": input_corners.get("leftFront", True) is not False,
        "rightFront": input_corners.get("rightFront", True) is not False,
        "rightBack": input_corners.get("rightBack", True) is not False,
        "leftBack": input_corners.get("leftBack", True) is not False,
    }


def _has_any_chamfer_corner(corners):
    return any(corners.values())


def _build_vertical_chamfer_outline(x1, z1, x2, z2, y, chamfer, corners):
    """Build perimeter outline with chamfered corners.
    Returns list of (x, y, z) in scene coordinates."""
    c = chamfer
    points = []

    # Front edge (L→R)
    if corners["leftFront"]:
        points.append((x1 + c, y, z1))
    else:
        points.append((x1, y, z1))
    if corners["rightFront"]:
        points.append((x2 - c, y, z1))

    # Right edge (F→B)
    if corners["rightFront"]:
        points.append((x2, y, z1 + c))
    else:
        points.append((x2, y, z1))
    if corners["rightBack"]:
        points.append((x2, y, z2 - c))

    # Back edge (R→L)
    if corners["rightBack"]:
        points.append((x2 - c, y, z2))
    else:
        points.append((x2, y, z2))
    if corners["leftBack"]:
        points.append((x1 + c, y, z2))

    # Left edge (B→F)
    if corners["leftBack"]:
        points.append((x1, y, z2 - c))
    else:
        points.append((x1, y, z2))
    if corners["leftFront"]:
        points.append((x1, y, z1 + c))

    return points


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _default_origin(fr, to):
    """Default element origin: centered on X/Z, anchored to the floor on Y."""
    return [
        round((fr[0] + to[0]) / 2, 3),
        round(min(fr[1], to[1]), 3),
        round((fr[2] + to[2]) / 2, 3),
    ]


def _infer_texture_role(name):
    """Infer texture role from element name conventions."""
    n = name.lower()
    if "glass" in n:
        return "accent"
    if "portal_shadow" in n or "door_leaf" in n or "window_leaf" in n:
        return "trim"
    return "wall"


def _attach_to_parent(child, parent):
    """Parent an object without using matrix_parent_inverse.

    The caller is responsible for setting ``child.location`` to the parent-
    local offset before calling this. We keep ``matrix_parent_inverse`` as the
    identity so the child's transform is fully determined by its local TRS
    (matching what the glTF exporter will write out)."""
    child.parent = parent
    child.matrix_parent_inverse.identity()


def _localize_object(obj, origin, parent, parent_world_blender):
    """Move ``obj`` into its parent's local space and attach it.

    ``obj.location`` is initially the world origin in Blender coords (set by
    the mesh builders). When a parent is provided, we rebase it to the local
    offset from ``parent_world_blender`` and parent without any mpi tricks."""
    if parent is None:
        return
    world_blender = s2b_vec(origin)
    obj.location = _sub(world_blender, parent_world_blender)
    _attach_to_parent(obj, parent)


def _sub(a, b):
    return (a[0] - b[0], a[1] - b[1], a[2] - b[2])
