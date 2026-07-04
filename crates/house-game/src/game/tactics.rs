//! Goo tactics — the arena brain (child module of `game`, the goo.rs /
//! weapon.rs pattern). ARENA-ONLY by construction: every entry point returns
//! immediately off arena levels, the legacy wander/seek AI in `goo_step_ai`
//! is untouched (bit-identical, same RNG draw order), and the new per-blob
//! tactic fields fold into `state_hash` only under the arena gate — so the
//! four goo hash oracles stand without recapture.
//!
//! ## Composition model
//!
//! Tactics are small state machines COMPOSED from four shared primitives:
//!
//! - **LOS** (`los_clear`) — segment vs the level's solid AABBs in XZ.
//! - **Nav** (`NavField`) — a BFS flow field over a 0.125-wu grid from the
//!   player, rebuilt every few ticks. Steering descends the field, which
//!   routes bodies around walls and THROUGH the squeeze slot organically
//!   (the field knows the slot is the short way; the PBF fluid does the
//!   actual squeezing). Derived state: recomputed from hashed inputs, never
//!   hashed itself.
//! - **Cover** (`Res.cover`) — wall-corner points computed once from the
//!   spec's solids; `pick_cover` selects one that breaks LOS to the player.
//! - **Sprint** — a timed speed/turn burst (the attack commitment).
//!
//! The tactic graph:
//!
//! ```text
//! Direct ──(doctrine roll)──> Flank ──(arrived | LOS)──────────> Sprint
//!    │                                                             ^
//!    ├──(cover found)──> ToCover ──> Peek ──> Hide ──(timer)───────┤
//!    │    "show itself around the corner, duck back, then rush"    │
//!    └──(paired + LOS to partner)──> CoordWait ──(strike tick)─────┘
//!                 both blobs BLINK an accelerating pulse
//!                 until the agreed tick — the visible comms
//! ```
//!
//! Everything is deterministic with ZERO RNG draws: timing and choices come
//! from `ID_HASH_STRIDE` scrambles of (mob id, decision window), so replays
//! stay bit-exact and the shared RNG stream never shifts.

use super::goo::{goo_tier_speed, rotate_toward, GOO_CURE_SLOW, GOO_ID_MIX, GOO_MAX_TURN};
use super::*;
use crate::spec::MobId;
use crate::GooKind;
use glam::Vec2;
use sim_core::AudioSink;

// ---- tuning -----------------------------------------------------------------

/// Nav grid cell size (wu). Fine enough that the 0.5625-wu squeeze slot keeps
/// free columns (cells are blocked on center-in-solid, no inflation — goo
/// anchors and particles are point tests, they really do fit anywhere a cell
/// center fits).
const NAV_CELL: f32 = 0.125;
/// Rebuild the flow field at most this often (ticks) — also rebuilt whenever
/// the player crosses into a new cell.
const NAV_REBUILD_TICKS: u64 = 12;
/// Doctrine re-roll window (ticks): a blob in `Direct` reconsiders its tactic
/// once per window, at an id-staggered tick inside it.
const DOCTRINE_WINDOW: u64 = 64;
/// Tactic maneuvers only make sense at mid range: closer, just attack;
/// farther, keep approaching.
const TACTIC_NEAR: f32 = 2.5;
const TACTIC_FAR: f32 = 9.5;
/// A maneuver point counts as reached within this distance (wu).
const ARRIVE: f32 = 0.45;
/// Peek: how far past the cover corner the blob steps to show itself (wu).
const PEEK_STEP: f32 = 0.9;
/// Peek/hide phase lengths (ticks); hide is id-jittered up to +HIDE_JITTER.
const PEEK_TICKS: u16 = 45;
const HIDE_TICKS: u16 = 55;
const HIDE_JITTER: u32 = 65;
/// Sprint burst: duration and per-kind speed multipliers (turn also x1.6).
const SPRINT_TICKS: u16 = 105;
const SPRINT_TURN: f32 = 1.6;
/// Give up on a maneuver that hasn't arrived in this long (wall snag etc).
const MANEUVER_TIMEOUT: u16 = 300;
/// Comms: pairing range (wu), strike delay (ticks) + id jitter, and the
/// global cooldown between pacts so the arena isn't a constant light show.
const COMM_RANGE: f32 = 6.0;
const COMM_SEE: f32 = 9.0;
const COMM_DELAY: u64 = 110;
const COMM_JITTER: u64 = 50;
const COMM_COOLDOWN: u64 = 300;
/// Flank: lateral bearing off the player→blob axis (radians) and standoff
/// radius of the flank waypoint.
const FLANK_ANGLE: f32 = 1.9; // ~109°
const FLANK_JITTER: f32 = 0.6;
const FLANK_RADIUS: f32 = 2.75;

