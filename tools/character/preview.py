"""Software preview of the player mesh (numpy z-buffer, orthographic,
Lambert + ambient): front, side, back and a three-quarter view side by side.
A dev tool for tools/character — the game renders the real thing.
"""
import math

import numpy as np


def _view(yaw, pitch):
    cy, sy = math.cos(yaw), math.sin(yaw)
    cp, sp = math.cos(pitch), math.sin(pitch)
    R_yaw = np.array([[cy, 0, -sy], [0, 1, 0], [sy, 0, cy]])
    R_pitch = np.array([[1, 0, 0], [0, cp, -sp], [0, sp, cp]])
    return R_pitch @ R_yaw


def raster(pos, nrm, tris, mats, R, size=320, scale=160.0, light=(0.4, 0.7, 0.6)):
    img = np.full((size, size, 3), 0.18)
    zb = np.full((size, size), -1e9)
    p = pos @ R.T
    n = nrm @ R.T
    L = np.array(light) / np.linalg.norm(light)
    cx, cy = size / 2, size * 0.95
    sx = cx + p[:, 0] * scale
    sy = cy - p[:, 1] * scale
    for m, ts in tris.items():
        base = np.array(mats[m][0]) ** (1 / 2.2)
        for a, b, c in ts:
            xs = np.array([sx[a], sx[b], sx[c]])
            ys = np.array([sy[a], sy[b], sy[c]])
            x0, x1 = int(max(0, xs.min())), int(min(size - 1, xs.max() + 1))
            y0, y1 = int(max(0, ys.min())), int(min(size - 1, ys.max() + 1))
            if x0 > x1 or y0 > y1:
                continue
            d = (xs[1] - xs[0]) * (ys[2] - ys[0]) - (xs[2] - xs[0]) * (ys[1] - ys[0])
            if abs(d) < 1e-9:
                continue
            X, Y = np.meshgrid(np.arange(x0, x1 + 1) + .5, np.arange(y0, y1 + 1) + .5)
            w1 = ((X - xs[0]) * (ys[2] - ys[0]) - (xs[2] - xs[0]) * (Y - ys[0])) / d
            w2 = ((xs[1] - xs[0]) * (Y - ys[0]) - (X - xs[0]) * (ys[1] - ys[0])) / d
            w0 = 1 - w1 - w2
            inside = (w0 >= 0) & (w1 >= 0) & (w2 >= 0)
            if not inside.any():
                continue
            z = w0 * p[a, 2] + w1 * p[b, 2] + w2 * p[c, 2]
            nn = (w0[..., None] * n[a] + w1[..., None] * n[b] + w2[..., None] * n[c])
            nn /= np.linalg.norm(nn, axis=-1, keepdims=True) + 1e-9
            shade = 0.35 + 0.65 * np.clip(np.abs(nn @ L), 0, 1)
            sub = zb[y0:y1 + 1, x0:x1 + 1]
            upd = inside & (z > sub)
            sub[upd] = z[upd]
            img[y0:y1 + 1, x0:x1 + 1][upd] = base * shade[upd][:, None]
    return img


def render(pos, nrm, tris, mats, out, views=((0, 0), (math.pi / 2, 0), (math.pi, 0), (-math.pi / 4, -0.5)), size=320):
    import matplotlib
    matplotlib.use('Agg')
    import matplotlib.pyplot as plt
    imgs = [raster(pos, nrm, tris, mats, _view(y, pch), size) for y, pch in views]
    plt.imsave(out, np.clip(np.hstack(imgs), 0, 1))
    print('preview', out)


def load_skin(path):
    import struct
    b = open(path, 'rb').read()
    assert b[:8] == b'HFSKIN01'
    o = 8
    nm, = struct.unpack_from('<I', b, o)
    o += 4
    mats = []
    for _ in range(nm):
        r, g, bl, rough, flags = struct.unpack_from('<4fI', b, o)
        o += 20
        mats.append(((r, g, bl), rough, flags))
    o += 4  # bones
    nv, = struct.unpack_from('<I', b, o)
    o += 4 + nv * (32 + 4 + 16)
    ng, = struct.unpack_from('<I', b, o)
    o += 4
    tris = {}
    for _ in range(ng):
        m, n = struct.unpack_from('<II', b, o)
        o += 8
        idx = struct.unpack_from(f'<{n}I', b, o)
        o += 4 * n
        tris[m] = [idx[i:i + 3] for i in range(0, n, 3)]
    return mats, tris


def sheet(frames_bin, skin_path, out, first, step, count, yaw=-0.5, pitch=-0.5236, cols=10, size=200, scale=100.0):
    """Contact sheet of dumped frames, camera following the body."""
    import struct
    import matplotlib
    matplotlib.use('Agg')
    import matplotlib.pyplot as plt
    mats, tris = load_skin(skin_path)
    b = open(frames_bin, 'rb').read()
    nf, nv = struct.unpack_from('<II', b, 0)
    data = np.frombuffer(b, dtype='<f4', offset=8).reshape(nf, nv, 6)
    R = _view(yaw, pitch)
    imgs = []
    for k in range(count):
        fi = min(first + k * step, nf - 1)
        pos = data[fi, :, :3].copy()
        c = pos.mean(axis=0)
        pos[:, 0] -= c[0]
        pos[:, 2] -= c[2]
        img = raster(pos, data[fi, :, 3:], tris, mats, R, size=size, scale=scale)
        img[:3, :] = 1.0 if k % 2 == 0 else 0.6
        imgs.append(img)
    rows = [np.hstack(imgs[i:i + cols]) for i in range(0, len(imgs), cols)]
    if len(rows) > 1 and rows[-1].shape != rows[0].shape:
        pad = np.full((size, rows[0].shape[1] - rows[-1].shape[1], 3), 0.18)
        rows[-1] = np.hstack([rows[-1], pad])
    plt.imsave(out, np.clip(np.vstack(rows), 0, 1))
    print('sheet', out)


if __name__ == '__main__':
    import sys
    a = sys.argv
    sheet(a[1], a[2], a[3], int(a[4]), int(a[5]), int(a[6]), float(a[7]) if len(a) > 7 else -0.5)
