"""Build the player's skinned mesh -> assets/characters/player.skin

    python3 tools/character/build_mesh.py [--preview out.png]

A man in his mid-forties in the blue/yellow Vault 42 jumpsuit: ONE skinned
body — limbs are continuous tubes that run THROUGH their joints, with the
bone weights blending across each joint, so a knee or an elbow bends as a
surface instead of two rigid parts meeting. Every piece is a loft of
superellipse sections along a path; each ring carries its own bone
weights (a few pieces — the torso, the hip seat — weight per vertex).

Game axes (see skeleton.py): Y up, facing +Z, the body's left is +X.

Output (little-endian), read by crates/avatar:
  b'HFSKIN01'
  u32 materials; per material: f32 rgb[3], f32 roughness, u32 flags
  u32 bones (must equal the skeleton's)
  u32 vertices; per vertex: f32 pos[3], f32 nrm[3], f32 uv[2],
                            u8 bone[4], f32 weight[4]
  u32 groups; per group: u32 material, u32 index count, u32 indices[]
The uv channel is the bind-pose coordinate (x + 0.4 z, y) the suit shader
(`survivor.inc`) keys its wear on: it rides with the cloth, not the world.
The fifteen materials keep survivor.inc's slot meaning (0..6 cloth, 7..9
skin, 10..11 hair, 12 metal, 13 yellow, 14 boot leather).
"""
import math
import struct
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
import skeleton as sk  # noqa: E402

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / 'assets/characters/player.skin'

MATS = []


def material(rgb, rough=.9, matte=True):
    lin = tuple(c / 12.92 if c <= .04045 else ((c + .055) / 1.055) ** 2.4 for c in rgb)
    MATS.append((lin, rough, 4 if matte else 0))
    return len(MATS) - 1


SUIT = material((.11, .25, .57), .96)
SEAM = material((.07, .17, .42), .97)
DARK = material((.06, .058, .055), .94, False)
PANEL = material((.13, .28, .60), .96)
TROUSER = material((.10, .23, .53), .98)
FOLD_HI = material((.19, .35, .64), .98)
FOLD_LO = material((.06, .14, .34), .98)
SKIN = material((.66, .48, .37), .95)
SKIN_HI = material((.72, .545, .43), .95)
SKIN_LO = material((.46, .33, .25), .97)
HAIR = material((.17, .125, .09), .98)
HAIR_HI = material((.36, .33, .29), .98)
METAL = material((.47, .46, .40), .54, False)
YELLOW = material((.93, .70, .20), .96)
BOOT = material((.15, .13, .11), .82, False)

BONES = sk.bones()
BI = {b[0]: i for i, b in enumerate(BONES)}
HEAD = {b[0]: np.array(b[2]) for b in BONES}
TAIL = {b[0]: np.array(b[3]) for b in BONES}


class Mesh:
    def __init__(self):
        self.pos, self.nrm, self.bones, self.weights = [], [], [], []
        self.tris = {}  # material -> [(a, b, c)]

    def part(self, verts, faces, face_mats, weights, smooth=True):
        """Append a part: verts (N,3), faces [(a,b,c,d?)], a material per
        face, a weight list [(bone, w), ...] per vertex."""
        verts = np.asarray(verts, float)
        base = len(self.pos)
        tris = []
        for f, m in zip(faces, face_mats):
            for k in range(1, len(f) - 1):
                tris.append(((f[0], f[k], f[k + 1]), m))
        # smooth normals within the part (area weighted)
        n = np.zeros_like(verts)
        for (a, b, c), _ in tris:
            fn = np.cross(verts[b] - verts[a], verts[c] - verts[a])
            n[a] += fn
            n[b] += fn
            n[c] += fn
        if not smooth:
            pass
        ln = np.linalg.norm(n, axis=1, keepdims=True)
        n = np.where(ln > 1e-12, n / np.maximum(ln, 1e-12), [0, 1, 0])
        for v, nn, w in zip(verts, n, weights):
            self.pos.append(v)
            self.nrm.append(nn)
            w = [(BI[b], x) for b, x in w if x > 1e-4]
            w.sort(key=lambda t: -t[1])
            w = w[:4]
            s = sum(x for _, x in w)
            w = [(b, x / s) for b, x in w] + [(0, 0.0)] * (4 - len(w))
            self.bones.append([b for b, _ in w])
            self.weights.append([x for _, x in w])
        for (a, b, c), m in tris:
            if np.linalg.norm(np.cross(verts[b] - verts[a], verts[c] - verts[a])) < 1e-10:
                continue
            self.tris.setdefault(m, []).append((base + a, base + b, base + c))