/// Per-kind sprint speed multiplier — the attack lunge. Runners are the
/// sprint species; Tanks commit slower but still meaningfully.
fn sprint_mult(kind: GooKind) -> f32 {
    match kind {
        GooKind::Runner => 2.3,
        GooKind::Green => 1.9,
        GooKind::Tank => 1.5,
    }
}

// ---- the tactic state machine -------------------------------------------------

/// The blob's current maneuver. `Direct` is the resting default (flow-field
/// approach) and the state every other tactic collapses back to.
#[derive(Clone, Copy, PartialEq, Eq, Debug, Default)]
pub enum Tactic {
    #[default]
    Direct,
    /// Swing wide to `tac_point` beside the player, then commit.
    Flank,
    /// Move to `tac_point` (a cover corner that breaks LOS to the player).
    ToCover,
    /// Step out past the corner — SHOW yourself (the taunt half of ambush).
    Peek,
    /// Duck back behind cover for a beat...
    Hide,
    /// ...paired pact: hold until the agreed `strike` tick, blinking.
    CoordWait,
    /// The committed attack burst (speed + turn up), then back to Direct.
    Sprint,
}

impl Tactic {
    /// Stable hash tag (enum discriminants are not order-stable; pin them).
    pub(crate) fn tag(self) -> u64 {
        match self {
            Tactic::Direct => 0,
            Tactic::Flank => 1,
            Tactic::ToCover => 2,
            Tactic::Peek => 3,
            Tactic::Hide => 4,
            Tactic::CoordWait => 5,
            Tactic::Sprint => 6,
        }
    }
}

// ---- primitives ---------------------------------------------------------------

/// LOS through walls AND dead chunks: a goo-height sightline is blocked by
/// the knee-high stone corpses too (the player shoots over them; the goo
/// cannot see past them) — so the horde treats your masonry as cover.
pub fn los_clear2(solids: &[[f32; 4]], chunks: &[[f32; 4]], a: Vec2, b: Vec2) -> bool {
    los_clear(solids, a, b) && los_clear(chunks, a, b)
}

/// Segment `a`→`b` vs every solid AABB (XZ, 2D slab test). `true` = clear.
/// Pure; used for player sightlines AND blob↔blob comm eligibility.
pub fn los_clear(solids: &[[f32; 4]], a: Vec2, b: Vec2) -> bool {
    let d = b - a;
    for s in solids {
        // slab test on [s0,s2]x[s1,s3]
        let (mut t0, mut t1) = (0.0f32, 1.0f32);
        let mut hit = true;
        for ax in 0..2 {
            let (da, pa, lo, hi) = if ax == 0 { (d.x, a.x, s[0], s[2]) } else { (d.y, a.y, s[1], s[3]) };
            if da.abs() < 1e-9 {
                if pa < lo || pa > hi {
                    hit = false;
                    break;
                }
            } else {
                let (mut e0, mut e1) = ((lo - pa) / da, (hi - pa) / da);
                if e0 > e1 {
                    std::mem::swap(&mut e0, &mut e1);
                }
                t0 = t0.max(e0);
                t1 = t1.min(e1);
                if t0 > t1 {
                    hit = false;
                    break;
                }
            }
        }
        if hit {
            return false;
        }
    }
    true
}

/// The BFS flow field: integer distances (in cells) from the player over the
/// walkable grid. DERIVED state — a pure function of (floor, solids, player
/// cell), rebuilt on a fixed cadence; never hashed (like `Level` itself).
#[derive(Clone, Debug, Default)]
pub struct NavField {
    pub w: i32,
    pub h: i32,
    pub x0: f32,
    pub z0: f32,
    pub dist: Vec<u16>,
    pub player_cell: (i32, i32),
    pub built_at: u64,
}

impl NavField {
    fn idx(&self, cx: i32, cz: i32) -> Option<usize> {
        (cx >= 0 && cz >= 0 && cx < self.w && cz < self.h).then(|| (cz * self.w + cx) as usize)
    }

