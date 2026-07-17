//! The gym greybox, built straight from the sim's `Grid` (cells hold ground,
//! EDGES hold walls). The same grid drives sim collision and these visuals,
//! so what blocks the walk blocks the eye — by construction.
//!
//! Greybox discipline (owner directive): colored boxes only, one grid cell =
//! 1 wu, ARCHITECTURE XZ dims on the 0.1-wu grid — the trimetric preset's
//! clean-stair lattice (1/10 wu along X, 1/20 along Z; see
//! `Projection::clean_xz`). No grid is clean under BOTH presets: tenths show
//! mixed treads under the iso21 A/B reference — the game projection wins.
//! The PLAYER body still sits on the legacy 1/16 lattice: it is animated
//! (treads invisible in motion) and Faza 2 rebuilds it anyway. Wall slabs
//! are 0.2 wu thick, centred on the shared edge; the building's roof is an
//! occluding cap. Occlusion is the dollhouse WALLCUT: outdoors the building
//! stands whole; indoors every occluder drops to sill height (`WALL_CUT_H`).
//!
//! The AESTHETIC is data: a [`Look`] preset (look.rs; Faza 1b) supplies
//! every colour, the lamp mood, the lighting env, the sun/sky and the
//! dress switches. The 2026-07-12 BLOCKY rebuild (owner directive:
//! prostsze kształty, blokowość jak tecta — the concept monolith) keeps
//! every mesh the fewest axis-aligned boxes that read: walls are clean
//! full-height slabs (no plinth) with a FULL-HEIGHT tinted-glass window
//! only every so often (even-coordinate cells) — REAL openings holding
//! transmissive panes ("black tinted but transparent", see
//! `wall_slab`/`mark_glass`); the roof is ONE inset cap per run (a stepped
//! parapet, no fascia/ridge); lamps are a post + one hanging lantern
//! block; grass tufts are single blocks. Green/organic surfaces are MATTE
//! ([`mark_matte`]): the shade pass skips specular there, so the ceramic
//! sheen stays on porcelain and glass only — grass never shines.
//!
//! NEE discipline: the ONLY named lights are the spec lamps (conceptual point
//! lights). Every emissive box (lamp fixtures) is part of a dynamic run,
//! which the light scan and probe bake exclude — so the light-join stays
//! complete without naming dressing.

use crate::look::Look;
use glam::{Mat4, Vec3};
use house_game::gym::grid::{CellKind, CellPos, Dir, EdgeKind, Grid};
use house_game::gym::sim::GymLevel;
use rt_probe::{hex_linear, Scene};

/// Wall height (the building's occluding shell).
pub const WALL_TOP: f32 = 2.1875;
/// The WALLCUT sill-height cutaway plane: while the player is indoors, walls
/// drop to this height, bodies stay whole.
pub const WALL_CUT_H: f32 = 1.0;

const FLOOR_TOP: f32 = 6.0 / 128.0;
const WALL_HT: f32 = 0.1; // wall half-thickness (0.2 wu slab, on the 0.1 grid)
// The cap is SUNK into the wall band (base below WALL_TOP): its side faces
// hide inside the slabs below the wall top and step back cleanly above it.
const ROOF_BASE: f32 = 2.0;
const ROOF_TOP: f32 = 2.5;

/// Flag a primitive's material as a see-through OCCLUDER (Material._pad
/// bit 1), the bit the shade pass reads to know a primary-ray hit is a wall
/// the ROI reveal / WALLCUT may dissolve. `add_box_world` mints one material
/// per box, so this targets exactly this box. Floors and bodies stay 0.
fn mark_occluder(scene: &mut Scene, prim: usize) {
    let mid = scene.primitives[prim].material_id as usize;
    scene.materials[mid]._pad |= 1;
}

/// Additionally flag a primitive's material as tinted GLASS (Material._pad
/// bit 2): the shade pass carries the primary ray THROUGH the pane,
/// multiplying its base colour in as a transmission tint and adding the
/// porcelain sheen (sun key + fresnel sky) — black tinted but transparent
/// (owner directive 2026-07-12). Shadow rays and the probe bake keep glass
/// opaque, so the panes block light like the walls they sit in. Combine
/// with [`mark_occluder`] on window panes: the WALLCUT/ROI must take the
/// glass together with its wall.
fn mark_glass(scene: &mut Scene, prim: usize) {
    let mid = scene.primitives[prim].material_id as usize;
    scene.materials[mid]._pad |= 2;
}

