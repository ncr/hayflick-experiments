//! tilehouse — a RULE-BASED house generator on a tile grid (the pivot away from
//! rectangle partitioning). Rooms live as cells in an owner grid, so they need
//! NOT be rectangular: a bedroom wraps L-shaped around its carved-in ensuite and
//! the whole house can be an L/T of offset masses, the way real plans read.
//!
//! Pipeline (one grid cell = 0.6 m), each pass keyed to a rule in the catalog at
//! `/tmp/floorplans/rules/house_rules_catalog.md`:
//!   * SKELETON — a circulation spine, one of three topologies (C2/C5):
//!       straight · L (90° turn) · loop (a ring with no dead-ends).
//!   * FOOTPRINT — the bedroom wing is blitted into a wider house whose public
//!       band juts past it (offset masses → L/T), optionally with an attached
//!       garage (A4).
//!   * ZONING / ADJACENCY — bedrooms off the spine; open public zone where the
//!       dining touches both living and kitchen (A1/A2); a service core in loops
//!       split into bath/laundry/storage (A11).
//!   * FEATURE / PRODUCTION RULES — master suite ensuite + wardrobe (A6); powder
//!       room by the entry (A7); windows on habitable rooms + corridor dead-ends
//!       (C6/W1/W3); furniture sized & drawn to fit clearances (F1/F2/F3).
//!   * VERIFICATION — egress (W5), bath access (A5), furniture-fit are checked and
//!       logged per house; carves are hold-by-construction so they never fire.
//!
//! Output is a true tilemap render: semantic room colours, derived walls, doors
//! (orange), windows (cyan), furniture. `cargo run -p house-game --bin tilehouse -- <dir> [n] [seed0]`.

use house_game::mapviz::{montage, Canvas};
use std::collections::HashSet;

// fixed canvas grid so every seed's tile is the same size (montage-friendly);
// wide enough for the largest loop footprint plus offset-mass juts and a garage
const GW: i32 = 48;
const GH: i32 = 38;
const PX: i32 = 14;
const MARGIN: i32 = 8;
const HDR: i32 = 34;

// One grid cell = 0.6 m. Chosen so the ~0.6 m / 24 in ergonomic clearance module
// (walkway, counter depth) is exactly one cell — furniture-fit rules quantize
// cleanly. Corridor 2 cells = 1.2 m (comfortable two-person, C1).
const CELL_M: f32 = 0.6;

struct Rng(u64);
impl Rng {
    fn next_u64(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9E37_79B9_7F4A_7C15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        z ^ (z >> 31)
    }
    fn range(&mut self, lo: i32, hi: i32) -> i32 {
        lo + (self.next_u64() % (hi - lo).max(1) as u64) as i32
    }
    fn chance(&mut self, n: u64, d: u64) -> bool {
        self.next_u64() % d < n
    }
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Kind {
    Corridor,
    Foyer,
    Living,
    Kitchen,
    Dining,
    Bedroom,
    Master,
    Bath,
    Powder,
    Wardrobe,
    Laundry,
    Storage,
    Garage,
}
use Kind::*;

impl Kind {
    fn color(self) -> [u8; 3] {
        match self {
            Corridor => [120, 126, 142],
            Foyer => [205, 200, 192],
            Living => [226, 178, 120],
            Kitchen => [142, 182, 236],
            Dining => [152, 210, 140],
            Bedroom => [182, 170, 236],
            Master => [206, 158, 232],
            Bath => [120, 212, 206],
            Powder => [120, 200, 168],
            Wardrobe => [230, 150, 200],
            Laundry => [150, 196, 198],
            Storage => [176, 170, 150],
            Garage => [150, 152, 162],
        }
    }
    fn label(self) -> &'static str {
        match self {
            Corridor => "",
            Foyer => "FOY",
            Living => "LIV",
            Kitchen => "KIT",
            Dining => "DIN",
            Bedroom => "BED",
            Master => "MBED",
            Bath => "WC",
            Powder => "PWD",
            Wardrobe => "WDR",
            Laundry => "LDY",
            Storage => "STO",
            Garage => "GAR",
        }
    }
    /// Habitable rooms get exterior windows; service/wet/circulation do not.
    fn wants_window(self) -> bool {
        matches!(self, Living | Kitchen | Dining | Bedroom | Master)
    }
    /// F1/F2/F3: the clear envelope (furniture footprint + ergonomic clearance
    /// band) the room must contain, in cells (CELL_M = 0.6 m). Derived:
    ///   bedroom  queen 1.52×2.03 + 0.61 walk each side + 0.76 at foot → 2.74×2.79 → 5×5
    ///   master   king  1.93×2.03 + same                              → 3.15×2.79 → 6×5
    ///   dining   table 0.9×1.5 + 0.91 clear each seated side         → 2.72×3.32 → 5×6
    ///   kitchen  galley 0.61 + 1.07 aisle + 0.61 counter, length run → 2.29×~2.4 → 4×4
    ///   living   sofa group + walk-around, ≈ S5 150 ft² floor        → 6×6
    ///   bath     full 1.5×2.4 (tub+toilet+sink)                      → 3×4
    /// Returned unoriented: a room passes if its largest rectangle holds the box
    /// either way round. None = no furniture-fit gate (foyer/corridor/wardrobe).
    fn fit_box(self) -> Option<(i32, i32)> {
        match self {
            Bedroom => Some((5, 5)),
            Master => Some((6, 5)),
            Dining => Some((5, 6)),
            Kitchen => Some((4, 4)),
            Living => Some((6, 6)),
            Bath => Some((3, 4)),
            _ => None,
        }
    }
}

struct House {
    w: i32,
    h: i32,
    owner: Vec<i32>,
    kind: Vec<Kind>,        // per room id
    door_cell: Vec<Option<(i32, i32)>>, // bedroom cell beside its corridor door (for carve placement)
    doors_v: HashSet<(i32, i32)>, // door on vertical wall line x, at row z
    doors_h: HashSet<(i32, i32)>, // door on horizontal wall line z, at col x
    win_v: HashSet<(i32, i32)>,
    win_h: HashSet<(i32, i32)>,
    start: (i32, i32),
    log: Vec<String>,
}