    fn cell_of(&self, p: Vec2) -> (i32, i32) {
        (((p.x - self.x0) / NAV_CELL) as i32, ((p.y - self.z0) / NAV_CELL) as i32)
    }

    fn center(&self, cx: i32, cz: i32) -> Vec2 {
        Vec2::new(self.x0 + (cx as f32 + 0.5) * NAV_CELL, self.z0 + (cz as f32 + 0.5) * NAV_CELL)
    }

    /// Distance (cells) at a world point; u16::MAX = blocked / unreachable.
    pub fn dist_at(&self, p: Vec2) -> u16 {
        let (cx, cz) = self.cell_of(p);
        self.idx(cx, cz).map_or(u16::MAX, |i| self.dist[i])
    }

    /// Steering direction at `from`: toward the lowest-distance 8-neighbour
    /// (fixed scan order — deterministic tie-break). `None` when the field
    /// has nothing better (at the player, blocked, unreachable) — callers
    /// fall back to direct pursuit.
    pub fn dir_at(&self, from: Vec2) -> Option<Vec2> {
        let (cx, cz) = self.cell_of(from);
        let here = self.idx(cx, cz).map_or(u16::MAX, |i| self.dist[i]);
        let mut best = here;
        let mut pick: Option<(i32, i32)> = None;
        for (dx, dz) in [(1, 0), (-1, 0), (0, 1), (0, -1), (1, 1), (1, -1), (-1, 1), (-1, -1)] {
            let (nx, nz) = (cx + dx, cz + dz);
            if let Some(i) = self.idx(nx, nz) {
                // diagonal steps must not cut a blocked corner
                if dx != 0 && dz != 0 {
                    let ax = self.idx(cx + dx, cz).map_or(u16::MAX, |i| self.dist[i]);
                    let az = self.idx(cx, cz + dz).map_or(u16::MAX, |i| self.dist[i]);
                    if ax == u16::MAX || az == u16::MAX {
                        continue;
                    }
                }
                if self.dist[i] < best {
                    best = self.dist[i];
                    pick = Some((nx, nz));
                }
            }
        }
        pick.map(|(nx, nz)| (self.center(nx, nz) - from).normalize_or_zero())
    }
}

/// Build the field: block cells whose center is inside any solid (or off the
/// floor), then BFS out from the player cell in fixed neighbour order.
pub fn build_nav(floor: [f32; 4], solids: &[[f32; 4]], player: Vec2, tick: u64) -> NavField {
    let w = ((floor[2] - floor[0]) / NAV_CELL).ceil() as i32;
    let h = ((floor[3] - floor[1]) / NAV_CELL).ceil() as i32;
    let mut nf = NavField { w, h, x0: floor[0], z0: floor[1], dist: vec![u16::MAX; (w * h) as usize], player_cell: (0, 0), built_at: tick };
    let blocked: Vec<bool> = (0..w * h)
        .map(|i| {
            let c = nf.center(i % w, i / w);
            solids.iter().any(|s| c.x >= s[0] && c.x <= s[2] && c.y >= s[1] && c.y <= s[3])
        })
        .collect();
    let (pcx, pcz) = nf.cell_of(player);
    let (pcx, pcz) = (pcx.clamp(0, w - 1), pcz.clamp(0, h - 1));
    nf.player_cell = (pcx, pcz);
    let start = (pcz * w + pcx) as usize;
    if blocked[start] {
        return nf; // player inside a solid?? leave the field empty (direct fallback)
    }
    nf.dist[start] = 0;
    let mut queue = std::collections::VecDeque::with_capacity(1024);
    queue.push_back((pcx, pcz));
    while let Some((cx, cz)) = queue.pop_front() {
        let d = nf.dist[(cz * w + cx) as usize];
        for (dx, dz) in [(1, 0), (-1, 0), (0, 1), (0, -1)] {
            let (nx, nz) = (cx + dx, cz + dz);
            if nx < 0 || nz < 0 || nx >= w || nz >= h {
                continue;
            }
            let i = (nz * w + nx) as usize;
            if blocked[i] || nf.dist[i] != u16::MAX {
                continue;
            }
            nf.dist[i] = d + 1;
            queue.push_back((nx, nz));
        }
    }
    nf
}