/// Flag a primitive's material MATTE (Material._pad bit 4): the shade pass
/// skips the specular terms and the gloss roughness-remap, so the material's
/// authored roughness stands. Green/organic surfaces wear it (grass floor,
/// tufts) — the look's ceramic sheen stays on porcelain and glass only
/// (owner directive 2026-07-12: grass must not shine).
fn mark_matte(scene: &mut Scene, prim: usize) {
    let mid = scene.primitives[prim].material_id as usize;
    scene.materials[mid]._pad |= 4;
}

/// World centre of a grid cell (on the ground plane).
pub fn cell_world(p: CellPos) -> Vec3 {
    Vec3::new(p.x as f32 + 0.5, FLOOR_TOP, p.z as f32 + 0.5)
}

/// Build the renderable greybox for the gym in the given look. `roof` gates the
/// building's roof caps — the dynamic-GI spike tears the roof off at runtime
/// (rebuild with `roof=false` + re-bake) to flood the interior with light.
/// Stage-2 tear-off targets, returned alongside the built gym: the roof
/// primitive indices (to hide from the TLAS at runtime) and the interior world
/// AABB whose probes a tear-off refreshes (the Room footprint × floor→roof).
/// `roof_prims` is empty when `roof == false` (nothing to tear) or the level
/// has no Room cells.
pub struct GymMeta {
    pub roof_prims: std::ops::Range<usize>,
    pub room_min: Vec3,
    pub room_max: Vec3,
    /// Every solid wall segment (a windowed run's piers, a plain run's whole
    /// slab), one box prim each — the wall-smash tear-off targets (phase 3).
    pub piers: Vec<Pier>,
}

/// One tearable wall segment: its prim (to TLAS-mask), its world AABB (the
/// brick layout + probe-refresh region) and the parent run's slab AABB (the
/// surviving flanks become invisible physics colliders).
pub struct Pier {
    pub prim: usize,
    pub lo: Vec3,
    pub hi: Vec3,
    pub run_lo: Vec3,
    pub run_hi: Vec3,
}

impl GymMeta {
    /// The pier containing a world point (the demo names a breach point, the
    /// meta resolves which wall segment that is after any rebuild).
    pub fn pier_at(&self, p: Vec3) -> Option<&Pier> {
        self.piers.iter().find(|q| q.lo.cmple(p).all() && q.hi.cmpge(p).all())
    }
}