impl House {
    fn new(w: i32, h: i32) -> Self {
        House { w, h, owner: vec![-1; (w * h) as usize], kind: Vec::new(), door_cell: Vec::new(), doors_v: HashSet::new(), doors_h: HashSet::new(), win_v: HashSet::new(), win_h: HashSet::new(), start: (0, 0), log: Vec::new() }
    }
    fn own(&self, x: i32, z: i32) -> i32 {
        if x < 0 || z < 0 || x >= self.w || z >= self.h {
            -1
        } else {
            self.owner[(z * self.w + x) as usize]
        }
    }
    fn stamp(&mut self, x0: i32, z0: i32, x1: i32, z1: i32, k: Kind) -> i32 {
        let id = self.kind.len() as i32;
        self.kind.push(k);
        self.door_cell.push(None);
        for z in z0..z1 {
            for x in x0..x1 {
                self.owner[(z * self.w + x) as usize] = id;
            }
        }
        id
    }
    fn bbox(&self, id: i32) -> (i32, i32, i32, i32) {
        let (mut x0, mut z0, mut x1, mut z1) = (self.w, self.h, 0, 0);
        for z in 0..self.h {
            for x in 0..self.w {
                if self.own(x, z) == id {
                    x0 = x0.min(x);
                    z0 = z0.min(z);
                    x1 = x1.max(x + 1);
                    z1 = z1.max(z + 1);
                }
            }
        }
        (x0, z0, x1, z1)
    }
    fn area(&self, id: i32) -> i32 {
        self.owner.iter().filter(|&&o| o == id).count() as i32
    }
}

// --- z-run slicer ---
fn runs(rng: &mut Rng, start: i32, end: i32, min_d: i32, max_d: i32) -> Vec<(i32, i32)> {
    let mut out = Vec::new();
    let mut z = start;
    while z < end {
        let rem = end - z;
        let mut d = if rem <= max_d { rem } else { rng.range(min_d, max_d + 1) };
        if rem - d < min_d {
            d = rem;
        }
        out.push((z, z + d));
        z += d;
    }
    out
}

// ------------------------------------------------------------- generation ---

// which side of a room band faces the corridor (N = 0 is the default `_` arm)
const E: u8 = 1;
const S: u8 = 2;
const W: u8 = 3;

/// Fill a rectangular band with a row of rooms, each spanning the band's full
/// depth and getting a door to the corridor on `side`. Rooms are sliced along
/// the axis parallel to the corridor. Returns the new room ids. This is the
/// generic "rooms off a corridor" primitive — works for any corridor shape.
fn fill_band(hs: &mut House, rng: &mut Rng, x0: i32, z0: i32, x1: i32, z1: i32, side: u8) -> Vec<i32> {
    let mut ids = Vec::new();
    let (mn, mx) = (5, 7); // F1: each bedroom ≥5 cells wide so a queen+clearance fits
    if x1 <= x0 || z1 <= z0 {
        return ids;
    }
    match side {
        E | W => {
            // corridor runs vertically; stack rooms along Z
            for (a, b) in runs(rng, z0, z1, mn, mx) {
                let id = hs.stamp(x0, a, x1, b, Bedroom);
                let zc = (a + b) / 2;
                if side == E {
                    hs.doors_v.insert((x1, zc));
                    hs.door_cell[id as usize] = Some((x1 - 1, zc));
                } else {
                    hs.doors_v.insert((x0, zc));
                    hs.door_cell[id as usize] = Some((x0, zc));
                }
                ids.push(id);
            }
        }
        _ => {
            // corridor runs horizontally; lay rooms along X
            for (a, b) in runs(rng, x0, x1, mn, mx) {
                let id = hs.stamp(a, z0, b, z1, Bedroom);
                let xc = (a + b) / 2;
                if side == S {
                    hs.doors_h.insert((xc, z1));
                    hs.door_cell[id as usize] = Some((xc, z1 - 1));
                } else {
                    hs.doors_h.insert((xc, z0));
                    hs.door_cell[id as usize] = Some((xc, z0));
                }
                ids.push(id);
            }
        }
    }
    ids
}

/// Tag the largest wing room as the master, the smallest as a bath.
fn assign_wing_kinds(hs: &mut House, ids: &[i32]) {
    if ids.is_empty() {
        return;
    }
    let big = *ids.iter().max_by_key(|&&i| hs.area(i)).unwrap();
    hs.kind[big as usize] = Master;
    if ids.len() >= 3 {
        let small = *ids.iter().min_by_key(|&&i| hs.area(i)).unwrap();
        if small != big {
            hs.kind[small as usize] = Bath;
        }
    }
}

/// Public band at the south, open-plan so the dining touches BOTH living and
/// kitchen (A1/A2): living is the full-depth left block; the dining spans the
/// back from the living edge to the right wall; a front vestibule (foyer) sits at
/// the corridor mouth with the kitchen beside it. Wires doors, front door, spawn.
///
///   ┌──────────┬──────────────────┐
///   │          │     DINING       │  back  (touches living ← and kitchen ↓)
///   │  LIVING  ├──────┬───────────┤
///   │          │ FOY  │  KITCHEN  │  front (foyer = entry vestibule)
///   └──────────┴──────┴───────────┘
fn build_public(hs: &mut House, priv_h: i32, h: i32, w: i32, m0: i32, m1: i32) {
    let dz = priv_h + (h - priv_h) / 2; // back (dining) / front (foyer+kitchen) split
    if m0 > 0 {
        hs.stamp(0, priv_h, m0, h, Living); // full-depth left
    }
    hs.stamp(m0, priv_h, w, dz, Dining); // back strip, living edge → right wall
    hs.stamp(m0, dz, m1, h, Foyer); // front vestibule at the corridor mouth
    if m1 < w {
        hs.stamp(m1, dz, w, h, Kitchen); // front-right
    }

    hs.start = (m0, h - 2);
    hs.doors_h.insert((m0, priv_h)); // corridor mouth → dining (open plan)
    hs.doors_h.insert((m0, dz)); // dining → foyer
    hs.doors_h.insert((m0, h)); // front door
    let back_mid = priv_h + (dz - priv_h) / 2;
    if m0 > 0 {
        hs.doors_v.insert((m0, back_mid)); // A2: dining ↔ living
        hs.doors_v.insert((m0, dz + 1)); // living ↔ foyer (direct from entry)
    }
    if m1 < w {
        hs.doors_h.insert((m1 + (w - m1) / 2, dz)); // A1: kitchen ↔ dining
        hs.doors_v.insert((m1, dz + (h - dz) / 2)); // kitchen ↔ foyer
        hs.log.push("A1 kitchen abuts dining".into());
        hs.log.push("A2 dining abuts living + kitchen".into());
    }
}

