"""Dress the player's body -> assets/characters/player.skin

    python3 tools/character/build_mesh.py [--preview out.png]

The body is the MakeHuman man `build_body.py` exported to `body.npz` (a
stocky worker of ~45, one continuous, skin-weighted mesh — owner
2026-09-28: the hand-lofted body read thin, with a flat seat and arms
"glued on"). This script only DRESSES it in the blue/yellow Vault 42 suit:
every triangle gets a material from where it sits on the body (the bone
that owns it, the MakeHuman region groups, its height and facing), cloth
and boots stand a few millimetres proud of the skin, and the yellow 42 is
original mesh lettering projected onto the back.

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

# cloth and boots stand proud of the skin (m, along the vertex normal);
# trouser legs hang looser than the jacket
CLOTH = 0.008
TROUSER_PROUD = 0.014
BOOT_PROUD = 0.012


def normals(pos, tri):
    n = np.zeros_like(pos)
    fn = np.cross(pos[tri[:, 1]] - pos[tri[:, 0]], pos[tri[:, 2]] - pos[tri[:, 0]])
    for k in range(3):
        np.add.at(n, tri[:, k], fn)
    return n / np.maximum(np.linalg.norm(n, axis=1, keepdims=True), 1e-12)


def load():
    d, k = sk.body()
    pos = d['pos'].astype(float) * k
    tri = d['tri'].astype(np.int64)
    w = d['w'].astype(float)
    w /= np.maximum(w.sum(1, keepdims=True), 1e-9)
    groups = {g[2:]: d[g] for g in d if g.startswith('g_')}
    eyes = [d['j_eyeL'] * k, d['j_eyeR'] * k]
    return pos, tri, d['poly'].astype(np.int64), w, groups, eyes


def per_poly(values, poly):
    """Average a per-triangle quantity over the MakeHuman quad each
    triangle came from — materials are decided per quad, so a trim's edge
    follows the mesh's loops instead of zigzagging across split quads."""
    n = poly.max() + 1
    acc = np.zeros((n,) + values.shape[1:])
    np.add.at(acc, poly, values)
    cnt = np.bincount(poly, minlength=n).reshape((n,) + (1,) * (values.ndim - 1))
    return (acc / np.maximum(cnt, 1))[poly]


def classify(pos, nrm, tri, poly, w, groups, eyes):
    """One material per quad, from where it sits on the body."""
    owner = np.argmax(w, axis=1)
    c = per_poly(pos[tri].mean(axis=1), poly)
    cn = per_poly(nrm[tri].mean(axis=1), poly)
    votes = per_poly(np.eye(len(BONES))[owner[tri]].sum(1), poly)
    bone = votes.argmax(1)
    name = np.array([BONES[b][0] for b in bone])
    ingroup = {g: per_poly(m[tri].sum(1).astype(float), poly) >= 2 for g, m in groups.items()}
    x, y, z = c[:, 0], c[:, 1], c[:, 2]
    ax = np.abs(x)
    mat = np.full(len(tri), SUIT)

    neck_y = HEAD['neck'][1]
    waist_y = HEAD['spine'][1] + 0.01
    ankle_y = HEAD['footL'][1]
    front = cn[:, 2] > 0.35

    # trousers below the waist band
    mat[y < waist_y - 0.02] = TROUSER
    # waist band, collar, zip placket (the suit's own yellow; a chest yoke
    # read as a ragged cross on MakeHuman's diagonal chest loops)
    mat[(np.abs(y - waist_y) < 0.022) & np.isin(name, ['pelvis', 'spine', 'chest'])] = YELLOW
    # the collar rings the neck only (the shoulder tops share its height)
    neck_r = np.hypot(x, z - HEAD['neck'][2])
    collar = (y > neck_y - 0.035) & (y < neck_y + 0.02) & (neck_r < 0.085) & np.isin(name, ['chest', 'neck', 'clavL', 'clavR'])
    mat[collar] = YELLOW
    mat[front & (ax < 0.018) & (y > waist_y) & (y < neck_y - 0.03)] = YELLOW
    # cuffs: the last 4 cm of the sleeve before the wrist; the hand is skin
    for s in 'LR':
        wr = HEAD['hand' + s]
        fdir = (wr - HEAD['forearm' + s]) / np.linalg.norm(wr - HEAD['forearm' + s])
        along = (c - wr) @ fdir
        near = (name == 'forearm' + s) | (name == 'hand' + s)
        mat[near & (along > -0.045) & (along < -0.005)] = YELLOW
        mat[(name == 'hand' + s) & (along >= -0.005)] = SKIN
        mat[np.isin(name, [f'{b}{s}' for b in ('fingers1', 'fingers2', 'fingers3', 'thumb1', 'thumb2')])] = SKIN
    # boots from above the ankle, soles under
    boot = (y < ankle_y + 0.09) & np.isin(name, ['footL', 'footR', 'toeL', 'toeR', 'shinL', 'shinR'])
    mat[boot] = BOOT
    mat[boot & (y < 0.022)] = DARK
    # head and neck skin above the collar
    skin = np.isin(name, ['head', 'neck']) & (y > neck_y + 0.02)
    mat[skin] = SKIN
    mat[ingroup['ears']] = SKIN
    mat[ingroup['lips']] = SKIN_LO
    mat[ingroup['fingernails']] = SKIN  # bright nails read as specks
    # hair: the scalp, grey at the temples
    scalp = ingroup['scalp']
    mat[scalp] = HAIR
    ey = eyes[0][1]
    mat[scalp & (ax > 0.055) & (y < ey + 0.07)] = HAIR_HI
    # eyes and brows
    for e in eyes:
        d = np.linalg.norm(c - e, axis=1)
        mat[(d < 0.016) & front] = DARK
        brow = (np.abs(x - e[0]) < 0.022) & (y > e[1] + 0.012) & (y < e[1] + 0.026) & front & (z > e[2] - 0.01)
        mat[brow & skin] = HAIR
    # stubble along the jaw
    jaw = skin & front & (y < ey - 0.055) & (y > neck_y + 0.05) & ~ingroup['lips']
    mat[jaw] = SKIN_LO
    return mat


