//! The thief sim: M1 spine + M2 playable-slice systems
//! (docs/spec/12 — "M1 · The spine, headless" / "M2 · Playable slice").
//!
//! Greybox scope, whole spine: a player with a describable look moves through
//! an edge-gated level; NPCs sense (cones + LOS + the CPU light field, 05a),
//! remember, and report with real travel latency (05b's "race the rumor");
//! reported observations correlate into Cases; a guard who later SEES someone
//! matching a live profile past the scrutiny threshold hails them and closes
//! in — the graded social stop of 05c: bluff / bribe / submit-to-search /
//! flee, each with consequences that feed the engine. The alertness ladder
//! (08) — fast rise, slow decay to a heightened baseline — arbitrates NPC
//! behavior over their routine.
//!
//! M2 additions: sim-owned movement cadence (sneak/walk/run modes, so replay
//! never depends on shell frame timing), encumbrance + the carry-capacity
//! feel knob (07), the day/night clock + ambient outdoor light feel knob
//! (04), hiding spots, coin, the confrontation ladder (05c), and a
//! tick-stamped event stream that projects to the prose log (11, `log.rs`).
//!
//! Determinism: all integer state; NPCs iterate in spec order; observations
//! ingest in (tick, npc-order) order; movement/pathing is BFS with a fixed
//! direction order; stop checks are stateless hash(seed, tick) rolls.
//! `state_hash` is a portable replay oracle.

use super::deduction::CaseFile;
use super::grid::{
    CellField, CellKind, CellPos, Dir, DoorState, EdgeKind, Passage, Prop, TownGrid, DIRS,
    LOUD_RUN, LOUD_SNEAK, LOUD_WALK,
};
use super::perception::{
    ActionKind, Description, Feature, Headwear, Hue, NpcId, Observation, Source,
};
use sim_core::{Simulation, Tick};

// ---------------------------------------------------------------------------
// Tunables (integers). The two M2 FEEL-TEST knobs — day length and carry
// capacity — live in `ThiefSpec` (replay identity must carry everything that
// shaped the sim, docs/spec/12). The rest are fixed constants of the design.
// ---------------------------------------------------------------------------

/// NPC vision range, cells (Chebyshev), inside a 90° facing cone.
pub const VISION_RANGE: i32 = 8;
/// Minimum read clarity for a sighting to register at all.
pub const CONF_GATE: i32 = 25;
/// A memory this alarming sends a civilian off to report it.
pub const REPORT_SALIENCE: u8 = 60;
/// Scrutiny at/above this and an authority moves to stop/pursue (05c).
pub const STOP_SCRUTINY: i32 = 15;
/// NPCs take one grid step per this many ticks (routine pace).
pub const MOVE_PERIOD: u64 = 12;
/// Approaching/pursuing guards close at this brisker cadence.
pub const MOVE_PERIOD_HUNT: u64 = 8;
/// An NPC re-records a continuously-visible subject doing the SAME thing at
/// most this often; a change of action registers immediately. (Staring is
/// one memory, not sixty a second.)
pub const OBS_PERIOD: u64 = 60;
/// Alertness decays one point per this many ticks.
pub const ALERT_DECAY_PERIOD: u64 = 30;
/// Light level below which a sighting is heavily degraded (night stealth).
pub const DIM_LIGHT: i32 = 4;
pub const DARK_LIGHT: i32 = 2;
/// Secondhand confidence: reported observations keep 3/4 of their clarity.
const SECONDHAND_NUM: u32 = 3;
const SECONDHAND_DEN: u32 = 4;

/// Player step cadence by mode, ticks per cell. The SIM owns the rate —
/// excess Move commands are dropped, so live play and trace replay agree
/// regardless of how often the shell pushes.
pub const STEP_SNEAK: u64 = 14;
pub const STEP_WALK: u64 = 8;
pub const STEP_RUN: u64 = 5;
/// Encumbrance (07): each point of carried bulk adds this many ticks per
/// step — only under the encumbrance carry model (`carry_capacity: Some`).
pub const ENCUMBER_STEP: u64 = 2;

/// An approach that hasn't cornered you within this many ticks becomes a
/// chase — walking away from a hail reads as evasion.
pub const APPROACH_TIMEOUT: u64 = 300;
/// Ticks the player has to answer a stop before the guard forces a search.
pub const STOP_DECIDE_TICKS: u64 = 300;
/// After resolving a stop this guard leaves you be for a while.
pub const RESTOP_COOLDOWN: u64 = 900;
/// Head start after bolting from a stop before a pursuer's grab can land.
pub const CATCH_GRACE: u64 = 90;
/// What a street bribe costs, and the fine when caught red-handed.
pub const BRIBE_COST: i32 = 8;
pub const CAUGHT_FINE: i32 = 5;
/// Case-confidence spikes: a caught lie / attempted bribe confirms a little;
/// flight from a stop all but confirms guilt (05c).
pub const LIE_CONF_BUMP: u16 = 25;
pub const FLEE_CONF_BUMP: u16 = 60;

/// Ambient outdoor light by day phase (04: strong day/night contrast).
/// Interior cells see lamps only — a windowless back room is dark at noon.
pub const AMBIENT_DAY: i32 = 8;
pub const AMBIENT_DAWN_DUSK: i32 = 3;
pub const AMBIENT_NIGHT: i32 = 1;

// ---------------------------------------------------------------------------
// The clock (04) — continuous, deterministic, tunable day length
// ---------------------------------------------------------------------------

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum DayPhase {
    Dawn,
    Day,
    Dusk,
    Night,
}

impl DayPhase {
    pub fn code(self) -> u8 {
        match self {
            DayPhase::Dawn => 0,
            DayPhase::Day => 1,
            DayPhase::Dusk => 2,
            DayPhase::Night => 3,
        }
    }
}

/// Tick → phase: dawn ⅛, day ½, dusk ⅛, night ¼ of the day. Runs start at
/// dawn (tick 0).
pub fn day_phase(tick: u64, day_len_ticks: u64) -> DayPhase {
    let f8 = (tick % day_len_ticks) * 8 / day_len_ticks;
    match f8 {
        0 => DayPhase::Dawn,
        1..=4 => DayPhase::Day,
        5 => DayPhase::Dusk,
        _ => DayPhase::Night,
    }
}

/// Minute-of-day (0..1440) for prose clocks — dawn maps to 06:00.
pub fn day_minute(tick: u64, day_len_ticks: u64) -> u32 {
    (((tick % day_len_ticks) * 1440 / day_len_ticks) as u32 + 6 * 60) % 1440
}

fn ambient(phase: DayPhase) -> i32 {
    match phase {
        DayPhase::Dawn | DayPhase::Dusk => AMBIENT_DAWN_DUSK,
        DayPhase::Day => AMBIENT_DAY,
        DayPhase::Night => AMBIENT_NIGHT,
    }
}

// ---------------------------------------------------------------------------
// Spec — the level source of truth (ordered Vecs only)
// ---------------------------------------------------------------------------

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Role {
    Guard,
    Civilian,
}

#[derive(Clone, Debug)]
pub struct NpcSpec {
    pub id: NpcId,
    pub role: Role,
    /// Prose handle for the event log ("the watchman"); cosmetic, unhashed.
    pub name: String,
    pub start: CellPos,
    pub facing: Dir,
    /// Waypoint loop for guards; a civilian stays near `start` (v0 routine —
    /// module 04 schedules replace this at M3).
    pub patrol: Vec<CellPos>,
    /// Will this one take a street bribe? (Seeded per-NPC by the generator;
    /// authored here.) Attempting to buy an honest guard is damning.
    pub corruptible: bool,
}

#[derive(Clone)]
pub struct ThiefSpec {
    pub grid: TownGrid,
    pub player_start: CellPos,
    /// The player's ground-truth look — every field Seen (module 06's worn
    /// state; observers down-grade it to partial Descriptions).
    pub player_look: Description,
    pub npcs: Vec<NpcSpec>,
    /// The stealable target (M1/M2: one strongbox cell).
    pub target: CellPos,
    /// Bulk of the target loot (07): what encumbrance weighs.
    pub target_bulk: i32,
    /// Static light sources (cell, intensity) — the sim-side light field.
    pub lights: Vec<(CellPos, i32)>,
    /// FEEL KNOB (04): ticks per full day/night cycle.
    pub day_len_ticks: u64,
    /// FEEL KNOB (07): `Some(cap)` = encumbrance model (bulk-limited,
    /// carrying slows you); `None` = free-carry comparison model.
    pub carry_capacity: Option<i32>,
    /// Starting purse — street bribes and fines come out of this (09 proper
    /// lands at M5; this is the minimum the confrontation ladder needs).
    pub player_coin: i32,
    pub seed: u64,
}

// ---------------------------------------------------------------------------
// Commands & events
// ---------------------------------------------------------------------------

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum MoveMode {
    Sneak,
    Walk,
    Run,
}

impl MoveMode {
    pub fn code(self) -> u8 {
        match self {
            MoveMode::Sneak => 0,
            MoveMode::Walk => 1,
            MoveMode::Run => 2,
        }
    }
}

/// Your outs at a stop (05c's graded social stop). Papers are module-10
/// forgery territory — deferred.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum StopChoice {
    Bluff,
    Bribe,
    Submit,
    Flee,
}

