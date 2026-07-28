//! THE LEVEL-MEASURING HALF of `wear_core::wall`'s tests.
//!
//! Eleven claims the wear model makes are not about arithmetic in the abstract —
//! they are about what the model does to the walls of the two REAL SHIPPED
//! LEVELS. "An amount is an area" measured on a synthetic 6-wu rectangle would
//! prove almost nothing: the property that matters is that it holds on the gym's
//! 1.6-wu doorway pier and on the bench's 2.2-wu slab, at every scrub position,
//! and the only way to ask that is to build the level.
//!
//! Building a level means `gym_scene::build_gym`, which means an `rt_probe::Scene`
//! — so these tests cannot live in the leaf crate their subject moved to
//! (2026-07-28: `wall.rs` and `rebar.rs` became `wear-core`, deps `glam` only).
//! They stayed here and reach in through `wear_core::wall::…`. That is the
//! CORRECT outcome of the split, not a casualty of it: they are integration
//! tests by nature, and the import at the top of every function now says so.
//!
//! The pure-arithmetic three — break placement, `derive` being the only writer,
//! and the shell compiler's limits — went with the module.

use glam::Vec3;
use wear_core::field::mixf;
use wear_core::wall::*;

/// Every RUN of both shipped levels, as the authoring model sees them.
fn runs_of(spec: &house_game::gym::sim::GymLevel) -> Vec<RunRect> {
    let (_scene, meta) = crate::gym_scene::build_gym(spec, &crate::look::POLANA);
    let mut out: Vec<RunRect> = Vec::new();
    for p in &meta.piers {
        if !out.iter().any(|r| (r.lo - p.run_lo).length() < 1e-4 && (r.hi - p.run_hi).length() < 1e-4) {
            out.push(RunRect { lo: p.run_lo, hi: p.run_hi });
        }
    }
    out
}
fn both_levels() -> Vec<(&'static str, Vec<RunRect>)> {
    vec![
        ("gym", runs_of(&house_game::gym::sim::gym_level())),
        ("catalogue", runs_of(&house_game::gym::sim::catalogue_level())),
    ]
}

/// The field's extremes — the only two questions anything asks about them, and
/// both are about whether the gate CODE RANGE brackets a run. `sorted` is
/// private and does not store them twice, so this reads them back through
/// [`RunField::extremes`].
fn field_lo(f: &RunField) -> f32 {
    f.extremes().0
}
fn field_hi(f: &RunField) -> f32 {
    f.extremes().1
}

/// Continuous coverage, measured on a lattice 4× finer than the one the
/// threshold was solved on — the honest question, since the promise is
/// about the FACE and not about the sample set.
fn true_coverage(r: &RunRect, story: f32, t: f32) -> f32 {
    let fine = LATTICE * 0.25;
    let run_x = (r.hi.x - r.lo.x) >= (r.hi.z - r.lo.z);
    let (a0, a1) = if run_x { (r.lo.x, r.hi.x) } else { (r.lo.z, r.hi.z) };
    let n = |a: f32, b: f32| ((((b - a) / fine).round()) as usize).max(2);
    let (nu, ny) = (n(a0, a1), n(r.lo.y, r.hi.y));
    let mut above = 0usize;
    for i in 0..nu {
        let u = mixf(a0, a1, (i as f32 + 0.5) / nu as f32);
        for j in 0..ny {
            let y = mixf(r.lo.y, r.hi.y, (j as f32 + 0.5) / ny as f32);
            if RunField::at(story, u, y) >= t {
                above += 1;
            }
        }
    }
    above as f32 / (nu * ny) as f32
}

