"""Bake CMU motion capture onto the player's skeleton -> assets/characters/player.anim

    python3 tools/character/bake.py <cmu dir>          # write the asset
    python3 tools/character/bake.py <cmu dir> --report # + stats and preview sheets

<cmu dir> holds the ASF/AMC files listed in CLIPS (download them from
http://mocap.cs.cmu.edu/subjects/<subject>/<file>; the list in
docs/PLAYER.md). The raw captures are not checked in; this script and its
output are.

RETARGETING. An ASF bone's global frame is the identity in the rest pose,
so its global rotation G(t) IS its rotation away from rest. Our skeleton's
rest rotations are the identity too, but its rest DIRECTIONS differ (our arms
hang down, CMU's stretch out sideways; our femurs are vertical, CMU's splay),
so each of our bones gets a fixed alignment A = arc(our rest dir -> CMU rest
dir) and its world rotation is G(t)·A: the bone points where the actor's did,
with OUR lengths. The pelvis is placed so that our hip centre sits at the
actor's hip centre scaled by leg length, which keeps the foot paths the
actor's (scaled) instead of whatever our different pelvis offset would make.

CYCLES. A locomotion clip is cut between two consecutive LEFT heel strikes
in its steadiest stretch, resampled to SAMPLES phase steps (phase 0 = left
foot lands), and closed: the end-vs-start residual of every rotation and of
the pelvis height is spread linearly over the cycle. Root motion becomes a
stride length + the pelvis offset from the straight line, in the cycle's own
heading frame, so the runtime can advance phase by distance travelled.

IDLE clips are played by time; their residual is spread the same way.
"""
import math
import struct
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
import cmu  # noqa: E402
import skeleton as sk  # noqa: E402

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / 'assets/characters/player.anim'
SAMPLES = 64
IDLE_HZ = 30

# name, subject, trial, kind, (first, last) frame window to search (None = all)
CLIPS = [
    ('idle', '139', '02', 'idle', (40, 880)),
    ('walk', '35', '01', 'cycle', None),
    ('brisk', '07', '12', 'cycle', None),
    ('run', '35', '17', 'cycle', None),
    ('sneak', '132', '15', 'cycle', None),
]


# ---------------------------------------------------------------- math
def arc(a, b):
    """Rotation matrix taking unit vector a onto unit vector b (minimal)."""
    a = a / np.linalg.norm(a)
    b = b / np.linalg.norm(b)
    v = np.cross(a, b)
    c = float(np.dot(a, b))
    if c < -0.9999:
        axis = np.cross(a, [1, 0, 0])
        if np.linalg.norm(axis) < 1e-3:
            axis = np.cross(a, [0, 0, 1])
        axis /= np.linalg.norm(axis)
        return 2 * np.outer(axis, axis) - np.eye(3)
    k = np.array([[0, -v[2], v[1]], [v[2], 0, -v[0]], [-v[1], v[0], 0]])
    return np.eye(3) + k + k @ k / (1 + c)


def roty(a):
    c, s = math.cos(a), math.sin(a)
    return np.array([[c, 0, s], [0, 1, 0], [-s, 0, c]])


def mat_to_quat(m):
    """(x, y, z, w)."""
    t = m[0, 0] + m[1, 1] + m[2, 2]
    if t > 0:
        s = math.sqrt(t + 1) * 2
        q = [(m[2, 1] - m[1, 2]) / s, (m[0, 2] - m[2, 0]) / s, (m[1, 0] - m[0, 1]) / s, 0.25 * s]
    elif m[0, 0] > m[1, 1] and m[0, 0] > m[2, 2]:
        s = math.sqrt(1 + m[0, 0] - m[1, 1] - m[2, 2]) * 2
        q = [0.25 * s, (m[0, 1] + m[1, 0]) / s, (m[0, 2] + m[2, 0]) / s, (m[2, 1] - m[1, 2]) / s]
    elif m[1, 1] > m[2, 2]:
        s = math.sqrt(1 + m[1, 1] - m[0, 0] - m[2, 2]) * 2
        q = [(m[0, 1] + m[1, 0]) / s, 0.25 * s, (m[1, 2] + m[2, 1]) / s, (m[0, 2] - m[2, 0]) / s]
    else:
        s = math.sqrt(1 + m[2, 2] - m[0, 0] - m[1, 1]) * 2
        q = [(m[0, 2] + m[2, 0]) / s, (m[1, 2] + m[2, 1]) / s, 0.25 * s, (m[1, 0] - m[0, 1]) / s]
    q = np.array(q)
    return q / np.linalg.norm(q)