#[derive(Clone, Copy, PartialEq, Debug)]
pub enum Command {
    /// Step one cell (dx, dz ∈ {-1,0,1}, one axis only). The sim rate-limits
    /// to the mode's cadence; extra commands are dropped, not queued.
    Move {
        dx: i16,
        dz: i16,
        mode: MoveMode,
    },
    /// Take the loot if standing on it (and it fits the carry model).
    Steal,
    /// Set the loot down where you stand (stash it, ditch it mid-chase).
    Drop,
    /// Change worn layers (v0: anywhere unobserved-or-not; M4 adds
    /// witnessed-change). Ignored during a stop.
    Outfit {
        top: Hue,
        headwear: Headwear,
    },
    /// Answer an active stop.
    Stop(StopChoice),
    Wait,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum StopOutcome {
    Bluffed,
    Bribed,
    CleanSearch,
    Caught,
    Fled,
}

#[derive(Clone, Copy, PartialEq, Debug)]
pub enum GameEvent {
    Stole {
        at: CellPos,
    },
    Dropped {
        at: CellPos,
    },
    Seen {
        by: NpcId,
        action: ActionKind,
        salience: u8,
    },
    Reported {
        by: NpcId,
        to: NpcId,
        count: u8,
    },
    /// A case opened; `profile` is the wanted description at that moment
    /// (carried in the event so the log projection is a pure function).
    CaseOpened {
        id: u16,
        profile: Description,
    },
    /// A clean search struck this look from the case (05c).
    CaseCleared {
        id: u16,
    },
    /// A guard breaks off to stop-and-question you (05c notice → approach).
    Hailed {
        guard: NpcId,
    },
    /// The guard reached you: the stop is live, answer it.
    StopBegan {
        guard: NpcId,
    },
    LieCaught {
        guard: NpcId,
    },
    BribeRefused {
        guard: NpcId,
    },
    StopResolved {
        guard: NpcId,
        outcome: StopOutcome,
    },
    /// Grabbed — at a stop gone wrong or run down in pursuit.
    Caught {
        guard: NpcId,
        had_loot: bool,
    },
    /// A guard gives chase (fled stop, or an approach you walked out on).
    HuntStarted {
        guard: NpcId,
    },
    PhaseChanged {
        phase: DayPhase,
    },
}

/// Tick-stamped event — the deterministic stream the prose log projects
/// (docs/spec/11: "a human-readable projection of the same deterministic
/// sim-event stream").
#[derive(Clone, Copy, PartialEq, Debug)]
pub struct Stamped {
    pub tick: u64,
    pub ev: GameEvent,
}

// ---------------------------------------------------------------------------
// NPC runtime state — the alertness ladder (module 08)
// ---------------------------------------------------------------------------

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum NpcState {
    Routine,
    Notice,
    Investigate,
    /// Civilian: traveling to tell a guard what they saw.
    Reporting,
    /// Guard: closing in to stop-and-question a match (05c step 1).
    Approach,
    /// Guard: standing on you, running the stop (05c step 2).
    Confront,
    /// Guard: actively hunting a fleeing/evading suspect.
    Pursue,
}

impl NpcState {
    pub fn code(self) -> u8 {
        match self {
            NpcState::Routine => 0,
            NpcState::Notice => 1,
            NpcState::Investigate => 2,
            NpcState::Reporting => 3,
            NpcState::Pursue => 4,
            NpcState::Approach => 5,
            NpcState::Confront => 6,
        }
    }
}

#[derive(Clone, Debug)]
struct Npc {
    spec: NpcSpec,
    pos: CellPos,
    facing: Dir,
    state: NpcState,
    /// 0..=100; fast rise, slow decay to `baseline`.
    alertness: i32,
    /// Heightened floor after a real scare (08: never back to oblivious).
    baseline: i32,
    /// Personal memory: everything this NPC perceived (05b ground truth).
    memory: Vec<Observation>,
    /// How many of `memory` have been handed to the authorities.
    reported: usize,
    /// Where the current stimulus points (investigate / pursue anchor).
    stimulus: Option<CellPos>,
    waypoint: usize,
    /// (tick, action, confidence) of this NPC's last recorded sighting of
    /// the player — the re-notice cooldown.
    last_obs: Option<(u64, ActionKind, u8)>,
    /// Tick the current approach was hailed at (evasion timeout anchor).
    hail_since: u64,
    /// Tick this guard last resolved a stop/catch with you — no re-stop
    /// inside RESTOP_COOLDOWN, no grab inside CATCH_GRACE.
    recent_stop: Option<u64>,
}

// ---------------------------------------------------------------------------
// The game
// ---------------------------------------------------------------------------

#[derive(Clone, Copy, Debug)]
struct StopState {
    /// Index into `npcs` of the confronting guard.
    guard: usize,
    began: u64,
}

pub struct ThiefGame {
    spec: ThiefSpec,
    grid: TownGrid,
    light: CellField,
    player: CellPos,
    look: Description,
    carrying: bool,
    /// Carried bulk (07); slows the step cadence under encumbrance.
    load: i32,
    /// The purse: bribes and fines.
    coin: i32,
    /// Where the loot lies when not carried (None while carried or seized).
    loot_pos: Option<CellPos>,
    /// Loot seized at a catch is gone for the run.
    loot_seized: bool,
    /// Earliest tick the next step may land (sim-owned movement cadence).
    next_move_at: u64,
    /// Ticks since the theft (drives Fleeing reads); u64::MAX = not yet.
    stole_at: u64,
    stole_this_tick: bool,
    npcs: Vec<Npc>,
    stop: Option<StopState>,
    pub cases: CaseFile,
    pub events: Vec<Stamped>,
    tick: u64,
}

/// Per-NPC read model for presentation (alert bubbles, facing cones).
#[derive(Clone, Copy, Debug)]
pub struct NpcView {
    pub id: NpcId,
    pub role: Role,
    pub pos: CellPos,
    pub facing: Dir,
    pub state: NpcState,
    pub alertness: i32,
}

/// The live stop, for the choice UI.
#[derive(Clone, Copy, Debug)]
pub struct StopView {
    pub guard: NpcId,
    /// Ticks until the guard stops waiting and forces a search.
    pub ticks_left: u64,
}

#[derive(Clone, Debug)]
pub struct ThiefSnapshot {
    pub player: CellPos,
    pub carrying: bool,
    pub load: i32,
    pub coin: i32,
    pub loot_pos: Option<CellPos>,
    pub npcs: Vec<NpcView>,
    pub n_cases: usize,
    /// Live scrutiny of the player's current look — the exposure meter.
    pub scrutiny: i32,
    /// Sim light level at the player's cell — the stealth read the GI
    /// visualizes (05a: what looks dark must BE dark to the sim).
    pub light: i32,
    pub phase: DayPhase,
    /// Minute-of-day, 0..1440 (for prose clocks).
    pub day_min: u32,
    pub stop: Option<StopView>,
    /// True when concealed in a hiding spot (standing still inside one).
    pub hidden: bool,
}

impl ThiefGame {
    pub fn new(spec: ThiefSpec) -> ThiefGame {
        let grid = spec.grid.clone();
        let light = grid.light_field(&spec.lights);
        let npcs = spec
            .npcs
            .iter()
            .map(|s| Npc {
                spec: s.clone(),
                pos: s.start,
                facing: s.facing,
                state: NpcState::Routine,
                alertness: 0,
                baseline: 0,
                memory: Vec::new(),
                reported: 0,
                stimulus: None,
                waypoint: 0,
                last_obs: None,
                hail_since: 0,
                recent_stop: None,
            })
            .collect();
        ThiefGame {
            player: spec.player_start,
            look: spec.player_look,
            carrying: false,
            load: 0,
            coin: spec.player_coin,
            loot_pos: Some(spec.target),
            loot_seized: false,
            next_move_at: 0,
            stole_at: u64::MAX,
            stole_this_tick: false,
            grid,
            light,
            npcs,
            stop: None,
            cases: CaseFile::new(),
            events: Vec::new(),
            spec,
            tick: 0,
        }
    }

    /// Read access for visualization (the mapviz clip bin, the viewer
    /// adapter) — sim-internal state stays private otherwise.
    pub fn grid(&self) -> &TownGrid {
        &self.grid
    }

    pub fn look(&self) -> &Description {
        &self.look
    }

    pub fn spec(&self) -> &ThiefSpec {
        &self.spec
    }

    /// Effective sim light at a cell: lamp field, plus the day-phase ambient
    /// on outdoor ground (04). THE stealth-read source of truth — the GI
    /// visualizes this, never the reverse (05a).
    pub fn light_at(&self, pos: CellPos) -> i32 {
        let lamp = self.light.level(&self.grid, pos);
        if self.grid.cell(pos).kind == CellKind::Outdoor {
            lamp.max(ambient(day_phase(self.tick, self.spec.day_len_ticks)))
        } else {
            lamp
        }
    }

    fn emit(&mut self, ev: GameEvent) {
        self.events.push(Stamped {
            tick: self.tick,
            ev,
        });
    }

    /// Is the player concealed right now? (In a hiding spot, holding still —
    /// stepping in or out is visible.)
    fn player_hidden(&self, moved: bool) -> bool {
        self.grid.cell(self.player).prop == Prop::HidingSpot && !moved
    }

    /// Can NPC `i` see the player this instant (cone + LOS + range; the
    /// hunt's live-tracking check — read clarity is sense()'s business)?
    fn can_see(&self, i: usize) -> bool {
        let npc = &self.npcs[i];
        self.grid.cell(self.player).prop != Prop::HidingSpot
            && in_cone(npc.pos, npc.facing, self.player)
            && chebyshev(npc.pos, self.player) <= VISION_RANGE
            && self.grid.los(npc.pos, self.player).clear
    }

    /// Step cadence for a mode under the current load (07 encumbrance).
    fn step_period(&self, mode: MoveMode) -> u64 {
        let base = match mode {
            MoveMode::Sneak => STEP_SNEAK,
            MoveMode::Walk => STEP_WALK,
            MoveMode::Run => STEP_RUN,
        };
        if self.spec.carry_capacity.is_some() {
            base + ENCUMBER_STEP * self.load.max(0) as u64
        } else {
            base
        }
    }

    // -- systems, fixed source order --------------------------------------