/// THE CLAIM THE WHOLE MODEL RESTS ON: an amount is an AREA.
///
/// Asked for 0.30, a wall gets 30 % of its face — measured on a lattice 4×
/// finer than the one the threshold was solved on, over every run of both
/// shipped levels, at several scrub positions (every variant of the field
/// must keep the promise, or the scrub dial would be a second intensity
/// knob). The test also MEASURES the run-length floor below which the
/// promise stops holding and prints it, because that floor is a real
/// property of the field (its finest octave is 1.09 × 0.70 wu, so a short
/// run simply has fewer independent features than a fine fraction needs)
/// and the bench's slabs are 2.2 wu.
#[test]
fn an_amount_is_an_area() {
    let mut worst: Vec<(String, f32, f32, f32)> = Vec::new();
    let mut n = 0;
    for (level, runs) in both_levels() {
        for (i, r) in runs.iter().enumerate() {
            for scrub in [0.0f32, 0.3, 0.8] {
                let story = scrub_key(r.story(), scrub);
                let f = RunField::of(r.lo, r.hi, story, [0, 0]);
                for asked in [0.1f32, 0.3, 0.6, 0.9] {
                    let got = true_coverage(r, story, gate_quantize(f.threshold(asked)));
                    worst.push((format!("{level} run {i} ({:.1} wu) scrub {scrub}", r.length()), asked, got, (got - asked).abs()));
                    n += 1;
                }
            }
        }
    }
    worst.sort_by(|a, b| b.3.total_cmp(&a.3));
    for (who, asked, got, e) in worst.iter().take(5) {
        println!("worst: {who} asked {asked:.2} got {got:.2} (err {e:.3})");
    }
    assert!(n >= 150, "VACUOUS: only {n} cases");
    // The quantization alone costs up to GATE_STEP/2 of threshold, which on
    // a steep part of the field is a few per cent of area; the floor below
    // is what the measurement above actually produced.
    let e = worst[0].3;
    assert!(e < 0.12, "an amount is not an area on {}: asked {:.2}, got {:.2}", worst[0].0, worst[0].1, worst[0].2);
}

/// ZERO IS PROVABLY EMPTY — and it has to be provable, not merely small:
/// code 0 is what every material nobody stamped decodes to, so if it caught
/// even the field's peak, the whole unaged level would age itself.
#[test]
fn zero_is_provably_empty() {
    for (level, runs) in both_levels() {
        for (i, r) in runs.iter().enumerate() {
            for scrub in [0.0f32, 0.5, 1.0] {
                let f = RunField::of(r.lo, r.hi, scrub_key(r.story(), scrub), [0, 0]);
                assert!(field_hi(&f) < GATE_EMPTY, "{level} run {i} scrub {scrub}: field max {} reaches the empty gate", field_hi(&f));
                assert_eq!(gate_code(f.threshold(0.0)), 0, "{level} run {i}: 'none of it' is not code 0");
                assert_eq!(f.coverage(gate_quantize(f.threshold(0.0))), 0.0);
            }
        }
    }
}

/// THE CODE BRACKETS EVERY RUN: 63 steps down from an unreachable high must
/// still reach below the field's minimum, or full coverage is unreachable on
/// some wall — which is the dead-dial-region defect this codec replaced.
#[test]
fn the_gate_code_brackets_every_run() {
    let low = GATE_HI - 63.0 * GATE_STEP;
    for (level, runs) in both_levels() {
        for (i, r) in runs.iter().enumerate() {
            for scrub in [0.0f32, 0.5, 1.0] {
                let f = RunField::of(r.lo, r.hi, scrub_key(r.story(), scrub), [0, 0]);
                assert!(field_lo(&f) > low, "{level} run {i} scrub {scrub}: field min {} is below the lowest code {low}", field_lo(&f));
                assert_eq!(gate_code(f.threshold(1.0)), 63, "{level} run {i}: 'all of it' is not the bottom code");
                assert_eq!(f.coverage(gate_quantize(f.threshold(1.0))), 1.0, "{level} run {i}: full coverage unreachable");
            }
        }
    }
}