/// Cover candidates from the solids: each corner pushed diagonally outward.
/// Computed once at level build (pure function of the spec).
pub fn cover_points(solids: &[[f32; 4]]) -> Vec<Vec2> {
    let mut v = Vec::new();
    for s in solids {
        for (cx, cz, sx, sz) in [(s[0], s[1], -1.0, -1.0), (s[2], s[1], 1.0, -1.0f32), (s[0], s[3], -1.0, 1.0), (s[2], s[3], 1.0, 1.0)] {
            v.push(Vec2::new(cx + sx * 0.5, cz + sz * 0.5));
        }
    }
    v
}

/// Deterministic per-blob scramble for tactic timing/choice: id + decision
/// window through the shared Knuth stride. No RNG draw.
fn tac_hash(id: MobId, salt: u32) -> u32 {
    id.0.wrapping_mul(ID_HASH_STRIDE).wrapping_add(salt.wrapping_mul(GOO_ID_MIX))
}

impl<S: AudioSink> HouseGame<S> {
    /// Pick a cover corner that (a) breaks LOS to the player, (b) is closer
    /// to the blob than the player is, (c) sits at a useful standoff. First
    /// best by distance-to-blob; fixed iteration order = deterministic.
    fn pick_cover(&self, from: Vec2, player: Vec2) -> Option<Vec2> {
        let solids = &self.res.level.solids;
        let floor = self.res.level.floor;
        let mut best: Option<(f32, Vec2)> = None;
        // corners of the player's OWN masonry join the authored cover set:
        // the horde hides behind the corpses you made (chunks are capped at
        // GOO_CHUNK_CAP, so this stays a handful of candidates)
        let chunk_cover: Vec<Vec2> = cover_points(&self.res.chunks);
        for c in self.res.cover.iter().chain(chunk_cover.iter()) {
            // must be ON the floor (corner points of perimeter-adjacent walls
            // land outside it) and reachable per the flow field — a blob
            // grinding at a wall toward an unreachable corner reads as broken
            if c.x < floor[0] + 0.5 || c.y < floor[1] + 0.5 || c.x > floor[2] - 0.5 || c.y > floor[3] - 0.5 {
                continue;
            }
            // must be reachable AND advancing: taking cover that the flow
            // field says is FARTHER from the player than the blob already is
            // reads as a retreat detour (the mother re-crossing the squeeze
            // wall to hide on the wrong side, famously)
            if let Some(nf) = self.res.nav.as_ref() {
                let (dc, db) = (nf.dist_at(*c), nf.dist_at(from));
                if dc == u16::MAX || (db != u16::MAX && dc >= db) {
                    continue;
                }
            }
            let dp = (*c - player).length();
            if dp < 1.6 || dp > 8.5 {
                continue;
            }
            if los_clear2(solids, &self.res.chunks, *c, player) {
                continue; // not cover — the player can see this corner
            }
            let db = (*c - from).length();
            if db > 7.0 {
                continue;
            }
            if best.map_or(true, |(bd, _)| db < bd) {
                best = Some((db, *c));
            }
        }
        best.map(|(_, c)| c)
    }