    /// 1 · Player commands → movement, theft, outfit, stop answers. Emits
    /// noise. Returns the mode of a step taken this tick (None = stood
    /// still), which feeds the motion term of the vision read.
    fn resolve_commands(
        &mut self,
        cmds: &[Command],
        noises: &mut Vec<(CellPos, i32)>,
    ) -> Option<MoveMode> {
        self.stole_this_tick = false;
        let mut moved: Option<MoveMode> = None;
        for c in cmds {
            match *c {
                Command::Move { dx, dz, mode } => {
                    let dir = match (dx, dz) {
                        (-1, 0) => Dir::Xm,
                        (1, 0) => Dir::Xp,
                        (0, -1) => Dir::Zm,
                        (0, 1) => Dir::Zp,
                        _ => continue,
                    };
                    // The sim owns the cadence: too soon = dropped.
                    if self.tick < self.next_move_at {
                        continue;
                    }
                    match self.grid.passage(self.player, dir) {
                        Passage::Free => {}
                        Passage::OpenFirst => {
                            // v0: doors open as you pass (noisier); windows too.
                            if let EdgeKind::Door(_) = self.grid.edge(self.player, dir) {
                                self.grid.set_edge(
                                    self.player,
                                    dir,
                                    EdgeKind::Door(DoorState::Open),
                                );
                            } else {
                                continue; // shut windows stay shut for v0 movement
                            }
                            noises.push((self.player, LOUD_WALK + 4));
                        }
                        _ => continue, // locked/vault/climb are M3+ verbs
                    }
                    // Bolting out of a live stop IS the flee answer (05c).
                    if self.stop.is_some() {
                        self.resolve_stop(StopChoice::Flee);
                    }
                    self.player = self.player.step(dir);
                    self.next_move_at = self.tick + self.step_period(mode);
                    moved = Some(mode);
                    let mat_mod = self.grid.cell(self.player).material.step_loudness_mod();
                    let base = match mode {
                        MoveMode::Sneak => LOUD_SNEAK,
                        MoveMode::Walk => LOUD_WALK,
                        MoveMode::Run => LOUD_RUN,
                    };
                    // A heavy sack rattles (only under the encumbrance model).
                    let rattle = if self.spec.carry_capacity.is_some() {
                        self.load.max(0) / 2
                    } else {
                        0
                    };
                    noises.push((self.player, base + mat_mod + rattle));
                }
                Command::Steal => {
                    if self.stop.is_some() || self.loot_pos != Some(self.player) {
                        continue;
                    }
                    if let Some(cap) = self.spec.carry_capacity {
                        if self.load + self.spec.target_bulk > cap {
                            continue;
                        }
                    }
                    self.carrying = true;
                    self.load += self.spec.target_bulk;
                    self.loot_pos = None;
                    self.stole_at = self.tick;
                    self.stole_this_tick = true;
                    noises.push((self.player, LOUD_WALK));
                    self.emit(GameEvent::Stole { at: self.player });
                }
                Command::Drop => {
                    if self.stop.is_some() || !self.carrying {
                        continue;
                    }
                    self.carrying = false;
                    self.load = 0;
                    self.loot_pos = Some(self.player);
                    self.emit(GameEvent::Dropped { at: self.player });
                }
                Command::Outfit { top, headwear } => {
                    if self.stop.is_some() {
                        continue;
                    }
                    self.look = Description {
                        top: Feature::Seen(top),
                        headwear: Feature::Seen(headwear),
                        ..self.look
                    };
                }
                Command::Stop(choice) => {
                    if self.stop.is_some() {
                        self.resolve_stop(choice);
                    }
                }
                Command::Wait => {}
            }
        }
        moved
    }

    /// What is the player DOING, as an observer would name it?
    fn player_action(&self, moved_recently: bool) -> ActionKind {
        if self.stole_this_tick {
            ActionKind::Stealing
        } else if self.carrying && self.tick.saturating_sub(self.stole_at) < 600 && moved_recently {
            ActionKind::Fleeing
        } else if self.carrying && moved_recently {
            ActionKind::Carrying
        } else {
            ActionKind::Loitering
        }
    }

    /// 2 · NPC senses: vision cones (05a). A sighting emits an Observation
    /// into the NPC's own memory; guards (authority) also ingest into the
    /// case file at once and run the scrutiny check → the hail (05c).
    fn sense(&mut self, moved: Option<MoveMode>) {
        // Concealment: a still figure inside a hiding spot resolves to
        // nobody's cone (going to ground, 05c pursuit-and-escape).
        if self.player_hidden(moved.is_some()) {
            return;
        }
        let action = self.player_action(moved.is_some());
        for i in 0..self.npcs.len() {
            let npc = &self.npcs[i];
            if !in_cone(npc.pos, npc.facing, self.player) {
                continue;
            }
            let sight = self.grid.los(npc.pos, self.player);
            if !sight.clear {
                continue;
            }
            let dist = chebyshev(npc.pos, self.player);
            if dist > VISION_RANGE {
                continue;
            }
            // Read clarity: distance, light at the SUBJECT's cell, glass,
            // motion (a moving figure draws the eye — 05a; a runner more so,
            // a creeper less).
            let light = self.light_at(self.player);
            let mut conf = 90 - 5 * dist - 15 * sight.degradations as i32;
            conf += if light < DARK_LIGHT {
                -40
            } else if light < DIM_LIGHT {
                -20
            } else {
                0
            };
            conf += match moved {
                None => -10,
                Some(MoveMode::Sneak) => 0,
                Some(MoveMode::Walk) => 10,
                Some(MoveMode::Run) => 18,
            };
            // Point blank you see SOMETHING regardless of dark.
            if dist <= 1 {
                conf = conf.max(CONF_GATE);
            }
            if conf < CONF_GATE {
                continue;
            }
            let conf = conf.clamp(0, 100) as u8;
            // Re-notice cooldown: the same action, recently recorded, at no
            // better clarity → no new atom. A materially CLEARER look (they
            // came closer, stepped into the light) re-registers at once —
            // staring is one memory, but a good look is a better memory.
            if let Some((t0, a0, c0)) = npc.last_obs {
                if a0 == action
                    && self.tick.saturating_sub(t0) < OBS_PERIOD
                    && conf <= c0.saturating_add(4)
                {
                    continue;
                }
            }
            let obs = Observation {
                observer: npc.spec.id,
                subject: partial_read(&self.look, conf),
                action,
                at: self.player,
                when: Tick(self.tick),
                confidence: conf,
                salience: action.base_salience(),
                source: Source::Direct,
            };
            self.emit(GameEvent::Seen {
                by: self.npcs[i].spec.id,
                action,
                salience: obs.salience,
            });
            let is_guard = self.npcs[i].spec.role == Role::Guard;
            let npc = &mut self.npcs[i];
            npc.last_obs = Some((self.tick, action, conf));
            npc.memory.push(obs);
            // Sighting stimulus: rise fast (08).
            let stim = (conf as i32 + obs.salience as i32) / 2;
            npc.alertness = npc.alertness.max(stim);
            npc.stimulus = Some(obs.at);
            if obs.salience >= REPORT_SALIENCE {
                npc.baseline = npc.baseline.max(20);
            }
            if is_guard {
                // Authority: goes straight into the case file (self-report).
                npc.reported = npc.memory.len();
                let had = self.cases.cases.len();
                self.cases.ingest(obs);
                if self.cases.cases.len() > had {
                    self.emit(GameEvent::CaseOpened {
                        id: self.cases.cases[had].id,
                        profile: self.cases.cases[had].profile,
                    });
                }
                // The 05b scrutiny rule, live: does this person match a
                // wanted profile enough to stop them? → the hail (05c),
                // unless this guard just dealt with you.
                let scr = self.cases.scrutiny(&obs.subject);
                let npc = &self.npcs[i];
                let cooled = npc
                    .recent_stop
                    .map(|t| self.tick.saturating_sub(t) >= RESTOP_COOLDOWN)
                    .unwrap_or(true);
                let engaged = matches!(
                    npc.state,
                    NpcState::Approach | NpcState::Confront | NpcState::Pursue
                );
                if scr >= STOP_SCRUTINY && !engaged && cooled && self.stop.is_none() {
                    let npc = &mut self.npcs[i];
                    npc.state = NpcState::Approach;
                    npc.alertness = 100;
                    npc.stimulus = Some(obs.at);
                    npc.hail_since = self.tick;
                    self.emit(GameEvent::Hailed {
                        guard: self.npcs[i].spec.id,
                    });
                }
            }
        }
    }

    /// 3 · Noise: propagate each emission; hearers get a low-fidelity
    /// observation + an alertness bump (05a hearing).
    fn hear(&mut self, noises: &[(CellPos, i32)]) {
        for &(src, loudness) in noises {
            if loudness <= 0 {
                continue;
            }
            let field = self.grid.propagate_sound(src, loudness);
            for npc in &mut self.npcs {
                let lvl = field.level(&self.grid, npc.pos);
                if lvl < 1 || npc.pos == src {
                    continue;
                }
                let obs = Observation {
                    observer: npc.spec.id,
                    subject: Description::UNKNOWN,
                    action: ActionKind::Noise,
                    at: src,
                    when: Tick(self.tick),
                    confidence: (lvl * 8).clamp(0, 40) as u8,
                    salience: ActionKind::Noise.base_salience(),
                    source: Source::Direct,
                };
                npc.memory.push(obs);
                npc.alertness = npc.alertness.max((lvl * 4).min(50));
                if npc.state == NpcState::Routine || npc.state == NpcState::Notice {
                    npc.stimulus = Some(src);
                }
            }
        }
    }

