//! props — procedural street props for creative mode (owner 2026-09-23:
//! "time to start making props: generate ten diverse ones").
//!
//! Every prop is a function of (kind, seed): the seed picks the variant —
//! a car's paint and how much of it rusted through, which wheels are gone, a
//! barrel standing or tipped, how bent a sign is — so no two placed props are
//! the same and a level stores only `prop <kind> X Z YAW SEED`. Geometry is
//! blocky low-poly on purpose: at this pixel size a 6-sided barrel and a
//! 24-sided one are the same few pixels, and faceted solids read as part of
//! the greybox family.
//!
//! Output is WORLD-space triangles grouped by [`Mat`], so the adapter can
//! merge every prop in a level into one primitive per material.

use std::f32::consts::{PI, TAU};

mod car;

/// What a triangle is made of. `Paint` carries its colour (linear rgb) —
/// the one channel the seed varies freely.
#[derive(Clone, Copy, PartialEq, Debug)]
pub enum Mat {
    Paint([f32; 3]),
    Rust,
    Steel,
    Rubber,
    Wood,
    Concrete,
    Glass,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Kind {
    Car,
    Barrel,
    Crate,
    Tires,
    Barrier,
    Pole,
    Sign,
    Hydrant,
    Mailbox,
    Bench,
}

impl Kind {
    pub const ALL: [Kind; 10] = [Kind::Car, Kind::Barrel, Kind::Crate, Kind::Tires, Kind::Barrier, Kind::Pole, Kind::Sign, Kind::Hydrant, Kind::Mailbox, Kind::Bench];

    pub fn name(self) -> &'static str {
        match self {
            Kind::Car => "car",
            Kind::Barrel => "barrel",
            Kind::Crate => "crate",
            Kind::Tires => "tires",
            Kind::Barrier => "barrier",
            Kind::Pole => "pole",
            Kind::Sign => "sign",
            Kind::Hydrant => "hydrant",
            Kind::Mailbox => "mailbox",
            Kind::Bench => "bench",
        }
    }

    pub fn by_name(s: &str) -> Option<Kind> {
        Kind::ALL.into_iter().find(|k| k.name() == s)
    }

    /// The footprint's half extents (along the prop's own x, z) — what the
    /// body collides with and what the placement ghost shows.
    pub fn half(self) -> (f32, f32) {
        match self {
            Kind::Car => (2.4, 0.95),
            Kind::Barrel => (0.32, 0.32),
            Kind::Crate => (0.42, 0.42),
            Kind::Tires => (0.42, 0.42),
            Kind::Barrier => (1.0, 0.32),
            Kind::Pole => (0.15, 0.15),
            Kind::Sign => (0.07, 0.07),
            Kind::Hydrant => (0.2, 0.2),
            Kind::Mailbox => (0.12, 0.12),
            Kind::Bench => (0.9, 0.3),
        }
    }
}

pub type Tri = [[f32; 3]; 3];

pub(crate) fn hash(x: i32, y: i32, seed: u32) -> f32 {
    let mut a = (x as u32).wrapping_mul(0x9e37_79b9) ^ (y as u32).wrapping_mul(0x85eb_ca6b) ^ seed.wrapping_mul(0xc2b2_ae35);
    a ^= a >> 16;
    a = a.wrapping_mul(0x7feb_352d);
    a ^= a >> 15;
    (a & 0xff_ffff) as f32 / 16_777_215.0
}

/// A seeded draw sequence.
pub(crate) struct Rng {
    pub(crate) seed: u32,
    k: i32,
}

impl Rng {
    pub(crate) fn f(&mut self) -> f32 {
        self.k += 1;
        hash(self.k, 57, self.seed)
    }
    pub(crate) fn range(&mut self, a: f32, b: f32) -> f32 {
        a + (b - a) * self.f()
    }
    pub(crate) fn pick<T: Copy>(&mut self, xs: &[T]) -> T {
        xs[((self.f() * xs.len() as f32) as usize).min(xs.len() - 1)]
    }
}