fn gen(seed: u64) -> House {
    let mut rng = Rng(seed ^ 0x71_1E_C0DE_0001);
    let cw = 2; // corridor width
    let priv_h = rng.range(14, 18); // bedroom wing height
    let pub_d = rng.range(10, 13); // public band depth (≥10 → dining/kitchen halves ≥5 deep, F2/F3)
    let ctype = rng.next_u64() % 3; // 0 straight, 1 L, 2 loop

    // Build just the bedroom wing (corridor + bands) into its own block, then
    // place it inside a wider house whose PUBLIC band juts past it on one or both
    // sides — so the two masses read as offset rectangles (L / T footprint) rather
    // than one solid box. The corners beside the wing stay exterior.
    let (wing, beds, (lm0, lm1)) = match ctype {
        0 => build_straight(&mut rng, cw, priv_h),
        1 => build_l(&mut rng, cw, priv_h),
        _ => build_loop(&mut rng, cw, priv_h),
    };
    let ww = wing.w;
    let (lext, rext) = match rng.next_u64() % 3 {
        0 => (0, 0), // rectangle
        1 => {
            let e = rng.range(3, 7); // L: public juts past one side
            if rng.chance(1, 2) { (e, 0) } else { (0, e) }
        }
        _ => (rng.range(2, 5), rng.range(2, 5)), // T: public juts both sides
    };
    let core_w = lext + ww + rext; // width of the living block (house minus garage)
    let h = priv_h + pub_d;
    let (m0, m1) = (lext + lm0, lext + lm1);

    // Optional attached garage projecting past the wing on the kitchen (right)
    // side — its own mass, with the area beside the wing left exterior (A4).
    let (gw, gd) = if rng.chance(1, 2) { (rng.range(6, 9), pub_d) } else { (0, 0) };
    let w = core_w + gw;

    let mut hs = House::new(w, h);
    blit(&mut hs, &wing, lext); // copy the wing in, shifted right by lext
    hs.log.push(format!("C2 corridor: {}", ["straight", "L-shaped", "loop"][ctype as usize]));
    if lext > 0 || rext > 0 {
        hs.log.push(format!("footprint: offset masses (+{lext}/+{rext})"));
    }

    build_public(&mut hs, priv_h, h, core_w, m0, m1);
    assign_wing_kinds(&mut hs, &beds);
    if gw > 0 {
        add_garage(&mut hs, core_w, gw, gd, h);
    }

    // ---- HIGH-LEVEL PRODUCTION RULES ----
    rule_suites(&mut hs, &mut rng);
    rule_powder(&mut hs);
    rule_bath_access(&mut hs);
    rule_corridor_window(&mut hs);
    rule_exterior_windows(&mut hs);
    rule_egress(&mut hs);
    rule_furniture_fit(&mut hs);
    hs
}

/// Copy a wing block `src` into the (empty) destination house, shifted right by
/// `ox`. The destination starts with no rooms, so source room ids carry over 1:1
/// — owner cells, door_cell, and door sets just shift in x. The cells `src` does
/// not own stay exterior in `dst`, which is what forms the L/T notches.
fn blit(dst: &mut House, src: &House, ox: i32) {
    debug_assert!(dst.kind.is_empty());
    dst.kind.extend_from_slice(&src.kind);
    for dc in &src.door_cell {
        dst.door_cell.push(dc.map(|(x, z)| (x + ox, z)));
    }
    for z in 0..src.h {
        for x in 0..src.w {
            let o = src.owner[(z * src.w + x) as usize];
            if o >= 0 {
                dst.owner[(z * dst.w + (x + ox)) as usize] = o;
            }
        }
    }
    for &(x, z) in &src.doors_v {
        dst.doors_v.insert((x + ox, z));
    }
    for &(x, z) in &src.doors_h {
        dst.doors_h.insert((x + ox, z));
    }
}

/// A4: attach a garage as a mass projecting past the wing on the right, flush with
/// the front. A people-door connects it to the adjacent house room (the kitchen),
/// and an overhead vehicle door faces the street at the front.
fn add_garage(hs: &mut House, x0: i32, gw: i32, gd: i32, h: i32) {
    let z0 = h - gd;
    hs.stamp(x0, z0, x0 + gw, h, Garage);
    // people-door into the house: lowest cell on the inner wall that borders a room
    for z in (z0..h).rev() {
        let n = hs.own(x0 - 1, z);
        if n >= 0 && hs.kind[n as usize] != Garage {
            hs.doors_v.insert((x0, z));
            break;
        }
    }
    hs.doors_h.insert((x0 + gw / 2, h)); // overhead vehicle door (street front)
    hs.log.push("A4 attached garage → kitchen".into());
}

/// W5 (HARD, IRC R310): every bedroom needs an Emergency Escape & Rescue Opening
/// — i.e. at least one window on an exterior wall. Verifies the window passes
/// actually delivered one per bedroom; flags any that didn't (would mean an
/// interior bedroom — illegal — that a future layout must fix).
fn rule_egress(hs: &mut House) {
    let (mut ok, mut tot) = (0, 0);
    let mut bad = Vec::new();
    for id in 0..hs.kind.len() as i32 {
        let k = hs.kind[id as usize];
        if k != Bedroom && k != Master {
            continue;
        }
        tot += 1;
        if room_has_window(hs, id) {
            ok += 1;
        } else {
            bad.push(format!("{:?}#{id}", k));
        }
    }
    if tot > 0 {
        hs.log.push(format!("W5 bedroom egress {ok}/{tot}"));
    }
    for b in bad {
        hs.log.push(format!("  ! NO EGRESS: {b}"));
    }
}