    /// 4 · The ladder + movement (08: alertness overrides schedule; resumes
    /// it on decay). Routine pace is one step per MOVE_PERIOD; a hunting
    /// guard closes at MOVE_PERIOD_HUNT.
    fn behave(&mut self) {
        for i in 0..self.npcs.len() {
            // Decay: slow fall to the heightened baseline.
            if self.tick.is_multiple_of(ALERT_DECAY_PERIOD) {
                let npc = &mut self.npcs[i];
                npc.alertness = (npc.alertness - 1).max(npc.baseline);
            }
            // State from alertness (the engaged states are sticky until
            // resolved below).
            let npc = &mut self.npcs[i];
            if !matches!(
                npc.state,
                NpcState::Pursue | NpcState::Reporting | NpcState::Approach | NpcState::Confront
            ) {
                npc.state = if npc.alertness >= 70 {
                    NpcState::Investigate
                } else if npc.alertness >= 40 {
                    NpcState::Notice
                } else {
                    NpcState::Routine
                };
                // A civilian with an unreported alarming memory goes to tell
                // a guard (05b reporting: latency = the travel).
                if npc.spec.role == Role::Civilian
                    && npc.memory[npc.reported..]
                        .iter()
                        .any(|o| o.salience >= REPORT_SALIENCE)
                {
                    npc.state = NpcState::Reporting;
                }
            }
            // A hunting guard TRACKS a target he can currently see: the
            // stimulus follows the live position (08's shared last-known-
            // position). Tracking is not a new memory atom — the OBS_PERIOD
            // throttle on observations stands; break cone/LOS/range and the
            // trail truly goes stale.
            if matches!(
                self.npcs[i].state,
                NpcState::Approach | NpcState::Pursue
            ) && self.can_see(i)
            {
                self.npcs[i].stimulus = Some(self.player);
            }
            // Reach checks run EVERY tick (the player moves between the
            // guard's step ticks too).
            match self.npcs[i].state {
                NpcState::Approach
                    if self.stop.is_none()
                        && chebyshev(self.npcs[i].pos, self.player) <= 1
                        && self.grid.los(self.npcs[i].pos, self.player).clear
                    => {
                        let npc = &mut self.npcs[i];
                        npc.state = NpcState::Confront;
                        npc.stimulus = Some(self.player);
                        self.stop = Some(StopState {
                            guard: i,
                            began: self.tick,
                        });
                        self.emit(GameEvent::StopBegan {
                            guard: self.npcs[i].spec.id,
                        });
                    }
                NpcState::Pursue => {
                    let grace = self.npcs[i]
                        .recent_stop
                        .map(|t| self.tick.saturating_sub(t) < CATCH_GRACE)
                        .unwrap_or(false);
                    if !grace
                        && chebyshev(self.npcs[i].pos, self.player) <= 1
                        && self.grid.los(self.npcs[i].pos, self.player).clear
                        && self.grid.cell(self.player).prop != Prop::HidingSpot
                    {
                        self.resolve_search(i, false);
                        continue;
                    }
                }
                NpcState::Confront => {
                    // Square up to the suspect.
                    if let Some(d) = dir_toward(self.npcs[i].pos, self.player) {
                        self.npcs[i].facing = d;
                    }
                }
                _ => {}
            }
            let period = match self.npcs[i].state {
                NpcState::Approach | NpcState::Pursue => MOVE_PERIOD_HUNT,
                _ => MOVE_PERIOD,
            };
            if !self.tick.is_multiple_of(period) {
                continue;
            }
            match self.npcs[i].state {
                NpcState::Routine => self.step_routine(i),
                NpcState::Notice => {} // stand and look (v0: no head turn)
                NpcState::Investigate => {
                    if let Some(t) = self.npcs[i].stimulus {
                        if self.npcs[i].pos == t {
                            // Checked out, nothing here: let it decay.
                            self.npcs[i].stimulus = None;
                            self.npcs[i].alertness = self.npcs[i].alertness.min(60);
                        } else {
                            self.step_toward(i, t);
                        }
                    }
                }
                NpcState::Reporting => {
                    // Head for the nearest guard (spec order breaks ties).
                    let guard = self
                        .npcs
                        .iter()
                        .enumerate()
                        .filter(|(_, n)| n.spec.role == Role::Guard)
                        .min_by_key(|(gi, n)| (chebyshev(n.pos, self.npcs[i].pos), *gi))
                        .map(|(gi, _)| gi);
                    if let Some(gi) = guard {
                        let gpos = self.npcs[gi].pos;
                        if chebyshev(self.npcs[i].pos, gpos) <= 1 {
                            self.deliver_report(i, gi);
                        } else {
                            self.step_toward(i, gpos);
                        }
                    }
                }
                NpcState::Approach => {
                    if self.tick.saturating_sub(self.npcs[i].hail_since) > APPROACH_TIMEOUT {
                        // You walked out on a hail: that's evasion — chase.
                        self.npcs[i].state = NpcState::Pursue;
                        self.emit(GameEvent::HuntStarted {
                            guard: self.npcs[i].spec.id,
                        });
                    } else if self.can_see(i) {
                        // Close on the live target; at arm's length, hold —
                        // the every-tick reach check opens the stop.
                        if chebyshev(self.npcs[i].pos, self.player) > 1 {
                            let to = self.player;
                            self.step_toward(i, to);
                        }
                    } else if let Some(t) = self.npcs[i].stimulus {
                        if self.npcs[i].pos == t {
                            // Reached the last sighting, nobody: lost them.
                            let npc = &mut self.npcs[i];
                            npc.stimulus = None;
                            npc.state = NpcState::Investigate;
                            npc.alertness = 65;
                        } else {
                            self.step_toward(i, t);
                        }
                    }
                }
                NpcState::Confront => {} // hold the stop; resolution moves us
                NpcState::Pursue => {
                    if self.can_see(i) {
                        // You never "lose" someone you're looking at: run
                        // them down; at arm's length hold for the grab
                        // (or for the fled-stop head start to expire).
                        if chebyshev(self.npcs[i].pos, self.player) > 1 {
                            let to = self.player;
                            self.step_toward(i, to);
                        }
                    } else if let Some(t) = self.npcs[i].stimulus {
                        if self.npcs[i].pos == t {
                            // Lost them: heightened routine, hunt cools.
                            let npc = &mut self.npcs[i];
                            npc.stimulus = None;
                            npc.state = NpcState::Investigate;
                            npc.alertness = 65;
                            npc.baseline = npc.baseline.max(20);
                        } else {
                            self.step_toward(i, t);
                        }
                    }
                }
            }
        }
    }

    /// Civilian i hands everything unreported to guard g; the guard ingests
    /// it into the case file secondhand (reduced confidence, tagged source).
    fn deliver_report(&mut self, i: usize, g: usize) {
        let from = self.npcs[i].spec.id;
        let to_report: Vec<Observation> = self.npcs[i].memory[self.npcs[i].reported..].to_vec();
        let n = to_report.len() as u8;
        self.npcs[i].reported = self.npcs[i].memory.len();
        self.npcs[i].state = NpcState::Routine;
        self.npcs[i].baseline = self.npcs[i].baseline.max(20);
        let mut opened = Vec::new();
        for mut obs in to_report {
            obs.source = Source::Secondhand { from };
            obs.confidence = ((obs.confidence as u32 * SECONDHAND_NUM) / SECONDHAND_DEN) as u8;
            let had = self.cases.cases.len();
            self.cases.ingest(obs);
            if self.cases.cases.len() > had {
                opened.push((self.cases.cases[had].id, self.cases.cases[had].profile));
            }
        }
        // The briefed guard raises his guard and goes to look (08).
        let guard = &mut self.npcs[g];
        guard.alertness = guard.alertness.max(70);
        guard.baseline = guard.baseline.max(20);
        if !matches!(
            guard.state,
            NpcState::Pursue | NpcState::Approach | NpcState::Confront
        ) {
            if let Some(worst) = self.cases.pool.iter().rev().max_by_key(|o| o.salience) {
                guard.stimulus = Some(worst.at);
            }
        }
        let to = self.npcs[g].spec.id;
        self.emit(GameEvent::Reported {
            by: from,
            to,
            count: n,
        });
        for (id, profile) in opened {
            self.emit(GameEvent::CaseOpened { id, profile });
        }
    }

    // -- the confrontation ladder (05c) ------------------------------------

    /// The guard at conversation range resolves your features — a stop
    /// always costs a close look, whatever else it costs (06: "close
    /// inspection"). Feeds his memory AND the case file.
    fn close_look(&mut self, g: usize, action: ActionKind) {
        let conf = 95u8;
        let obs = Observation {
            observer: self.npcs[g].spec.id,
            subject: partial_read(&self.look, conf),
            action,
            at: self.player,
            when: Tick(self.tick),
            confidence: conf,
            salience: action.base_salience(),
            source: Source::Direct,
        };
        let npc = &mut self.npcs[g];
        npc.memory.push(obs);
        npc.reported = npc.memory.len();
        npc.last_obs = Some((self.tick, action, conf));
        let had = self.cases.cases.len();
        self.cases.ingest(obs);
        if self.cases.cases.len() > had {
            self.emit(GameEvent::CaseOpened {
                id: self.cases.cases[had].id,
                profile: self.cases.cases[had].profile,
            });
        }
    }

    /// Close the stop: the guard stands down and leaves you be a while.
    fn end_stop(&mut self, g: usize, outcome: StopOutcome) {
        let npc = &mut self.npcs[g];
        npc.state = NpcState::Routine;
        npc.alertness = 50;
        npc.baseline = npc.baseline.max(20);
        npc.stimulus = None;
        npc.recent_stop = Some(self.tick);
        self.stop = None;
        self.emit(GameEvent::StopResolved {
            guard: self.npcs[g].spec.id,
            outcome,
        });
    }

    /// Answer a live stop (05c's outs). Deterministic: any chance is a
    /// stateless hash roll of (seed, tick, guard).
    fn resolve_stop(&mut self, choice: StopChoice) {
        let Some(st) = self.stop else {
            return;
        };
        let g = st.guard;
        let gid = self.npcs[g].spec.id;
        match choice {
            StopChoice::Bluff => {
                // Your story holds against a weak case; a strong description
                // with a confident case behind it sees through you.
                let scr = self.cases.scrutiny(&self.look);
                let conf = self
                    .cases
                    .scrutiny_case(&self.look)
                    .map(|(ci, _)| self.cases.cases[ci].confidence.min(100) as i32)
                    .unwrap_or(0);
                let chance = (70 - conf / 2 - scr).clamp(5, 90);
                if roll100(self.spec.seed, self.tick, gid as u64) < chance {
                    self.close_look(g, ActionKind::Loitering);
                    self.end_stop(g, StopOutcome::Bluffed);
                } else {
                    self.emit(GameEvent::LieCaught { guard: gid });
                    if let Some((ci, _)) = self.cases.scrutiny_case(&self.look) {
                        self.cases.bump(ci, LIE_CONF_BUMP);
                    }
                    self.resolve_search(g, true);
                }
            }
            StopChoice::Bribe => {
                if !self.npcs[g].spec.corruptible {
                    // Trying to buy an honest guard is itself damning.
                    self.emit(GameEvent::BribeRefused { guard: gid });
                    if let Some((ci, _)) = self.cases.scrutiny_case(&self.look) {
                        self.cases.bump(ci, LIE_CONF_BUMP);
                    }
                    self.resolve_search(g, true);
                } else if self.coin >= BRIBE_COST {
                    self.coin -= BRIBE_COST;
                    self.close_look(g, ActionKind::Loitering);
                    self.end_stop(g, StopOutcome::Bribed);
                }
                // Not enough coin: the offer dies on your lips — pick
                // another out before the deadline.
            }
            StopChoice::Submit => self.resolve_search(g, true),
            StopChoice::Flee => {
                // Bolting all but confirms guilt: the case spikes and the
                // look you're wearing is burned into it (05c).
                self.close_look(g, ActionKind::Fleeing);
                if let Some((ci, _)) = self.cases.scrutiny_case(&self.look) {
                    self.cases.bump(ci, FLEE_CONF_BUMP);
                }
                self.stop = None;
                self.emit(GameEvent::StopResolved {
                    guard: gid,
                    outcome: StopOutcome::Fled,
                });
                let npc = &mut self.npcs[g];
                npc.state = NpcState::Pursue;
                npc.alertness = 100;
                npc.stimulus = Some(self.player);
                npc.recent_stop = Some(self.tick); // the shove-past head start
                self.emit(GameEvent::HuntStarted { guard: gid });
            }
        }
    }