pub(crate) type V = [f32; 3];

fn v(x: f32, y: f32, z: f32) -> V {
    [x, y, z]
}

/// A 3x3 rotation, row-major, applied as `m * p`.
#[derive(Clone, Copy)]
pub(crate) struct Rot([[f32; 3]; 3]);

impl Rot {
    const I: Rot = Rot([[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]]);
    fn y(a: f32) -> Rot {
        let (s, c) = a.sin_cos();
        Rot([[c, 0.0, s], [0.0, 1.0, 0.0], [-s, 0.0, c]])
    }
    pub(crate) fn x(a: f32) -> Rot {
        let (s, c) = a.sin_cos();
        Rot([[1.0, 0.0, 0.0], [0.0, c, -s], [0.0, s, c]])
    }
    pub(crate) fn z(a: f32) -> Rot {
        let (s, c) = a.sin_cos();
        Rot([[c, -s, 0.0], [s, c, 0.0], [0.0, 0.0, 1.0]])
    }
    pub(crate) fn mul(self, o: Rot) -> Rot {
        let mut r = [[0.0; 3]; 3];
        for (i, row) in r.iter_mut().enumerate() {
            for (j, cell) in row.iter_mut().enumerate() {
                *cell = (0..3).map(|k| self.0[i][k] * o.0[k][j]).sum();
            }
        }
        Rot(r)
    }
    pub(crate) fn apply(self, p: V) -> V {
        let m = self.0;
        [m[0][0] * p[0] + m[0][1] * p[1] + m[0][2] * p[2], m[1][0] * p[0] + m[1][1] * p[1] + m[1][2] * p[2], m[2][0] * p[0] + m[2][1] * p[1] + m[2][2] * p[2]]
    }
}

/// A prop under construction, in its LOCAL frame (x right, y up, z
/// forward, origin at the base centre).
#[derive(Default)]
pub(crate) struct Build {
    parts: Vec<(Mat, Vec<Tri>)>,
}

impl Build {
    pub(crate) fn tris(&mut self, m: Mat) -> &mut Vec<Tri> {
        if let Some(i) = self.parts.iter().position(|(pm, _)| *pm == m) {
            return &mut self.parts[i].1;
        }
        self.parts.push((m, Vec::new()));
        &mut self.parts.last_mut().unwrap().1
    }

    /// An oriented box: centre, half extents, rotation.
    pub(crate) fn obox(&mut self, m: Mat, c: V, h: V, r: Rot) {
        let corner = |sx: f32, sy: f32, sz: f32| {
            let p = r.apply([sx * h[0], sy * h[1], sz * h[2]]);
            [c[0] + p[0], c[1] + p[1], c[2] + p[2]]
        };
        let p = [
            corner(-1.0, -1.0, -1.0), corner(1.0, -1.0, -1.0), corner(1.0, 1.0, -1.0), corner(-1.0, 1.0, -1.0),
            corner(-1.0, -1.0, 1.0), corner(1.0, -1.0, 1.0), corner(1.0, 1.0, 1.0), corner(-1.0, 1.0, 1.0),
        ];
        const F: [[usize; 4]; 6] = [[0, 3, 2, 1], [4, 5, 6, 7], [0, 1, 5, 4], [3, 7, 6, 2], [0, 4, 7, 3], [1, 2, 6, 5]];
        let t = self.tris(m);
        for f in F {
            t.push([p[f[0]], p[f[1]], p[f[2]]]);
            t.push([p[f[0]], p[f[2]], p[f[3]]]);
        }
    }

    fn bx(&mut self, m: Mat, c: V, h: V) {
        self.obox(m, c, h, Rot::I);
    }