/// Does room `id` have a window on any of its exterior walls?
fn room_has_window(hs: &House, id: i32) -> bool {
    for z in 0..hs.h {
        for x in 0..hs.w {
            if hs.own(x, z) != id {
                continue;
            }
            if hs.own(x, z - 1) == -1 && hs.win_h.contains(&(x, z)) {
                return true;
            }
            if hs.own(x, z + 1) == -1 && hs.win_h.contains(&(x, z + 1)) {
                return true;
            }
            if hs.own(x - 1, z) == -1 && hs.win_v.contains(&(x, z)) {
                return true;
            }
            if hs.own(x + 1, z) == -1 && hs.win_v.contains(&(x + 1, z)) {
                return true;
            }
        }
    }
    false
}

/// Largest axis-aligned rectangle of cells satisfying `inside`, scanned over the
/// box [bx0,bx1)×[bz0,bz1). Classic largest-rectangle-in-histogram sweep. Returns
/// (area, x0, z0, x1, z1). The predicate lets callers ask "biggest all-`id` rect"
/// or "biggest rect if these cells were carved away" without mutating the grid.
fn largest_rect_pred(bx0: i32, bz0: i32, bx1: i32, bz1: i32, inside: impl Fn(i32, i32) -> bool) -> (i32, i32, i32, i32, i32) {
    let bw = bx1 - bx0;
    if bw <= 0 || bz1 <= bz0 {
        return (0, bx0, bz0, bx0, bz0);
    }
    let mut hist = vec![0i32; bw as usize];
    let mut best = (0i32, bx0, bz0, bx0, bz0); // area,x0,z0,x1,z1
    for z in bz0..bz1 {
        for i in 0..bw {
            hist[i as usize] = if inside(bx0 + i, z) { hist[i as usize] + 1 } else { 0 };
        }
        let mut stack: Vec<(i32, i32)> = Vec::new(); // (start_col, height)
        for i in 0..=bw {
            let cur = if i < bw { hist[i as usize] } else { 0 };
            let mut start = i;
            while let Some(&(s, hh)) = stack.last() {
                if hh <= cur {
                    break;
                }
                let area = hh * (i - s);
                if area > best.0 {
                    best = (area, bx0 + s, z + 1 - hh, bx0 + i, z + 1);
                }
                start = s;
                stack.pop();
            }
            stack.push((start, cur));
        }
    }
    best
}

/// The largest all-`id` rectangle inside room `id` (rooms may be L-shaped after a
/// suite carve, so the bbox overstates usable space). Returns (x0,z0,x1,z1).
fn largest_rect(hs: &House, id: i32) -> (i32, i32, i32, i32) {
    let (bx0, bz0, bx1, bz1) = hs.bbox(id);
    let (_, x0, z0, x1, z1) = largest_rect_pred(bx0, bz0, bx1, bz1, |x, z| hs.own(x, z) == id);
    (x0, z0, x1, z1)
}

/// Does a `wxh` box fit in an `lw x lh` rectangle, either orientation?
fn box_fits(lw: i32, lh: i32, w: i32, h: i32) -> bool {
    (lw >= w && lh >= h) || (lw >= h && lh >= w)
}

/// F1/F2/F3: validate every room contains its furniture+clearance envelope
/// inside its largest rectangle, oriented either way. Logs a per-rule summary and
/// flags any room that comes up short (honest reporting — soft, not a hard gate).
fn rule_furniture_fit(hs: &mut House) {
    let (mut ok, mut total) = (0, 0);
    let mut fails: Vec<String> = Vec::new();
    for id in 0..hs.kind.len() as i32 {
        let k = hs.kind[id as usize];
        let Some((fw, fh)) = k.fit_box() else { continue };
        total += 1;
        let (x0, z0, x1, z1) = largest_rect(hs, id);
        let (lw, lh) = (x1 - x0, z1 - z0);
        let fits = box_fits(lw, lh, fw, fh);
        if fits {
            ok += 1;
        } else {
            fails.push(format!("{:?}#{id} {lw}x{lh}<{fw}x{fh}", k));
        }
    }
    if total > 0 {
        hs.log.push(format!("F1/F2/F3 furniture-fit {ok}/{total}"));
    }
    for f in fails {
        hs.log.push(format!("  ! tight: {f}"));
    }
}

/// Straight vertical spine, double-loaded (rooms both sides). C6 window at the
/// north dead-end.
fn build_straight(rng: &mut Rng, cw: i32, priv_h: i32) -> (House, Vec<i32>, (i32, i32)) {
    let cx = rng.range(7, 10);
    let right_w = rng.range(8, 11);
    let w = cx + cw + right_w;
    let mut hs = House::new(w, priv_h);
    hs.stamp(cx, 0, cx + cw, priv_h, Corridor);
    let mut beds = fill_band(&mut hs, rng, 0, 0, cx, priv_h, E);
    beds.extend(fill_band(&mut hs, rng, cx + cw, 0, w, priv_h, W));
    (hs, beds, (cx, cx + cw))
}

/// L-shaped corridor: a vertical arm with a horizontal arm branching east.
/// Left band serves off the vertical arm (west windows). Above the horizontal
/// arm, rooms serve off it and take NORTH windows. Below the arm, rooms would be
/// landlocked between corridor and the public zone — so they serve off the
/// VERTICAL arm and reach the EAST exterior wall (egress, W5). C6 windows at both
/// dead-ends (N and E).
fn build_l(rng: &mut Rng, cw: i32, priv_h: i32) -> (House, Vec<i32>, (i32, i32)) {
    let cx = rng.range(7, 10);
    let right_w = rng.range(7, 10); // capped so the east-reaching lower rooms stay squarish
    let w = cx + cw + right_w;
    let hz = rng.range(5, priv_h - cw - 5 + 1); // bend row (both arm bands ≥5 deep → F1 fits)
    let mut hs = House::new(w, priv_h);
    hs.stamp(cx, 0, cx + cw, priv_h, Corridor); // vertical arm
    hs.stamp(cx + cw, hz, w, hz + cw, Corridor); // horizontal arm (east)
    let mut beds = fill_band(&mut hs, rng, 0, 0, cx, priv_h, E); // left of vertical arm (W windows)
    beds.extend(fill_band(&mut hs, rng, cx + cw, 0, w, hz, S)); // upper-right onto horiz arm (N windows)
    beds.extend(fill_band(&mut hs, rng, cx + cw, hz + cw, w, priv_h, W)); // lower-right off vertical arm (E windows)
    (hs, beds, (cx, cx + cw))
}