    /// The search — voluntary, forced, or a pursuit grab (`in_stop: false`).
    fn resolve_search(&mut self, g: usize, in_stop: bool) {
        let gid = self.npcs[g].spec.id;
        let action = if self.carrying {
            ActionKind::Carrying
        } else {
            ActionKind::Loitering
        };
        self.close_look(g, action);
        if self.carrying {
            // Red-handed: the goods are seized, you pay the ladder's first
            // rung (05c: fine) and walk. They got their man and their goods:
            // the case is answered (confidence collapses; the town stays
            // warier — play on, per 02).
            self.carrying = false;
            self.load = 0;
            self.loot_seized = true;
            self.coin = (self.coin - CAUGHT_FINE).max(0);
            if let Some((ci, _)) = self.cases.scrutiny_case(&self.look) {
                self.cases.cases[ci].confidence = 0;
            }
            self.emit(GameEvent::Caught {
                guard: gid,
                had_loot: true,
            });
            if in_stop {
                self.end_stop(g, StopOutcome::Caught);
            } else {
                let npc = &mut self.npcs[g];
                npc.state = NpcState::Investigate;
                npc.alertness = 65;
                npc.baseline = npc.baseline.max(25);
                npc.stimulus = None;
                npc.recent_stop = Some(self.tick);
            }
        } else if in_stop {
            // Clean: the search positively clears this look from the case
            // (05c's strong relief).
            if let Some((ci, _)) = self.cases.scrutiny_case(&self.look) {
                self.cases.cases[ci].cleared_look = Some(self.look);
                let id = self.cases.cases[ci].id;
                self.emit(GameEvent::CaseCleared { id });
            }
            self.end_stop(g, StopOutcome::CleanSearch);
        } else {
            // Run down but clean: released — yet you RAN; no clearance.
            self.emit(GameEvent::Caught {
                guard: gid,
                had_loot: false,
            });
            let npc = &mut self.npcs[g];
            npc.state = NpcState::Investigate;
            npc.alertness = 65;
            npc.baseline = npc.baseline.max(25);
            npc.stimulus = None;
            npc.recent_stop = Some(self.tick);
        }
    }

    fn step_routine(&mut self, i: usize) {
        let npc = &self.npcs[i];
        if npc.spec.patrol.is_empty() {
            // Civilians drift home to their start cell.
            if npc.pos != npc.spec.start {
                self.step_toward(i, self.npcs[i].spec.start);
            }
            return;
        }
        let wp = npc.spec.patrol[npc.waypoint];
        if npc.pos == wp {
            self.npcs[i].waypoint = (npc.waypoint + 1) % npc.spec.patrol.len();
        } else {
            self.step_toward(i, wp);
        }
    }

    /// BFS next-step (fixed DIRS order, first-found = canonical shortest).
    /// NPCs walk Free edges and open doors as residents do (OpenFirst), no
    /// climbing/picking.
    fn step_toward(&mut self, i: usize, to: CellPos) {
        let from = self.npcs[i].pos;
        if from == to {
            return;
        }
        let Some(dir) = next_step(&self.grid, from, to) else {
            return;
        };
        // Doors open as NPCs pass, same as the player.
        if self.grid.edge(from, dir).passage() == Passage::OpenFirst {
            if let EdgeKind::Door(_) = self.grid.edge(from, dir) {
                self.grid
                    .set_edge(from, dir, EdgeKind::Door(DoorState::Open));
            } else {
                return;
            }
        }
        let npc = &mut self.npcs[i];
        npc.pos = npc.pos.step(dir);
        npc.facing = dir;
    }
}

fn chebyshev(a: CellPos, b: CellPos) -> i32 {
    let dx = (a.x as i32 - b.x as i32).abs();
    let dz = (a.z as i32 - b.z as i32).abs();
    dx.max(dz)
}

/// Dominant-axis direction from `a` toward `b` (None when equal).
fn dir_toward(a: CellPos, b: CellPos) -> Option<Dir> {
    let dx = b.x as i32 - a.x as i32;
    let dz = b.z as i32 - a.z as i32;
    if dx == 0 && dz == 0 {
        return None;
    }
    Some(if dx.abs() >= dz.abs() {
        if dx > 0 {
            Dir::Xp
        } else {
            Dir::Xm
        }
    } else if dz > 0 {
        Dir::Zp
    } else {
        Dir::Zm
    })
}

/// Stateless deterministic 0..100 roll — FNV over (seed, tick, salt), the
/// flicker pattern: no RNG state to carry or hash.
fn roll100(seed: u64, tick: u64, salt: u64) -> i32 {
    let mut h: u64 = 0xcbf29ce484222325;
    for w in [seed, tick, salt] {
        for b in w.to_le_bytes() {
            h = (h ^ b as u64).wrapping_mul(0x100000001b3);
        }
    }
    (h % 100) as i32
}

/// 90° vision cone: the target must lie in the facing half-plane with
/// |lateral| ≤ |forward|, same floor.
fn in_cone(pos: CellPos, facing: Dir, target: CellPos) -> bool {
    if pos.floor != target.floor {
        return false;
    }
    let (dx, dz) = (
        target.x as i32 - pos.x as i32,
        target.z as i32 - pos.z as i32,
    );
    let (fx, fz) = {
        let (a, b) = facing.delta();
        (a as i32, b as i32)
    };
    let fwd = dx * fx + dz * fz;
    let lat = dx * fz - dz * fx;
    (fwd > 0 && lat.abs() <= fwd) || (dx == 0 && dz == 0)
}

/// Degrade the ground-truth look to what a read at `conf` resolves (05a: a
/// poor read fills fields with Unknown). Deterministic clarity bands.
fn partial_read(truth: &Description, conf: u8) -> Description {
    let mut d = Description::UNKNOWN;
    if conf >= 30 {
        d.build = truth.build;
        d.top = truth.top;
        d.headwear = truth.headwear;
    }
    if conf >= 50 {
        d.bottom = truth.bottom;
        d.masked = truth.masked;
    }
    if conf >= 70 {
        d.gait = truth.gait;
        d.mark = truth.mark;
    }
    d
}

/// BFS from `from` until `to`; returns the first step of the canonical
/// shortest path (DIRS order tie-break). Resident-level passability.
fn next_step(grid: &TownGrid, from: CellPos, to: CellPos) -> Option<Dir> {
    use std::collections::VecDeque;
    let mut prev: Vec<u8> = vec![u8::MAX; grid.n_cells()];
    let mut q = VecDeque::new();
    prev[grid.flat_index(from)] = 4; // sentinel "start"
    q.push_back(from);
    while let Some(p) = q.pop_front() {
        if p == to {
            // Walk back to the step after `from`.
            let mut cur = p;
            loop {
                let d_code = prev[grid.flat_index(cur)];
                let d = DIRS[d_code as usize];
                let back = cur.step(d.opposite());
                if back == from {
                    return Some(d);
                }
                cur = back;
            }
        }
        for (di, d) in DIRS.iter().enumerate() {
            let n = p.step(*d);
            if !grid.in_bounds(n) || prev[grid.flat_index(n)] != u8::MAX {
                continue;
            }
            let pass = grid.passage(p, *d);
            if pass != Passage::Free && pass != Passage::OpenFirst {
                continue;
            }
            // Only doors auto-open; a shut window is not a walking route.
            if pass == Passage::OpenFirst && !matches!(grid.edge(p, *d), EdgeKind::Door(_)) {
                continue;
            }
            prev[grid.flat_index(n)] = di as u8;
            q.push_back(n);
        }
    }
    None
}

// ---------------------------------------------------------------------------
// Simulation impl
// ---------------------------------------------------------------------------

impl Simulation for ThiefGame {
    type Command = Command;
    type Snapshot = ThiefSnapshot;

    fn tick(&mut self, t: Tick, cmds: &[Command]) {
        self.tick = t.0;
        // The clock turns (04): phase transitions are world events the log
        // narrates ("night falls").
        if self.tick > 0 {
            let now = day_phase(self.tick, self.spec.day_len_ticks);
            if day_phase(self.tick - 1, self.spec.day_len_ticks) != now {
                self.emit(GameEvent::PhaseChanged { phase: now });
            }
        }
        let mut noises = Vec::new();
        let moved = self.resolve_commands(cmds, &mut noises);
        // A stop you leave unanswered resolves itself: the guard's patience
        // runs out and he searches you.
        if let Some(st) = self.stop {
            if self.tick.saturating_sub(st.began) >= STOP_DECIDE_TICKS {
                self.resolve_search(st.guard, true);
            }
        }
        self.sense(moved);
        self.hear(&noises);
        self.behave();
        self.cases.decay_tick(t);
    }

