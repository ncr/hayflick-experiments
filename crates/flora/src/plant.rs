//! Procedural trees and bushes: one seed, one plant. Output is a triangle
//! soup per material — bark, green leaf, dry leaf — in WORLD space, ready for
//! the adapter to emit as three primitives.
//!
//! The aftermath reading: most trees are struggling — a few clumps of leaves
//! on a mostly bare crown, some dead outright — and the dryness of the ground
//! a plant stands on (the grass map's `dry`) browns its leaves, so a bush in
//! a scorched lot comes out straw-coloured without anyone choosing it.

use crate::hash;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Kind {
    Tree,
    Bush,
}

impl Kind {
    pub fn name(self) -> &'static str {
        match self {
            Kind::Tree => "tree",
            Kind::Bush => "bush",
        }
    }
    pub fn by_name(s: &str) -> Option<Kind> {
        [Kind::Tree, Kind::Bush].into_iter().find(|k| k.name() == s)
    }
    /// How far from its root a plant counts as "here" (remove clicks, and the
    /// scatter brush's spacing).
    pub fn radius(self) -> f32 {
        match self {
            Kind::Tree => 0.6,
            Kind::Bush => 0.45,
        }
    }
}

pub type Tri = [[f32; 3]; 3];

#[derive(Default)]
pub struct Soup {
    pub bark: Vec<Tri>,
    pub leaf: Vec<Tri>,
    pub dry: Vec<Tri>,
}

type V = [f32; 3];

