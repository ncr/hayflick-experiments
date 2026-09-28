"""The player's BODY from the MakeHuman base mesh (MPFB, CC0 assets) ->
tools/character/body.npz

    BLENDER_USER_RESOURCES=<dir with MPFB installed> \\
        blender -b --python tools/character/build_body.py

MPFB 2.0.17 is the Blender extension from extensions.blender.org (code GPL,
the base mesh, targets and rig weights CC0); install it into an isolated
profile (see docs/PLAYER.md). Only this script's OUTPUT is checked in, so
the rest of the pipeline (`build_mesh.py`, `skeleton.py`, `bake.py`) runs on
plain numpy.

The man (owner 2026-09-28, "a stocky worker"): male, ~45, 1.80 m, strong
muscle, some weight and a small belly, broad chest and shoulders, a real
seat. The arms are lowered from MakeHuman's A pose to hang at the sides
(the bind pose the runtime expects: rest rotations identity, arms down),
and the game_engine rig's skin weights are summed onto our 21 bones.

Output (game axes: Y up, facing +Z, the body's left is +X; metres):
  pos (N,3) float32, tri (M,3) int32, poly (M,) int32 (the quad each
  triangle came from), w (N,21) float32 (bone order of
  skeleton.BONE_NAMES), groups: scalp/ears/lips/fingernails/toenails masks
  (N,) bool, joints: name -> (3,) for every joint the skeleton reads.
"""
import math
import os
import sys

import bpy
import numpy as np
from mathutils import Matrix, Vector

from bl_ext.user_default.mpfb.services.humanservice import HumanService
from bl_ext.user_default.mpfb.services.targetservice import TargetService
import bl_ext.user_default.mpfb as mpfb

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, 'body.npz')
TARGETS = os.path.join(os.path.dirname(mpfb.__file__), 'data', 'targets')
HEIGHT = 1.80

MACRO = {
    'gender': 1.0,
    'age': 0.654,        # MakeHuman: 0.5 = 25 years, 1.0 = 90
    'muscle': 0.62,
    'weight': 0.82,
    'proportions': 0.5,
    'height': 0.62,      # refined below to reach HEIGHT
    'cupsize': 0.5,
    'firmness': 0.5,
    'race': {'asian': 0.0, 'caucasian': 1.0, 'african': 0.0},
}

# (target file under data/targets, weight): the stocky worker on top of the
# macros — a seat, shoulders and arms with muscle, a trace of belly.
DETAIL = [
    ('buttocks/buttocks-volume-incr', 0.55),
    ('torso/torso-muscle-pectoral-incr', 0.35),
    ('torso/torso-muscle-dorsi-incr', 0.35),
    ('torso/torso-scale-horiz-incr', 0.15),
    ('torso/torso-vshape-decr', 0.35),
    ('torso/measure-waist-circ-incr', 0.35),
    ('torso/measure-shoulder-dist-incr', 0.35),
    ('stomach/stomach-pregnant-incr', 0.3),
    ('neck/neck-scale-horiz-incr', 0.35),
    ('neck/neck-scale-depth-incr', 0.25),
    ('arms/l-upperarm-muscle-incr', 0.55),
    ('arms/r-upperarm-muscle-incr', 0.55),
    ('arms/l-upperarm-shoulder-muscle-incr', 0.6),
    ('arms/r-upperarm-shoulder-muscle-incr', 0.6),
    ('arms/l-lowerarm-muscle-incr', 0.45),
    ('arms/r-lowerarm-muscle-incr', 0.45),
    ('legs/l-upperleg-muscle-incr', 0.35),
    ('legs/r-upperleg-muscle-incr', 0.35),
    ('legs/l-lowerleg-muscle-incr', 0.3),
    ('legs/r-lowerleg-muscle-incr', 0.3),
]

# our bone <- game_engine bones whose skin weights it takes
MAP = {
    'pelvis': ['pelvis', 'Root'],
    'spine': ['spine_01'],
    'chest': ['spine_02', 'spine_03'],
    'neck': ['neck_01'],
    'head': ['head'],
}
for s, gs in (('L', 'l'), ('R', 'r')):
    MAP.update({
        'clav' + s: ['clavicle_' + gs],
        'upperarm' + s: ['upperarm_' + gs],
        'forearm' + s: ['lowerarm_' + gs],
        'hand' + s: ['hand_' + gs] + [f'{f}_0{k}_{gs}' for f in ('thumb', 'index', 'middle', 'ring', 'pinky') for k in (1, 2, 3)],
        'thigh' + s: ['thigh_' + gs],
        'shin' + s: ['calf_' + gs],
        'foot' + s: ['foot_' + gs],
        'toe' + s: ['ball_' + gs],
    })

# game axes from Blender's: (x, y, z) -> (x, z, -y)
G = np.array([[1, 0, 0], [0, 0, 1], [0, -1, 0]], float)


def human():
    bpy.ops.object.select_all(action='SELECT')
    bpy.ops.object.delete()
    h = HumanService.create_human(scale=0.1, macro_detail_dict=MACRO)
    for path, w in DETAIL:
        TargetService.load_target(h, os.path.join(TARGETS, path + '.target.gz'), weight=w)
    return h


def height_of(h):
    """Height with every shape key applied, helpers (eyes, teeth, the
    tights proxy...) excluded."""
    ev = h.evaluated_get(bpy.context.evaluated_depsgraph_get())
    zs = [v.co.z for v in ev.data.vertices]
    return max(zs) - min(zs)