    fn snapshot(&self) -> ThiefSnapshot {
        ThiefSnapshot {
            player: self.player,
            carrying: self.carrying,
            load: self.load,
            coin: self.coin,
            loot_pos: self.loot_pos,
            npcs: self
                .npcs
                .iter()
                .map(|n| NpcView {
                    id: n.spec.id,
                    role: n.spec.role,
                    pos: n.pos,
                    facing: n.facing,
                    state: n.state,
                    alertness: n.alertness,
                })
                .collect(),
            n_cases: self.cases.cases.len(),
            scrutiny: self.cases.scrutiny(&self.look),
            light: self.light_at(self.player),
            phase: day_phase(self.tick, self.spec.day_len_ticks),
            day_min: day_minute(self.tick, self.spec.day_len_ticks),
            stop: self.stop.map(|st| StopView {
                guard: self.npcs[st.guard].spec.id,
                ticks_left: STOP_DECIDE_TICKS.saturating_sub(self.tick.saturating_sub(st.began)),
            }),
            hidden: self.grid.cell(self.player).prop == Prop::HidingSpot,
        }
    }

    fn state_hash(&self) -> u64 {
        let mut h: u64 = 0xcbf29ce484222325;
        let mut eat = |b: u8| {
            h = (h ^ b as u64).wrapping_mul(0x100000001b3);
        };
        let eat_pos = |p: CellPos, eat: &mut dyn FnMut(u8)| {
            eat(p.x as u8);
            eat((p.x >> 8) as u8);
            eat(p.z as u8);
            eat((p.z >> 8) as u8);
            eat(p.floor as u8);
        };
        eat_pos(self.player, &mut eat);
        self.look.eat_into(&mut eat);
        eat(self.carrying as u8);
        eat(self.load as u8);
        eat(self.coin as u8);
        eat(self.loot_seized as u8);
        match self.loot_pos {
            None => eat(0xfc),
            Some(p) => eat_pos(p, &mut eat),
        }
        for byte in self.next_move_at.to_le_bytes() {
            eat(byte);
        }
        for byte in self.stole_at.to_le_bytes() {
            eat(byte);
        }
        match self.stop {
            None => eat(0xfb),
            Some(st) => {
                eat(st.guard as u8);
                for byte in st.began.to_le_bytes() {
                    eat(byte);
                }
            }
        }
        for npc in &self.npcs {
            eat_pos(npc.pos, &mut eat);
            eat(npc.state.code());
            eat(npc.alertness as u8);
            eat(npc.baseline as u8);
            eat(npc.memory.len() as u8);
            eat(npc.reported as u8);
            match npc.stimulus {
                None => eat(0xff),
                Some(p) => eat_pos(p, &mut eat),
            }
            match npc.last_obs {
                None => eat(0xfe),
                Some((t, a, c)) => {
                    for byte in t.to_le_bytes() {
                        eat(byte);
                    }
                    eat(a.code());
                    eat(c);
                }
            }
            eat(npc.waypoint as u8);
            for byte in npc.hail_since.to_le_bytes() {
                eat(byte);
            }
            match npc.recent_stop {
                None => eat(0xfa),
                Some(t) => {
                    for byte in t.to_le_bytes() {
                        eat(byte);
                    }
                }
            }
            for obs in &npc.memory {
                obs.eat_into(&mut eat);
            }
        }
        // Dynamic edges (opened doors) matter: fold the grid in.
        for byte in self.grid.grid_hash().to_le_bytes() {
            eat(byte);
        }
        for byte in self.cases.state_hash().to_le_bytes() {
            eat(byte);
        }
        h
    }
}

// ---------------------------------------------------------------------------
// The M1/M2 greybox fixture + the deduction-scenario gate
// ---------------------------------------------------------------------------

/// One building (shop + back room), a shopkeeper in the back room, a guard
/// patrolling the street, a hay cart to vanish into. The M1/M2 stage.
pub fn spine_level() -> ThiefSpec {
    use super::grid::{Cell, Material, WindowState};
    let mut grid = TownGrid::new(24, 12, 0, 0);
    for z in 0..12 {
        for x in 0..24 {
            grid.set_cell(
                CellPos::new(x, z, 0),
                Cell {
                    kind: CellKind::Outdoor,
                    material: Material::Stone,
                    prop: Prop::None,
                },
            );
        }
    }
    // Building [3,11) × [3,9): back room (z 3..6) with the strongbox, shop
    // front (z 6..9) opening SOUTH — the guard's beat is the NORTH street,
    // so approach and flee can stay out of his sight; the return is the
    // confrontation.
    for z in 3..9 {
        for x in 3..11 {
            grid.set_cell(
                CellPos::new(x, z, 0),
                Cell {
                    kind: CellKind::Room(if z < 6 { 1 } else { 0 }),
                    material: Material::Wood,
                    prop: Prop::None,
                },
            );
        }
    }
    let p = |x, z| CellPos::new(x, z, 0);
    for x in 3..11 {
        grid.set_edge(p(x, 3), Dir::Zm, EdgeKind::Wall);
        grid.set_edge(p(x, 8), Dir::Zp, EdgeKind::Wall);
        grid.set_edge(p(x, 6), Dir::Zm, EdgeKind::Wall); // interior wall
    }
    for z in 3..9 {
        grid.set_edge(p(3, z), Dir::Xm, EdgeKind::Wall);
        grid.set_edge(p(10, z), Dir::Xp, EdgeKind::Wall);
    }
    // South front door onto the z=9 street; interior door; shopfront glass.
    grid.set_edge(p(5, 8), Dir::Zp, EdgeKind::Door(DoorState::Closed));
    grid.set_edge(p(6, 6), Dir::Zm, EdgeKind::Door(DoorState::Closed));
    grid.set_edge(p(9, 8), Dir::Zp, EdgeKind::Window(WindowState::Shut));
    // A hay cart on the east street — enterable concealment (going to
    // ground breaks a chase, 05c).
    grid.set_cell(
        p(18, 2),
        Cell {
            kind: CellKind::Outdoor,
            material: Material::Stone,
            prop: Prop::HidingSpot,
        },
    );
    // Lamps light both rooms; one street lamp by the door.
    let lights = vec![(p(6, 7), 8), (p(8, 4), 8), (p(5, 10), 6)];
    ThiefSpec {
        grid,
        player_start: p(20, 10),
        player_look: Description {
            build: Feature::Seen(super::perception::Build::Average),
            top: Feature::Seen(Hue::Green),
            bottom: Feature::Seen(Hue::Drab),
            headwear: Feature::Seen(Headwear::Hood),
            masked: Feature::Seen(false),
            gait: Feature::Seen(super::perception::Gait::Normal),
            mark: Feature::Seen(super::perception::Mark::None),
        },
        npcs: vec![
            NpcSpec {
                id: 1,
                role: Role::Guard,
                name: "the watchman".into(),
                start: p(2, 1),
                facing: Dir::Xp,
                patrol: vec![p(2, 1), p(8, 1)],
                corruptible: true,
            },
            NpcSpec {
                id: 2,
                role: Role::Civilian,
                name: "the shopkeeper".into(),
                start: p(4, 4),
                facing: Dir::Xp,
                patrol: vec![],
                corruptible: false,
            },
        ],
        target: p(9, 4),
        target_bulk: 2,
        lights,
        day_len_ticks: 14_400,
        carry_capacity: Some(6),
        player_coin: 12,
        seed: 1,
    }
}

/// The scripted M1/M2 trace: walk in the front door, through the shop, into
/// the back room; steal under the shopkeeper's eyes; flee to the far street
/// corner; then stroll back toward the guard's beat — still hooded, or with
/// the look shed (`change_outfit`). Hooded, the guard hails, closes, and
/// (unanswered) forces the search: caught red-handed — the whole 05c ladder
/// end-to-end. Drives the deduction-scenario gate tests AND the clip bin.
pub fn spine_trace(change_outfit: bool) -> Vec<(Tick, Command)> {
    let mut t = Vec::new();
    let mut tick = 10u64;
    // gap ≥ the step period: pre-steal walk = 8; carrying bulk 2 under the
    // encumbrance knob = 12 (the flee is heavier than the approach).
    let mv = |tick: &mut u64, dx: i16, dz: i16, n: usize, gap: u64| {
        let mut v = Vec::new();
        for _ in 0..n {
            v.push((
                Tick(*tick),
                Command::Move {
                    dx,
                    dz,
                    mode: MoveMode::Walk,
                },
            ));
            *tick += gap;
        }
        v
    };
    // Approach along the south street, out of the north-beat guard's
    // sight: (20,10) → door (5,9) → shop → back room → strongbox (9,4).
    t.extend(mv(&mut tick, -1, 0, 15, 8)); // x 20 → 5 on z=10
    t.extend(mv(&mut tick, 0, -1, 1, 8)); // → (5,9) doorstep
    t.extend(mv(&mut tick, 0, -1, 1, 8)); // through the front door → (5,8)
    t.extend(mv(&mut tick, 1, 0, 1, 8)); // → (6,8)
    t.extend(mv(&mut tick, 0, -1, 2, 8)); // → (6,6)
    t.extend(mv(&mut tick, 0, -1, 1, 8)); // through the interior door → (6,5)
    t.extend(mv(&mut tick, 1, 0, 3, 8)); // → (9,5)
    t.extend(mv(&mut tick, 0, -1, 1, 8)); // → (9,4) the strongbox
    t.push((Tick(tick), Command::Steal));
    tick += 30;
    // Flee back out south, then east along z=10 — still unseen, and slower
    // now: the strongbox weighs (encumbrance, 07).
    t.extend(mv(&mut tick, 0, 1, 1, 12));
    t.extend(mv(&mut tick, -1, 0, 3, 12));
    t.extend(mv(&mut tick, 0, 1, 3, 12)); // through the interior door → (6,8)
    t.extend(mv(&mut tick, -1, 0, 1, 12)); // → (5,8)
    t.extend(mv(&mut tick, 0, 1, 2, 12)); // out the front door → (5,10)
    t.extend(mv(&mut tick, 1, 0, 15, 12)); // east to (20,10)
                                           // Lie low a moment (the rumor races: shopkeeper → guard).
    tick += 1200;
    if change_outfit {
        t.push((
            Tick(tick),
            Command::Outfit {
                top: Hue::Brown,
                headwear: Headwear::Bare,
            },
        ));
        tick += 10;
    }
    // Stroll back up the east street and west into the guard's beat.
    t.extend(mv(&mut tick, -1, 0, 8, 12)); // → (12,10)
    t.extend(mv(&mut tick, 0, -1, 8, 12)); // → (12,2) up the open east street
    t.extend(mv(&mut tick, -1, 0, 3, 12)); // → (9,2), inside the beat's eye
                                           // Stand there long enough to be looked at (and stopped).
    t.push((Tick(tick + 600), Command::Wait));
    t
}

#[cfg(test)]
mod tests {
    use super::*;
    use sim_core::Runner;