/// MORE IS MORE, per layer per run: coverage monotone in the amount. A
/// non-monotone dial is unusable however correct its endpoints are.
#[test]
fn more_is_more() {
    for (level, runs) in both_levels() {
        for (i, r) in runs.iter().enumerate() {
            let f = RunField::of(r.lo, r.hi, r.story(), [0, 0]);
            let mut prev = -1.0;
            for k in 0..=20 {
                let got = f.coverage(gate_quantize(f.threshold(k as f32 / 20.0)));
                assert!(got >= prev - 1e-6, "{level} run {i}: coverage fell from {prev} to {got} at amount {}", k as f32 / 20.0);
                prev = got;
            }
        }
    }
}

/// SCRUB RE-ROLLS THE FIELD WITHOUT ADDING DAMAGE: at a fixed amount the
/// coverage is invariant (solving a threshold per run buys that for EVERY
/// seed) while the damaged patch actually MOVES — the whole point of the
/// dial. And it is quantized on the 6-bit grid, so a drag inside one step
/// changes nothing: the rebuild gate stays quiet by construction.
#[test]
fn scrub_rerolls_the_field_without_adding_damage() {
    let runs = runs_of(&house_game::gym::sim::gym_level());
    let mut moved = 0;
    for r in &runs {
        let (a, b) = (scrub_key(r.story(), 0.0), scrub_key(r.story(), 0.6));
        assert_eq!(a, r.story(), "scrub 0 must be the run's own hash — the wall that shipped");
        let (fa, fb) = (RunField::of(r.lo, r.hi, a, [0, 0]), RunField::of(r.lo, r.hi, b, [0, 0]));
        let (ta, tb) = (gate_quantize(fa.threshold(0.30)), gate_quantize(fb.threshold(0.30)));
        assert!((fa.coverage(ta) - 0.30).abs() < 0.10);
        assert!((fb.coverage(tb) - 0.30).abs() < 0.10, "a scrubbed wall must keep its amount");
        // …and the damaged SET moved: count lattice points whose in/out
        // state changed between the two variants
        let run_x = (r.hi.x - r.lo.x) >= (r.hi.z - r.lo.z);
        let (a0, a1) = if run_x { (r.lo.x, r.hi.x) } else { (r.lo.z, r.hi.z) };
        let (mut diff, mut n) = (0usize, 0usize);
        let nu = (((a1 - a0) / LATTICE).round() as usize).max(2);
        let ny = (((r.hi.y - r.lo.y) / LATTICE).round() as usize).max(2);
        for i in 0..nu {
            let u = mixf(a0, a1, (i as f32 + 0.5) / nu as f32);
            for j in 0..ny {
                let y = mixf(r.lo.y, r.hi.y, (j as f32 + 0.5) / ny as f32);
                diff += ((RunField::at(a, u, y) >= ta) != (RunField::at(b, u, y) >= tb)) as usize;
                n += 1;
            }
        }
        if diff as f32 / n as f32 > 0.15 {
            moved += 1;
        }
    }
    assert!(moved * 2 >= runs.len(), "scrub moved the damage on only {moved} of {} runs", runs.len());
    // the 6-bit grid: a sub-step drag is the SAME key, a real step is not
    assert_eq!(scrub_key(7.4, 0.500), scrub_key(7.4, 0.505), "a sub-quantum scrub moved the key");
    assert_ne!(scrub_key(7.4, 0.500), scrub_key(7.4, 0.530), "a real scrub step did not move the key");
}