/// Loop corridor: a rectangular ring (two vertical arms joined top & bottom).
/// Bedrooms ring the outside; the windowless interior is subdivided into a stack
/// of service rooms (W3/A11). No dead-ends — the C5 circuit.
fn build_loop(rng: &mut Rng, cw: i32, priv_h: i32) -> (House, Vec<i32>, (i32, i32)) {
    let outer_l = rng.range(6, 9); // ≥6 so the living room (its width) holds S5 6×6
    let center = rng.range(6, 9);
    let outer_r = rng.range(6, 9);
    let w = outer_l + cw + center + cw + outer_r;
    let (lx, rx) = (outer_l, outer_l + cw + center);
    let mut hs = House::new(w, priv_h);
    hs.stamp(lx, 0, lx + cw, priv_h, Corridor); // left arm
    hs.stamp(rx, 0, rx + cw, priv_h, Corridor); // right arm
    hs.stamp(lx, 0, rx + cw, cw, Corridor); // top connector
    hs.stamp(lx, priv_h - cw, rx + cw, priv_h, Corridor); // bottom connector
    fill_core(&mut hs, rng, lx + cw, cw, rx, priv_h - cw); // subdivided service core
    let mut beds = fill_band(&mut hs, rng, 0, 0, lx, priv_h, E);
    beds.extend(fill_band(&mut hs, rng, rx + cw, 0, w, priv_h, W));
    (hs, beds, (lx, lx + cw))
}

/// A11/W3: subdivide the windowless interior of a loop into a stack of service
/// rooms — a full bath, then laundry / storage — each doored to an adjacent
/// corridor arm (doors alternate left/right so both arms stay live). The first
/// (largest) slot is the bath; the rest cycle laundry → storage.
fn fill_core(hs: &mut House, rng: &mut Rng, x0: i32, z0: i32, x1: i32, z1: i32) {
    if x1 <= x0 || z1 <= z0 {
        return;
    }
    let slots = runs(rng, z0, z1, 4, 6);
    // make the bath the deepest slot so it comfortably holds the 3×4 fit box
    let bath_i = (0..slots.len()).max_by_key(|&i| slots[i].1 - slots[i].0).unwrap_or(0);
    for (i, (a, b)) in slots.iter().copied().enumerate() {
        let k = if i == bath_i { Bath } else if i % 2 == 0 { Storage } else { Laundry };
        let id = hs.stamp(x0, a, x1, b, k);
        let zc = (a + b) / 2;
        if i % 2 == 0 {
            hs.doors_v.insert((x0, zc)); // door west, into the left arm
        } else {
            hs.doors_v.insert((x1, zc)); // door east, into the right arm
        }
        hs.door_cell[id as usize] = Some((x0, zc));
    }
}

/// A6: large bedroom → ensuite WC; master → also a walk-in wardrobe. Carved from
/// an interior corner (farthest from the room's corridor door), leaving the
/// bedroom L-shaped.
fn rule_suites(hs: &mut House, rng: &mut Rng) {
    for id in 0..hs.kind.len() as i32 {
        let k = hs.kind[id as usize];
        if k != Bedroom && k != Master {
            continue;
        }
        let keep = k.fit_box(); // the bedroom must still hold its own bed afterward
        // Master always gets a suite; a roomy secondary bedroom (≥ ~17 m²) sometimes.
        if !(k == Master || (hs.area(id) >= 48 && rng.chance(1, 2))) {
            continue;
        }
        // A6: ensuite (full bath, must itself hold a 3×4 fit box), then for the
        // master a walk-in wardrobe — each placed so the bedroom keeps `keep`.
        if try_carve(hs, id, (3, 4), keep, Bath) {
            hs.log.push(format!("A6 ensuite WC -> {:?} #{id}", k));
        }
        if k == Master && try_carve(hs, id, (3, 3), keep, Wardrobe) {
            hs.log.push(format!("A6 wardrobe -> master #{id}"));
        }
    }
}