pub fn build_gym(spec: &GymLevel, look: &Look, roof: bool) -> (Scene, GymMeta) {
    let mut scene = Scene::new();
    let g = &spec.grid;
    let (w, h) = (g.w, g.h);
    // Room world AABB (footprint × floor→roof) — the tear-off refresh region.
    let (mut room_min, mut room_max) = (Vec3::splat(f32::INFINITY), Vec3::splat(f32::NEG_INFINITY));
    for z in 0..h {
        for x in 0..w {
            if g.cell(CellPos::new(x, z)) == CellKind::Room {
                room_min = room_min.min(Vec3::new(x as f32, FLOOR_TOP, z as f32));
                room_max = room_max.max(Vec3::new(x as f32 + 1.0, ROOF_TOP, z as f32 + 1.0));
            }
        }
    }
    if !room_min.x.is_finite() {
        (room_min, room_max) = (Vec3::ZERO, Vec3::ZERO); // no Room cells
    }
    let mut piers: Vec<Pier> = Vec::new();

    // ---- floors: one quad per row-run of same (tint, matte) key (cheap prim
    // merge; a checker look breaks field rows into per-cell quads — fine at
    // gym scale). Outdoor grass is MATTE; the Room floor keeps the sheen.
    for z in 0..h {
        let mut x = 0i16;
        while x < w {
            let key = floor_key(g, CellPos::new(x, z), look);
            let x0 = x;
            while x < w && floor_key(g, CellPos::new(x, z), look) == key {
                x += 1;
            }
            let prim = scene.primitives.len();
            scene.add_floor(x0 as f32, x as f32, z as f32, z as f32 + 1.0, FLOOR_TOP, hex_linear(key.0));
            if key.1 {
                mark_matte(&mut scene, prim);
            }
        }
    }

    // ---- walls: merge consecutive wall edges along each boundary line.
    // Runs also split where BUILDING-ness changes: window slots go only on
    // walls bounding a Room (the building facade); freestanding garden
    // walls stay clean porcelain panels (owner directive 2026-07-12).
    let roomy = |p: Option<CellPos>| p.is_some_and(|p| g.in_bounds(p) && g.cell(p) == CellKind::Room);
    // Z-boundaries (edges between (x,z-1) and (x,z), drawn per cell's Zm):
    for z in 0..h {
        let zroomy = |x: i16| roomy(Some(CellPos::new(x, z))) || (z > 0 && roomy(Some(CellPos::new(x, z - 1))));
        let mut x = 0i16;
        while x < w {
            if g.edge(CellPos::new(x, z), Dir::Zm) == EdgeKind::Wall {
                let (x0, rm) = (x, zroomy(x));
                while x < w && g.edge(CellPos::new(x, z), Dir::Zm) == EdgeKind::Wall && zroomy(x) == rm {
                    x += 1;
                }
                wall_slab(&mut scene, &mut piers, [x0 as f32 - WALL_HT, z as f32 - WALL_HT, x as f32 + WALL_HT, z as f32 + WALL_HT], true, rm, look);
            } else {
                x += 1;
            }
        }
    }
    // X-boundaries (per cell's Xm):
    for x in 0..w {
        let xroomy = |z: i16| roomy(Some(CellPos::new(x, z))) || (x > 0 && roomy(Some(CellPos::new(x - 1, z))));
        let mut z = 0i16;
        while z < h {
            if g.edge(CellPos::new(x, z), Dir::Xm) == EdgeKind::Wall {
                let (z0, rm) = (z, xroomy(z));
                while z < h && g.edge(CellPos::new(x, z), Dir::Xm) == EdgeKind::Wall && xroomy(z) == rm {
                    z += 1;
                }
                wall_slab(&mut scene, &mut piers, [x as f32 - WALL_HT, z0 as f32 - WALL_HT, x as f32 + WALL_HT, z as f32 + WALL_HT], false, rm, look);
            } else {
                z += 1;
            }
        }
    }

    // ---- roof: an occluding cap over every Room cell (merged per row).
    // Visible from outside (the building reads as a building); the WALLCUT
    // indoor cutaway dissolves it the moment the player steps inside. Gated by
    // `roof` so the dynamic-GI spike can tear it off and re-bake.
    let roof_first = scene.primitives.len();
    if roof {
        for z in 0..h {
            let mut x = 0i16;
            while x < w {
                if g.cell(CellPos::new(x, z)) == CellKind::Room {
                    let x0 = x;
                    while x < w && g.cell(CellPos::new(x, z)) == CellKind::Room {
                        x += 1;
                    }
                    roof_run(&mut scene, x0 as f32, x as f32, z as f32, look);
                } else {
                    x += 1;
                }
            }
        }
    }
    let roof_prims = roof_first..scene.primitives.len();

    // ---- lamps: the spec's lamp cells, as NAMED conceptual point lights
    // (the ONLY named lights — the mirror join sees exactly these) + an
    // unnamed fixture post per lamp, registered as a never-patched dynamic
    // run so its glow head stays out of the NEE scan and probe bake.
    for (i, (cell, intensity)) in spec.lights.iter().enumerate() {
        let c = cell_world(*cell);
        let s = 620.0 * (*intensity as f32 / 8.0) * look.lamp_scale;
        // The conceptual light must have CLEAR AIR toward the ground: NEE
        // shadow rays see the fixture (a dynamic run), so the light hangs
        // UNDER the bracket-arm lantern, where a real luminaire emits.
        scene.point_lights.push([c.x + 0.3, 1.40625, c.z, 0.25, s * look.lamp_tint[0], s * look.lamp_tint[1], s * look.lamp_tint[2], 0.0]);
        scene.name_point_light(&format!("lamp_{i}"), scene.point_lights.len() - 1);
        let first = scene.primitives.len();
        // blocky fixture (2026-07-12 rebuild): a slim post and ONE chunky
        // lantern block straddling its top — the block swallows the post
        // top (no coplanar faces) and overhangs +x, with the conceptual
        // light in the clear air under the overhang (position unchanged
        // from the old bracket-arm rig, so the lighting stands still).
        scene.add_box_world(Vec3::new(c.x - 0.05, 0.0, c.z - 0.05), Vec3::new(c.x + 0.05, 1.6875, c.z + 0.05), look.lamp_post, [0.0; 4], 0.6, 0.0);
        scene.add_box_world(Vec3::new(c.x - 0.1, 1.5, c.z - 0.15), Vec3::new(c.x + 0.4, 1.75, c.z + 0.15), look.lamp_head, look.lamp_glow, 0.4, 0.0);
        scene.register_dynamic(&format!("lamp_fix_{i}"), first, scene.primitives.len() - first, Mat4::IDENTITY);
    }

    // ---- lush-nature dress: grass tufts over the Outdoor cells
    if let Some(greens) = look.grass {
        grass_dress(&mut scene, spec, greens);
    }

    scene.recompute_bounds();

    // ---- dynamics (after recompute_bounds, local space): the player body.
    build_player_body(&mut scene, look);

    scene.floor_rect = [0.0, 0.0, w as f32, h as f32];
    scene.solids = Vec::new(); // collision is the sim's grid, not AABBs
    scene.player_start = cell_world(spec.player_start);
    scene.lighting = look.lighting;
    scene.sun_sky = look.sun; // sun/sky-as-data (Faza 1b)
    (scene, GymMeta { roof_prims, room_min, room_max, piers })
}