    /// 3b-pre. The arena brain: advance every live blob's tactic state
    /// machine, then let `goo_step_ai_arena` steer by it. Runs before
    /// `goo_system`; a hard no-op (and RNG-free) off arena levels, so
    /// nothing outside the arena ever sees it.
    pub(crate) fn tactic_system(&mut self) {
        if self.res.arsenal.is_none() || self.mobs.is_empty() {
            return;
        }
        let tick = self.res.cur_tick;
        let p3 = self.player_pos();
        let player = Vec2::new(p3.x, p3.z);

        // flow field upkeep (derived cache — cadence + player-cell change)
        let rebuild = match &self.res.nav {
            None => true,
            Some(nf) => tick.wrapping_sub(nf.built_at) >= NAV_REBUILD_TICKS || nf.cell_of(player) != nf.player_cell,
        };
        if rebuild {
            self.res.nav = Some(build_nav(self.res.level.floor, &self.res.level.solids, player, tick));
        }

        // per-blob tactic transitions (id-sorted handles = fixed order)
        let chunks = self.res.chunks.clone(); // ≤16 rects, cloned once per tick
        let mobs = self.mobs.clone();
        for e in mobs {
            let mut g = self.world.get::<&mut Goo>(e).unwrap();
            if g.fusing > 0 {
                continue;
            }
            // a harpooned body loses its plan (it can't execute anything)
            if g.pinned > 0 {
                g.tac = Tactic::Direct;
                g.strike = 0;
                continue;
            }
            let head = g.ends[0];
            let dist = (player - head).length();
            let solids = &self.res.level.solids;
            g.tac_timer = g.tac_timer.saturating_sub(1);
            match g.tac {
                Tactic::Direct => {
                    // doctrine roll: once per id-staggered decision window.
                    // Maneuvers only start once the blob can SEE the player —
                    // a body still routing through walls (the squeeze slot!)
                    // keeps marching Direct instead of chasing corner points.
                    let window = (tick / DOCTRINE_WINDOW) as u32;
                    let due = (tac_hash(g.id, 7) as u64 % DOCTRINE_WINDOW) == tick % DOCTRINE_WINDOW;
                    if due && dist > TACTIC_NEAR && dist < TACTIC_FAR && los_clear2(solids, &chunks, head, player) {
                        let roll = tac_hash(g.id, window) % 100;
                        let cover = self.pick_cover(head, player);
                        // per-species doctrine: Runners flank, Greens ambush
                        // from cover, Tanks bore straight in (the anchor).
                        let choice = match g.kind {
                            GooKind::Runner => {
                                if roll < 50 {
                                    Some(Tactic::Flank)
                                } else if roll < 80 && cover.is_some() {
                                    Some(Tactic::ToCover)
                                } else {
                                    None
                                }
                            }
                            GooKind::Green => {
                                if roll < 45 && cover.is_some() {
                                    Some(Tactic::ToCover)
                                } else {
                                    None
                                }
                            }
                            GooKind::Tank => None,
                        };
                        match choice {
                            Some(Tactic::Flank) => {
                                // waypoint beside the player, biased by id so
                                // two runners naturally take opposite sides
                                let side = if tac_hash(g.id, 11) & 1 == 0 { 1.0 } else { -1.0 };
                                let to_blob = (head - player).normalize_or_zero();
                                let ang = side * (FLANK_ANGLE + (tac_hash(g.id, 13) % 100) as f32 * 0.01 * FLANK_JITTER);
                                let (s, c) = ang.sin_cos();
                                let dir = Vec2::new(to_blob.x * c - to_blob.y * s, to_blob.x * s + to_blob.y * c);
                                g.tac = Tactic::Flank;
                                g.tac_point = player + dir * FLANK_RADIUS;
                                g.tac_timer = MANEUVER_TIMEOUT;
                            }
                            Some(Tactic::ToCover) => {
                                g.tac = Tactic::ToCover;
                                g.tac_point = cover.unwrap();
                                g.tac_timer = MANEUVER_TIMEOUT;
                            }
                            _ => {}
                        }
                    }
                }
                Tactic::Flank => {
                    let arrived = (g.tac_point - head).length() < ARRIVE;
                    if arrived || g.tac_timer == 0 {
                        g.tac = Tactic::Sprint;
                        g.tac_timer = SPRINT_TICKS;
                        // commit SNAP: rotate_toward lerps through zero at the
                        // 180° antipode (a maneuver often leaves the heading
                        // pointing dead away), so the lunge aims itself
                        g.heading = (player - head).normalize_or_zero();
                    }
                }
                Tactic::ToCover => {
                    let arrived = (g.tac_point - head).length() < ARRIVE;
                    if arrived {
                        // step out toward the player past the corner: PEEK
                        g.tac = Tactic::Peek;
                        g.tac_point = head + (player - head).normalize_or_zero() * PEEK_STEP;
                        g.tac_timer = PEEK_TICKS;
                    } else if g.tac_timer == 0 {
                        g.tac = Tactic::Direct; // snagged — reconsider
                    }
                }
                Tactic::Peek => {
                    if g.tac_timer == 0 {
                        // duck back behind the corner it came from
                        g.tac = Tactic::Hide;
                        g.tac_point = head + (head - player).normalize_or_zero() * PEEK_STEP;
                        g.tac_timer = HIDE_TICKS + (tac_hash(g.id, 17) % HIDE_JITTER) as u16;
                    }
                }
                Tactic::Hide => {
                    if g.tac_timer == 0 {
                        g.tac = Tactic::Sprint; // burst from around the corner
                        g.tac_timer = SPRINT_TICKS;
                        g.heading = (player - head).normalize_or_zero(); // commit snap
                    }
                }
                Tactic::CoordWait => {
                    if tick >= g.strike {
                        g.tac = Tactic::Sprint;
                        g.tac_timer = SPRINT_TICKS;
                        g.strike = 0;
                        g.heading = (player - head).normalize_or_zero(); // commit snap
                    }
                }
                Tactic::Sprint => {
                    if g.tac_timer == 0 || dist < TACTIC_NEAR * 0.6 {
                        g.tac = Tactic::Direct;
                    }
                }
            }
            let _ = solids;
        }

        // comms: one pact per cooldown window. Scan id-sorted pairs; the
        // first eligible pair agrees a strike tick and both start blinking.
        if tick >= self.res.next_comm_tick && self.mobs.len() >= 2 {
            let solids = self.res.level.solids.clone();
            let mut pact: Option<(sim_core::Entity, sim_core::Entity, u64)> = None;
            'pair: for a in 0..self.mobs.len() {
                let ga = self.world.get::<&Goo>(self.mobs[a]).unwrap();
                if !comm_ready(&ga, player, &solids) {
                    continue;
                }
                for b in (a + 1)..self.mobs.len() {
                    let gb = self.world.get::<&Goo>(self.mobs[b]).unwrap();
                    if !comm_ready(&gb, player, &solids) {
                        continue;
                    }
                    if (ga.ends[0] - gb.ends[0]).length() > COMM_RANGE {
                        continue;
                    }
                    if !los_clear2(&solids, &self.res.chunks, ga.ends[0], gb.ends[0]) {
                        continue; // they must SEE each other to signal
                    }
                    let strike = tick + COMM_DELAY + tac_hash(ga.id, 23) as u64 % COMM_JITTER;
                    pact = Some((self.mobs[a], self.mobs[b], strike));
                    break 'pair;
                }
            }
            if let Some((ea, eb, strike)) = pact {
                for e in [ea, eb] {
                    let mut g = self.world.get::<&mut Goo>(e).unwrap();
                    g.tac = Tactic::CoordWait;
                    g.strike = strike;
                    g.tac_timer = 0;
                }
                self.res.next_comm_tick = strike + COMM_COOLDOWN;
            }
        }
    }

    /// Arena steering — replaces the legacy wander/seek match when the level
    /// has an arsenal. Returns `(mv, speed)` like `goo_step_ai`; NO RNG.
    pub(crate) fn goo_step_ai_arena(&mut self, g: &mut Goo, pxz: Vec2) -> (f32, f32) {
        let (kind_speed, kind_turn, _) = goo_kind_moves(g.kind);
        let head = g.ends[0];
        // (target direction, move gate, speed multiplier, turn multiplier)
        let nav_to_player = || {
            self.res.nav.as_ref().and_then(|nf| nf.dir_at(head)).unwrap_or_else(|| (pxz - head).normalize_or_zero())
        };
        let (dir, mv, smult, tmult) = match g.tac {
            Tactic::Direct => (nav_to_player(), 1.0, 1.0, 1.0),
            Tactic::Sprint => (nav_to_player(), 1.0, sprint_mult(g.kind), SPRINT_TURN),
            Tactic::Flank | Tactic::ToCover | Tactic::Hide => {
                let to = g.tac_point - head;
                let arrived = to.length() < ARRIVE;
                (to.normalize_or_zero(), if arrived { 0.0 } else { 1.0 }, 1.15, 1.2)
            }
            Tactic::Peek => {
                let to = g.tac_point - head;
                let arrived = to.length() < ARRIVE * 0.7;
                // slow, deliberate step out — the show-yourself move
                (to.normalize_or_zero(), if arrived { 0.0 } else { 1.0 }, 0.45, 1.0)
            }
            // creep forward very slowly while blinking (menace, not statue)
            Tactic::CoordWait => (nav_to_player(), 1.0, 0.22, 0.7),
        };
        if let Some(td) = dir.try_normalize() {
            g.heading = rotate_toward(g.heading, td, GOO_MAX_TURN * kind_turn * tmult);
        }
        let cure_mul = (1.0 - GOO_CURE_SLOW * g.cure as f32).max(0.4);
        (mv, goo_tier_speed(g.tier) * kind_speed * cure_mul * smult)
    }
}

