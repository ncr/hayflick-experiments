//! THE SHARED TEST FIXTURES — sheets and piers spelled out by hand.
//!
//! One copy for every submodule's tests: a fixture that drifted between two of
//! them would make two tests disagree about what "a hot wall" is.

use crate::gym_scene::Pier;
use glam::Vec3;
use rt_probe::Scene;
use super::{Wear, NPOL};

/// ONE TEST SHEET, hand-built. It stands in for `wall::compile_specs` so a
/// generator test is not also testing the solver: the gates are a mid-field
/// set in the causal order `wall::derive` produces (stains widest, the crack
/// zone next, the veneer's tightest), and every amount is stated outright.
pub(super) fn sheet(area: [f32; wear_core::wall::Layer::N], t: f32, shape: wear_core::wall::Shape, breaks: wear_core::wall::Breaks) -> wear_core::wall::Sheet {
    let mut gate = [t; wear_core::wall::Layer::N];
    gate[wear_core::wall::Layer::Stain.index()] = t - 0.06;
    gate[wear_core::wall::Layer::Cracks.index()] = t - 0.03;
    let q = |v: f32| (v.clamp(0.0, 1.0) * 63.0).round() as u8;
    wear_core::wall::Sheet {
        label: "test",
        area,
        breaks,
        gate,
        paint: wear_core::wall::Paint::default(),
        geom: wear_core::wall::Geom {
            t_cracks: wear_core::wall::gate_code(gate[wear_core::wall::Layer::Cracks.index()]) as u8,
            t_chips: wear_core::wall::gate_code(gate[wear_core::wall::Layer::Chips.index()]) as u8,
            spall: q(area[wear_core::wall::Layer::Spall.index()]),
            grain: q(shape.grain),
            relief: q(shape.relief),
            pattern: shape.pattern.code(),
            par: shape.pattern.par().map(q),
            breaks: breaks.count,
            ..Default::default()
        },
        notes: Vec::new(),
    }
}

/// The default shape at one policy — the shape half of [`sheet`].
pub(super) fn shape(policy: u8) -> wear_core::wall::Shape {
    wear_core::wall::Shape { pattern: wear_core::wall::Pattern::DEFAULTS[policy as usize % NPOL], ..wear_core::wall::Shape::DEFAULT }
}

/// A one-run [`Wear`] over `n` piers, all reading `sheets[0]`.
pub(super) fn wear1(sheets: &[wear_core::wall::Sheet], n: usize) -> Wear<'_> {
    static ZERO: [usize; 64] = [0; 64];
    static NO: [bool; 64] = [false; 64];
    Wear { sheets, pier_run: &ZERO[..n], paint_only: &NO[..n] }
}

/// A HOT wall: heavily cracked, chipped, mid relief. The successor to the
/// four-knob `HOT` quad, in the model's own units.
pub(super) fn hot(policy: u8) -> wear_core::wall::Sheet {
    use wear_core::wall::Layer::*;
    let mut a = [0.0; wear_core::wall::Layer::N];
    (a[Stain.index()], a[Web.index()], a[Cracks.index()], a[Chips.index()]) = (0.9, 0.7, 0.65, 0.35);
    sheet(a, 0.45, shape(policy), NO_BREAK)
}

pub(super) fn pier_at(scene: &mut Scene, x0: f32) -> Pier {
    let lo = Vec3::new(x0, 0.0, 9.9);
    let hi = Vec3::new(x0 + 6.0, 1.2, 10.15);
    scene.add_box_world(lo, hi, [0.9, 0.9, 0.9, 1.0], [0.0; 4], 0.85, 0.0);
    Pier { prim: scene.primitives.len() - 1, lo, hi, run_lo: lo, run_hi: hi }
}

/// The plain greybox: no story, nothing to build.
pub(super) fn pristine() -> wear_core::wall::Sheet {
    sheet([0.0; wear_core::wall::Layer::N], 1.2, shape(0), NO_BREAK)
}

/// A wall that CRAZES hard — a wide damaged area and most of its plates
/// missing, which is what makes a veneer pattern visible at all.
pub(super) fn crazy(policy: u8) -> wear_core::wall::Sheet {
    use wear_core::wall::Layer::*;
    let mut a = [0.0; wear_core::wall::Layer::N];
    (a[Stain.index()], a[Web.index()], a[Cracks.index()], a[Chips.index()]) = (1.0, 0.9, 0.85, 0.80);
    sheet(a, 0.45, wear_core::wall::Shape { relief: 0.6, ..shape(policy) }, NO_BREAK)
}

/// …and the same wall, broken once.
pub(super) fn broken(policy: u8) -> wear_core::wall::Sheet {
    wear_core::wall::Sheet { breaks: ONE_BREAK, geom: wear_core::wall::Geom { breaks: 1, ..hot(policy).geom }, ..hot(policy) }
}

/// The relief and cracking a break's own geometry reads (`run_breaks`).
pub(super) const REL: f32 = 0.45;
pub(super) const CRK: f32 = 0.65;

/// A HOT wall with an authored break count.
pub(super) fn with_breaks(b: wear_core::wall::Breaks) -> wear_core::wall::Sheet {
    wear_core::wall::Sheet { breaks: b, geom: wear_core::wall::Geom { breaks: b.count, ..hot(0).geom }, ..hot(0) }
}

/// A wall at one RELIEF setting — for the veneer-thickness sweep.
pub(super) fn relief_sheet(relief: f32) -> wear_core::wall::Sheet {
    let mut sh = hot(0);
    sh.geom.relief = (relief.clamp(0.0, 1.0) * 63.0).round() as u8;
    sh
}

/// A wall with SPALL, at the amount named.
pub(super) fn spalling(area: f32) -> wear_core::wall::Sheet {
    let mut sh = hot(0);
    sh.area[wear_core::wall::Layer::Spall.index()] = area;
    sh
}

/// One break, story-placed. It used to take `faulting_pier`, a loop over
/// eight wall positions looking for a strip whose hash happened to fire —
/// the clearest possible statement of what was wrong with the old
/// mechanism, and the exact reason the effect catalogue's break specimen
/// once shipped four cells wide.
pub(super) const ONE_BREAK: wear_core::wall::Breaks = wear_core::wall::Breaks { count: 1, at: None };
pub(super) const NO_BREAK: wear_core::wall::Breaks = wear_core::wall::Breaks::NONE;

pub(super) fn assert_in_box(scene: &Scene, from: usize, pier: &Pier, tag: &str) {
    for p in &scene.primitives[from..] {
        for v in &scene.vertices[p.vertex_offset as usize..(p.vertex_offset + p.vertex_count) as usize] {
            assert!(v.pos[0] >= pier.lo.x - 1e-4 && v.pos[0] <= pier.hi.x + 1e-4, "{tag}: x in box");
            assert!(v.pos[1] >= pier.lo.y - 1e-4 && v.pos[1] <= pier.hi.y + 1e-4, "{tag}: y in box");
            assert!(v.pos[2] >= pier.lo.z - 1e-4 && v.pos[2] <= pier.hi.z + 1e-4, "{tag}: z in box");
        }
    }
}