/// Carve a `(w,h)` sub-room out of room `id` for `k`, choosing the placement
/// (4 corners × 2 orientations) that leaves the parent's *largest remaining
/// rectangle* as big as possible — and only committing if that remainder still
/// holds `keep` (the parent's own fit box). This is hold-by-construction: a suite
/// is added only when it doesn't break the bedroom's F1 fit. Returns whether one
/// was placed. Ties break toward the corner farthest from the parent's door.
fn try_carve(hs: &mut House, id: i32, (w, h): (i32, i32), keep: Option<(i32, i32)>, k: Kind) -> bool {
    let (bx0, bz0, bx1, bz1) = hs.bbox(id);
    let door = hs.door_cell[id as usize].unwrap_or(((bx0 + bx1) / 2, (bz0 + bz1) / 2));
    let mut best: Option<(i32, i32, i32, i32, i32)> = None; // score, dist, sx, sz, then (cw,ch) via flag
    let mut best_dims = (0, 0);
    for &(cw, ch) in &[(w, h), (h, w)] {
        if bx1 - bx0 < cw || bz1 - bz0 < ch {
            continue;
        }
        for &(sx, sz) in &[(bx0, bz0), (bx1 - cw, bz0), (bx0, bz1 - ch), (bx1 - cw, bz1 - ch)] {
            let in_block = |x: i32, z: i32| x >= sx && x < sx + cw && z >= sz && z < sz + ch;
            // the block must be solid `id` right now (room may already be L-shaped)
            if (sz..sz + ch).any(|z| (sx..sx + cw).any(|x| hs.own(x, z) != id)) {
                continue;
            }
            // must not swallow the parent's own corridor door (it would orphan it)
            if hs.door_cell[id as usize].is_some_and(|(dx, dz)| in_block(dx, dz)) {
                continue;
            }
            // must leave the parent with exterior frontage (W5 egress survives)
            let keeps_ext = (bz0..bz1).any(|z| {
                (bx0..bx1).any(|x| {
                    hs.own(x, z) == id && !in_block(x, z) && [(x - 1, z), (x + 1, z), (x, z - 1), (x, z + 1)].iter().any(|&(nx, nz)| hs.own(nx, nz) == -1)
                })
            });
            if !keeps_ext {
                continue;
            }
            // largest parent rectangle that survives carving this block away
            let (rem, rx0, rz0, rx1, rz1) = largest_rect_pred(bx0, bz0, bx1, bz1, |x, z| hs.own(x, z) == id && !in_block(x, z));
            if let Some((kw, kh)) = keep {
                if !box_fits(rx1 - rx0, rz1 - rz0, kw, kh) {
                    continue;
                }
            }
            let dist = (sx - door.0).abs() + (sz - door.1).abs();
            if best.map_or(true, |(s, dd, ..)| (rem, dist) > (s, dd)) {
                best = Some((rem, dist, sx, sz, 0));
                best_dims = (cw, ch);
            }
        }
    }
    let Some((_, _, sx, sz, _)) = best else { return false };
    let (cw, ch) = best_dims;
    let nid = hs.kind.len() as i32;
    hs.kind.push(k);
    hs.door_cell.push(None);
    for z in sz..sz + ch {
        for x in sx..sx + cw {
            hs.owner[(z * hs.w + x) as usize] = nid;
        }
    }
    // door back to the parent: pick an inner edge that still borders `id`
    let (xc, zc) = (sx + cw / 2, sz + ch / 2);
    if hs.own(sx + cw, zc) == id {
        hs.doors_v.insert((sx + cw, zc));
    } else if hs.own(sx - 1, zc) == id {
        hs.doors_v.insert((sx, zc));
    } else if hs.own(xc, sz + ch) == id {
        hs.doors_h.insert((xc, sz + ch));
    } else if hs.own(xc, sz - 1) == id {
        hs.doors_h.insert((xc, sz));
    }
    true
}

/// A7: a powder room (half-bath) by the entry — carved from the living's corner
/// next to the foyer, doored to the foyer (NOT the kitchen/dining). Placed at the
/// front so it sits right off the entry hall. Skipped if it would shrink the
/// living below its fit box.
fn rule_powder(hs: &mut House) {
    let Some(foy) = (0..hs.kind.len() as i32).find(|&i| hs.kind[i as usize] == Foyer) else {
        return;
    };
    let (fx0, _, _, fz1) = hs.bbox(foy);
    let (pw, pd) = (2, 2);
    let (sx, sz) = (fx0 - pw, fz1 - pd); // living's front corner, hard against the foyer
    if sx < 0 || sz < 0 {
        return;
    }
    let solid_living = (sz..sz + pd).all(|z| (sx..sx + pw).all(|x| hs.own(x, z) >= 0 && hs.kind[hs.own(x, z) as usize] == Living));
    if !solid_living {
        return;
    }
    let liv = hs.own(sx, sz);
    // would the living still hold its fit box after losing this corner?
    let (_, lx0, lz0, lx1, lz1) = largest_rect_pred(0, 0, hs.w, hs.h, |x, z| hs.own(x, z) == liv && !(x >= sx && x < sx + pw && z >= sz && z < sz + pd));
    if let Some((kw, kh)) = Living.fit_box() {
        if !box_fits(lx1 - lx0, lz1 - lz0, kw, kh) {
            return;
        }
    }
    let nid = hs.kind.len() as i32;
    hs.kind.push(Powder);
    hs.door_cell.push(None);
    for z in sz..sz + pd {
        for x in sx..sx + pw {
            hs.owner[(z * hs.w + x) as usize] = nid;
        }
    }
    hs.doors_v.insert((fx0, sz)); // powder → foyer
    hs.log.push("A7 powder room by entry".into());
}

/// A5: every bedroom should be within a short hop of a bathroom — i.e. it has an
/// ensuite, or shares the corridor with a bath/powder off the same hall. Verifies
/// and logs; flags any bedroom left stranded.
fn rule_bath_access(hs: &mut House) {
    let is_bath = |k: Kind| matches!(k, Bath | Powder);
    // is there a bath/powder opening off the corridor network at all?
    let mut bath_on_hall = false;
    for z in 0..hs.h {
        for x in 0..hs.w {
            let o = hs.own(x, z);
            if o < 0 || !is_bath(hs.kind[o as usize]) {
                continue;
            }
            if [(x - 1, z), (x + 1, z), (x, z - 1), (x, z + 1)].iter().any(|&(nx, nz)| {
                let n = hs.own(nx, nz);
                n >= 0 && hs.kind[n as usize] == Corridor
            }) {
                bath_on_hall = true;
            }
        }
    }
    let (mut ok, mut tot) = (0, 0);
    let mut bad = Vec::new();
    for id in 0..hs.kind.len() as i32 {
        let k = hs.kind[id as usize];
        if k != Bedroom && k != Master {
            continue;
        }
        tot += 1;
        let ensuite = room_adjacent_to(hs, id, is_bath);
        if ensuite || bath_on_hall {
            ok += 1;
        } else {
            bad.push(format!("{:?}#{id}", k));
        }
    }
    if tot > 0 {
        hs.log.push(format!("A5 bath access {ok}/{tot}"));
    }
    for b in bad {
        hs.log.push(format!("  ! far from bath: {b}"));
    }
}

/// Does room `id` share an edge with any room whose kind satisfies `pred`?
fn room_adjacent_to(hs: &House, id: i32, pred: impl Fn(Kind) -> bool) -> bool {
    for z in 0..hs.h {
        for x in 0..hs.w {
            if hs.own(x, z) != id {
                continue;
            }
            for &(nx, nz) in &[(x - 1, z), (x + 1, z), (x, z - 1), (x, z + 1)] {
                let n = hs.own(nx, nz);
                if n >= 0 && n != id && pred(hs.kind[n as usize]) {
                    return true;
                }
            }
        }
    }
    false
}