def bind_pose(rig):
    """MakeHuman's A pose -> the bind pose: arms hanging 7 degrees out from
    vertical with the elbows a little bent forward and the wrists straight,
    legs 3 degrees out (MakeHuman stands with the ankles 39 cm apart), shins
    vertical. Applied as the new rest pose."""
    bpy.context.view_layer.objects.active = rig
    bpy.ops.object.mode_set(mode='POSE')
    rad = math.radians
    for s, sign in (('l', 1), ('r', -1)):
        forearm = Vector((sign * 0.1, -0.2, -1.0)).normalized()
        for name, want in (('upperarm_' + s, Vector((sign * math.sin(rad(7)), 0.0, -math.cos(rad(7))))),
                           ('lowerarm_' + s, forearm),
                           ('hand_' + s, forearm),
                           ('thigh_' + s, Vector((sign * math.sin(rad(3)), 0.0, -math.cos(rad(3))))),
                           ('calf_' + s, Vector((0.0, 0.0, -1.0)))):
            pb = rig.pose.bones[name]
            bpy.context.view_layer.update()
            head = rig.matrix_world @ pb.head
            now = (rig.matrix_world @ pb.tail - head).normalized()
            rot = now.rotation_difference(want).to_matrix().to_4x4()
            m = Matrix.Translation(head) @ rot @ Matrix.Translation(-head) @ (rig.matrix_world @ pb.matrix)
            pb.matrix = rig.matrix_world.inverted() @ m
            bpy.context.view_layer.update()
        # the feet level and pointing straight ahead again after the leg
        # turns (MakeHuman's own ankle->ball direction, less its toe-out)
        pb = rig.pose.bones['foot_' + s]
        head = rig.matrix_world @ pb.head
        now = rig.matrix_world @ pb.tail - head
        want = Vector((0.0, -1.0, -0.45)).normalized()
        rot = now.normalized().rotation_difference(want).to_matrix().to_4x4()
        pb.matrix = rig.matrix_world.inverted() @ (Matrix.Translation(head) @ rot @ Matrix.Translation(-head) @ (rig.matrix_world @ pb.matrix))
        bpy.context.view_layer.update()
    bpy.ops.object.mode_set(mode='OBJECT')


def main():
    h = human()
    # refine the height macro until the man stands HEIGHT tall
    for _ in range(4):
        cur = height_of(h)
        MACRO['height'] = min(1.0, max(0.0, MACRO['height'] + (HEIGHT - cur) * 1.2))
        h = human()
    print('height', height_of(h))
    rig = HumanService.add_builtin_rig(h, 'game_engine', import_weights=True)
    # joint helper centroids (eyes) before the helpers go
    def centroid(group):
        gi = h.vertex_groups[group].index
        pts = [v.co.copy() for v in h.data.vertices if any(g.group == gi and g.weight > 0.5 for g in v.groups)]
        return sum(pts, Vector()) / len(pts)
    eyes = {'eyeL': centroid('joint-l-eye'), 'eyeR': centroid('joint-r-eye')}
    # freeze the shape: shape keys into the mesh, then the helpers out
    bpy.context.view_layer.objects.active = h
    h.select_set(True)
    if h.data.shape_keys:
        bpy.ops.object.shape_key_remove(all=True, apply_mix=True)
    for m in list(h.modifiers):
        if m.type == 'MASK':
            bpy.ops.object.modifier_apply(modifier=m.name)
    bind_pose(rig)
    bpy.context.view_layer.objects.active = h
    for m in list(h.modifiers):
        if m.type == 'ARMATURE':
            bpy.ops.object.modifier_apply(modifier=m.name)
    bpy.context.view_layer.objects.active = rig
    bpy.ops.object.mode_set(mode='POSE')
    bpy.ops.pose.armature_apply()
    bpy.ops.object.mode_set(mode='OBJECT')

    me = h.data
    me.calc_loop_triangles()
    wm = h.matrix_world
    pos = np.array([(wm @ v.co)[:] for v in me.vertices]) @ G.T
    tri = np.array([t.vertices[:] for t in me.loop_triangles], np.int32)
    poly = np.array([t.polygon_index for t in me.loop_triangles], np.int32)
    import skeleton
    names = skeleton.BONE_NAMES
    gidx = {g.index: g.name for g in h.vertex_groups}
    back = {ge: ours for ours, ges in MAP.items() for ge in ges}
    w = np.zeros((len(me.vertices), len(names)), np.float32)
    groups = {k: np.zeros(len(me.vertices), bool) for k in ('scalp', 'ears', 'lips', 'fingernails', 'toenails')}
    for vi, v in enumerate(me.vertices):
        for g in v.groups:
            n = gidx[g.group]
            if n in back:
                w[vi, names.index(back[n])] += g.weight
            if n in groups and g.weight > 0.5:
                groups[n][vi] = True
    joints = {}
    bones = rig.data.bones
    rw = rig.matrix_world
    for b in bones:
        joints[b.name + '.head'] = np.array((rw @ b.head_local)[:]) @ G.T
        joints[b.name + '.tail'] = np.array((rw @ b.tail_local)[:]) @ G.T
    for k, v in eyes.items():
        joints[k] = np.array((wm @ v)[:]) @ G.T
    joints['top'] = np.array([0.0, pos[:, 1].max(), 0.0])
    np.savez_compressed(OUT, pos=pos.astype(np.float32), tri=tri, poly=poly, w=w,
                        **{'g_' + k: v for k, v in groups.items()},
                        **{'j_' + k: v.astype(np.float32) for k, v in joints.items()})
    print('wrote', OUT, len(pos), 'vertices', len(tri), 'triangles; unweighted', int((w.sum(1) < 1e-4).sum()))


sys.path.insert(0, HERE)
main()