/// Comm-pact eligibility: an unhurt-enough blob mid-maneuver can't sign up;
/// only bodies currently approaching (Direct/Flank) with the player in
/// sensing range join a pact.
fn comm_ready(g: &Goo, player: Vec2, solids: &[[f32; 4]]) -> bool {
    let d = (player - g.ends[0]).length();
    matches!(g.tac, Tactic::Direct | Tactic::Flank)
        && g.pinned == 0
        && g.fusing == 0
        // close enough to care, far enough that scheduling makes sense — a
        // body already ON the player just attacks, it doesn't diarize
        && d < COMM_SEE
        && d > TACTIC_NEAR
        // you can't co-ordinate an attack on a target you can't see — and a
        // pact freeze behind a wall reads as a stuck blob, not menace
        && los_clear(solids, g.ends[0], player)
}

/// The comm blink the renderer shows: an accelerating pulse that both pact
/// members share (same strike tick → same phase → visibly synchronized).
/// 0 when silent. Pure presentation, derived from hashed state.
pub fn comm_pulse(tac: Tactic, strike: u64, tick: u64) -> f32 {
    if tac != Tactic::CoordWait || strike <= tick {
        return 0.0;
    }
    let rem = strike - tick;
    // blink period tightens as the strike nears: 20 ticks -> 5
    let period = (rem / 8).clamp(5, 20);
    let on = (rem / period) % 2 == 0;
    if on {
        // brighter as it gets closer
        let total = COMM_DELAY + COMM_JITTER;
        0.45 + 0.55 * (1.0 - (rem as f32 / total as f32).min(1.0))
    } else {
        0.0
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::spec::{arena_level, MobSpec};
    use crate::GooKind;
    use sim_core::{NullSink, Simulation, Tick};

    fn wallish() -> Vec<[f32; 4]> {
        vec![[-2.0, -0.25, 2.0, 0.25]] // a 4-wu wall across the origin
    }

    #[test]
    fn los_blocked_by_wall_and_clear_beside_it() {
        let s = wallish();
        assert!(!los_clear(&s, Vec2::new(0.0, -3.0), Vec2::new(0.0, 3.0)), "straight through the wall");
        assert!(los_clear(&s, Vec2::new(-4.0, -3.0), Vec2::new(-4.0, 3.0)), "past the end of the wall");
        assert!(los_clear(&s, Vec2::new(-3.0, -1.0), Vec2::new(3.0, -1.0)), "parallel, never touching");
    }

    #[test]
    fn nav_field_routes_around_a_wall() {
        let floor = [-5.0, -5.0, 5.0, 5.0];
        let s = wallish();
        let player = Vec2::new(0.0, 3.0);
        let nf = build_nav(floor, &s, player, 0);
        // a point straight across the wall is reachable, but longer than the
        // crow flies: distance must exceed the straight-line cell count
        let d = nf.dist_at(Vec2::new(0.0, -3.0));
        assert!(d != u16::MAX, "reachable around the wall");
        let straight = (6.0 / NAV_CELL) as u16;
        assert!(d > straight, "wall detour is longer than the crow flies: {d} vs {straight}");
        // following dir_at must strictly descend the field
        let mut p = Vec2::new(0.0, -3.0);
        let mut last = nf.dist_at(p);
        for _ in 0..40 {
            let Some(dir) = nf.dir_at(p) else { break };
            p += dir * NAV_CELL;
            let now = nf.dist_at(p);
            assert!(now <= last, "descending the flow field");
            last = now;
        }
        assert!(last < nf.dist_at(Vec2::new(0.0, -3.0)));
    }

    #[test]
    fn cover_points_break_los() {
        let s = wallish();
        let cps = cover_points(&s);
        assert_eq!(cps.len(), 4);
        // at least one corner point is hidden from a player north of the wall
        let player = Vec2::new(0.0, 3.0);
        assert!(cps.iter().any(|c| !los_clear(&s, *c, player)));
    }

    #[test]
    fn arena_blobs_leave_direct_and_sprint_eventually() {
        let mut g = crate::HouseGame::new(&arena_level(), NullSink);
        let mut seen_maneuver = false;
        let mut seen_sprint = false;
        for t in 0..1200u64 {
            g.tick(Tick(t), &[]);
            for &e in &g.mobs {
                let gg = g.world.get::<&Goo>(e).unwrap();
                match gg.tac {
                    Tactic::Flank | Tactic::ToCover | Tactic::Peek | Tactic::Hide | Tactic::CoordWait => seen_maneuver = true,
                    Tactic::Sprint => seen_sprint = true,
                    Tactic::Direct => {}
                }
            }
            if seen_maneuver && seen_sprint {
                break;
            }
        }
        assert!(seen_maneuver, "some blob picked a maneuver tactic within 20 s");
        assert!(seen_sprint, "some blob committed a sprint within 20 s");
    }

    #[test]
    fn comm_pact_synchronizes_two_blobs() {
        // two runners near each other, player in range, open floor
        let mut spec = arena_level();
        spec.static_solids = vec![];
        spec.mobs = vec![
            MobSpec { id: crate::spec::MobId(0), tier: 1, kind: GooKind::Runner, pos: glam::Vec3::new(-1.0, 0.0, 1.0) },
            MobSpec { id: crate::spec::MobId(1), tier: 1, kind: GooKind::Runner, pos: glam::Vec3::new(1.0, 0.0, 1.0) },
        ];
        let mut g = crate::HouseGame::new(&spec, NullSink);
        let mut agreed: Option<u64> = None;
        for t in 0..900u64 {
            g.tick(Tick(t), &[]);
            let strikes: Vec<u64> = g.mobs.iter().map(|&e| g.world.get::<&Goo>(e).unwrap().strike).collect();
            if strikes.len() == 2 && strikes[0] != 0 && strikes[0] == strikes[1] {
                agreed = Some(strikes[0]);
                break;
            }
        }
        let strike = agreed.expect("the pair agreed a strike tick within 15 s");
        // ... and both sprint AT the agreed tick
        let mut t = g.res.cur_tick;
        while t < strike + 2 {
            t += 1;
            g.tick(Tick(t), &[]);
        }
        for &e in &g.mobs {
            let gg = g.world.get::<&Goo>(e).unwrap();
            assert_eq!(gg.tac, Tactic::Sprint, "both pact members sprint at the strike tick");
        }
    }

    #[test]
    fn large_blob_squeezes_through_the_slot() {
        // the arena's north-wall squeeze slot is 0.5625 wu; a Large body is
        // ~1 wu across — the flow field routes it in and the PBF fluid must
        // physically funnel through (head and particles are point colliders,
        // the BODY squeezes). Blob north of the slot, player due south.
        let mut spec = arena_level();
        spec.static_solids = vec![[-10.0, -2.125, -7.0, -1.875], [-6.4375, -2.125, -3.25, -1.875]];
        spec.mobs = vec![MobSpec { id: crate::spec::MobId(0), tier: 0, kind: GooKind::Green, pos: glam::Vec3::new(-6.71875, 0.0, -4.5) }];
        spec.player_start = glam::Vec3::new(-6.71875, 0.0, 3.0);
        let mut g = crate::HouseGame::new(&spec, NullSink);
        let start_z = {
            let gg = g.world.get::<&Goo>(g.mobs[0]).unwrap();
            gg.centroid().y
        };
        assert!(start_z < -2.125, "starts north of the wall");
        let mut through_at = None;
        for t in 0..2600u64 {
            g.tick(Tick(t), &[]);
            let c = g.world.get::<&Goo>(g.mobs[0]).unwrap().centroid();
            if c.y > -1.0 {
                through_at = Some(t);
                break;
            }
        }
        let t = through_at.expect("the Large squeezed through the slot within ~43 s");
        // sanity: it went THROUGH the slot, not around (the wall spans the
        // whole west floor; x must still be near the slot when it crossed)
        let c = g.world.get::<&Goo>(g.mobs[0]).unwrap().centroid();
        assert!(c.x > -8.5 && c.x < -4.5, "crossed near the slot (x = {}), tick {t}", c.x);
    }

    #[test]
    fn comm_pulse_blinks_and_brightens() {
        let strike = 1000u64;
        // silent outside CoordWait
        assert_eq!(comm_pulse(Tactic::Direct, strike, 900), 0.0);
        // somewhere in the countdown it is lit, and it goes dark in between
        let lit: Vec<f32> = (900..1000).map(|t| comm_pulse(Tactic::CoordWait, strike, t)).collect();
        assert!(lit.iter().any(|&v| v > 0.0), "blinks on");
        assert!(lit.iter().any(|&v| v == 0.0), "blinks off");
        // late pulses are brighter than early ones
        let early = lit.iter().take(20).cloned().fold(0.0f32, f32::max);
        let late = lit.iter().rev().take(20).cloned().fold(0.0f32, f32::max);
        assert!(late >= early, "accelerating/brightening telegraph: {early} -> {late}");
    }
}