M = Mesh()


def frame_along(path):
    """Per-point (tangent, side, front) frames along a polyline, with the
    section's 'front' kept close to world +Z (the body's front)."""
    path = np.asarray(path, float)
    frames = []
    for i in range(len(path)):
        t = path[min(i + 1, len(path) - 1)] - path[max(i - 1, 0)]
        t /= np.linalg.norm(t)
        f = np.array([0, 0, 1.0]) - t * t[2]
        if np.linalg.norm(f) < 1e-3:
            f = np.array([0, 1.0, 0]) - t * t[1]
        f /= np.linalg.norm(f)
        s = np.cross(t, f)
        frames.append((t, s, f))
    return frames


def loft(path, sections, weights, mats, n=16, power=.8, cap0=True, cap1=True, frames=None):
    """Loft superellipse sections along a path.

    sections[i] = (half width, front depth, back depth, x shift, z shift) in
    the section's (side, front) frame; weights[i] = [(bone, w)] for ring i
    (or a callable pos -> [(bone, w)]); mats = one material for every face,
    or callable (ring j, around k, centre) -> material.
    """
    path = np.asarray(path, float)
    frames = frames or frame_along(path)
    verts, wts = [], []
    for i, (p, (t, s, f), sec) in enumerate(zip(path, frames, sections)):
        rx, front, back, dx, dz = (list(sec) + [0, 0])[:5]
        for k in range(n):
            a = 2 * math.pi * (k + .5) / n
            c, sn = math.cos(a), math.sin(a)
            x = math.copysign(abs(c) ** power, c) * rx
            z = math.copysign(abs(sn) ** power, sn) * (front if sn >= 0 else back)
            v = p + s * (x + dx) + f * (z + dz)
            verts.append(v)
            w = weights[i]
            wts.append(w(v) if callable(w) else w)
    faces, fm = [], []
    rows = len(path)
    for j in range(rows - 1):
        for k in range(n):
            a = j * n + k
            b = j * n + (k + 1) % n
            faces.append((a, b, b + n, a + n))
            fm.append(mats(j, k, None) if callable(mats) else mats)
    if cap0:
        c0 = len(verts)
        verts.append(path[0] + frames[0][1] * 0 + 0)
        w = weights[0]
        wts.append(w(path[0]) if callable(w) else w)
        for k in range(n):
            faces.append((c0, (k + 1) % n, k))
            fm.append(mats(0, k, None) if callable(mats) else mats)
    if cap1:
        c1 = len(verts)
        verts.append(path[-1])
        w = weights[-1]
        wts.append(w(path[-1]) if callable(w) else w)
        base = (rows - 1) * n
        for k in range(n):
            faces.append((c1, base + k, base + (k + 1) % n))
            fm.append(mats(rows - 2, k, None) if callable(mats) else mats)
    # orient outward: the path's tangent x side should give an outward face
    verts = np.array(verts)
    fa = faces[0]
    nrm = np.cross(verts[fa[1]] - verts[fa[0]], verts[fa[2]] - verts[fa[0]])
    out = verts[fa[0]] - path[0]
    if np.dot(nrm, out) < 0:
        faces = [tuple(reversed(f)) for f in faces]
    M.part(verts, faces, fm, wts)
    return verts


def smooth01(x):
    x = min(1.0, max(0.0, x))
    return x * x * (3 - 2 * x)


def blend(a, b, t):
    t = smooth01(t)
    return [(a, 1 - t), (b, t)]