    fn run_spine(change_outfit: bool) -> (ThiefGame, u64) {
        let mut r = Runner::new(ThiefGame::new(spine_level()));
        r.feed(spine_trace(change_outfit));
        let hash = r.run_ticks(6000);
        (r.sim, hash)
    }

    fn has(game: &ThiefGame, f: impl Fn(&GameEvent) -> bool) -> bool {
        game.events.iter().any(|s| f(&s.ev))
    }

    /// Drive the spine until the stop is live, then answer it. Returns the
    /// runner just after the answer tick.
    fn run_to_stop_and(choice: StopChoice) -> Runner<ThiefGame> {
        let mut r = Runner::new(ThiefGame::new(spine_level()));
        r.feed(spine_trace(false));
        let mut ticks = 0u64;
        while !has(&r.sim, |e| matches!(e, GameEvent::StopBegan { .. })) {
            r.run_ticks(1);
            ticks += 1;
            assert!(ticks < 6000, "the spine must reach a stop");
        }
        let now = ticks; // Runner has run [0, ticks); next tick is `ticks`.
        r.feed(vec![(Tick(now + 1), Command::Stop(choice))]);
        r.run_ticks(2);
        r
    }

    /// THE M1→M2 gate (docs/spec/12): steal → seen → word spreads → a
    /// description forms → the guard stops the matching profile → the whole
    /// confrontation ladder lands (unanswered stop → forced search → caught
    /// red-handed, fined, loot seized).
    #[test]
    fn deduction_scenario_steal_seen_spread_hunt() {
        let (game, _) = run_spine(false);
        // 1 · The theft happened and was SEEN happening.
        assert!(
            has(&game, |e| matches!(e, GameEvent::Stole { .. })),
            "no theft: {:?}",
            game.events
        );
        assert!(
            has(&game, |e| matches!(
                e,
                GameEvent::Seen {
                    by: 2,
                    action: ActionKind::Stealing,
                    ..
                }
            )),
            "the shopkeeper must witness the steal: {:?}",
            game.events
        );
        // 2 · Word spread: the shopkeeper reached the guard and reported.
        assert!(
            has(&game, |e| matches!(
                e,
                GameEvent::Reported { by: 2, to: 1, .. }
            )),
            "the report must reach the guard: {:?}",
            game.events
        );
        // 3 · A description formed: a case whose profile wears the hood.
        assert!(!game.cases.cases.is_empty(), "a case must open");
        let case = &game.cases.cases[0];
        assert_eq!(
            case.profile.headwear,
            Feature::Seen(Headwear::Hood),
            "profile: {:?}",
            case.profile
        );
        assert_eq!(case.profile.top, Feature::Seen(Hue::Green));
        assert!(case.severity >= 80);
        // 4 · The ladder: hailed → stopped → (unanswered) searched → caught.
        assert!(
            has(&game, |e| matches!(e, GameEvent::Hailed { guard: 1 })),
            "the guard must hail the matching hood: {:?}",
            game.events
        );
        assert!(has(&game, |e| matches!(
            e,
            GameEvent::StopBegan { guard: 1 }
        )));
        assert!(has(&game, |e| matches!(
            e,
            GameEvent::Caught {
                guard: 1,
                had_loot: true
            }
        )));
        assert!(has(&game, |e| matches!(
            e,
            GameEvent::StopResolved {
                outcome: StopOutcome::Caught,
                ..
            }
        )));
        // 5 · Consequences: loot seized, fine paid, the case answered.
        let snap = game.snapshot();
        assert!(!snap.carrying && snap.loot_pos.is_none());
        assert_eq!(snap.coin, 12 - CAUGHT_FINE);
        assert_eq!(
            snap.scrutiny, 0,
            "a caught-and-answered case exerts no scrutiny"
        );
    }

    /// The counterfactual that proves the loop is systemic, not scripted:
    /// same crime, same witnesses — but the thief sheds the hood and coat
    /// before strolling back. The guard looks straight past them.
    #[test]
    fn changing_look_defeats_the_description() {
        let (game, _) = run_spine(true);
        // The crime still happened, was seen, was reported…
        assert!(has(&game, |e| matches!(
            e,
            GameEvent::Reported { by: 2, to: 1, .. }
        )));
        assert!(!game.cases.cases.is_empty());
        // …but no hail: the walker no longer matches the wanted profile.
        assert!(
            !has(&game, |e| matches!(e, GameEvent::Hailed { .. })),
            "a changed look must not draw the stop: {:?}",
            game.events
        );
        let snap = game.snapshot();
        assert!(
            snap.scrutiny < STOP_SCRUTINY,
            "scrutiny of the new look must collapse: {}",
            snap.scrutiny
        );
        assert!(snap.carrying, "nobody took the strongbox back");
    }

    /// Latency is real: between the sighting and the delivered report there
    /// are ticks where the town "knows" nothing — the race-the-rumor window
    /// (05b).
    #[test]
    fn the_rumor_has_latency() {
        let mut r = Runner::new(ThiefGame::new(spine_level()));
        r.feed(spine_trace(false));
        // Run to just past the steal (it lands around tick ~220).
        r.run_ticks(300);
        assert!(has(&r.sim, |e| matches!(e, GameEvent::Stole { .. })));
        // Incidental street sightings may already sit in the file, but the
        // CRIME cannot be known yet — the witness is still walking.
        assert!(
            !r.sim.cases.cases.iter().any(|c| c.severity >= 80),
            "the case file must not know of the theft yet: {:#?}",
            r.sim.cases.cases
        );
        r.run_ticks(5700);
        assert!(
            r.sim.cases.cases.iter().any(|c| c.severity >= 80),
            "the report must eventually land"
        );
    }

    /// Answering the stop with a bribe: the corruptible watchman pockets it
    /// and waves you on — WITH the strongbox still under your coat. The
    /// case stays live; only the moment was bought.
    #[test]
    fn bribery_buys_the_stop_but_not_the_case() {
        let r = run_to_stop_and(StopChoice::Bribe);
        let game = &r.sim;
        assert!(has(game, |e| matches!(
            e,
            GameEvent::StopResolved {
                outcome: StopOutcome::Bribed,
                ..
            }
        )));
        assert!(!has(game, |e| matches!(e, GameEvent::Caught { .. })));
        let snap = game.snapshot();
        assert!(snap.carrying, "a bribe skips the search — the loot stays");
        assert_eq!(snap.coin, 12 - BRIBE_COST);
        assert!(
            game.cases.cases[0].confidence > 0,
            "the case is bought off the STREET, not out of the FILE"
        );
    }

    /// Fleeing the stop confirms guilt: the case spikes, the hunt starts —
    /// and a walker hauling a strongbox is run down and caught.
    #[test]
    fn fleeing_a_stop_starts_a_hunt_that_catches_the_laden() {
        let mut r = run_to_stop_and(StopChoice::Flee);
        let conf_after_flee = r.sim.cases.cases[0].confidence;
        assert!(has(&r.sim, |e| matches!(
            e,
            GameEvent::StopResolved {
                outcome: StopOutcome::Fled,
                ..
            }
        )));
        assert!(has(&r.sim, |e| matches!(e, GameEvent::HuntStarted { .. })));
        assert!(
            conf_after_flee >= FLEE_CONF_BUMP,
            "flight must spike the case: {conf_after_flee}"
        );
        // Bolt east, carrying, at a walk-with-load pace: the guard is
        // faster. Push a move every tick; the sim's cadence gates them.
        let mut fed = Vec::new();
        let start = r.sim.tick + 1;
        for k in 0..900u64 {
            fed.push((
                Tick(start + k),
                Command::Move {
                    dx: 1,
                    dz: 0,
                    mode: MoveMode::Walk,
                },
            ));
        }
        r.feed(fed);
        r.run_ticks(900);
        assert!(
            has(&r.sim, |e| matches!(
                e,
                GameEvent::Caught {
                    had_loot: true,
                    ..
                }
            )),
            "an encumbered walker cannot outrun the watch: {:?}",
            r.sim
                .events
                .iter()
                .rev()
                .take(8)
                .collect::<Vec<_>>()
        );
    }

    /// Drop the loot, run, and go to ground: the empty-handed runner is
    /// faster than the guard, the hay cart swallows them, the chase breaks
    /// (05c: a broken trail is genuinely broken).
    #[test]
    fn dropping_the_loot_and_hiding_breaks_the_chase() {
        let mut r = run_to_stop_and(StopChoice::Flee);
        let cart = CellPos::new(18, 2, 0);
        // Ditch the sack, then sprint for the cart: steer one step at a
        // time off the live position (the sim's cadence sets the pace).
        r.feed(vec![(Tick(r.sim.tick + 1), Command::Drop)]);
        r.run_ticks(2);
        for _ in 0..64 {
            let pos = r.sim.snapshot().player;
            if pos == cart {
                break;
            }
            let dx = (cart.x - pos.x).signum();
            let dz = if dx == 0 { (cart.z - pos.z).signum() } else { 0 };
            r.feed(vec![(
                Tick(r.sim.tick + 1),
                Command::Move {
                    dx,
                    dz,
                    mode: MoveMode::Run,
                },
            )]);
            r.run_ticks(STEP_RUN);
        }
        // Hold still inside the hay until the hunt gives up.
        r.run_ticks(1200);
        let game = &r.sim;
        assert!(
            !has(game, |e| matches!(e, GameEvent::Caught { .. })),
            "the unladen runner must not be caught: {:?}",
            game.events.iter().rev().take(8).collect::<Vec<_>>()
        );
        let snap = game.snapshot();
        assert_eq!(snap.player, cart, "must reach the hay cart");
        assert!(snap.hidden);
        assert!(
            snap.npcs.iter().all(|n| n.state != NpcState::Pursue),
            "the chase must break once the trail does: {:?}",
            snap.npcs
        );
        assert!(snap.loot_pos.is_some(), "the dropped loot waits");
    }

