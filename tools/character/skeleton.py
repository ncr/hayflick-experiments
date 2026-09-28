"""The player's skeleton: ONE definition shared by the mesh builder
(`build_mesh.py`) and the mocap bake (`bake.py`). Both write it into their
asset, and the runtime (`crates/avatar`) reads it from there, so the Rust
side never restates a joint position.

Since 2026-09-28 the joints come from the BODY: `body.npz`, the MakeHuman
man `build_body.py` exports, carries the game_engine rig's joints in the
lowered-arm bind pose, and each of our 21 bones runs between two of them
(`_CENTRE`, `_SIDE`). The body is scaled to HEIGHT here (mesh and joints
alike, `body()`).

Game axes: Y up, the body faces +Z, so its LEFT side is +X. Metres (1 wu).
The rest pose is the BIND pose: arms hang a few degrees out from the body,
legs straight, feet flat — every bone's rest rotation is the identity, which
is what makes retargeting a plain matter of directions (see `bake.py`).

`cmu` names the bone of the CMU ASF skeleton whose motion drives it.
"""
from pathlib import Path

import numpy as np

HEIGHT = 1.80
BODY = Path(__file__).resolve().parent / 'body.npz'

# name, parent, head joint, tail joint (game_engine joint names in body.npz,
# or 'top' = the crown), cmu source
_CENTRE = [
    ('pelvis', None, 'pelvis.head', 'spine_01.head', 'root'),
    ('spine', 'pelvis', 'spine_01.head', 'spine_02.head', 'lowerback'),
    ('chest', 'spine', 'spine_02.head', 'neck_01.head', 'thorax'),
    ('neck', 'chest', 'neck_01.head', 'head.head', 'lowerneck'),
    ('head', 'neck', 'head.head', 'top', 'head'),
]
_SIDE = [
    ('clav', 'chest', 'clavicle_{s}.head', 'upperarm_{s}.head', 'clavicle'),
    ('upperarm', 'clav', 'upperarm_{s}.head', 'lowerarm_{s}.head', 'humerus'),
    ('forearm', 'upperarm', 'lowerarm_{s}.head', 'hand_{s}.head', 'radius'),
    ('hand', 'forearm', 'hand_{s}.head', 'middle_01_{s}.head', 'hand'),
    ('thigh', 'pelvis', 'thigh_{s}.head', 'calf_{s}.head', 'femur'),
    ('shin', 'thigh', 'calf_{s}.head', 'foot_{s}.head', 'tibia'),
    ('foot', 'shin', 'foot_{s}.head', 'ball_{s}.head', 'foot'),
    ('toe', 'foot', 'ball_{s}.head', 'ball_{s}.tail', 'toes'),
    # the four fingers as one three-jointed finger, and a two-jointed thumb:
    # the runtime curls them per gait (relaxed walking, a fist running).
    # No capture drives them (cmu None: they follow the hand).
    ('fingers1', 'hand', 'middle_01_{s}.head', 'middle_02_{s}.head', None),
    ('fingers2', 'fingers1', 'middle_02_{s}.head', 'middle_03_{s}.head', None),
    ('fingers3', 'fingers2', 'middle_03_{s}.head', 'middle_03_{s}.tail', None),
    ('thumb1', 'hand', 'thumb_01_{s}.head', 'thumb_02_{s}.head', None),
    ('thumb2', 'thumb1', 'thumb_02_{s}.head', 'thumb_03_{s}.tail', None),
]
BONE_NAMES = [b[0] for b in _CENTRE] + [n + s for s in 'LR' for n, *_ in _SIDE]


def body():
    """The body export and the scale that stands its crown at HEIGHT."""
    d = dict(np.load(BODY))
    return d, HEIGHT / float(d['pos'][:, 1].max())


def _joints():
    d, k = body()
    j = {key[2:]: d[key] * k for key in d if key.startswith('j_')}
    j['top'] = np.array([0.0, HEIGHT, j['head.head'][2]])
    return j


def bones():
    """[(name, parent index or -1, head, tail, cmu name)] parent-first."""
    j = _joints()
    out = [(n, p, tuple(map(float, j[h])), tuple(map(float, j[t])), c) for n, p, h, t, c in _CENTRE]
    for side, gs in (('L', 'l'), ('R', 'r')):
        for n, p, h, t, c in _SIDE:
            parent = p if p in ('chest', 'pelvis') else p + side
            out.append((n + side, parent, tuple(map(float, j[h.format(s=gs)])), tuple(map(float, j[t.format(s=gs)])), gs + c if c else None))
    names = [b[0] for b in out]
    assert names == BONE_NAMES
    return [(n, names.index(p) if p else -1, h, t, c) for n, p, h, t, c in out]


def index(name):
    return BONE_NAMES.index(name)


def _contacts():
    """Heel and ball contact points relative to the ankle in the rest pose
    (so in the FOOT bone's frame), both ON the ground plane the rest foot
    stands on: the heel at the back of the sole, the ball under the ball
    joint. The runtime foot IK and the bake's contact detector use them."""
    d, k = body()
    pos = d['pos'] * k
    j = _joints()
    ankle, ball = j['foot_l.head'], j['ball_l.head']
    w = d['w']
    foot = (w[:, index('footL')] + w[:, index('toeL')]) > 0.5
    ground = float(pos[foot, 1].min())
    heel = (0.0, ground - ankle[1], float(pos[foot, 2].min()) + 0.015 - ankle[2])
    ballp = (ball[0] - ankle[0], ground - ankle[1], ball[2] - ankle[2])
    return tuple(float(x) for x in heel), tuple(float(x) for x in ballp)


HEEL, BALL = _contacts()