    /// A capped cylinder of `n` sides from `a` to `b`, radius `r`.
    pub(crate) fn cyl(&mut self, m: Mat, a: V, b: V, r: f32, n: usize) {
        let ax = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
        let l = (ax[0] * ax[0] + ax[1] * ax[1] + ax[2] * ax[2]).sqrt().max(1e-6);
        let d = [ax[0] / l, ax[1] / l, ax[2] / l];
        let helper = if d[1].abs() < 0.9 { [0.0, 1.0, 0.0] } else { [1.0, 0.0, 0.0] };
        let cross = |p: V, q: V| [p[1] * q[2] - p[2] * q[1], p[2] * q[0] - p[0] * q[2], p[0] * q[1] - p[1] * q[0]];
        let u = {
            let c = cross(d, helper);
            let m = (c[0] * c[0] + c[1] * c[1] + c[2] * c[2]).sqrt();
            [c[0] / m, c[1] / m, c[2] / m]
        };
        let w = cross(d, u);
        let ring = |o: V, k: usize| {
            let t = k as f32 * TAU / n as f32;
            let (s, c) = t.sin_cos();
            [o[0] + (u[0] * c + w[0] * s) * r, o[1] + (u[1] * c + w[1] * s) * r, o[2] + (u[2] * c + w[2] * s) * r]
        };
        let t = self.tris(m);
        for k in 0..n {
            let (p0, p1, q0, q1) = (ring(a, k), ring(a, k + 1), ring(b, k), ring(b, k + 1));
            t.push([p0, p1, q1]);
            t.push([p0, q1, q0]);
            t.push([a, p1, p0]);
            t.push([b, q0, q1]);
        }
    }

    /// Place the local build in the world: yaw about y, then translate.
    fn place(self, x: f32, y: f32, z: f32, yaw: f32) -> Vec<(Mat, Vec<Tri>)> {
        let r = Rot::y(yaw);
        self.parts
            .into_iter()
            .map(|(m, tris)| {
                let tris = tris
                    .into_iter()
                    .map(|t| {
                        t.map(|p| {
                            let q = r.apply(p);
                            [q[0] + x, q[1] + y, q[2] + z]
                        })
                    })
                    .collect();
                (m, tris)
            })
            .collect()
    }
}

const DRUM_PAINT: [[f32; 3]; 4] = [[0.05, 0.1, 0.22], [0.3, 0.05, 0.03], [0.35, 0.26, 0.03], [0.05, 0.12, 0.05]];

/// Build one prop at world `(x, y, z)` turned `yaw` radians. Pure: the seed
/// decides every variant.
pub fn build(kind: Kind, x: f32, y: f32, z: f32, yaw: f32, seed: u32) -> Vec<(Mat, Vec<Tri>)> {
    let mut b = Build::default();
    let mut r = Rng { seed, k: 0 };
    match kind {
        Kind::Car => car::car(&mut b, &mut r),
        Kind::Barrel => barrel(&mut b, &mut r),
        Kind::Crate => crate_(&mut b, &mut r),
        Kind::Tires => tires(&mut b, &mut r),
        Kind::Barrier => barrier(&mut b, &mut r),
        Kind::Pole => pole(&mut b, &mut r),
        Kind::Sign => sign(&mut b, &mut r),
        Kind::Hydrant => hydrant(&mut b, &mut r),
        Kind::Mailbox => mailbox(&mut b, &mut r),
        Kind::Bench => bench(&mut b, &mut r),
    }
    b.place(x, y, z, yaw)
}

/// An oil drum: painted or rusted, ribbed, standing or tipped on its side.
fn barrel(b: &mut Build, r: &mut Rng) {
    let m = if r.f() < 0.4 { Mat::Rust } else { Mat::Paint(r.pick(&DRUM_PAINT)) };
    let tipped = r.f() < 0.3;
    let (h, rad) = (0.88, 0.29);
    if tipped {
        let a = v(-h / 2.0, rad, 0.0);
        let e = v(h / 2.0, rad, 0.0);
        b.cyl(m, a, e, rad, 10);
        for t in [0.33f32, 0.66] {
            let x = -h / 2.0 + h * t;
            b.cyl(m, v(x - 0.02, rad, 0.0), v(x + 0.02, rad, 0.0), rad + 0.012, 10);
        }
    } else {
        b.cyl(m, v(0.0, 0.0, 0.0), v(0.0, h, 0.0), rad, 10);
        for t in [0.33f32, 0.66] {
            b.cyl(m, v(0.0, h * t - 0.02, 0.0), v(0.0, h * t + 0.02, 0.0), rad + 0.012, 10);
        }
        b.cyl(Mat::Steel, v(0.0, h, 0.0), v(0.0, h + 0.02, 0.0), rad * 0.95, 10);
    }
}