    /// Submit with the loot stashed first: a clean search positively CLEARS
    /// this look from the case — the guard then looks straight past the
    /// same hood (05c's strong relief).
    #[test]
    fn a_clean_search_clears_the_description() {
        // Same crime, but the flee leg ends with the strongbox dropped at
        // the far corner before strolling back hooded.
        let mut trace = spine_trace(false);
        // Insert a Drop right at the lie-low pause: find the last pre-pause
        // command (the Wait is last; the pause precedes the return moves).
        // Simpler: drop immediately after the final east flee move.
        let steal_i = trace
            .iter()
            .position(|(_, c)| *c == Command::Steal)
            .unwrap();
        // 25 flee moves follow the steal; drop right after the last one, at
        // the far street corner.
        let (drop_tick, _) = trace[steal_i + 25];
        trace.insert(
            steal_i + 26,
            (Tick(drop_tick.0 + 6), Command::Drop),
        );
        let mut r = Runner::new(ThiefGame::new(spine_level()));
        r.feed(trace);
        let mut ticks = 0u64;
        while !has(&r.sim, |e| matches!(e, GameEvent::StopBegan { .. })) {
            r.run_ticks(1);
            ticks += 1;
            assert!(ticks < 6000, "the spine must still reach a stop");
        }
        assert!(!r.sim.snapshot().carrying, "the loot must be stashed");
        r.feed(vec![(Tick(ticks + 1), Command::Stop(StopChoice::Submit))]);
        r.run_ticks(2);
        let game = &r.sim;
        assert!(has(game, |e| matches!(
            e,
            GameEvent::StopResolved {
                outcome: StopOutcome::CleanSearch,
                ..
            }
        )));
        assert!(has(game, |e| matches!(e, GameEvent::CaseCleared { .. })));
        assert!(!has(game, |e| matches!(e, GameEvent::Caught { .. })));
        let snap = game.snapshot();
        assert_eq!(snap.coin, 12, "a clean search costs nothing");
        assert_eq!(
            snap.scrutiny, 0,
            "the cleared look must draw no scrutiny though the case lives"
        );
        assert!(
            game.cases.cases[0].confidence > 0,
            "the case itself is NOT closed — only this look is cleared"
        );
    }

    /// A bluff resolves deterministically (stateless seeded roll) and its
    /// two branches stay internally consistent.
    #[test]
    fn a_bluff_resolves_deterministically() {
        let a = run_to_stop_and(StopChoice::Bluff);
        let b = run_to_stop_and(StopChoice::Bluff);
        let ea: Vec<_> = a.sim.events.iter().map(|s| format!("{s:?}")).collect();
        let eb: Vec<_> = b.sim.events.iter().map(|s| format!("{s:?}")).collect();
        assert_eq!(ea, eb, "the roll is a pure function of (seed, tick)");
        let bluffed = has(&a.sim, |e| matches!(
            e,
            GameEvent::StopResolved {
                outcome: StopOutcome::Bluffed,
                ..
            }
        ));
        if bluffed {
            assert!(!has(&a.sim, |e| matches!(e, GameEvent::Caught { .. })));
            assert!(a.sim.snapshot().carrying);
        } else {
            assert!(has(&a.sim, |e| matches!(e, GameEvent::LieCaught { .. })));
            assert!(has(&a.sim, |e| matches!(
                e,
                GameEvent::Caught { had_loot: true, .. }
            )));
        }
    }

    /// The carry-model feel knob (07): the same post-steal walk covers less
    /// ground under encumbrance than under free-carry, at exact cadences.
    #[test]
    fn encumbrance_knob_slows_the_laden_walk() {
        let walk_west = |capacity: Option<i32>| -> i16 {
            let mut spec = spine_level();
            spec.carry_capacity = capacity;
            spec.target = spec.player_start; // strongbox at the street start
            let mut r = Runner::new(ThiefGame::new(spec));
            let mut fed = vec![(Tick(1), Command::Steal)];
            for k in 0..118u64 {
                fed.push((
                    Tick(2 + k),
                    Command::Move {
                        dx: -1,
                        dz: 0,
                        mode: MoveMode::Walk,
                    },
                ));
            }
            r.feed(fed);
            r.run_ticks(120);
            r.sim.snapshot().player.x
        };
        let enc = walk_west(Some(6));
        let free = walk_west(None);
        // 120 ticks from x=20: steps land at tick 2 + k·period (ticks 0..119).
        // Encumbered walk = 8 + 2·bulk(2) = 12/step → 10 steps; free = 8 → 15.
        assert_eq!(enc, 10, "encumbered cadence must be 12 ticks/step");
        assert_eq!(free, 5, "free-carry cadence must be 8 ticks/step");
    }

    /// Day and night are different games (04): the same still figure at the
    /// same spot is invisible at range in the dark, plain in daylight.
    #[test]
    fn ambient_light_gates_the_read_across_the_day() {
        use super::super::grid::{Cell, Material};
        let mut grid = TownGrid::new(14, 5, 0, 0);
        for z in 0..5 {
            for x in 0..14 {
                grid.set_cell(
                    CellPos::new(x, z, 0),
                    Cell {
                        kind: CellKind::Outdoor,
                        material: Material::Stone,
                        prop: Prop::None,
                    },
                );
            }
        }
        let spec = ThiefSpec {
            grid,
            player_start: CellPos::new(10, 2, 0), // dist 8 from the guard
            player_look: spine_level().player_look,
            npcs: vec![NpcSpec {
                id: 1,
                role: Role::Guard,
                name: "the watchman".into(),
                start: CellPos::new(2, 2, 0),
                facing: Dir::Xp,
                patrol: vec![],
                corruptible: false,
            }],
            target: CellPos::new(0, 0, 0),
            target_bulk: 1,
            lights: vec![],
            day_len_ticks: 800, // dawn 0..100, day 100..500, dusk, night
            carry_capacity: Some(6),
            player_coin: 0,
            seed: 7,
        };
        let mut r = Runner::new(ThiefGame::new(spec));
        r.run_ticks(790);
        let first_seen = r
            .sim
            .events
            .iter()
            .find(|s| matches!(s.ev, GameEvent::Seen { .. }))
            .map(|s| s.tick);
        let seen = first_seen.expect("daylight must reveal the still figure");
        assert!(
            (100..500).contains(&seen),
            "the first read must land in full day, not dawn/dusk/night: {seen}"
        );
        // And the sim's own light field agrees with the phases.
        assert_eq!(day_phase(50, 800), DayPhase::Dawn);
        assert_eq!(day_phase(300, 800), DayPhase::Day);
        assert_eq!(day_phase(700, 800), DayPhase::Night);
    }

    /// Sneaking is silent where running is heard — through a wall, with no
    /// line of sight (05a hearing).
    #[test]
    fn running_is_heard_through_the_wall_sneaking_is_not() {
        use super::super::grid::{Cell, Material};
        let build = || {
            let mut grid = TownGrid::new(8, 4, 0, 0);
            for z in 0..4 {
                for x in 0..8 {
                    grid.set_cell(
                        CellPos::new(x, z, 0),
                        Cell {
                            kind: CellKind::Outdoor,
                            material: Material::Stone,
                            prop: Prop::None,
                        },
                    );
                }
            }
            // Full wall between z=1 and z=2.
            for x in 0..8 {
                grid.set_edge(CellPos::new(x, 1, 0), Dir::Zp, EdgeKind::Wall);
            }
            ThiefSpec {
                grid,
                player_start: CellPos::new(2, 1, 0),
                player_look: spine_level().player_look,
                npcs: vec![NpcSpec {
                    id: 1,
                    role: Role::Guard,
                    name: "the watchman".into(),
                    start: CellPos::new(3, 2, 0), // just past the wall
                    facing: Dir::Zp,              // facing AWAY (no cone)
                    patrol: vec![],
                    corruptible: false,
                }],
                target: CellPos::new(0, 0, 0),
                target_bulk: 1,
                lights: vec![],
                day_len_ticks: 14_400,
                carry_capacity: Some(6),
                player_coin: 0,
                seed: 7,
            }
        };
        let alert_after = |mode: MoveMode| -> i32 {
            let mut r = Runner::new(ThiefGame::new(build()));
            let mut fed = Vec::new();
            for k in 0..4u64 {
                fed.push((
                    Tick(1 + k * 20),
                    Command::Move {
                        dx: 1,
                        dz: 0,
                        mode,
                    },
                ));
            }
            r.feed(fed);
            r.run_ticks(90);
            r.sim.snapshot().npcs[0].alertness
        };
        assert!(alert_after(MoveMode::Run) > 0, "running carries through");
        assert_eq!(alert_after(MoveMode::Sneak), 0, "sneaking does not");
    }

    /// M1 determinism gates: replay-twice-identical; the two traces diverge.
    #[test]
    fn spine_replays_bit_identical() {
        let (_, h1) = run_spine(false);
        let (_, h2) = run_spine(false);
        assert_eq!(h1, h2, "same trace must replay to the same state hash");
        let (_, h3) = run_spine(true);
        assert_ne!(h1, h3, "a different trace is a different world");
    }

    /// Pinned portable oracle (all-integer sim). Recapture only with a
    /// reason, in the commit message. (M2 recapture: the sim grew movement
    /// cadence/modes, encumbrance, day/night ambient, coin, and the whole
    /// confrontation ladder — every M1 float… integer… was preserved, but
    /// the state layout and the spine's ending changed by design.)
    #[test]
    fn spine_state_hash_oracle_pinned() {
        let (_, h) = run_spine(false);
        assert_eq!(h, 0x4418_fc21_f5bb_7d05, "recapture: {h:#018x}");
    }

    #[test]
    fn snapshot_is_pure() {
        let (game, _) = run_spine(false);
        let a = format!("{:?}", game.snapshot());
        let b = format!("{:?}", game.snapshot());
        assert_eq!(a, b);
        let h1 = game.state_hash();
        let _ = game.snapshot();
        assert_eq!(game.state_hash(), h1, "snapshot must not mutate state");
    }
}