/// THE BAND HOLDS THE DAMAGE — and says so when an ask does not fit.
///
/// Three claims: the default band is a bit-exact no-op (that is what keeps
/// every shipped level byte-stable); a banded wall's solved threshold puts
/// its WHOLE area inside the band (the feather is the only spill); and an
/// ask larger than the band's own area is honoured with a difference that
/// lands in [`Miss::Coarse`] — the honest-limit discipline, not a silent
/// clamp.
#[test]
fn the_band_holds_the_damage_and_says_when_an_ask_does_not_fit() {
    // the no-op: subtraction leaves in-band values EXACT
    assert_eq!(band_codes(0.0, 1.0), [0, 0], "the default authoring packs to the empty lanes");
    for v in [0.0f32, 0.37, 1.16, -0.2] {
        assert_eq!(banded(v, [0, 0], 0.5), v, "band off must be the raw field, bit for bit");
    }
    let runs = runs_of(&house_game::gym::sim::gym_level());
    // the longest run, so the Coarse tolerance is about the BAND, not the
    // run being short
    let r = runs.iter().max_by(|a, b| a.length().total_cmp(&b.length())).expect("the gym has runs");
    let spec = WallSpec { band: (0.0, 0.45), pin: Pins::NONE.area(Layer::Cracks, 0.20), ..WallSpec::PRISTINE };
    let sheets = compile_specs(std::slice::from_ref(r), &[("banded", spec)]);
    let (gate, band) = (sheets[0].gate[Layer::Cracks.index()], band_codes(0.0, 0.45));
    let story = scrub_key(r.story(), 0.0);
    // every damaged sample sits inside the band (+ the feather)
    let run_x = (r.hi.x - r.lo.x) >= (r.hi.z - r.lo.z);
    let (a0, a1) = if run_x { (r.lo.x, r.hi.x) } else { (r.lo.z, r.hi.z) };
    let (mut hit, mut n) = (0usize, 0usize);
    for i in 0..(((a1 - a0) / LATTICE) as usize) {
        let u = mixf(a0, a1, (i as f32 + 0.5) / ((a1 - a0) / LATTICE));
        for j in 0..(((r.hi.y - r.lo.y) / LATTICE) as usize) {
            let y = mixf(r.lo.y, r.hi.y, (j as f32 + 0.5) / ((r.hi.y - r.lo.y) / LATTICE));
            if banded(RunField::at(story, u, y), band, y / BAND_TOP) >= gate {
                hit += 1;
                assert!(y / BAND_TOP <= 0.45 + BAND_FEATHER + 1e-3, "damage at {:.2} of the wall height escaped a (0, 0.45) band", y / BAND_TOP);
            }
            n += 1;
        }
    }
    let got = hit as f32 / n as f32;
    assert!((got - 0.20).abs() < 0.08, "a 0.20 ask inside a 0.45 band must still be a 0.20 area, got {got:.3}");
    assert!(sheets[0].notes.is_empty(), "an ask the band can hold must not be reported: {:?}", sheets[0].notes);

    // an ask the band CANNOT hold: honoured with a difference, and said
    let over = WallSpec { band: (0.0, 0.45), pin: Pins::NONE.area(Layer::Cracks, 0.90), ..WallSpec::PRISTINE };
    let sheets = compile_specs(std::slice::from_ref(r), &[("over", over)]);
    let Some(Miss::Coarse { layer, asked, got, .. }) = sheets[0].notes.iter().find(|m| matches!(m, Miss::Coarse { .. })) else {
        panic!("a 0.90 ask inside a 0.45 band was obeyed silently: {:?}", sheets[0].notes);
    };
    assert_eq!(*layer, Layer::Cracks);
    assert_eq!(*asked, 0.90);
    assert!(*got < 0.55, "the band held {got:.2} of the face — it should top out near its own area");
}