/// A slatted wooden crate, sometimes with its lid knocked askew.
fn crate_(b: &mut Build, r: &mut Rng) {
    let s = r.range(0.34, 0.42);
    // corner posts
    for (x, z) in [(1.0, 1.0), (1.0, -1.0), (-1.0, 1.0), (-1.0, -1.0)] {
        b.bx(Mat::Wood, v(x * (s - 0.03), s, z * (s - 0.03)), [0.035, s, 0.035]);
    }
    // three slats a side, with gaps
    for k in 0..3 {
        let y = 0.15 + k as f32 * (2.0 * s - 0.2) / 2.0;
        b.bx(Mat::Wood, v(0.0, y, s), [s, 0.07, 0.015]);
        b.bx(Mat::Wood, v(0.0, y, -s), [s, 0.07, 0.015]);
        b.bx(Mat::Wood, v(s, y, 0.0), [0.015, 0.07, s]);
        b.bx(Mat::Wood, v(-s, y, 0.0), [0.015, 0.07, s]);
    }
    b.bx(Mat::Wood, v(0.0, 0.02, 0.0), [s, 0.02, s]);
    let askew = r.f() < 0.5;
    let lid = if askew { Rot::y(r.range(0.2, 0.6)).mul(Rot::z(0.12)) } else { Rot::I };
    let lc = if askew { v(0.12, 2.0 * s + 0.05, 0.08) } else { v(0.0, 2.0 * s + 0.02, 0.0) };
    b.obox(Mat::Wood, lc, [s + 0.02, 0.02, s + 0.02], lid);
}

/// A leaning stack of worn tyres.
fn tires(b: &mut Build, r: &mut Rng) {
    let n = 2 + (r.f() * 4.0) as usize;
    let mut y = 0.0;
    for _ in 0..n {
        let off = v(r.range(-0.06, 0.06), 0.0, r.range(-0.06, 0.06));
        let tilt = Rot::x(r.range(-0.08, 0.08)).mul(Rot::z(r.range(-0.08, 0.08)));
        // a tyre: eight tread segments round a hole
        for k in 0..8 {
            let a = k as f32 * TAU / 8.0;
            let c = tilt.apply(v(a.cos() * 0.27, 0.11, a.sin() * 0.27));
            b.obox(Mat::Rubber, [c[0] + off[0], c[1] + y, c[2] + off[2]], [0.07, 0.11, 0.12], tilt.mul(Rot::y(-a)));
        }
        y += 0.2;
    }
}

/// A concrete Jersey barrier: the stepped profile, chipped.
fn barrier(b: &mut Build, r: &mut Rng) {
    let len = r.range(0.9, 1.0);
    b.bx(Mat::Concrete, v(0.0, 0.1, 0.0), [len, 0.1, 0.3]);
    b.bx(Mat::Concrete, v(0.0, 0.3, 0.0), [len, 0.1, 0.2]);
    b.bx(Mat::Concrete, v(0.0, 0.58, 0.0), [len, 0.18, 0.09]);
    // a chipped corner off the top
    if r.f() < 0.6 {
        let x = r.pick(&[-1.0, 1.0]) * (len - 0.15);
        b.obox(Mat::Concrete, v(x, 0.7, 0.0), [0.15, 0.06, 0.1], Rot::z(0.5));
    }
}