/// C6: wherever a corridor meets an exterior wall (its dead-end), put a
/// window. Works for any corridor shape — a straight spine windows its north
/// end, an L windows both arm ends, a loop has none (no dead-end, by design).
fn rule_corridor_window(hs: &mut House) {
    let mut placed = false;
    let is_corr = |hs: &House, x: i32, z: i32| hs.own(x, z) >= 0 && hs.kind[hs.own(x, z) as usize] == Corridor;
    for z in 0..hs.h {
        for x in 0..hs.w {
            if !is_corr(hs, x, z) {
                continue;
            }
            if hs.own(x, z - 1) == -1 {
                hs.win_h.insert((x, z));
                placed = true;
            }
            if hs.own(x, z + 1) == -1 {
                hs.win_h.insert((x, z + 1));
                placed = true;
            }
            if hs.own(x - 1, z) == -1 {
                hs.win_v.insert((x, z));
                placed = true;
            }
            if hs.own(x + 1, z) == -1 {
                hs.win_v.insert((x + 1, z));
                placed = true;
            }
        }
    }
    if placed {
        hs.log.push("C6 window at corridor dead-end".into());
    }
}

/// W1: each habitable room with an exterior wall gets a window on its longest
/// exterior face (skipping cells already used by a door).
fn rule_exterior_windows(hs: &mut House) {
    for id in 0..hs.kind.len() as i32 {
        if !hs.kind[id as usize].wants_window() {
            continue;
        }
        // gather exterior edges per side: N,S as (col,zline); W,E as (xline,row)
        let mut north = Vec::new();
        let mut south = Vec::new();
        let mut west = Vec::new();
        let mut east = Vec::new();
        for z in 0..hs.h {
            for x in 0..hs.w {
                if hs.own(x, z) != id {
                    continue;
                }
                if hs.own(x, z - 1) == -1 {
                    north.push((x, z));
                }
                if hs.own(x, z + 1) == -1 {
                    south.push((x, z + 1));
                }
                if hs.own(x - 1, z) == -1 {
                    west.push((x, z));
                }
                if hs.own(x + 1, z) == -1 {
                    east.push((x + 1, z));
                }
            }
        }
        let sides = [north, south, west, east];
        let best = (0..4).max_by_key(|&i| sides[i].len()).unwrap();
        let s = &sides[best];
        if s.is_empty() {
            continue;
        }
        let m = s[s.len() / 2];
        match best {
            0 => {
                hs.win_h.insert(m);
            }
            1 => {
                hs.win_h.insert(m);
            }
            _ => {
                hs.win_v.insert(m);
            }
        }
    }
}

// ------------------------------------------------------------ furniture ---

fn shade(c: [u8; 3], f: f32) -> [u8; 3] {
    [(c[0] as f32 * f) as u8, (c[1] as f32 * f) as u8, (c[2] as f32 * f) as u8]
}

/// Place representative furniture inside each room's largest rectangle so the
/// F1/F2/F3 fit is visible: bed (+pillow) in bedrooms, table in dining, an L of
/// counter in the kitchen, sofa + coffee table in the living, three fixtures in
/// baths. Returned in CELL coordinates (x0,z0,x1,z1,color); render() insets them.
fn furnish(hs: &House) -> Vec<(i32, i32, i32, i32, [u8; 3])> {
    let mut f = Vec::new();
    for id in 0..hs.kind.len() as i32 {
        let k = hs.kind[id as usize];
        let base = k.color();
        let (body, accent, wood) = (shade(base, 0.62), shade(base, 0.85), shade(base, 0.5));
        let (x0, z0, x1, z1) = largest_rect(hs, id);
        let (lw, lh) = (x1 - x0, z1 - z0);
        if lw <= 0 || lh <= 0 {
            continue;
        }
        match k {
            Bedroom | Master => {
                let bw0 = if k == Master { 4 } else { 3 };
                // headboard goes against the wall FARTHEST from the corridor door,
                // so the bed never lands on the doorway.
                let dc = hs.door_cell[id as usize];
                if lh >= lw {
                    // bed runs along Z; head at top or bottom wall
                    let (bw, bl) = (bw0.min(lw), 4.min(lh));
                    let bx = x0 + (lw - bw) / 2;
                    let head_top = dc.map_or(true, |(_, dz)| dz >= (z0 + z1) / 2);
                    let bz = if head_top { z0 } else { z1 - bl };
                    let py = if head_top { bz } else { bz + bl - 1 };
                    f.push((bx, bz, bx + bw, bz + bl, body));
                    f.push((bx, py, bx + bw, py + 1, accent)); // pillow / headboard
                } else {
                    // bed runs along X; head at left or right wall
                    let (bw, bl) = (4.min(lw), bw0.min(lh));
                    let bz = z0 + (lh - bl) / 2;
                    let head_left = dc.map_or(true, |(dx, _)| dx >= (x0 + x1) / 2);
                    let bx = if head_left { x0 } else { x1 - bw };
                    let px = if head_left { bx } else { bx + bw - 1 };
                    f.push((bx, bz, bx + bw, bz + bl, body));
                    f.push((px, bz, px + 1, bz + bl, accent));
                }
            }
            Dining => {
                let (tw, tl) = if lh >= lw { (2.min(lw), 3.min(lh)) } else { (3.min(lw), 2.min(lh)) };
                let (tx, tz) = (x0 + (lw - tw) / 2, z0 + (lh - tl) / 2);
                f.push((tx, tz, tx + tw, tz + tl, wood));
            }
            Kitchen => {
                f.push((x0, z0, x0 + 1, z1, wood)); // counter run along one wall
                f.push((x0, z0, x1, z0 + 1, wood)); // returning leg (galley/L)
            }
            Living => {
                let sw = 4.min(lw);
                let sx = x0 + (lw - sw) / 2;
                f.push((sx, z1 - 1, sx + sw, z1, body)); // sofa along the back wall
                if lh >= 3 {
                    let cw2 = 2.min(lw);
                    let cx = x0 + (lw - cw2) / 2;
                    f.push((cx, z1 - 2, cx + cw2, z1 - 1, accent)); // coffee table
                }
            }
            Bath => {
                f.push((x0, z0, x0 + 1, z0 + 2.min(lh), accent)); // tub
                f.push((x0, z1 - 1, x0 + 1, z1, body)); // toilet
                f.push((x1 - 1, z1 - 1, x1, z1, body)); // sink
            }
            Powder => {
                f.push((x0, z1 - 1, x0 + 1, z1, body)); // toilet
                f.push((x1 - 1, z0, x1, z0 + 1, body)); // sink
            }
            Garage => {
                let cars = if lw >= 7 { 2 } else { 1 };
                let cwid = 3.min(lw);
                let clen = 5.min(lh);
                let gap = ((lw - cars * cwid) / (cars + 1)).max(1);
                let cz = z0 + (lh - clen) / 2;
                for i in 0..cars {
                    let cx = x0 + gap * (i + 1) + cwid * i;
                    if cx + cwid <= x1 {
                        f.push((cx, cz, cx + cwid, cz + clen, body)); // parked car
                    }
                }
            }
            _ => {}
        }
    }
    f
}