def taubin(pos, tri, move, steps=12, lam=0.5, mu=-0.53):
    """Taubin smoothing of the vertices in `move`: takes out the muscle
    definition a loose suit hides without shrinking the body (plain
    Laplacian smoothing would thin the limbs)."""
    n = len(pos)
    edges = np.concatenate([tri[:, [0, 1]], tri[:, [1, 2]], tri[:, [2, 0]]])
    edges = np.concatenate([edges, edges[:, ::-1]])
    deg = np.bincount(edges[:, 0], minlength=n).astype(float)
    p = pos.copy()
    for k in range(steps):
        f = lam if k % 2 == 0 else mu
        avg = np.zeros_like(p)
        np.add.at(avg, edges[:, 0], p[edges[:, 1]])
        avg /= np.maximum(deg, 1)[:, None]
        p[move] += f * (avg[move] - p[move])
    return p


def dress(pos, nrm, tri, mat):
    """The suit: cloth smoothed over the muscles and standing proud of the
    skin, boots proud of the feet."""
    push = np.zeros(len(pos))
    cloth = np.zeros(len(pos), bool)
    for m, amount in ((SUIT, CLOTH), (TROUSER, TROUSER_PROUD), (YELLOW, CLOTH + 0.001), (BOOT, BOOT_PROUD), (DARK, BOOT_PROUD)):
        vs = np.unique(tri[mat == m])
        push[vs] = np.maximum(push[vs], amount)
        if m in (SUIT, TROUSER, YELLOW):
            cloth[vs] = True
    skin = np.unique(tri[np.isin(mat, [SKIN, SKIN_HI, SKIN_LO, HAIR, HAIR_HI])])
    cloth[skin] = False  # the collar and cuff edges stay on the skin they meet
    pos = taubin(pos, tri, cloth)
    return pos + normals(pos, tri) * push[:, None]


GLYPHS = {'4': ['10010', '10010', '10010', '11111', '00010', '00010', '00010'],
          '2': ['01110', '10001', '00001', '00010', '00100', '01000', '11111']}