# ------------------------------------------------------------------ torso
# (y, half width, front, back, z centre): a sturdy man of forty-five — broad
# chest, a little softness at the waist, hips narrower than the shoulders.
TORSO = [
    # a man's trunk: hips no wider than the waist, the width in the chest
    # and the lats (owner 2026-09-25: the first cut read feminine)
    (.835, .10, .072, .08, .0), (.86, .136, .09, .097, .0), (.90, .156, .098, .104, .0),
    (.95, .159, .1, .104, -.002), (1.005, .159, .104, .102, -.004),
    (1.02, .159, .105, .102, -.004), (1.045, .159, .106, .101, -.004),
    (1.06, .159, .106, .101, -.005), (1.11, .161, .106, .101, -.007),
    (1.17, .168, .108, .104, -.01), (1.25, .184, .116, .108, -.013),
    (1.32, .198, .121, .111, -.015), (1.39, .204, .116, .109, -.017),
    (1.43, .196, .104, .102, -.018), (1.465, .168, .087, .091, -.019),
    (1.49, .11, .07, .075, -.018), (1.505, .07, .06, .064, -.016),
]


def torso_weight(v):
    x, y, z = v
    w = {}
    # vertical chain
    if y < 1.0:
        w['pelvis'] = 1.0
    elif y < 1.12:
        t = smooth01((y - 1.0) / .12)
        w['pelvis'], w['spine'] = 1 - t, t
    elif y < 1.22:
        w['spine'] = 1.0
    elif y < 1.34:
        t = smooth01((y - 1.22) / .12)
        w['spine'], w['chest'] = 1 - t, t
    else:
        w['chest'] = 1.0
    # the seat and the front of the hip follow the thigh a little
    if y < .97 and abs(x) > .03:
        side = 'L' if x > 0 else 'R'
        t = smooth01((.97 - y) / .12) * smooth01((abs(x) - .03) / .08) * .55
        w = {k: v * (1 - t) for k, v in w.items()}
        w['thigh' + side] = t
    # the shoulder top rides the clavicle
    if y > 1.38 and abs(x) > .09:
        side = 'L' if x > 0 else 'R'
        t = smooth01((y - 1.38) / .08) * smooth01((abs(x) - .09) / .08) * .7
        w = {k: v * (1 - t) for k, v in w.items()}
        w['clav' + side] = t
    return list(w.items())


N_T = 28


def torso_mat(j, k, _):
    y0, y1 = TORSO[j][0], TORSO[j + 1][0]
    a = 2 * math.pi * (k + 1) / N_T  # face centre angle (sections sit at k+.5)
    front = math.sin(a) > 0
    across = abs(math.cos(a))
    if 1.02 <= y0 and y1 <= 1.06:
        return YELLOW  # waist band
    if front and across < .12 and y0 >= 1.06 and y1 <= 1.465:
        return YELLOW  # zip placket
    if front and 1.39 <= y0 and y1 <= 1.43 and .12 < across < .78:
        return YELLOW  # shoulder yoke
    if y1 <= 1.02:
        return TROUSER
    return SUIT


loft([(0, r[0], r[4]) for r in TORSO], [(r[1], r[2], r[3]) for r in TORSO],
     [torso_weight] * len(TORSO), torso_mat, n=N_T, power=.78)

# collar and neck
loft([(0, 1.47, -.012), (0, 1.505, -.01), (0, 1.53, -.006)],
     [(.085, .07, .075), (.078, .066, .07), (.072, .064, .066)],
     [[('chest', 1)], [('chest', .7), ('neck', .3)], [('chest', .4), ('neck', .6)]], YELLOW, n=16, power=.8)
loft([(0, 1.49, -.004), (0, 1.54, .0), (0, 1.60, .006), (0, 1.625, .008)],
     [(.058, .052, .054), (.056, .05, .054), (.054, .049, .052), (.05, .045, .05)],
     [[('chest', .5), ('neck', .5)], [('neck', 1)], [('neck', .6), ('head', .4)], [('head', 1)]], SKIN, n=12, power=.9)

# ------------------------------------------------------------------ head
# A man in his forties: full jaw, short dark hair going grey at the temples.
HY = 1.655  # the old survivor's head rows are relative to this height


