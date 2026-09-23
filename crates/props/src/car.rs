//! The car wreck, modelled as a BODY rather than a stack of boxes (owner
//! 2026-09-23: "the cars need more work — they are too boxy").
//!
//! The shell is LOFTED: a side silhouette (bumper, bonnet, windscreen, roof,
//! rear screen, boot — one table per body style) is sampled every ~10 cm
//! along the car, and at each station a cross-section ring is built with
//! rounded bottom edges, a slight bulge at the waist and TUMBLEHOME — the
//! glasshouse leaning in above the belt line — so the outline has the soft
//! shoulders a real car has. Wheel arches are cut into the bottom line, and
//! every quad is assigned its material by where it sits: side glass between
//! the pillars, the windscreen and rear screen on the sloped top, patches of
//! rust eating up from the sills and the arches, paint elsewhere.
//!
//! Then the details a car is read by: wheels (tyre, rim, hubcap), bumpers,
//! headlamps, tail lamps, grille, mirrors, a plate — and the wreck's
//! history: dents, a crumpled front, wheels gone with that corner sunk.

use crate::{Build, Mat, Rng, Rot, V};

/// A body style: the length, the top silhouette as (x, y) knots from the
/// rear (x = -len/2) to the front, the glasshouse span along x, and where its
/// three pillars stand.
struct Style {
    len: f32,
    width: f32,
    /// Top of the body, rear to front.
    top: &'static [(f32, f32)],
    /// The belt line: glass above it, panels below.
    belt: f32,
    /// Side glass runs between these x.
    glass: (f32, f32),
    /// Pillar centres (the glass is interrupted around them).
    pillars: &'static [f32],
    /// Sloped glass on the TOP surface: windscreen and rear screen spans.
    screens: &'static [(f32, f32)],
    /// Wheel centres along x.
    axles: (f32, f32),
}

const SEDAN: Style = Style {
    len: 4.4,
    width: 0.86,
    top: &[(-2.2, 0.52), (-2.17, 0.78), (-2.0, 0.86), (-1.25, 0.9), (-0.95, 1.02), (-0.5, 1.36), (0.45, 1.39), (0.7, 1.33), (1.15, 0.98), (1.35, 0.93), (2.05, 0.82), (2.17, 0.72), (2.2, 0.5)],
    belt: 0.93,
    glass: (-0.9, 1.1),
    pillars: &[-0.62, 0.02, 0.74],
    screens: &[(-1.0, -0.5), (0.7, 1.15)],
    axles: (-1.35, 1.35),
};

const HATCH: Style = Style {
    len: 3.9,
    width: 0.82,
    top: &[(-1.95, 0.52), (-1.92, 0.8), (-1.85, 0.95), (-1.6, 1.32), (-1.4, 1.38), (0.35, 1.4), (0.6, 1.34), (1.05, 0.98), (1.25, 0.92), (1.8, 0.8), (1.92, 0.7), (1.95, 0.5)],
    belt: 0.92,
    glass: (-1.55, 1.0),
    pillars: &[-1.42, -0.2, 0.62],
    screens: &[(-1.85, -1.6), (0.6, 1.05)],
    axles: (-1.2, 1.2),
};

const PICKUP: Style = Style {
    len: 4.7,
    width: 0.9,
    top: &[(-2.35, 0.55), (-2.32, 0.95), (-0.72, 0.97), (-0.68, 1.48), (0.35, 1.5), (0.6, 1.44), (1.05, 1.06), (1.25, 1.0), (2.2, 0.9), (2.32, 0.78), (2.35, 0.55)],
    belt: 1.02,
    glass: (-0.62, 1.0),
    pillars: &[-0.62, 0.62],
    screens: &[(0.6, 1.05)],
    axles: (-1.55, 1.45),
};

const VAN: Style = Style {
    len: 4.6,
    width: 0.92,
    top: &[(-2.3, 0.55), (-2.28, 1.0), (-2.25, 1.86), (-2.1, 1.92), (0.8, 1.92), (1.05, 1.82), (1.55, 1.12), (2.15, 0.92), (2.28, 0.8), (2.3, 0.55)],
    belt: 1.08,
    glass: (0.6, 1.5),
    pillars: &[0.95],
    screens: &[(1.05, 1.55)],
    axles: (-1.5, 1.5),
};