def lettering(pos, tri):
    """The yellow 42 across the upper back: each glyph cell is a quad cast
    onto the back surface along +Z (from behind), lifted 4 mm, weighted to
    the chest."""
    back = pos[tri].mean(1)[:, 2] < HEAD['chest'][2]
    T = pos[tri[back]]
    e1, e2 = T[:, 1] - T[:, 0], T[:, 2] - T[:, 0]
    cell = 0.026
    top = HEAD['neck'][1] - 0.09

    def cast(x, y):
        o = np.array([x, y, -1.0])
        d = np.array([0.0, 0.0, 1.0])
        p = np.cross(d, e2)
        det = (e1 * p).sum(1)
        ok = np.abs(det) > 1e-12
        inv = np.where(ok, 1 / np.where(ok, det, 1), 0)
        s = o - T[:, 0]
        u = (s * p).sum(1) * inv
        q = np.cross(s, e1)
        v = (q @ d) * inv
        t = (q * e2).sum(1) * inv
        hit = ok & (u >= 0) & (v >= 0) & (u + v <= 1) & (t > 0)
        return o + d * t[hit].min()

    verts, faces = [], []
    for digit, ch in enumerate('42'):
        for row, line in enumerate(GLYPHS[ch]):
            for col, bit in enumerate(line):
                if bit != '1':
                    continue
                # seen from behind the wearer's left (+X) is on the viewer's right
                x1 = 0.15 - digit * 0.16 - col * cell
                x0 = x1 - cell
                y1 = top - row * cell
                y0 = y1 - cell
                base = len(verts)
                for qx, qy in ((x0, y0), (x0, y1), (x1, y1), (x1, y0)):
                    verts.append(cast(qx, qy) - np.array([0, 0, 0.004]))
                faces += [(base, base + 2, base + 1), (base, base + 3, base + 2)]
    verts = np.array(verts)
    wch = np.zeros((len(verts), len(BONES)))
    wch[:, BI['chest']] = 1.0
    return verts, np.array(faces), wch


def top4(w):
    idx = np.argsort(-w, axis=1, kind='stable')[:, :4]
    vals = np.take_along_axis(w, idx, 1)
    vals /= np.maximum(vals.sum(1, keepdims=True), 1e-9)
    return idx, vals


def build():
    pos, tri, poly, w, groups, eyes = load()
    nrm = normals(pos, tri)
    mat = classify(pos, nrm, tri, poly, w, groups, eyes)
    pos = dress(pos, nrm, tri, mat)
    nrm = normals(pos, tri)
    lp, lf, lw = lettering(pos, tri)
    base = len(pos)
    pos = np.vstack([pos, lp])
    nrm = np.vstack([nrm, np.tile([0.0, 0.0, -1.0], (len(lp), 1))])
    w = np.vstack([w, lw])
    tri = np.vstack([tri, lf + base])
    mat = np.concatenate([mat, np.full(len(lf), YELLOW)])
    return pos, nrm, tri, w, mat


def write(pos, nrm, tri, w, mat):
    bones, weights = top4(w)
    with OUT.open('wb') as f:
        f.write(b'HFSKIN01')
        f.write(struct.pack('<I', len(MATS)))
        for rgb, rough, flags in MATS:
            f.write(struct.pack('<4fI', *rgb, rough, flags))
        f.write(struct.pack('<I', len(BONES)))
        f.write(struct.pack('<I', len(pos)))
        for p, n, b, ww in zip(pos, nrm, bones, weights):
            f.write(struct.pack('<8f', *p, *n, p[0] + .4 * p[2], p[1]))
            f.write(struct.pack('<4B4f', *[int(x) for x in b], *ww))
        used = sorted(set(mat.tolist()))
        f.write(struct.pack('<I', len(used)))
        for m in used:
            idx = tri[mat == m].reshape(-1)
            f.write(struct.pack('<II', m, len(idx)))
            f.write(struct.pack(f'<{len(idx)}I', *idx.tolist()))
    print(f'wrote {OUT}: {len(pos)} vertices, {len(tri)} triangles, {OUT.stat().st_size} bytes')


if __name__ == '__main__':
    P, N, T, W, M = build()
    write(P, N, T, W, M)
    if '--preview' in sys.argv:
        import preview
        tris = {m: [tuple(t) for t in T[M == m]] for m in sorted(set(M.tolist()))}
        preview.render(P, N, tris, MATS, sys.argv[sys.argv.index('--preview') + 1])