def head_rows():
    return [(-.106, .045, .066, .04, .019), (-.085, .066, .073, .052, .01),
            (-.05, .079, .075, .064, .002), (.0, .084, .08, .073, -.004),
            (.045, .082, .078, .077, -.008), (.09, .078, .068, .074, -.014),
            (.12, .062, .05, .058, -.016), (.14, .03, .026, .03, -.016)]


rows = head_rows()


def head_mat(j, k, _):
    a = 2 * math.pi * (k + 1) / 16
    s = math.sin(a)
    y = rows[j][0]
    if y >= .09 or (y >= .045 and s < .2):
        return HAIR  # crown and back of the head
    if y >= .0 and s < -.3:
        return HAIR
    if -.1 <= y <= -.03 and s > .25:
        return SKIN_LO  # stubble along the jaw
    return SKIN


loft([(0, HY + r[0], r[4]) for r in rows], [(r[1], r[2], r[3]) for r in rows],
     [[('head', 1)]] * len(rows), head_mat, n=16, power=.8)


def quad(p, mat, bone='head', thick=.004):
    """A thin slab through four points (a face feature or an applique)."""
    p = np.asarray(p, float)
    nrm = np.cross(p[1] - p[0], p[2] - p[0])
    nrm /= np.linalg.norm(nrm)
    v = np.vstack([p, p - nrm * thick])
    faces = [(0, 1, 2, 3), (7, 6, 5, 4), (0, 4, 5, 1), (1, 5, 6, 2), (2, 6, 7, 3), (3, 7, 4, 0)]
    M.part(v, faces, [mat] * 6, [[(bone, 1)]] * 8)


def tube(points, r, mat, bone, n=6):
    loft(points, [(r, r, r)] * len(points), [[(bone, 1)]] * len(points), mat, n=n, power=1)


for sign in (-1, 1):
    y = HY
    quad([(sign * .02, y - .019, .081), (sign * .06, y - .011, .082), (sign * .073, y - .034, .066),
          (sign * .03, y - .06, .083)][::(1 if sign > 0 else -1)], SKIN_HI)
    tube([(sign * .014, y + .031, .088), (sign * .038, y + .035, .086), (sign * .064, y + .028, .077)], .006, HAIR, 'head')
    tube([(sign * .026, y + .014, .089), (sign * .046, y + .012, .087)], .0028, DARK, 'head')
    # grey temples
    quad([(sign * .079, y + .01, .02), (sign * .085, y + .06, .0), (sign * .083, y + .07, -.03),
          (sign * .08, y - .005, -.01)][::(1 if sign > 0 else -1)], HAIR_HI)
    loft([(sign * .087, y - .04, .005), (sign * .091, y - .02, .002), (sign * .09, y + .021, 0), (sign * .086, y + .036, 0)],
         [(.009, .009, .009), (.016, .017, .012), (.016, .016, .014), (.008, .008, .007)],
         [[('head', 1)]] * 4, SKIN, n=8)
# nose, mouth, chin
loft([(0, HY + .036, .080), (0, HY + .0, .098), (0, HY - .022, .112), (0, HY - .03, .104)],
     [(.011, .01, .01), (.014, .012, .012), (.018, .012, .012), (.02, .008, .01)],
     [[('head', 1)]] * 4, SKIN_HI, n=8)
tube([(-.026, HY - .055, .087), (0, HY - .058, .095), (.026, HY - .055, .087)], .003, SKIN_LO, 'head')
# short hair: a cap over the crown, a slightly receding line at the front
loft([(0, HY + .068, -.02), (0, HY + .105, -.016), (0, HY + .132, -.018), (0, HY + .146, -.019), (0, HY + .149, -.019)],
     [(.084, .045, .08), (.077, .06, .071), (.058, .052, .052), (.028, .025, .026), (.004, .004, .004)],
     [[('head', 1)]] * 5, HAIR, n=16, power=.84, cap0=False)

# ------------------------------------------------------------------ arms