// faded paints of an old street
const PAINT: [[f32; 3]; 7] = [[0.28, 0.06, 0.04], [0.06, 0.14, 0.16], [0.36, 0.33, 0.24], [0.08, 0.1, 0.06], [0.2, 0.2, 0.2], [0.3, 0.17, 0.05], [0.4, 0.38, 0.33]];

/// One cross-section point: (y, half-width, tag — 0 panel, 1 side glass
/// band, 2 top surface).
type RingPt = (f32, f32, u8);

fn lerp_top(s: &Style, x: f32) -> f32 {
    let k = s.top;
    if x <= k[0].0 {
        return k[0].1;
    }
    for w in k.windows(2) {
        if x <= w[1].0 {
            let t = (x - w[0].0) / (w[1].0 - w[0].0);
            // ease the knots so the silhouette bends, not kinks
            let t = t * t * (3.0 - 2.0 * t) * 0.35 + t * 0.65;
            return w[0].1 + (w[1].1 - w[0].1) * t;
        }
    }
    k[k.len() - 1].1
}

fn noise(x: f32, y: f32, seed: u32) -> f32 {
    let (ix, iy) = (x.floor(), y.floor());
    let (fx, fy) = (x - ix, y - iy);
    let (sx, sy) = (fx * fx * (3.0 - 2.0 * fx), fy * fy * (3.0 - 2.0 * fy));
    let h = |a: f32, b: f32| crate::hash(a as i32, b as i32, seed);
    let a = h(ix, iy) * (1.0 - sx) + h(ix + 1.0, iy) * sx;
    let b = h(ix, iy + 1.0) * (1.0 - sx) + h(ix + 1.0, iy + 1.0) * sx;
    a * (1.0 - sy) + b * sy
}