/// A timber utility pole with a crossarm and insulators, leaning.
fn pole(b: &mut Build, r: &mut Rng) {
    let h = r.range(4.6, 5.4);
    let lean = Rot::z(r.range(-0.08, 0.08)).mul(Rot::x(r.range(-0.05, 0.05)));
    let top = lean.apply(v(0.0, h, 0.0));
    b.cyl(Mat::Wood, v(0.0, -0.1, 0.0), top, 0.12, 6);
    let arm = lean.apply(v(0.0, h - 0.4, 0.0));
    b.obox(Mat::Wood, arm, [0.05, 0.05, 0.75], lean.mul(Rot::x(r.range(-0.1, 0.1))));
    for z in [-0.6f32, -0.2, 0.2, 0.6] {
        let p = lean.apply(v(0.0, h - 0.3, z));
        b.cyl(Mat::Glass, p, [p[0], p[1] + 0.12, p[2]], 0.035, 5);
    }
    if r.f() < 0.4 {
        let t = lean.apply(v(0.22, h - 1.2, 0.0));
        b.cyl(Mat::Steel, [t[0], t[1] - 0.35, t[2]], [t[0], t[1] + 0.35, t[2]], 0.16, 8);
    }
}

/// A road sign on a steel post: a stop octagon, a warning diamond or a plate,
/// the post bent from an old impact.
fn sign(b: &mut Build, r: &mut Rng) {
    let bend = r.range(0.0, 0.35);
    let lean = Rot::z(bend).mul(Rot::x(r.range(-0.1, 0.1)));
    let top = lean.apply(v(0.0, 2.3, 0.0));
    b.cyl(Mat::Steel, v(0.0, 0.0, 0.0), top, 0.03, 5);
    let face = Rot::y(r.range(-0.3, 0.3)).mul(lean);
    match (r.f() * 3.0) as i32 {
        0 => {
            // stop: an octagon of red paint on a white rim
            let c = [top[0], top[1], top[2] + 0.03];
            for k in 0..8 {
                let a = k as f32 * TAU / 8.0 + PI / 8.0;
                let p = face.apply(v(a.cos() * 0.2, a.sin() * 0.2, 0.0));
                let q = face.apply(v((a + TAU / 8.0).cos() * 0.2, (a + TAU / 8.0).sin() * 0.2, 0.0));
                let t = b.tris(Mat::Paint([0.4, 0.03, 0.02]));
                t.push([c, [c[0] + p[0], c[1] + p[1], c[2] + p[2]], [c[0] + q[0], c[1] + q[1], c[2] + q[2]]]);
                t.push([c, [c[0] + q[0], c[1] + q[1], c[2] + q[2]], [c[0] + p[0], c[1] + p[1], c[2] + p[2]]]);
            }
        }
        1 => b.obox(Mat::Paint([0.45, 0.33, 0.02]), top, [0.2, 0.2, 0.01], face.mul(Rot::z(PI / 4.0))),
        _ => b.obox(Mat::Paint([0.42, 0.42, 0.4]), top, [0.18, 0.26, 0.01], face),
    }
}

/// A squat fire hydrant: barrel, bonnet, two side nozzles.
fn hydrant(b: &mut Build, r: &mut Rng) {
    let m = if r.f() < 0.6 { Mat::Paint([0.38, 0.05, 0.03]) } else { Mat::Paint([0.45, 0.33, 0.03]) };
    b.cyl(m, v(0.0, 0.0, 0.0), v(0.0, 0.08, 0.0), 0.16, 8);
    b.cyl(m, v(0.0, 0.08, 0.0), v(0.0, 0.52, 0.0), 0.11, 8);
    b.cyl(m, v(0.0, 0.52, 0.0), v(0.0, 0.62, 0.0), 0.13, 8);
    b.cyl(m, v(0.0, 0.62, 0.0), v(0.0, 0.68, 0.0), 0.05, 5);
    for s in [-1.0f32, 1.0] {
        b.cyl(Mat::Steel, v(0.0, 0.36, 0.0), v(s * 0.2, 0.36, 0.0), 0.045, 6);
    }
    b.cyl(Mat::Steel, v(0.0, 0.3, 0.0), v(0.0, 0.3, 0.2), 0.06, 6);
}