/// Floor-run merge key: (tint, matte). Outdoor cells are the meadow — matte
/// by construction; the Room floor is porcelain and keeps the look's sheen.
fn floor_key(g: &Grid, p: CellPos, look: &Look) -> (u32, bool) {
    match g.cell(p) {
        CellKind::Outdoor => match look.street_alt {
            // cobble checker: per-cell parity split (breaks the row merge)
            Some(alt) if (p.x + p.z) & 1 == 1 => (alt, true),
            _ => (look.street, true),
        },
        CellKind::Room => (look.room_floor, false),
    }
}

/// One wall run. A windowless run (freestanding garden walls, and every run
/// when the look has no windows) is a single merged porcelain slab — since
/// the blocky rebuild there is NO plinth: the slab runs clean floor-to-top.
/// On BUILDING walls (`windows`) the look's window turns SOME cells into
/// REAL full-height openings (owner refinement 2026-07-12: porcelain panels
/// with a window only every so often, "black tinted but transparent"): the
/// slab becomes piers between openings, and each opening holds a
/// tinted-GLASS pane the shade pass transmits through. The rhythm is
/// anchored to EVEN world coordinates — not run-relative — so the doorway
/// split doesn't shift it; on the gym building (cells 3..=7) that gives two
/// symmetric windows per facade and one flanking each side of the doorway.
/// `along_x` says which axis the run spans.
fn wall_slab(scene: &mut Scene, piers: &mut Vec<Pier>, rect: [f32; 4], along_x: bool, windows: bool, look: &Look) {
    let wc = hex_linear(look.wall);
    let (a0, a1) = if along_x { (rect[0], rect[2]) } else { (rect[1], rect[3]) };
    let (run_lo, run_hi) = (Vec3::new(rect[0], 0.0, rect[1]), Vec3::new(rect[2], WALL_TOP, rect[3]));
    // window centres: even-coordinate cells (the run bounds are cell
    // coordinates ± WALL_HT, so round() recovers the integers exactly)
    let mut mids: Vec<f32> = Vec::new();
    if windows && look.window.is_some() {
        let mut c = (a0 + WALL_HT).round();
        while c + 1.0 <= a1 - WALL_HT + 0.001 {
            if (c as i32) % 2 == 0 {
                mids.push(c + 0.5);
            }
            c += 1.0;
        }
    }
    // COPLANARITY RULE (2026-07-12 white-flicker post-mortem): dress with a
    // DIFFERENT colour must never share a face plane with its host — offset
    // by a whole lattice step, inward or outward. Two coplanar faces of
    // different colours ray-z-fight: the per-pixel winner flips on sub-pixel
    // camera motion and the losing colour strobes through.
    //
    // piers: full-height slabs between the openings (openings are mid±0.2 —
    // 0.4 wide, clean on both stair axes; every pier length stays a 0.1
    // multiple: cell pitch 2.0 − opening 0.4 = 1.6, run ends add ±(0.3+0.1)).
    let mut s = a0;
    for stop in mids.iter().map(|m| Some(*m)).chain([None]) {
        let e = stop.map_or(a1, |m| m - 0.2);
        let first = scene.primitives.len();
        let (lo, hi) = if along_x {
            (Vec3::new(s, 0.0, rect[1]), Vec3::new(e, WALL_TOP, rect[3]))
        } else {
            (Vec3::new(rect[0], 0.0, s), Vec3::new(rect[2], WALL_TOP, e))
        };
        scene.add_box_world(lo, hi, wc, [0.0; 4], 0.85, 0.0);
        mark_occluder(scene, first);
        piers.push(Pier { prim: first, lo, hi, run_lo, run_hi });
        s = stop.map_or(a1, |m| m + 0.2);
    }
    // glass panes: one per opening, floor to 0.0625 above the wall top and
    // proud of the slab by 0.05 each side (no coplanar faces); the pane is
    // 0.6 wide — buried a full 0.1 lattice step into each pier — so its
    // side faces never share the opening's jamb planes. The base colour is
    // the TRANSMISSION tint (mark_glass); glass-smooth roughness keeps the
    // look's spec/gloss sheen on the front face.
    if let Some(hexw) = look.window {
        let gc = hex_linear(hexw);
        for &mid in &mids {
            let first = scene.primitives.len();
            let (lo, hi) = if along_x {
                (Vec3::new(mid - 0.3, 0.0, rect[1] - 0.05), Vec3::new(mid + 0.3, WALL_TOP + 0.0625, rect[3] + 0.05))
            } else {
                (Vec3::new(rect[0] - 0.05, 0.0, mid - 0.3), Vec3::new(rect[2] + 0.05, WALL_TOP + 0.0625, mid + 0.3))
            };
            scene.add_box_world(lo, hi, gc, [0.0; 4], 0.15, 0.0);
            mark_occluder(scene, first);
            mark_glass(scene, first);
        }
    }
}