/// Build the wreck in `b`'s local frame, long along x, front at +x.
pub(crate) fn car(b: &mut Build, r: &mut Rng) {
    let style = match (r.f() * 4.0) as i32 {
        0 => &SEDAN,
        1 => &HATCH,
        2 => &PICKUP,
        _ => &VAN,
    };
    let bare = r.f() < 0.25;
    let paint = if bare { Mat::Rust } else { Mat::Paint(r.pick(&PAINT)) };
    // how far rust has spread over the paint, 0..1
    let rot = if bare { 1.0 } else { r.range(0.15, 0.7) };
    let seed = r.seed;
    let crumple = if r.f() < 0.45 { r.range(0.15, 0.45) } else { 0.0 };
    let dents = r.range(0.0, 0.05);
    // wheels: each is gone with 30 %, and its corner sinks onto the hub
    let wheels: Vec<bool> = (0..4).map(|_| r.f() > 0.3).collect();
    let sink = |i: usize| if wheels[i] { 0.0 } else { 0.18 };
    let (half_l, w) = (style.len / 2.0, style.width);
    // the body settles onto its missing corners: each point drops by the
    // sink of the four corners, weighted by where it sits between the axles
    // and the sides — the wheels still there stay on the ground
    let settle = |x: f32, z: f32| {
        let f = ((x - style.axles.0) / (style.axles.1 - style.axles.0)).clamp(-0.3, 1.3);
        let l = (z / w * 0.5 + 0.5).clamp(0.0, 1.0);
        let front = sink(0) * l + sink(1) * (1.0 - l);
        let rear = sink(2) * l + sink(3) * (1.0 - l);
        rear + (front - rear) * f
    };
    let place = |p: V| [p[0], p[1] - settle(p[0], p[2]), p[2]];
    // the boxes' own tilt follows the settle's slope
    let pitch = (settle(style.axles.1, 0.0) - settle(style.axles.0, 0.0)) / (style.axles.1 - style.axles.0);
    let roll = (settle(0.0, w) - settle(0.0, -w)) / (2.0 * w);
    let tilt = Rot::z(-pitch).mul(Rot::x(roll));

    // ---- the lofted shell
    let wheel_r = 0.31;
    let arch = |x: f32| {
        [style.axles.0, style.axles.1]
            .iter()
            .map(|&ax| {
                let d = (x - ax).abs();
                if d < 0.44 {
                    wheel_r + 0.02 + (0.44f32 * 0.44 - d * d).sqrt() * 0.95
                } else {
                    0.0
                }
            })
            .fold(0.24f32, f32::max)
    };
    let stations = (style.len / 0.1).ceil() as usize;
    // ring: (y, half-width) pairs from the bottom centre round to the top
    // centre on the +z side; mirrored for -z
    let ring = |x: f32| -> Vec<RingPt> {
        // the crumpled front sags and pulls in
        let front = ((x - (half_l - 0.9)) / 0.9).clamp(0.0, 1.0) * crumple;
        let top = lerp_top(style, x) - front * 0.35;
        let bottom = arch(x).min(top - 0.1);
        let belt = style.belt.min(top);
        let taper = 1.0 - 0.08 * ((x.abs() - (half_l - 0.35)) / 0.35).clamp(0.0, 1.0);
        let ww = w * taper * (1.0 - front * 0.15);
        let roof_w = ww * 0.8;
        // tags: 0 panel, 1 side glass band, 2 top surface
        vec![
            (bottom, 0.0, 0),
            (bottom, ww * 0.88, 0),
            (bottom + 0.06, ww * 0.98, 0),
            ((bottom + belt) * 0.5, ww, 0),
            (belt - 0.03, ww * 0.99, 0),
            (belt, ww * 0.95, 1),
            // the glass band: from the belt up to just under the top, leaning
            // in; where the top is at the belt (bonnet, boot) it collapses
            // onto it instead of folding back through the panel below
            (belt + (top - belt) * 0.88, roof_w + (ww * 0.95 - roof_w) * (1.0 - ((top - belt) / 0.4).clamp(0.0, 1.0)), 1),
            (top, roof_w * 0.92 + (ww * 0.9 - roof_w * 0.92) * (1.0 - ((top - belt) / 0.4).clamp(0.0, 1.0)), 2),
            (top + 0.012, roof_w * 0.5, 2),
            (top + 0.015, 0.0, 2),
        ]
    };
    let rings: Vec<(f32, Vec<RingPt>)> = (0..=stations).map(|i| {
        let x = -half_l + style.len * i as f32 / stations as f32;
        (x, ring(x))
    }).collect();
    let in_glass = |x: f32| x > style.glass.0 && x < style.glass.1 && style.pillars.iter().all(|p| (x - p).abs() > 0.06);
    let on_screen = |x: f32| style.screens.iter().any(|&(a, b)| x > a + 0.03 && x < b - 0.03);
    for i in 0..stations {
        let (x0, r0) = &rings[i];
        let (x1, r1) = &rings[i + 1];
        let xm = (x0 + x1) * 0.5;
        for k in 0..r0.len() - 1 {
            let tag = r0[k].2.max(r0[k + 1].2);
            let ym = (r0[k].0 + r0[k + 1].0) * 0.5;
            let glass = (tag == 1 && k == 5 && in_glass(xm)) || (tag == 2 && k >= 7 && on_screen(xm));
            let rusty = !glass && {
                // rust climbs from the sills and eats round the arches
                let low = 1.0 - ((ym - 0.25) / 0.7).clamp(0.0, 1.0);
                noise(xm * 2.2, ym * 3.0, seed) * 0.8 + low * 0.5 > 1.25 - rot
            };
            let m = if glass { Mat::Glass } else if rusty { Mat::Rust } else { paint };
            for side in [1.0f32, -1.0] {
                let p = |x: f32, (y, hw, _): RingPt| {
                    // dents: the panels are pushed in here and there
                    let dent = dents * (noise(x * 3.0, y * 3.0 + side * 7.0, seed + 5) - 0.5) * 2.0;
                    place([x, y, side * (hw - dent.max(0.0))])
                };
                let (a, b2, c, d) = (p(*x0, r0[k]), p(*x0, r0[k + 1]), p(*x1, r1[k]), p(*x1, r1[k + 1]));
                let t = b.tris(m);
                if side > 0.0 {
                    t.push([a, c, b2]);
                    t.push([b2, c, d]);
                } else {
                    t.push([a, b2, c]);
                    t.push([b2, d, c]);
                }
            }
        }
    }
    // end caps: close the nose and the tail
    for (x, rg, sign) in [(rings[0].0, &rings[0].1, -1.0f32), (rings[stations].0, &rings[stations].1, 1.0)] {
        let centre = place([x, (rg[0].0 + rg[rg.len() - 1].0) * 0.5, 0.0]);
        for k in 0..rg.len() - 1 {
            for side in [1.0f32, -1.0] {
                let a = place([x, rg[k].0, side * rg[k].1]);
                let c = place([x, rg[k + 1].0, side * rg[k + 1].1]);
                let t = b.tris(paint);
                // wound so the cap's normal points out of the car (+x at the
                // nose, -x at the tail) — the shade pass lights by it
                if side * sign > 0.0 {
                    t.push([centre, c, a]);
                } else {
                    t.push([centre, a, c]);
                }
            }
        }
    }

    // ---- details the eye reads a car by
    let nose = half_l - 0.02;
    let lamp_y = lerp_top(style, nose - 0.1) - 0.14 - crumple * 0.3;
    // bumpers: a rounded bar across each end
    for (x, y) in [(half_l + 0.02, 0.36), (-half_l - 0.02, 0.38)] {
        b.cyl(Mat::Steel, place([x, y, -w * 0.95]), place([x, y, w * 0.95]), 0.075, 6);
    }
    // grille and headlamps (one may be smashed out)
    b.obox(Mat::Rubber, place([nose, lamp_y - 0.02, 0.0]), [0.02, 0.07, w * 0.45], tilt);
    for (i, z) in [w * 0.7, -w * 0.7].into_iter().enumerate() {
        if !(crumple > 0.3 && i == 0) {
            b.obox(Mat::Paint([0.6, 0.58, 0.5]), place([nose, lamp_y, z]), [0.02, 0.06, 0.12], tilt);
        }
    }
    // tail lamps and the plate
    let tail_y = lerp_top(style, -half_l + 0.1) - 0.12;
    for z in [w * 0.72, -w * 0.72] {
        b.obox(Mat::Paint([0.35, 0.03, 0.02]), place([-half_l - 0.01, tail_y, z]), [0.02, 0.06, 0.11], tilt);
    }
    b.obox(Mat::Paint([0.5, 0.5, 0.45]), place([-half_l - 0.02, 0.5, 0.0]), [0.01, 0.06, 0.16], tilt);
    // mirrors at the foot of the A-pillar
    if let Some(&a) = style.pillars.last() {
        for s in [1.0f32, -1.0] {
            if r.f() < 0.75 {
                b.obox(paint, place([a - 0.05, style.belt + 0.06, s * (w + 0.06)]), [0.05, 0.04, 0.05], tilt);
            }
        }
    }
    // wheel wells: the dark cavity every arch opens onto, so an empty arch
    // shows the car's underside, not the sky through the shell
    for ax in [style.axles.0, style.axles.1] {
        let c = place([ax, wheel_r + 0.04, 0.0]);
        b.obox(Mat::Rubber, c, [0.4, 0.2, w * 0.86], tilt);
    }
    // wheels: tyre, rim, hubcap — or, where the wheel is gone, the bare
    // brake drum the corner came down on
    for (i, &(ax, s)) in [(style.axles.1, 1.0f32), (style.axles.1, -1.0), (style.axles.0, 1.0), (style.axles.0, -1.0)].iter().enumerate() {
        if !wheels[i] {
            let c = [ax, 0.16, s * (w - 0.2)];
            b.cyl(Mat::Rust, [c[0], c[1], c[2] - s * 0.06], [c[0], c[1], c[2] + s * 0.06], 0.15, 8);
            continue;
        }
        // a wheel stands on the ground whatever the body does
        let c = [ax, wheel_r, s * (w - 0.08)];
        let z = [c[0], c[1], c[2] + s * 0.11];
        let zi = [c[0], c[1], c[2] - s * 0.11];
        b.cyl(Mat::Rubber, zi, z, wheel_r, 12);
        let rim = [c[0], c[1], c[2] + s * 0.115];
        b.cyl(Mat::Steel, [c[0], c[1], c[2] + s * 0.1], rim, 0.19, 10);
        b.cyl(Mat::Rust, rim, [rim[0], rim[1], rim[2] + s * 0.01], 0.08, 8);
    }
}