/// MUD'S AMOUNT IS AN AREA OF ITS BAND — solved, not calibrated. For every
/// gym run and several amounts, the coverage the SHADER will draw (its own
/// noise against the decoded 6-bit threshold, measured on a 4× finer
/// lattice than the solve) lands on the ask. A global amount→threshold
/// curve was the first cut and failed at 1.8×: a splash band holds ~a
/// dozen independent noise cells, so per-story coverage was a lottery —
/// the exact defect solved thresholds exist to remove.
#[test]
fn mud_amount_is_an_area_of_its_band() {
    let runs = runs_of(&house_game::gym::sim::gym_level());
    let mut worst = (0.0f32, 0.0f32, 0.0f32); // (asked, got, err)
    for r in &runs {
        let story = r.story();
        for asked in [0.2f32, 0.5, 0.8] {
            let code = mud_code(story, r.lo, r.hi, asked, WallSpec::MUD_TOP);
            assert!((1..=63).contains(&code), "a live mud ask must never code to 'none'");
            let t = code as f32 / 63.0; // the shader's decode
            let run_x = (r.hi.x - r.lo.x) >= (r.hi.z - r.lo.z);
            let (a0, a1) = if run_x { (r.lo.x, r.hi.x) } else { (r.lo.z, r.hi.z) };
            let y1 = WallSpec::MUD_TOP * BAND_TOP;
            let fine = LATTICE * 0.25;
            let (nu, ny) = (((a1 - a0) / fine) as usize, (y1 / fine) as usize);
            let mut hit = 0usize;
            for i in 0..nu {
                let u = mixf(a0, a1, (i as f32 + 0.5) / nu as f32);
                for j in 0..ny {
                    hit += (mud_noise(story, u, mixf(0.0, y1, (j as f32 + 0.5) / ny as f32)) > t) as usize;
                }
            }
            let got = hit as f32 / (nu * ny) as f32;
            if (got - asked).abs() > worst.2 {
                worst = (asked, got, (got - asked).abs());
            }
        }
    }
    println!("mud worst: asked {:.2} got {:.2}", worst.0, worst.1);
    assert!(worst.2 < 0.12, "mud asked {:.2} drew {:.2} of its band", worst.0, worst.1);
    assert_eq!(mud_code(7.4, Vec3::ZERO, Vec3::new(6.0, 2.1875, 0.25), 0.0, 0.35), 0, "no mud = code 0 = the unstamped-material value");
}

/// [`BAND_TOP`] IS the authored wall top. The shader twins hardcode the
/// same constant (their mask runs in world space), so if `wall_slab` ever
/// grows taller walls this is the assertion that says three places now
/// disagree about what "the top of the band" means.
#[test]
fn band_top_is_the_authored_wall_top() {
    assert_eq!(BAND_TOP, crate::gym_scene::WALL_TOP);
    let runs = runs_of(&house_game::gym::sim::gym_level());
    assert!(runs.iter().all(|r| r.hi.y == BAND_TOP && r.lo.y == 0.0), "a run does not span 0..BAND_TOP");
}

/// A LEVEL COMPILES OR SAYS WHY. A world point that hits no run, or two
/// names on one run, is an authoring mistake that must fail loudly — the
/// version this replaces printed a line to stderr and rendered the wall
/// unaged, so "the effect I asked for is not in the shot" had no cause.
#[test]
fn a_missed_or_duplicated_wall_is_an_error() {
    let runs = runs_of(&house_game::gym::sim::gym_level());
    static MISS: [WallAt; 1] = [WallAt::pristine((99.0, 99.0), "nowhere")];
    static DUP: [WallAt; 2] = [WallAt::pristine((13.0, 10.0), "a"), WallAt::pristine((14.0, 10.0), "b")];
    let lw = |w: &'static [WallAt]| LevelWear { base: Story::ZERO, spread: 0.0, walls: w };
    assert!(matches!(compile(&runs, &lw(&MISS)), Err(ref m) if matches!(m[0], Miss::NoWall { .. })));
    assert!(matches!(compile(&runs, &lw(&DUP)), Err(ref m) if matches!(m[0], Miss::Duplicate { .. })), "two names on the z=10 garden wall must collide");
    // …and a clean level compiles, one sheet per run
    static OK: [WallAt; 1] = [WallAt::pristine((13.0, 10.0), "control")];
    let sheets = compile(&runs, &lw(&OK)).expect("a clean level compiles");
    assert_eq!(sheets.len(), runs.len(), "one sheet per run");
    assert_eq!(sheets.iter().filter(|s| s.label == "control").count(), 1);
}