def arm(side, sign):
    sh = HEAD['upperarm' + side]
    el = HEAD['forearm' + side]
    wr = HEAD['hand' + side]
    up = (el - sh) / np.linalg.norm(el - sh)
    lo = (wr - el) / np.linalg.norm(wr - el)
    inner = sh + np.array([-sign * .06, .0, .0])
    pts, secs, wts, mats = [], [], [], []

    def ring(p, sec, w, m):
        pts.append(p)
        secs.append(sec)
        wts.append(w)
        mats.append(m)
    C, U, F, H = 'clav' + side, 'upperarm' + side, 'forearm' + side, 'hand' + side
    # the sleeve starts inside the torso and its first rings sit BELOW the
    # shoulder line, so the deltoid rounds the shoulder off instead of
    # standing on it like a pad
    ring(inner + np.array([0, -.02, 0]), (.05, .055, .055), [('chest', .6), (C, .4)], SUIT)
    ring(sh + np.array([-sign * .02, -.03, 0]), (.06, .063, .061), [(C, .55), (U, .45)], SUIT)
    ring(sh + np.array([0, -.03, 0]), (.066, .067, .065), [(C, .25), (U, .75)], SUIT)
    for s, r, w in [(.06, (.066, .064, .062), [(U, 1)]), (.13, (.058, .06, .055), [(U, 1)]),
                    (.2, (.052, .055, .05), [(U, 1)]), (.25, (.048, .049, .047), [(U, .85), (F, .15)])]:
        ring(sh + up * s, r, w, SUIT)
    ring(el - up * .015, (.046, .045, .049), [(U, .6), (F, .4)], SUIT)
    ring(el + lo * .02, (.046, .046, .048), [(U, .3), (F, .7)], SUIT)
    for s, r in [(.07, (.047, .047, .045)), (.14, (.042, .042, .04)), (.2, (.036, .036, .034))]:
        ring(el + lo * s, r, [(F, 1)], SUIT)
    Lf = np.linalg.norm(wr - el)
    ring(el + lo * (Lf - .045), (.035, .035, .034), [(F, 1)], YELLOW)
    ring(el + lo * (Lf - .008), (.035, .035, .034), [(F, .8), (H, .2)], YELLOW)
    ring(el + lo * Lf, (.03, .03, .029), [(F, .5), (H, .5)], SKIN)
    mt = mats

    def arm_mat(j, k, _):
        if mt[j] == YELLOW and mt[j + 1] == YELLOW:
            return YELLOW  # the cuff
        return SKIN if mt[j + 1] == SKIN else SUIT
    loft(pts, secs, wts, arm_mat, n=14, power=.85)
    # hand: a relaxed half fist hanging PALM TO THE THIGH (owner 2026-09-28:
    # the first cut had the palm facing forward, a flat plate across the
    # body). The hand is wide front-to-back and thin side-to-side, the
    # fingers curl in toward the thigh, the thumb lies along the front edge.
    hd = TAIL['hand' + side] - wr
    hdir = hd / np.linalg.norm(hd)
    fwd = np.array([0, 0, 1.0]) - hdir * hdir[2]
    fwd /= np.linalg.norm(fwd)
    out = np.cross(fwd, hdir)
    out *= sign / np.sign(out[0])  # away from the body
    inn = -out
    frames = lambda n: [(hdir, fwd, out)] * n
    palm = [wr + hdir * s for s in (0, .03, .06, .085)]
    loft(palm, [(.03, .02, .02), (.038, .024, .022), (.037, .023, .022), (.032, .02, .02)],
         [[(F, .3), (H, .7)], [(H, 1)], [(H, 1)], [(H, 1)]], SKIN, n=10, power=.7, frames=frames(4))
    loft([wr + hdir * .08 + inn * .006, wr + hdir * .105 + inn * .016, wr + hdir * .11 + inn * .034],
         [(.035, .018, .018), (.034, .02, .02), (.03, .016, .016)], [[(H, 1)]] * 3, SKIN_HI, n=10, power=.7,
         frames=[(hdir, fwd, inn)] * 3)
    tube([wr + hdir * .02 + fwd * .03, wr + hdir * .05 + fwd * .04 + inn * .008,
          wr + hdir * .07 + fwd * .036 + inn * .014], .011, SKIN, H, n=6)


arm('L', 1)
arm('R', -1)

# ------------------------------------------------------------------ legs


