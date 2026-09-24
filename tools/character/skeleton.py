"""The player's skeleton: ONE definition shared by the mesh builder
(`build_mesh.py`) and the mocap bake (`bake.py`). Both write it into their
asset, and the runtime (`crates/avatar`) reads it from there, so the Rust
side never restates a joint position.

Game axes: Y up, the body faces +Z, so its LEFT side is +X. Metres (1 wu).
A ~1.80 m man; joint heights follow Drillis & Contini's segment fractions
of stature (ankle .039, knee .285, hip .53, shoulder .818, elbow .63,
wrist .485) nudged to the mesh. The rest pose is the BIND pose: arms hang
a few degrees out from the body, legs straight, feet flat — every bone's
rest rotation is the identity, which is what makes retargeting a plain
matter of directions (see `bake.py`).

`cmu` names the bone of the CMU ASF skeleton whose motion drives it
(`None` = the root, driven by the mocap root).
"""

HEIGHT = 1.80

# name, parent, head (joint), tail, cmu source
_BONES = [
    ('pelvis', None, (0.0, 0.975, 0.0), (0.0, 1.06, -0.005), 'root'),
    ('spine', 'pelvis', (0.0, 1.02, -0.01), (0.0, 1.24, -0.025), 'lowerback'),
    ('chest', 'spine', (0.0, 1.24, -0.025), (0.0, 1.495, -0.02), 'thorax'),
    ('neck', 'chest', (0.0, 1.495, -0.02), (0.0, 1.585, 0.0), 'lowerneck'),
    ('head', 'neck', (0.0, 1.585, 0.0), (0.0, 1.80, 0.005), 'head'),
]
_SIDE = [
    # arms
    ('clav', 'chest', (0.025, 1.455, -0.005), (0.175, 1.465, -0.03), 'clavicle'),
    ('upperarm', 'clav', (0.175, 1.455, -0.03), (0.205, 1.155, -0.04), 'humerus'),
    ('forearm', 'upperarm', (0.205, 1.155, -0.04), (0.215, 0.895, -0.005), 'radius'),
    ('hand', 'forearm', (0.215, 0.895, -0.005), (0.22, 0.78, 0.01), 'hand'),
    # legs
    ('thigh', 'pelvis', (0.09, 0.93, 0.0), (0.095, 0.51, 0.012), 'femur'),
    ('shin', 'thigh', (0.095, 0.51, 0.012), (0.10, 0.085, -0.02), 'tibia'),
    ('foot', 'shin', (0.10, 0.085, -0.02), (0.105, 0.025, 0.125), 'foot'),
    ('toe', 'foot', (0.105, 0.025, 0.125), (0.105, 0.02, 0.195), 'toes'),
]


def _mirror(p):
    return (-p[0], p[1], p[2])


def bones():
    """[(name, parent index or -1, head, tail, cmu name)] parent-first."""
    out = list(_BONES)
    for side, cmu_side, flip in (('L', 'l', False), ('R', 'r', True)):
        for name, parent, head, tail, cmu in _SIDE:
            p = parent if parent in ('chest', 'pelvis') else parent + side
            if flip:
                head, tail = _mirror(head), _mirror(tail)
            out.append((name + side, p, head, tail, cmu_side + cmu))
    names = [b[0] for b in out]
    return [(n, names.index(p) if p else -1, h, t, c) for n, p, h, t, c in out]


def index(name):
    return [b[0] for b in bones()].index(name)


# Contact points on the sole, relative to the ankle in the rest pose (so in
# the FOOT bone's frame): heel and ball, both ON the ground plane when the
# rest foot stands flat. The runtime foot IK and the bake's contact detector
# use the same two points.
HEEL = (0.0, -0.085, -0.065)
BALL = (0.005, -0.085, 0.145)