/// Deterministic per-cell hash for the grass dress — a pure function of the
/// cell coords (no RNG state anywhere; the sim never sees these boxes).
fn cell_hash(x: i16, z: i16) -> u32 {
    let mut h = (x as u32).wrapping_mul(0x9E37_79B9) ^ (z as u32).wrapping_mul(0x85EB_CA6B);
    h ^= h >> 13;
    h = h.wrapping_mul(0xC2B2_AE35);
    h ^ (h >> 16)
}

/// Lush-nature dress (owner directive 2026-07-12; blocky rebuild same day):
/// ONE low grass-tuft block on ~1/4 of the Outdoor cells, hash-placed on
/// the clean stair lattice (X: 0.1, Z: 0.05 steps), three green tints,
/// MATTE (grass never shines). Tufts are walk-through visuals (grass), low
/// enough that the player wading through them reads as walking in grass;
/// bases sink to y=0 so no face lies ON the floor plane (coplanarity
/// rule). Lamp cells and the spawn cell stay clear.
fn grass_dress(scene: &mut Scene, spec: &GymLevel, greens: [u32; 3]) {
    let g = &spec.grid;
    for z in 0..g.h {
        for x in 0..g.w {
            let p = CellPos::new(x, z);
            if g.cell(p) != CellKind::Outdoor || p == spec.player_start || spec.lights.iter().any(|(c, _)| *c == p) {
                continue;
            }
            let h = cell_hash(x, z);
            if !h.is_multiple_of(4) {
                continue;
            }
            let ox = 0.1 + 0.1 * ((h >> 8) % 6) as f32; //  0.1..0.6
            let oz = 0.1 + 0.05 * ((h >> 16) % 12) as f32; // 0.1..0.65
            let ht = 0.09375 + 0.03125 * ((h >> 4) % 3) as f32;
            let tint = hex_linear(greens[((h >> 24) % 3) as usize]);
            let (cx, cz) = (x as f32 + ox, z as f32 + oz);
            let prim = scene.primitives.len();
            scene.add_box_world(Vec3::new(cx, 0.0, cz), Vec3::new(cx + 0.2, ht, cz + 0.15), tint, [0.0; 4], 0.9, 0.0);
            mark_matte(scene, prim);
        }
    }
}