fn add(a: V, b: V) -> V {
    [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
}
fn sub(a: V, b: V) -> V {
    [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}
fn mul(a: V, s: f32) -> V {
    [a[0] * s, a[1] * s, a[2] * s]
}
fn cross(a: V, b: V) -> V {
    [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
}
fn norm(a: V) -> V {
    let l = (a[0] * a[0] + a[1] * a[1] + a[2] * a[2]).sqrt().max(1e-6);
    mul(a, 1.0 / l)
}

/// A seeded draw sequence.
struct Rng {
    seed: u32,
    k: i32,
}

impl Rng {
    fn f(&mut self) -> f32 {
        self.k += 1;
        hash(self.k, 91, self.seed)
    }
    fn range(&mut self, a: f32, b: f32) -> f32 {
        a + (b - a) * self.f()
    }
}

/// A tapered five-sided limb from `a` (radius `ra`) to `b` (radius `rb`).
fn limb(out: &mut Vec<Tri>, a: V, b: V, ra: f32, rb: f32) {
    let axis = norm(sub(b, a));
    let helper = if axis[1].abs() < 0.9 { [0.0, 1.0, 0.0] } else { [1.0, 0.0, 0.0] };
    let u = norm(cross(axis, helper));
    let v = cross(axis, u);
    const SIDES: usize = 5;
    let ring = |c: V, r: f32, k: usize| {
        let t = k as f32 * std::f32::consts::TAU / SIDES as f32;
        add(c, add(mul(u, r * t.cos()), mul(v, r * t.sin())))
    };
    for k in 0..SIDES {
        let (p0, p1) = (ring(a, ra, k), ring(a, ra, k + 1));
        let (q0, q1) = (ring(b, rb, k), ring(b, rb, k + 1));
        out.push([p0, p1, q0]);
        out.push([p1, q1, q0]);
    }
    // cap the far end so a branch tip is not a hole
    let tip = ring(b, 0.0, 0);
    for k in 0..SIDES {
        out.push([ring(b, rb, k), ring(b, rb, k + 1), tip]);
    }
}

/// One leaf chip: a small closed octahedron (so a ray from outside always
/// meets a FRONT face — the probe bake counts back faces as "buried"),
/// flattened and turned at random.
fn chip(out: &mut Vec<Tri>, c: V, s: f32, rng: &mut Rng) {
    let a = norm([rng.range(-1.0, 1.0), rng.range(-0.4, 1.0), rng.range(-1.0, 1.0)]);
    let helper = if a[1].abs() < 0.9 { [0.0, 1.0, 0.0] } else { [1.0, 0.0, 0.0] };
    let u = norm(cross(a, helper));
    let v = cross(a, u);
    // a leaf is flat: thin along `a`, broad across it
    let axes = [mul(u, s * rng.range(0.8, 1.2)), mul(a, s * 0.45), mul(v, s * rng.range(0.8, 1.2))];
    for oct in 0..8 {
        let sg = |k: usize| if oct >> k & 1 == 0 { 1.0 } else { -1.0 };
        let (x, y, z) = (add(c, mul(axes[0], sg(0))), add(c, mul(axes[1], sg(1))), add(c, mul(axes[2], sg(2))));
        // outward winding: the (u, a, v) frame is LEFT-handed (u × a = -v),
        // so an octant with an even number of negative signs swaps two corners
        out.push(if sg(0) * sg(1) * sg(2) > 0.0 { [x, z, y] } else { [x, y, z] });
    }
}

/// A leaf clump: a loose cluster of small leaf chips in a squashed ellipsoid
/// of radius `r`, denser toward its shell. The silhouette is ragged and the
/// chips light and shadow one another, so it reads as foliage at the pixel
/// scale — one big faceted ball per clump read as a rock on a stick
/// (2026-09-24). `brown` is the chance a chip is dry, so a clump browns
/// patchily, not all at once.
fn clump(s: &mut Soup, c: V, r: f32, brown: f32, rng: &mut Rng) {
    let n = ((r * r * 220.0) as usize).clamp(8, 48);
    for _ in 0..n {
        let d = norm([rng.range(-1.0, 1.0), rng.range(-1.0, 1.0), rng.range(-1.0, 1.0)]);
        let reach = r * rng.f().powf(0.4);
        let p = add(c, [d[0] * reach, d[1] * reach * 0.72, d[2] * reach]);
        let into = if rng.f() < brown { &mut s.dry } else { &mut s.leaf };
        chip(into, p, rng.range(0.06, 0.1), rng);
    }
}

/// Build one plant rooted at `(x, ground_y, z)`. `dryness` 0..1 is the ground's
/// straw fraction there. Pure: the seed decides every branch.
pub fn build(kind: Kind, x: f32, ground_y: f32, z: f32, seed: u32, dryness: f32) -> Soup {
    let mut s = Soup::default();
    let mut rng = Rng { seed, k: 0 };
    let root: V = [x, ground_y - 0.05, z];
    // health: how much of the crown still carries leaves. Skewed low — the
    // aftermath's trees are struggling, and one in five is dead outright.
    let health = if rng.f() < 0.2 { 0.0 } else { rng.f().powf(0.7) } * (1.0 - 0.6 * dryness);
    // a clump is mostly green or mostly straw; its chips follow with a few
    // strays the other way
    let brown = |rng: &mut Rng| if rng.f() < 0.12 + 0.8 * dryness * dryness { 0.85 } else { 0.1 };
    match kind {
        Kind::Tree => {
            let height = rng.range(2.0, 3.3);
            let r0 = rng.range(0.07, 0.12);
            let lean = [rng.range(-0.25, 0.25), 0.0, rng.range(-0.25, 0.25)];
            // the trunk: four wandering segments
            let mut pts = vec![root];
            for k in 1..=4 {
                let f = k as f32 / 4.0;
                let wob = [rng.range(-0.06, 0.06), 0.0, rng.range(-0.06, 0.06)];
                pts.push(add(add(root, [lean[0] * f * f, height * f, lean[2] * f * f]), wob));
            }
            for k in 0..4 {
                let (fa, fb) = (k as f32 / 4.0, (k + 1) as f32 / 4.0);
                limb(&mut s.bark, pts[k], pts[k + 1], r0 * (1.0 - 0.7 * fa), r0 * (1.0 - 0.7 * fb));
            }
            // primary branches off the upper trunk, each forking into twigs
            let n = 3 + (rng.f() * 3.0) as usize;
            for b in 0..n {
                let f = rng.range(0.5, 0.95);
                let seg = ((f * 4.0) as usize).min(3);
                let t = f * 4.0 - seg as f32;
                let start = add(pts[seg], mul(sub(pts[seg + 1], pts[seg]), t));
                let yaw = (b as f32 + rng.range(-0.3, 0.3)) * std::f32::consts::TAU / n as f32;
                let up = rng.range(0.45, 1.1);
                let dir = norm([yaw.cos(), up, yaw.sin()]);
                let len = rng.range(0.6, 1.3) * (1.1 - 0.4 * f);
                let rb = r0 * (1.0 - 0.7 * f) * 0.65;
                let mid = add(start, add(mul(dir, len * 0.5), [0.0, rng.range(-0.05, 0.12), 0.0]));
                let end = add(start, add(mul(dir, len), [0.0, rng.range(-0.1, 0.15), 0.0]));
                limb(&mut s.bark, start, mid, rb, rb * 0.7);
                limb(&mut s.bark, mid, end, rb * 0.7, rb * 0.35);
                for _ in 0..2 + (rng.f() * 2.0) as usize {
                    let tw = norm(add(dir, [rng.range(-0.8, 0.8), rng.range(0.1, 0.8), rng.range(-0.8, 0.8)]));
                    let from = if rng.f() < 0.5 { mid } else { end };
                    let tip = add(from, mul(tw, rng.range(0.25, 0.55)));
                    limb(&mut s.bark, from, tip, rb * 0.35, 0.008);
                    if rng.f() < health {
                        let r = rng.range(0.22, 0.42);
                        let b = brown(&mut rng);
                        clump(&mut s, tip, r, b, &mut rng);
                    }
                }
                if rng.f() < health {
                    let r = rng.range(0.3, 0.5);
                    let b = brown(&mut rng);
                    clump(&mut s, end, r, b, &mut rng);
                }
            }
        }
        Kind::Bush => {
            // a low mound of clumps on a few woody stems
            let n = 4 + (rng.f() * 5.0) as usize;
            let spread = rng.range(0.25, 0.45);
            for _ in 0..n {
                let a = rng.f() * std::f32::consts::TAU;
                let d = rng.f().sqrt() * spread;
                let c = add(root, [a.cos() * d, rng.range(0.18, 0.55) * (1.0 - 0.5 * d / spread), a.sin() * d]);
                limb(&mut s.bark, add(root, [a.cos() * d * 0.3, 0.0, a.sin() * d * 0.3]), c, 0.02, 0.01);
                // a bush keeps more leaves than a tree, but dries the same
                if rng.f() < 0.35 + 0.65 * health.max(0.3) {
                    let r = rng.range(0.16, 0.3);
                    let b = brown(&mut rng);
                    clump(&mut s, c, r, b, &mut rng);
                }
            }
        }
    }
    s
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_seed_is_a_plant_and_different_seeds_differ() {
        let a = build(Kind::Tree, 3.0, 0.0, 4.0, 7, 0.0);
        let b = build(Kind::Tree, 3.0, 0.0, 4.0, 7, 0.0);
        let c = build(Kind::Tree, 3.0, 0.0, 4.0, 8, 0.0);
        assert_eq!(a.bark, b.bark);
        assert_ne!(a.bark, c.bark);
    }

    #[test]
    fn trees_stand_on_their_root_and_stay_tree_sized() {
        for seed in 0..40 {
            let t = build(Kind::Tree, 5.0, 0.0, 5.0, seed, 0.0);
            assert!(!t.bark.is_empty());
            for tri in t.bark.iter().chain(&t.leaf).chain(&t.dry) {
                for p in tri {
                    assert!(p.iter().all(|v| v.is_finite()));
                    assert!(p[1] > -0.2 && p[1] < 4.6, "seed {seed}: y {}", p[1]);
                    assert!((p[0] - 5.0).abs() < 2.6 && (p[2] - 5.0).abs() < 2.6, "seed {seed}: crown too wide {p:?}");
                }
            }
        }
    }

    #[test]
    fn dry_ground_browns_the_leaves() {
        let count = |dry: f32| (0..60).map(|s| build(Kind::Bush, 0.0, 0.0, 0.0, s, dry)).fold((0, 0), |a, p| (a.0 + p.leaf.len(), a.1 + p.dry.len()));
        let (g_wet, d_wet) = count(0.0);
        let (g_dry, d_dry) = count(1.0);
        assert!(g_wet > d_wet, "on healthy ground most leaves are green");
        assert!(d_dry > g_dry, "on dry ground most are straw");
    }

    #[test]
    fn leaf_chips_wind_outward() {
        // the normal the adapter takes from the winding must point away from
        // the chip's centre, or a lit crown shades as its own inside
        let mut rng = Rng { seed: 3, k: 0 };
        for _ in 0..20 {
            let mut out = Vec::new();
            let c = [rng.range(-2.0, 2.0), rng.range(0.0, 3.0), rng.range(-2.0, 2.0)];
            chip(&mut out, c, 0.08, &mut rng);
            for [a, b, d] in out {
                let n = cross(sub(b, a), sub(d, a));
                let mid = mul(add(add(a, b), d), 1.0 / 3.0);
                let out_dir = sub(mid, c);
                assert!(n[0] * out_dir[0] + n[1] * out_dir[1] + n[2] * out_dir[2] > 0.0);
            }
        }
    }

    #[test]
    fn some_trees_are_dead() {
        let bare = (0..50).filter(|&s| {
            let t = build(Kind::Tree, 0.0, 0.0, 0.0, s, 0.0);
            t.leaf.is_empty() && t.dry.is_empty()
        });
        assert!(bare.count() >= 3, "the aftermath has dead trees");
    }
}