def leg(side, sign):
    hip = HEAD['thigh' + side]
    knee = HEAD['shin' + side]
    ank = HEAD['foot' + side]
    T, S, P = 'thigh' + side, 'shin' + side, 'pelvis'
    pts, secs, wts = [], [], []

    def ring(p, sec, w):
        pts.append(np.asarray(p, float))
        secs.append(sec)
        wts.append(w)
    # starts inside the seat, runs through the knee into the boot shaft
    ring(hip + [-sign * .01, .08, -.005], (.08, .08, .085), [(P, .75), (T, .25)])
    ring(hip + [0, .0, 0], (.098, .095, .1), [(P, .3), (T, .7)])
    for y, sec in [(.86, (.094, .092, .098)), (.76, (.088, .086, .09)), (.66, (.078, .08, .078)),
                   (.585, (.068, .072, .068))]:
        t = (hip[1] - y) / (hip[1] - knee[1])
        ring(hip + (knee - hip) * t, sec, [(T, 1)])
    for y, sec, w in [(.545, (.064, .07, .064), [(T, .75), (S, .25)]), (.51, (.063, .07, .062), [(T, .5), (S, .5)]),
                      (.475, (.062, .066, .064), [(T, .25), (S, .75)])]:
        t = (hip[1] - y) / (hip[1] - knee[1])
        ring(hip + (knee - hip) * t, sec, w)
    for y, sec in [(.41, (.063, .058, .074)), (.33, (.062, .054, .072)), (.25, (.056, .05, .062)),
                   (.18, (.052, .05, .054)), (.135, (.055, .055, .057))]:
        t = (knee[1] - y) / (knee[1] - ank[1])
        ring(knee + (ank - knee) * t, sec, [(S, 1)])

    def leg_mat(j, k, _):
        if j == len(pts) - 2:
            return FOLD_LO  # the hem gathered on the boot
        return TROUSER
    loft(pts, secs, wts, leg_mat, n=16, power=.85)


def boot(side, sign):
    ank = HEAD['foot' + side]
    F, O, S = 'foot' + side, 'toe' + side, 'shin' + side
    x = ank[0]
    # shaft round the ankle
    loft([(x, .035, ank[2] - .005), (x, .1, ank[2] - .01), (x, .175, ank[2] - .015)],
         [(.052, .058, .058), (.056, .06, .062), (.058, .062, .062)],
         [[(F, 1)], [(F, .6), (S, .4)], [(S, 1)]], BOOT, n=14, power=.8)
    # the foot: sections across the foot, heel to toe
    zs = [-.085, -.07, -.03, .02, .07, .11, .14, .17, .195, .21]
    ws = [.038, .044, .046, .048, .052, .053, .051, .046, .038, .024]
    hs = [.075, .095, .1, .085, .07, .058, .052, .048, .042, .03]
    path = [np.array([x + sign * .004 * (z > .05), 0.0, z]) for z in zs]
    frames = [(np.array([0, 0, 1.0]), np.array([1.0, 0, 0]), np.array([0, 1.0, 0]))] * len(zs)
    secs = [(w, h, .0, .0, .0) for w, h in zip(ws, hs)]

    def sole_w(v):
        z = v[2]
        t = smooth01((z - .1) / .06)
        return [(F, 1 - t), (O, t)]

    def boot_mat(j, k, _):
        a = 2 * math.pi * (k + 1) / 14
        if math.sin(a) < .02:
            return DARK
        return BOOT
    # a flat sole: sections are half-superellipses resting on y = 0
    verts = []
    faces, fm, wts = [], [], []
    n = 14
    for i, (p, (w, h, *_)) in enumerate(zip(path, secs)):
        for k in range(n):
            a = 2 * math.pi * (k + .5) / n
            c, s = math.cos(a), math.sin(a)
            vx = math.copysign(abs(c) ** .6, c) * w
            # a rounded upper, a flat sole resting on y = 0
            vy = abs(s) ** .8 * h if s > 0 else .012 * (1 + s)
            verts.append(p + np.array([vx, vy, 0]))
            wts.append(sole_w(verts[-1]))
    for j in range(len(path) - 1):
        for k in range(n):
            a, b = j * n + k, j * n + (k + 1) % n
            faces.append((a, a + n, b + n, b))
            fm.append(boot_mat(j, k, None))
    c0 = len(verts)
    verts.append(path[0] + np.array([0, .04, 0]))
    wts.append(sole_w(verts[-1]))
    for k in range(n):
        faces.append((c0, k, (k + 1) % n))
        fm.append(BOOT)
    c1 = len(verts)
    verts.append(path[-1] + np.array([0, .015, 0]))
    wts.append(sole_w(verts[-1]))
    base = (len(path) - 1) * n
    for k in range(n):
        faces.append((c1, base + (k + 1) % n, base + k))
        fm.append(BOOT)
    verts = np.array(verts)
    f0 = faces[0]
    nn = np.cross(verts[f0[1]] - verts[f0[0]], verts[f0[2]] - verts[f0[0]])
    if np.dot(nn, verts[f0[0]] - path[0]) < 0:
        faces = [tuple(reversed(f)) for f in faces]
    M.part(verts, faces, fm, wts)
    # laces
    for j in range(3):
        z = .03 + j * .025
        tube([(x - .022, .082 - j * .01, z), (x + .022, .086 - j * .01, z + .004)], .0035, DARK, F, n=4)