/// One merged roof run: a SINGLE flat cap per row (blocky rebuild — no
/// fascia, no ridge). The cap spans the cell lines exactly, one lattice
/// step (0.1) inside the wall outer faces, and its base sits BELOW the wall
/// top: the side faces hide inside the wall slabs up to WALL_TOP and step
/// back cleanly above it — the building reads as a monolith with a stepped
/// parapet cap, and no face is coplanar with a wall plane. Occluder-marked
/// (the WALLCUT must take it) with the whole visible band above the cutaway.
fn roof_run(scene: &mut Scene, x0: f32, x1: f32, z: f32, look: &Look) {
    let first = scene.primitives.len();
    scene.add_box_world(Vec3::new(x0, ROOF_BASE, z), Vec3::new(x1, ROOF_TOP, z + 1.0), hex_linear(look.roof), [0.0; 4], 0.85, 0.0);
    mark_occluder(scene, first);
}

// ---- the player body --------------------------------------------------------
//
// One ARTICULATED blocky figure (~1.4 wu tall; 2026-07-12 rebuild — the
// fewest boxes that read) built from five dynamic runs — core (one torso
// block + head + hood cap + nose), `player/legL`, `/legR` (leg block +
// boot band, authored around the HIP pivot) and `player/armL`, `/armR`
// (one sleeve block, authored around the SHOULDER pivot) — so the loop
// can swing limbs per tick (deterministic walk cycle). Limb geometry is
// authored in PIVOT space: the loop's instance transform is
// `body * translate(pivot) * swing`, so a zero swing reproduces the rest
// pose exactly. The nose wedge makes facing read even axis-aligned.

/// Hip pivot height + lateral leg offset; shoulder pivot height + lateral
/// arm offset. The loop's limb transforms must use the SAME numbers.
pub const HIP: f32 = 0.46875;
pub const LEG_X: f32 = 0.0625;
pub const SHOULDER: f32 = 1.0;
pub const ARM_X: f32 = 0.1875;

fn build_player_body(scene: &mut Scene, look: &Look) {
    let coat = look.coat;
    // ---- core: one torso block, head, hood cap, nose. The torso base dips
    // 0.03125 below HIP so the leg tops (world HIP + 0.03125) stay buried
    // inside it through the swing — no coplanar interfaces.
    let first = scene.primitives.len();
    part(scene, 0.15625, 0.125, HIP - 0.03125, SHOULDER + 0.0625, coat); // torso
    part(scene, 0.09375, 0.09375, 1.0625, 1.28125, look.skin); // head
    part(scene, 0.125, 0.125, 1.25, 1.40625, look.hood); // hood cap
    // nose wedge on +Z at the head's face plane (facing read)
    scene.add_box_world(Vec3::new(-0.03125, 1.125, 0.09375), Vec3::new(0.03125, 1.21875, 0.15625), look.skin, [0.0; 4], 0.8, 0.0);
    scene.register_dynamic("player", first, scene.primitives.len() - first, Mat4::from_scale(Vec3::ZERO));

    // ---- legs: one leg block + a boot band, hanging from the hip pivot
    // (geometry centred on x — the pivot translation supplies ±LEG_X)
    for suffix in ["legL", "legR"] {
        let first = scene.primitives.len();
        scene.add_box_world(Vec3::new(-0.0625, -HIP + 0.09375, -0.0625), Vec3::new(0.0625, 0.03125, 0.0625), look.legs, [0.0; 4], 0.6, 0.0);
        scene.add_box_world(Vec3::new(-0.0625, -HIP, -0.0625), Vec3::new(0.0625, -HIP + 0.09375, 0.0625), look.boots, [0.0; 4], 0.6, 0.0);
        scene.register_dynamic(&format!("player/{suffix}"), first, scene.primitives.len() - first, Mat4::from_scale(Vec3::ZERO));
    }

    // ---- arms: ONE sleeve block from the shoulder pivot, long enough to
    // read as arm + hand; its inner face sinks 0.03125 into the torso side
    // (overlap, never coplanar) so the silhouette stays joined mid-swing.
    for suffix in ["armL", "armR"] {
        let first = scene.primitives.len();
        scene.add_box_world(Vec3::new(-0.0625, -0.53125, -0.0625), Vec3::new(0.0625, 0.03125, 0.0625), coat, [0.0; 4], 0.6, 0.0);
        scene.register_dynamic(&format!("player/{suffix}"), first, scene.primitives.len() - first, Mat4::from_scale(Vec3::ZERO));
    }
}