/// A kerbside mailbox on a timber post, its door sometimes hanging open.
fn mailbox(b: &mut Build, r: &mut Rng) {
    let m = if r.f() < 0.5 { Mat::Rust } else { Mat::Paint(r.pick(&[[0.2, 0.2, 0.19], [0.05, 0.1, 0.2], [0.3, 0.05, 0.03]])) };
    let lean = Rot::z(r.range(-0.15, 0.15));
    b.obox(Mat::Wood, lean.apply(v(0.0, 0.5, 0.0)), [0.05, 0.5, 0.05], lean);
    let top = lean.apply(v(0.0, 1.0, 0.0));
    // the box: a half-round tunnel along z
    b.obox(m, [top[0], top[1] + 0.1, top[2]], [0.12, 0.1, 0.24], lean);
    b.cyl(m, [top[0], top[1] + 0.2, top[2] - 0.24], [top[0], top[1] + 0.2, top[2] + 0.24], 0.12, 8);
    if r.f() < 0.5 {
        b.obox(m, [top[0], top[1] + 0.05, top[2] + 0.34], [0.12, 0.01, 0.12], lean.mul(Rot::x(0.2)));
    }
    b.obox(Mat::Paint([0.4, 0.05, 0.03]), [top[0] + 0.13, top[1] + 0.2, top[2]], [0.01, 0.12, 0.02], lean);
}