// --------------------------------------------------------------- render ---

fn render(hs: &House, header: &str) -> Canvas {
    let cw = (MARGIN * 2 + GW * PX) as usize;
    let ch = (MARGIN * 2 + HDR + GH * PX) as usize;
    let mut c = Canvas::new(cw, ch, [18, 19, 25]);
    c.fill(0, 0, cw as i32, HDR, [13, 14, 19]);
    c.text(header, MARGIN, MARGIN + 2, 3, [222, 226, 236]);

    let ox = (GW - hs.w) / 2;
    let oz = (GH - hs.h) / 2;
    let wx = |x: i32| MARGIN + (ox + x) * PX;
    let wz = |z: i32| MARGIN + HDR + (oz + z) * PX;
    let wall = [24, 25, 31];
    let door = [255, 152, 42];
    let window = [88, 200, 236];

    // floor cells by semantic kind
    for z in 0..hs.h {
        for x in 0..hs.w {
            let o = hs.own(x, z);
            if o >= 0 {
                c.fill(wx(x), wz(z), wx(x + 1), wz(z + 1), hs.kind[o as usize].color());
            }
        }
    }
    // furniture (inset inside the cells so it reads as objects in the room)
    for (fx0, fz0, fx1, fz1, col) in furnish(hs) {
        c.fill(wx(fx0) + 2, wz(fz0) + 2, wx(fx1) - 2, wz(fz1) - 2, col);
    }

    // vertical boundaries (line x, row z)
    for x in 0..=hs.w {
        for z in 0..hs.h {
            if hs.own(x - 1, z) == hs.own(x, z) {
                continue;
            }
            let (px, y0, y1) = (wx(x), wz(z), wz(z + 1));
            let ext = hs.own(x - 1, z) == -1 || hs.own(x, z) == -1;
            let col = if hs.doors_v.contains(&(x, z)) {
                door
            } else if ext && hs.win_v.contains(&(x, z)) {
                window
            } else {
                wall
            };
            c.fill(px - 1, y0, px + 2, y1, col);
        }
    }
    // horizontal boundaries (line z, col x)
    for z in 0..=hs.h {
        for x in 0..hs.w {
            if hs.own(x, z - 1) == hs.own(x, z) {
                continue;
            }
            let (py, x0, x1) = (wz(z), wx(x), wx(x + 1));
            let ext = hs.own(x, z - 1) == -1 || hs.own(x, z) == -1;
            let col = if hs.doors_h.contains(&(x, z)) {
                door
            } else if ext && hs.win_h.contains(&(x, z)) {
                window
            } else {
                wall
            };
            c.fill(x0, py - 1, x1, py + 2, col);
        }
    }

    // room labels at centroids
    let n = hs.kind.len();
    let mut sx = vec![0i64; n];
    let mut sz = vec![0i64; n];
    let mut cnt = vec![0i64; n];
    for z in 0..hs.h {
        for x in 0..hs.w {
            let o = hs.own(x, z);
            if o >= 0 {
                sx[o as usize] += x as i64;
                sz[o as usize] += z as i64;
                cnt[o as usize] += 1;
            }
        }
    }
    for id in 0..n {
        let lbl = hs.kind[id].label();
        if lbl.is_empty() || cnt[id] == 0 {
            continue;
        }
        let (mx, mz) = ((sx[id] / cnt[id]) as i32, (sz[id] / cnt[id]) as i32);
        let tw = lbl.len() as i32 * 4 * 2 - 2;
        c.text(lbl, wx(mx) + PX / 2 - tw / 2, wz(mz) + PX / 2 - 5, 2, [28, 28, 34]);
    }
    // spawn / front door marker
    c.disc(wx(hs.start.0) + PX / 2, wz(hs.start.1) + PX / 2, 4, [70, 230, 120]);
    c
}

fn main() {
    let mut a = std::env::args().skip(1);
    let out = a.next().unwrap_or_else(|| "/tmp/floorplans/tile".into());
    let n: u64 = a.next().and_then(|s| s.parse().ok()).unwrap_or(8);
    let seed0: u64 = a.next().and_then(|s| s.parse().ok()).unwrap_or(1);
    std::fs::create_dir_all(&out).expect("mkdir");

    let mut tiles = Vec::new();
    for k in 0..n {
        let seed = seed0 + k;
        let hs = gen(seed);
        let cells = hs.owner.iter().filter(|&&o| o >= 0).count() as f32;
        let m2 = cells * CELL_M * CELL_M;
        let header = format!("TILEHOUSE S{seed}  {:.0} m2  RULES {}", m2, hs.log.len());
        let canvas = render(&hs, &header);
        canvas.write_png(&format!("{out}/s{seed:03}.png"));
        tiles.push(canvas);
        println!("seed={seed} {}x{} rooms={} -- rules fired:", hs.w, hs.h, hs.kind.len());
        for l in &hs.log {
            println!("    {l}");
        }
    }
    let mon = montage(&tiles, 3, 14);
    mon.write_png(&format!("{out}/montage.png"));
    eprintln!("wrote {out}/montage.png");
}