fn part(scene: &mut Scene, hx: f32, hz: f32, y0: f32, y1: f32, color: [f32; 4]) {
    scene.add_box_world(Vec3::new(-hx, y0, -hz), Vec3::new(hx, y1, hz), color, [0.0; 4], 0.6, 0.0);
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::look::LOOKS;
    use house_game::gym::sim::gym_level;

    /// EVERY look preset produces the five player runs the loop patches —
    /// and keeps the NEE discipline (the only named lights are the spec
    /// lamps; dressing stays in dynamic runs / non-emissive statics).
    #[test]
    fn every_look_registers_the_player_runs_and_lamps_only() {
        for look in LOOKS {
            let spec = gym_level();
            let (scene, _) = build_gym(&spec, look, true);
            for name in ["player", "player/legL", "player/legR", "player/armL", "player/armR"] {
                assert!(scene.dynamics.iter().any(|(n, ..)| n == name), "{}: missing run {name}", look.name);
            }
            // the only NEE lights are the named lamps
            let scan = rt_probe::scan_lights(&scene).unwrap();
            assert_eq!(scan.light_count as usize, spec.lights.len(), "{}: lamps only — dressing must stay in dynamic runs", look.name);
            assert_eq!(scan.names.len(), spec.lights.len());
        }
    }

    /// Roof dressing (every look) sits fully above the WALLCUT plane and is
    /// occluder-marked — the indoor cutaway must take the whole cap.
    #[test]
    fn roof_boxes_are_occluders_above_the_wallcut() {
        for look in LOOKS {
            let mut scene = Scene::new();
            roof_run(&mut scene, 0.0, 4.0, 0.0, look);
            for p in 0..scene.primitives.len() {
                let prim = scene.primitives[p];
                let base = (0..prim.vertex_count).map(|i| scene.vertices[(prim.vertex_offset + i) as usize].pos[1]).fold(f32::INFINITY, f32::min);
                assert!(base > WALL_CUT_H, "{}: roof box base {base} under the cutaway plane", look.name);
                assert_eq!(scene.materials[prim.material_id as usize]._pad, 1, "{}: roof box not occluder-marked", look.name);
            }
        }
    }

    /// The wall-smash demo's breach point resolves to the east facade's
    /// middle pier: a full-height 0.2-thick slab between the two windows,
    /// occluder-marked (the tear masks a wall, not dressing), inside its
    /// parent run — the layout `phys_spike::wall_bricks` decomposes.
    #[test]
    fn east_facade_middle_pier_is_the_smash_target() {
        let spec = gym_level();
        let (scene, meta) = build_gym(&spec, &crate::look::DUSK, true);
        let pier = meta.pier_at(Vec3::new(8.0, 1.0, 5.5)).expect("breach point must land in a pier");
        assert_eq!((pier.lo.x, pier.hi.x), (7.9, 8.1), "0.2-wu slab on the x=8 boundary");
        assert_eq!((pier.lo.y, pier.hi.y), (0.0, WALL_TOP), "full height");
        assert!((pier.lo.z - 4.7).abs() < 1e-4 && (pier.hi.z - 6.3).abs() < 1e-4, "between the two windows: {:?}..{:?}", pier.lo, pier.hi);
        assert_eq!(scene.materials[scene.primitives[pier.prim].material_id as usize]._pad, 1, "the pier is a plain occluder wall box");
        assert!(pier.run_lo.z < pier.lo.z && pier.run_hi.z > pier.hi.z, "flanks survive on both sides");
    }

    /// The indoor cutaway plane sits below the wall tops (they dissolve to
    /// stubs) and above a lamp pedestal (furnishing-height dressing stays).
    #[test]
    #[allow(clippy::assertions_on_constants)] // a deliberate constants-relationship pin
    fn wall_cut_sits_below_wall_tops() {
        assert!(WALL_CUT_H < WALL_TOP, "walls must drop to stubs indoors");
        assert!(WALL_CUT_H > 0.25, "ground-level dressing survives the cutaway");
    }
}