/// A park bench: steel frames and wooden slats, some slats gone.
fn bench(b: &mut Build, r: &mut Rng) {
    for x in [-0.75f32, 0.75] {
        b.bx(Mat::Steel, v(x, 0.22, 0.12), [0.03, 0.22, 0.03]);
        b.bx(Mat::Steel, v(x, 0.22, -0.18), [0.03, 0.22, 0.03]);
        b.bx(Mat::Steel, v(x, 0.44, -0.03), [0.03, 0.02, 0.2]);
        b.obox(Mat::Steel, v(x, 0.7, -0.24), [0.03, 0.25, 0.02], Rot::x(-0.2));
    }
    // seat slats then back slats; each may be missing
    for k in 0..4 {
        if r.f() < 0.2 {
            continue;
        }
        b.bx(Mat::Wood, v(0.0, 0.47, 0.12 - k as f32 * 0.1), [0.9, 0.02, 0.04]);
    }
    for k in 0..3 {
        if r.f() < 0.25 {
            continue;
        }
        b.obox(Mat::Wood, v(0.0, 0.6 + k as f32 * 0.14, -0.23 - k as f32 * 0.03), [0.9, 0.04, 0.015], Rot::x(-0.2));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn bounds(parts: &[(Mat, Vec<Tri>)]) -> ([f32; 3], [f32; 3]) {
        let mut lo = [f32::MAX; 3];
        let mut hi = [f32::MIN; 3];
        for (_, tris) in parts {
            for t in tris {
                for p in t {
                    for k in 0..3 {
                        lo[k] = lo[k].min(p[k]);
                        hi[k] = hi[k].max(p[k]);
                    }
                }
            }
        }
        (lo, hi)
    }

    #[test]
    fn every_kind_builds_finite_geometry_that_fits_its_footprint() {
        for kind in Kind::ALL {
            for seed in 0..30 {
                let parts = build(kind, 0.0, 0.0, 0.0, 0.0, seed);
                assert!(parts.iter().map(|p| p.1.len()).sum::<usize>() > 0, "{kind:?} is empty");
                for (_, tris) in &parts {
                    for t in tris {
                        assert!(t.iter().flatten().all(|v| v.is_finite()), "{kind:?}");
                    }
                }
                let (lo, _) = bounds(&parts);
                assert!(lo[1] > -0.2, "{kind:?} sinks: {lo:?}");
                // what the body can run into — everything below head height —
                // stays near the collision footprint (a pole's crossarm and a
                // bent sign's plate may overhang above it)
                let (hx, hz) = kind.half();
                let slack = 0.35;
                for (_, tris) in &parts {
                    for p in tris.iter().flatten().filter(|p| p[1] < 1.6) {
                        assert!(p[0].abs() < hx + slack && p[2].abs() < hz + slack, "{kind:?} seed {seed}: {p:?} is outside its footprint");
                    }
                }
            }
        }
    }

    #[test]
    fn a_seed_is_a_prop_and_seeds_vary_it() {
        for kind in Kind::ALL {
            assert_eq!(build(kind, 0.0, 0.0, 0.0, 0.0, 5), build(kind, 0.0, 0.0, 0.0, 0.0, 5));
        }
        let distinct = (0..12).map(|s| format!("{:?}", build(Kind::Car, 0.0, 0.0, 0.0, 0.0, s))).collect::<std::collections::HashSet<_>>();
        assert!(distinct.len() > 8, "cars vary with the seed");
    }

    /// Every triangle of a car faces OUT of the body: its normal points away
    /// from the car's centre line (the shade pass lights by the geometric
    /// normal, so an inward face renders black — the end caps once did).
    #[test]
    fn a_car_shell_faces_outward() {
        for seed in 0..12 {
            let parts = build(Kind::Car, 0.0, 0.0, 0.0, 0.0, seed);
            // the lofted shell: the paint with the most triangles (the small
            // boxes — lamps, plate — are closed solids, half their faces look
            // inward by construction) and the glass
            let body = parts.iter().filter(|(m, _)| matches!(m, Mat::Paint(_) | Mat::Rust)).max_by_key(|(_, t)| t.len()).map(|(m, _)| *m);
            for (m, tris) in parts {
                if Some(m) != body && m != Mat::Glass {
                    continue;
                }
                let mut out = 0;
                let mut all = 0;
                for t in &tris {
                    let e1 = [t[1][0] - t[0][0], t[1][1] - t[0][1], t[1][2] - t[0][2]];
                    let e2 = [t[2][0] - t[0][0], t[2][1] - t[0][1], t[2][2] - t[0][2]];
                    let n = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
                    let c = [(t[0][0] + t[1][0] + t[2][0]) / 3.0, (t[0][1] + t[1][1] + t[2][1]) / 3.0 - 0.7, (t[0][2] + t[1][2] + t[2][2]) / 3.0];
                    let d = n[0] * c[0] * 0.2 + n[1] * c[1] + n[2] * c[2];
                    all += 1;
                    if d > 0.0 {
                        out += 1;
                    }
                }
                assert!(out * 10 >= all * 8, "seed {seed} {m:?}: only {out}/{all} triangles face out");
                // and the nose and tail caps specifically — a few dozen
                // triangles the ratio above cannot see: a face whose normal
                // runs along x must point the way its end of the car does
                let xmax = tris.iter().flatten().map(|p| p[0].abs()).fold(0.0, f32::max);
                for t in &tris {
                    let cx = (t[0][0] + t[1][0] + t[2][0]) / 3.0;
                    let e1 = [t[1][0] - t[0][0], t[1][1] - t[0][1], t[1][2] - t[0][2]];
                    let e2 = [t[2][0] - t[0][0], t[2][1] - t[0][1], t[2][2] - t[0][2]];
                    let n = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
                    let len = (n[0] * n[0] + n[1] * n[1] + n[2] * n[2]).sqrt();
                    if cx.abs() > xmax - 0.04 && n[0].abs() > 0.9 * len {
                        assert!(n[0] * cx > 0.0, "seed {seed}: an end cap faces into the car at x {cx}");
                    }
                }
            }
        }
    }

    #[test]
    fn yaw_turns_the_prop_about_its_base() {
        let a = bounds(&build(Kind::Bench, 0.0, 0.0, 0.0, 0.0, 1));
        let b = bounds(&build(Kind::Bench, 0.0, 0.0, 0.0, std::f32::consts::FRAC_PI_2, 1));
        assert!((a.1[0] - a.0[0]) > 1.5 && (b.1[2] - b.0[2]) > 1.5, "a bench turned a quarter runs along z");
    }
}