def quat_to_mat(q):
    x, y, z, w = q
    return np.array([
        [1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
        [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
        [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)],
    ])


def qmul(a, b):
    ax, ay, az, aw = a
    bx, by, bz, bw = b
    return np.array([
        aw * bx + ax * bw + ay * bz - az * by,
        aw * by - ax * bz + ay * bw + az * bx,
        aw * bz + ax * by - ay * bx + az * bw,
        aw * bw - ax * bx - ay * by - az * bz,
    ])


def qconj(q):
    return np.array([-q[0], -q[1], -q[2], q[3]])


def slerp(a, b, t):
    if np.dot(a, b) < 0:
        b = -b
    d = min(1.0, float(np.dot(a, b)))
    if d > 0.9995:
        q = a + (b - a) * t
        return q / np.linalg.norm(q)
    th = math.acos(d)
    return (math.sin((1 - t) * th) * a + math.sin(t * th) * b) / math.sin(th)


# ---------------------------------------------------------------- retarget
class Rig:
    def __init__(self, asf):
        self.asf = asf
        self.bones = sk.bones()
        self.head = np.array([b[2] for b in self.bones])
        self.tail = np.array([b[3] for b in self.bones])
        self.align = []
        for name, parent, head, tail, src in self.bones:
            if src == 'root':
                self.align.append(np.eye(3))
                continue
            ours = np.array(tail) - np.array(head)
            theirs = asf[src].direction
            self.align.append(arc(ours, theirs))
        L = sk.index('thighL')
        ours_leg = np.linalg.norm(self.tail[L] - self.head[L]) + np.linalg.norm(
            self.tail[L + 1] - self.head[L + 1])
        theirs_leg = 0.5 * sum(asf[s + 'femur'].length + asf[s + 'tibia'].length for s in 'lr')
        self.scale = ours_leg / theirs_leg
        self.hip_rest = 0.5 * (self.head[sk.index('thighL')] + self.head[sk.index('thighR')])

    def pose(self, f):
        """Global rotations + joint heads for one CMU FK frame."""
        R = []
        for (name, parent, head, tail, src), A in zip(self.bones, self.align):
            R.append(f[src][0] @ A)
        hip = 0.5 * (f['lfemur'][1] + f['rfemur'][1]) * self.scale
        pelvis = hip - R[0] @ (self.hip_rest - self.head[0])
        return np.array(R), pelvis

    def fk(self, R, pelvis):
        pos = np.zeros((len(self.bones), 3))
        for i, (name, parent, head, tail, src) in enumerate(self.bones):
            if parent < 0:
                pos[i] = pelvis
            else:
                pos[i] = pos[parent] + R[parent] @ (self.head[i] - self.head[parent])
        return pos

    def local(self, R):
        """Parent-relative rotations (the pelvis stays global)."""
        out = []
        for i, b in enumerate(self.bones):
            out.append(R[i] if b[1] < 0 else R[b[1]].T @ R[i])
        return out


def feet(rig, R, pos):
    """World heel and ball points of both feet: [(heel, ball) L, R]."""
    out = []
    for side in 'LR':
        i = sk.index('foot' + side)
        out.append((pos[i] + R[i] @ np.array(sk.HEEL), pos[i] + R[i] @ np.array(sk.BALL)))
    return out


# ---------------------------------------------------------------- analysis
class Take:
    """One retargeted capture: per-frame global rotations, pelvis, feet."""

    def __init__(self, rig, frames, hz=120):
        self.hz = hz
        self.R = []
        self.P = []
        for f in frames:
            R, p = rig.pose(f)
            self.R.append(R)
            self.P.append(p)
        self.R = np.array(self.R)
        self.P = np.array(self.P)
        pos = [rig.fk(R, p) for R, p in zip(self.R, self.P)]
        self.feet = np.array([[np.array(hb) for hb in feet(rig, R, q)] for R, q in zip(self.R, pos)])
        # feet: [frame, side, heel/ball, xyz]; floor = low percentile of the sole
        floor = np.percentile(self.feet[:, :, :, 1].min(axis=2), 3)
        self.P[:, 1] -= floor
        self.feet[..., 1] -= floor
        self.rig = rig
        n = len(frames)
        low = self.feet[:, :, :, 1].min(axis=2)
        v = np.zeros((n, 2))
        for s in range(2):
            pt = self.feet[:, s, :, :].mean(axis=1)
            d = np.linalg.norm(np.diff(pt[:, [0, 2]], axis=0), axis=1) * hz
            v[1:, s] = d
        k = np.ones(5) / 5
        self.fspeed = np.stack([np.convolve(v[:, s], k, 'same') for s in range(2)], 1)
        raw = (low < 0.045) & (self.fspeed < 0.5)
        self.contact = np.stack([debounce(raw[:, s], 6) for s in range(2)], 1)
        d = np.linalg.norm(np.diff(self.P[:, [0, 2]], axis=0), axis=1) * hz
        self.speed = np.convolve(np.r_[d[0], d], np.ones(25) / 25, 'same')

    def strikes(self, side):
        c = self.contact[:, side]
        return [i for i in range(1, len(c)) if c[i] and not c[i - 1]]


def debounce(c, n):
    """Fill contact gaps shorter than n frames, then drop contacts shorter
    than n: a sole grazing the threshold must not read as a new footfall."""
    c = c.copy()
    for want in (True, False):
        i = 0
        while i < len(c):
            if c[i] != want:
                j = i
                while j < len(c) and c[j] != want:
                    j += 1
                if 0 < i and j < len(c) and j - i < n:
                    c[i:j] = want
                i = j
            else:
                i += 1
    return c


def local_quats(rig, R, heading):
    Lq = []
    for i, m in enumerate(rig.local(R)):
        if i == 0:
            m = heading.T @ m
        Lq.append(mat_to_quat(m))
    return np.array(Lq)


def sample_rot(take, t):
    """Interpolated global rotations at fractional frame t."""
    a = int(math.floor(t))
    b = min(a + 1, len(take.R) - 1)
    u = t - a
    out = []
    for i in range(take.R.shape[1]):
        qa, qb = mat_to_quat(take.R[a, i]), mat_to_quat(take.R[b, i])
        out.append(quat_to_mat(slerp(qa, qb, u)))
    return np.array(out)


def sample_vec(arr, t):
    a = int(math.floor(t))
    b = min(a + 1, len(arr) - 1)
    u = t - a
    return arr[a] * (1 - u) + arr[b] * u


def close_loop(q):
    """Spread the end-start rotation residual over the samples (q[-1] must
    equal q[0] after; the stored cycle drops the duplicate last sample)."""
    n = len(q) - 1
    out = q.copy()
    for b in range(q.shape[1]):
        # keep hemispheres continuous
        for k in range(1, len(q)):
            if np.dot(out[k, b], out[k - 1, b]) < 0:
                out[k, b] = -out[k, b]
        fix = qmul(out[0, b], qconj(out[n, b]))
        for k in range(len(q)):
            c = slerp(np.array([0, 0, 0, 1.0]), fix, k / n)
            out[k, b] = qmul(c, out[k, b])
    return out


def cut_cycle(take, window):
    lo, hi = window if window else (0, len(take.R) - 1)
    strikes = [s for s in take.strikes(0) if lo <= s <= hi]
    rstr = take.strikes(1)
    pairs = [(a, b) for a, b in zip(strikes, strikes[1:]) if 0.5 * take.hz < b - a < 2.0 * take.hz]
    if not pairs:
        raise SystemExit('no clean cycle found')
    med = np.median([take.speed[a:b].mean() for a, b in pairs])
    best = None
    for a, b in pairs:
        # the right foot lands near the middle (a stray re-contact elsewhere
        # in the cycle is a sole settling, not a step)
        mids = [(r - a) / (b - a) for r in rstr if a < r < b]
        mid = min(mids, key=lambda m: abs(m - 0.5), default=None)
        if mid is None or abs(mid - 0.5) > 0.12:
            continue
        sp = take.speed[a:b].mean()
        if abs(sp - med) > 0.2 * med:
            continue
        la = local_quats(take.rig, take.R[a], np.eye(3))
        lb = local_quats(take.rig, take.R[b], np.eye(3))
        err = sum(1 - abs(float(np.dot(x, y))) for x, y in zip(la[1:], lb[1:]))
        dv = abs(take.speed[a:b].max() - take.speed[a:b].min())
        score = err * 10 + dv * 0.2 + abs(mid - 0.5)
        if best is None or score < best[0]:
            best = (score, a, b, mid)
    if best is None:
        raise SystemExit('no clean cycle found')
    return best[1:]


def bake_cycle(take, a, b):
    T = take.P[b] - take.P[a]
    T[1] = 0
    stride = float(np.linalg.norm(T))
    yaw = math.atan2(T[0], T[2])
    H = roty(yaw)
    rots, offs, cons = [], [], []
    for k in range(SAMPLES + 1):
        t = a + (b - a) * k / SAMPLES
        R = sample_rot(take, t)
        P = sample_vec(take.P, t)
        rots.append(local_quats(take.rig, R, H))
        rel = H.T @ (P - take.P[a] - T * k / SAMPLES)
        offs.append([rel[0], P[1], rel[2]])
        cons.append(sample_vec(take.contact.astype(float), t))
    rots = close_loop(np.array(rots))
    offs = np.array(offs)
    offs[:, 1] += (offs[0, 1] - offs[-1, 1]) * np.linspace(0, 1, SAMPLES + 1)
    dur = (b - a) / take.hz
    return dict(rots=rots[:-1], offs=offs[:-1], cons=np.array(cons[:-1]), stride=stride, dur=dur)


def bake_idle(take, window):
    lo, hi = window if window else (0, len(take.R) - 1)
    fwd = np.array([take.R[i, 0] @ np.array([0, 0, 1.0]) for i in range(lo, hi)]).mean(axis=0)
    H = roty(math.atan2(fwd[0], fwd[2]))
    mean = take.P[lo:hi].mean(axis=0)
    step = take.hz / IDLE_HZ
    n = int((hi - lo) / step)
    rots, offs, cons = [], [], []
    for k in range(n + 1):
        t = lo + k * step
        R = sample_rot(take, t)
        P = sample_vec(take.P, t)
        rots.append(local_quats(take.rig, R, H))
        rel = H.T @ (P - mean)
        offs.append([rel[0], P[1], rel[2]])
        cons.append(sample_vec(take.contact.astype(float), t))
    rots = close_loop(np.array(rots))
    offs = np.array(offs)
    offs += np.outer(np.linspace(0, 1, n + 1), offs[0] - offs[-1])
    return dict(rots=rots[:-1], offs=offs[:-1], cons=np.array(cons[:-1]), stride=0.0, dur=n / IDLE_HZ)


# ---------------------------------------------------------------- output
def write(clips, rig):
    with OUT.open('wb') as f:
        f.write(b'HFANIM01')
        f.write(struct.pack('<I', len(rig.bones)))
        for name, parent, head, tail, _ in rig.bones:
            f.write(struct.pack('<I', len(name)) + name.encode())
            f.write(struct.pack('<i6f', parent, *head, *tail))
        f.write(struct.pack('<3f', *sk.HEEL))
        f.write(struct.pack('<3f', *sk.BALL))
        f.write(struct.pack('<I', len(clips)))
        for name, c in clips:
            f.write(struct.pack('<I', len(name)) + name.encode())
            f.write(struct.pack('<Iff I', 1 if c['stride'] > 0 else 0, c['dur'], c['stride'], len(c['rots'])))
            for r, o, k in zip(c['rots'], c['offs'], c['cons']):
                f.write(struct.pack('<3f', *o))
                f.write(struct.pack('<2f', *k))
                for q in r:
                    f.write(struct.pack('<4f', *q))


def report(name, take, c, window):
    import matplotlib
    matplotlib.use('Agg')
    import matplotlib.pyplot as plt
    rig = take.rig
    print(f"{name}: {len(c['rots'])} samples, {c['dur']:.3f} s, stride {c['stride']:.3f} m,"
          f" speed {c['stride'] / c['dur'] if c['stride'] else 0:.3f} m/s,"
          f" pelvis y {c['offs'][:, 1].min():.3f}..{c['offs'][:, 1].max():.3f}")
    n = len(c['rots'])
    cols = 16
    fig, axes = plt.subplots(2, 1, figsize=(24, 7))
    pick = np.linspace(0, n, cols, endpoint=False).astype(int)
    for view, ax in zip((2, 0), axes):
        for j, k in enumerate(pick):
            R = []
            for i, q in enumerate(c['rots'][k]):
                m = quat_to_mat(q)
                R.append(m if i == 0 else R[rig.bones[i][1]] @ m)
            o = c['offs'][k]
            pel = np.array([o[0], o[1], o[2] + (c['stride'] * k / n if c['stride'] else 0)])
            pos = rig.fk(np.array(R), pel)
            off = j * 1.1
            for i, b in enumerate(rig.bones):
                tail = pos[i] + np.array(R[i]) @ (rig.tail[i] - rig.head[i])
                col = 'r' if b[0].endswith('L') else ('b' if b[0].endswith('R') else 'k')
                h = view
                base = pel[h] if view == 2 else 0
                ax.plot([off + pos[i][h] - base, off + tail[h] - base], [pos[i][1], tail[1]], col, lw=1.2)
            for s, fc in enumerate(c['cons'][k]):
                ax.plot(off + (0.3 if s else -0.3), -0.05, 'o', color='r' if s == 0 else 'b', alpha=float(fc))
        ax.set_aspect('equal')
        ax.set_ylim(-0.1, 1.9)
        ax.axhline(0, color='gray', lw=0.5)
    axes[0].set_title(f'{name}: side view (top), front view (bottom) over the clip')
    plt.tight_layout()
    plt.savefig(f'report_{name}.png', dpi=60)
    plt.close()


def main():
    src = Path(sys.argv[1])
    want_report = '--report' in sys.argv
    clips = []
    rig = None
    asfs = {}
    for name, subj, trial, kind, window in CLIPS:
        if subj not in asfs:
            asfs[subj] = cmu.read_asf(src / f'{subj}.asf')
        asf = asfs[subj]
        frames = [cmu.fk(asf, f) for f in cmu.read_amc(src / f'{subj}_{trial}.amc')]
        r = Rig(asf)
        rig = rig or r
        take = Take(r, frames)
        if kind == 'cycle':
            a, b, mid = cut_cycle(take, window)
            c = bake_cycle(take, a, b)
            if want_report:
                print(f'  {name}: frames {a}..{b}, right strike at phase {mid:.2f}')
        else:
            c = bake_idle(take, window)
        if want_report:
            report(name, take, c, window)
        clips.append((name, c))
    write(clips, rig)
    print('wrote', OUT, OUT.stat().st_size, 'bytes')


if __name__ == '__main__':
    main()