/// A DIAL THE GEOMETRY CANNOT HONOUR IS CLAMPED AND SAID SO — never
/// silently obeyed-ish. The relief knob's top would leave a spalling wall no
/// core to hold its reinforcement mat, and what used to happen is that the
/// steel simply stopped appearing, with nothing anywhere saying why (it was
/// written up as an "honest limit" in the module docs, which is not the same
/// as telling the person holding the slider).
///
/// Both halves are pinned, because a cap that fires when it should not is
/// the same defect the other way round: a wall with no spall keeps the whole
/// travel, since the constraint belongs to the effect that needs the core.
#[test]
fn a_relief_past_the_cap_is_clamped_and_said() {
    let runs = runs_of(&house_game::gym::sim::gym_level());
    const DEEP: Shape = Shape { relief: 1.0, ..Shape::DEFAULT };
    const WALLS: [WallAt; 2] = [
        WallAt { at: (13.0, 10.0), label: "deep and spalling", spec: WallSpec { story: Story { weather: 0.0, settlement: 0.0, cover_loss: 1.0 }, shape: DEEP, ..WallSpec::PRISTINE } },
        WallAt { at: (12.0, 4.0), label: "deep and sound", spec: WallSpec { story: Story { weather: 0.9, settlement: 0.0, cover_loss: 0.0 }, shape: DEEP, ..WallSpec::PRISTINE } },
    ];
    let lw = LevelWear { base: Story::ZERO, spread: 0.0, walls: &WALLS };
    let sheets = compile(&runs, &lw).expect("a clamp is not a compile error — the wall renders");
    let of = |label: &str| sheets.iter().find(|s| s.label == label).expect("both named walls compiled").clone();

    // the spalling wall is capped, and the note carries both numbers
    let spalling = of("deep and spalling");
    let thick = runs[sheets.iter().position(|s| s.label == "deep and spalling").unwrap()].thick();
    assert!(wear_core::rebar::t_cap(thick) < veneer(1.0, thick), "VACUOUS: relief 1.0 already fits the mat on a {thick}-wu wall");
    let note = spalling.notes.iter().find(|m| matches!(m, Miss::Clamped { .. })).unwrap_or_else(|| panic!("relief 1.0 on a spalling wall was obeyed silently: {:?}", spalling.notes));
    let Miss::Clamped { dial, asked, used, .. } = note else { unreachable!() };
    assert_eq!(*dial, "relief");
    assert_eq!(*asked, 1.0);
    assert!(*used < 1.0 && *used > 0.8, "the cap should cost the top of the slider, not most of it: {used:.3}");
    assert!(veneer(*used, thick) <= wear_core::rebar::t_cap(thick) + 1e-6, "the clamped relief still leaves the mat nowhere to sit");
    assert_eq!(spalling.geom.relief, (used * 63.0).round() as u8, "the note says one thing and the geometry gets another");

    // …and the identical relief on a wall with no cover loss is untouched:
    // the constraint belongs to the effect that needs the core, not to the
    // relief dial in general
    let sound = of("deep and sound");
    assert!(sound.notes.iter().all(|m| !matches!(m, Miss::Clamped { .. })), "a wall with no cover loss was capped: {:?}", sound.notes);
    assert_eq!(sound.geom.relief, 63, "…and it keeps the whole travel");
}

/// `Geom` IS THE REBUILD GATE: all-integer, so equality means "the built
/// mesh is still right". Pinned both ways — a dial move inside one
/// quantization step must NOT dirty it, and a move across one must.
#[test]
fn geom_is_integer_and_moves_only_when_the_mesh_would() {
    let runs = runs_of(&house_game::gym::sim::gym_level());
    let g = |grain: f32| {
        static W: [WallAt; 0] = [];
        let lw = LevelWear { base: Story { weather: 0.8, ..Story::ZERO }, spread: 0.0, walls: &W };
        let mut s = compile(&runs, &lw).expect("compiles");
        s[0].geom.grain = (grain.clamp(0.0, 1.0) * 63.0).round() as u8;
        s[0].geom
    };
    assert_eq!(g(0.500), g(0.505), "a sub-quantum move dirtied the geometry");
    assert_ne!(g(0.500), g(0.530), "a real move did not dirty the geometry");
}