for side, sign in (('L', 1), ('R', -1)):
    leg(side, sign)
    boot(side, sign)

# ------------------------------------------------------------------ the 42
GLYPHS = {'4': ['10010', '10010', '10010', '11111', '00010', '00010', '00010'],
          '2': ['01110', '10001', '00001', '00010', '00100', '01000', '11111']}


def back_z(x, y):
    """The torso's back surface at (x, y), from the same superellipse."""
    for a, b in zip(TORSO, TORSO[1:]):
        if a[0] <= y <= b[0]:
            t = (y - a[0]) / (b[0] - a[0])
            rx = a[1] + (b[1] - a[1]) * t
            back = a[3] + (b[3] - a[3]) * t
            cz = a[4] + (b[4] - a[4]) * t
            co = min(abs(x / rx) ** (1 / .78), .9999)
            return cz - back * (1 - co * co) ** (.78 / 2) - .003
    raise ValueError(y)


CELL = .024
for digit, ch in enumerate('42'):
    for row, line in enumerate(GLYPHS[ch]):
        for col, bit in enumerate(line):
            if bit != '1':
                continue
            # seen from behind the wearer's left (+X) is on the viewer's right
            x1 = .135 - digit * .145 - col * CELL
            x0 = x1 - CELL
            y1 = 1.405 - row * CELL
            y0 = y1 - CELL
            pts = [(x0, y0, back_z(x0, y0)), (x0, y1, back_z(x0, y1)),
                   (x1, y1, back_z(x1, y1)), (x1, y0, back_z(x1, y0))]
            quad(pts, YELLOW, 'chest', .003)


# ------------------------------------------------------------------ write
def write():
    with OUT.open('wb') as f:
        f.write(b'HFSKIN01')
        f.write(struct.pack('<I', len(MATS)))
        for rgb, rough, flags in MATS:
            f.write(struct.pack('<4fI', *rgb, rough, flags))
        f.write(struct.pack('<I', len(BONES)))
        f.write(struct.pack('<I', len(M.pos)))
        for p, n, b, w in zip(M.pos, M.nrm, M.bones, M.weights):
            f.write(struct.pack('<8f', *p, *n, p[0] + .4 * p[2], p[1]))
            f.write(struct.pack('<4B4f', *b, *w))
        f.write(struct.pack('<I', len(M.tris)))
        for m in sorted(M.tris):
            idx = [i for t in M.tris[m] for i in t]
            f.write(struct.pack('<II', m, len(idx)))
            f.write(struct.pack(f'<{len(idx)}I', *idx))
    ntri = sum(len(t) for t in M.tris.values())
    print(f'wrote {OUT}: {len(M.pos)} vertices, {ntri} triangles, {OUT.stat().st_size} bytes')


if __name__ == '__main__':
    write()
    if '--preview' in sys.argv:
        import preview
        preview.render(np.array(M.pos), np.array(M.nrm), M.tris, MATS, sys.argv[sys.argv.index('--preview') + 1])
