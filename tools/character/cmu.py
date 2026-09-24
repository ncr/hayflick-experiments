"""CMU motion-capture ASF/AMC reader: skeleton, per-frame forward kinematics.

The ASF rest pose has every bone's GLOBAL frame equal to the identity; a
bone's `axis` only defines the frame its degrees of freedom rotate in:

    L = C · R(dofs) · C⁻¹          (C = Euler XYZ of `axis`, R = Rz·Ry·Rx)
    G = G_parent · L
    joint_end = joint_start + length · G · direction

so `G(t)` is directly the bone's rotation AWAY FROM THE REST POSE, in world
space. That is what the retargeting in `bake.py` consumes. Units: ASF
`length 0.45` means one file unit is 1/0.45 inch; everything returned here
is converted to metres. Axes: Y up (the game's convention as well).
"""
import math
import numpy as np

UNIT = 0.0254 / 0.45  # file units -> metres


def rot(axis, deg):
    a = math.radians(deg)
    c, s = math.cos(a), math.sin(a)
    if axis == 'x':
        return np.array([[1, 0, 0], [0, c, -s], [0, s, c]])
    if axis == 'y':
        return np.array([[c, 0, s], [0, 1, 0], [-s, 0, c]])
    return np.array([[c, -s, 0], [s, c, 0], [0, 0, 1]])


def euler_xyz(x, y, z):
    """Static-axis XYZ: rotate about X first, then Y, then Z."""
    return rot('z', z) @ rot('y', y) @ rot('x', x)


class Bone:
    def __init__(self, name):
        self.name = name
        self.direction = np.zeros(3)
        self.length = 0.0
        self.C = np.eye(3)
        self.dof = []
        self.parent = None
        self.children = []


def read_asf(path):
    bones = {'root': Bone('root')}
    lines = open(path).read().splitlines()
    i = 0
    cur = None
    section = None
    while i < len(lines):
        raw = lines[i].strip()
        i += 1
        if not raw or raw.startswith('#'):
            continue
        if raw.startswith(':'):
            section = raw.split()[0]
            continue
        w = raw.split()
        if section == ':bonedata':
            if w[0] == 'begin':
                cur = None
            elif w[0] == 'name':
                cur = Bone(w[1])
                bones[w[1]] = cur
            elif w[0] == 'direction':
                cur.direction = np.array(list(map(float, w[1:4])))
            elif w[0] == 'length':
                cur.length = float(w[1]) * UNIT
            elif w[0] == 'axis':
                cur.C = euler_xyz(*map(float, w[1:4]))
            elif w[0] == 'dof':
                cur.dof = w[1:]
        elif section == ':hierarchy':
            if w[0] in ('begin', 'end'):
                continue
            for child in w[1:]:
                bones[child].parent = w[0]
                bones[w[0]].children.append(child)
    return bones


def read_amc(path):
    frames = []
    cur = None
    for raw in open(path):
        raw = raw.strip()
        if not raw or raw.startswith('#') or raw.startswith(':'):
            continue
        w = raw.split()
        if len(w) == 1 and w[0].isdigit():
            cur = {}
            frames.append(cur)
            continue
        cur[w[0]] = list(map(float, w[1:]))
    return frames


def order(bones):
    """Bones parent-before-child, root first."""
    out = []
    stack = ['root']
    while stack:
        b = stack.pop(0)
        out.append(b)
        stack[0:0] = bones[b].children
    return out


def fk(bones, frame):
    """Global rotation and joint START position of every bone for one frame.

    Returns {name: (G 3x3, start xyz, end xyz)} in metres.
    """
    out = {}
    r = frame['root']
    root_pos = np.array(r[0:3]) * UNIT
    G_root = euler_xyz(r[3], r[4], r[5])
    out['root'] = (G_root, root_pos, root_pos)
    for name in order(bones)[1:]:
        b = bones[name]
        G_parent, _, parent_end = out[b.parent]
        vals = frame.get(name, [])
        angles = {'rx': 0.0, 'ry': 0.0, 'rz': 0.0}
        for d, v in zip(b.dof, vals):
            angles[d] = v
        R = euler_xyz(angles['rx'], angles['ry'], angles['rz'])
        L = b.C @ R @ b.C.T
        G = G_parent @ L
        start = parent_end
        end = start + b.length * (G @ b.direction)
        out[name] = (G, start, end)
    return out


def load(asf, amc):
    bones = read_asf(asf)
    frames = read_amc(amc)
    return bones, [fk(bones, f) for f in frames]
