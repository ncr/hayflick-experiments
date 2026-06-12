//! sim-core — the generic game-loop/ECS framework (ARCHITECTURE.md area B).
//!
//! No game content, no GPU, no window: a fixed-timestep accumulator, a
//! tick-stamped command queue, an event buffer, a deterministic RNG, the
//! `Simulation` trait, a headless `Runner`, and the audio cue/sink boundary.
//! hecs is re-exported here so consumers never name it. The public surface is
//! FROZEN — see the `public_api_snapshot` test: extending sim-core means
//! editing that pinned list, so framework creep becomes a reviewed diff.
//! Game-flavored helpers live in the game crate until a second game demands
//! promotion (the experiment→promote rule).

use glam::Vec3;

// The ECS, behind sim_core (games import only `sim_core::*`). Curated list —
// anything more is surface growth and goes through the API snapshot.
pub use hecs::{Bundle, CommandBuffer, Component, DynamicBundle, Entity, EntityBuilder, Query, QueryBorrow, Ref, RefMut, With, Without, World};

/// Simulation tick number. Sim time is `tick · dt` — no wall clock anywhere
/// below the shell.
#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Debug, Default)]
pub struct Tick(pub u64);

/// The longest real frame delta `FixedLoop::advance` will honor (seconds).
/// A hitch — debugger pause, window drag, suspend — costs at most this much
/// sim time instead of unleashing a tick avalanche. Pinned by test.
pub const MAX_FRAME_DT: f32 = 0.1;

/// Fixed-timestep accumulator — the shell's only clock math. Feed real frame
/// deltas; it answers "how many fixed ticks to simulate now", carrying the
/// sub-tick remainder (no time lost or invented under the clamp).
pub struct FixedLoop {
    pub dt: f32,
    acc: f32,
    tick: Tick, // total ticks issued so far
}

impl FixedLoop {
    pub fn new(dt: f32) -> FixedLoop {
        FixedLoop { dt, acc: 0.0, tick: Tick(0) }
    }

    /// Clamp + accumulate `real_dt`; returns the number `n` of fixed ticks to
    /// run now. Their tick numbers are `tick().0 - n .. tick().0`.
    pub fn advance(&mut self, real_dt: f32) -> u32 {
        self.acc += real_dt.clamp(0.0, MAX_FRAME_DT);
        let n = (self.acc / self.dt).floor() as u32;
        self.acc -= n as f32 * self.dt;
        self.tick.0 += n as u64;
        n
    }

    /// Total ticks issued (= the tick number the NEXT batch starts at).
    pub fn tick(&self) -> Tick {
        self.tick
    }
}

/// Tick-stamped command queue. Push order is THE order: `drain_for(t)`
/// returns every command stamped at or before `t` in push order (a
/// late-stamped command is delivered, never dropped — replay must see exactly
/// what live play saw), leaving future-stamped commands queued.
pub struct InputQueue<C> {
    items: Vec<(Tick, C)>,
}

impl<C> InputQueue<C> {
    pub fn new() -> InputQueue<C> {
        InputQueue { items: Vec::new() }
    }

    pub fn push(&mut self, t: Tick, c: C) {
        self.items.push((t, c));
    }

    pub fn drain_for(&mut self, t: Tick) -> Vec<C> {
        let mut due = Vec::new();
        let mut later = Vec::with_capacity(self.items.len());
        for (st, c) in self.items.drain(..) {
            if st <= t { due.push(c) } else { later.push((st, c)) }
        }
        self.items = later;
        due
    }

    pub fn len(&self) -> usize {
        self.items.len()
    }

    pub fn is_empty(&self) -> bool {
        self.items.is_empty()
    }
}

impl<C> Default for InputQueue<C> {
    fn default() -> InputQueue<C> {
        InputQueue::new()
    }
}

/// Per-tick event buffer: systems emit domain events, downstream systems
/// (audio, scoring) drain them in emission order within the same tick.
pub struct Events<E> {
    items: Vec<E>,
}

impl<E> Events<E> {
    pub fn new() -> Events<E> {
        Events { items: Vec::new() }
    }

    pub fn emit(&mut self, e: E) {
        self.items.push(e);
    }

    /// Take every pending event, in emission order, leaving the buffer empty.
    pub fn drain(&mut self) -> Vec<E> {
        std::mem::take(&mut self.items)
    }

    pub fn len(&self) -> usize {
        self.items.len()
    }

    pub fn is_empty(&self) -> bool {
        self.items.is_empty()
    }
}

impl<E> Default for Events<E> {
    fn default() -> Events<E> {
        Events::new()
    }
}

/// PCG-XSH-RR 64/32 (O'Neill's `pcg32`) — the only gameplay RNG. Pure integer
/// math, so identical on every platform; seeded from the level seed. The
/// first 16 outputs are pinned by test so an accidental algorithm change
/// cannot slip past review.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Pcg32 {
    state: u64,
    inc: u64,
}

impl Pcg32 {
    /// Seed with the reference demo stream (54) — `Pcg32::new(42)` reproduces
    /// the published pcg32-global-demo output, our external cross-check.
    pub fn new(seed: u64) -> Pcg32 {
        Pcg32::with_stream(seed, 54)
    }

    /// `pcg32_srandom(seed, stream)` verbatim: distinct streams never collide.
    pub fn with_stream(seed: u64, stream: u64) -> Pcg32 {
        let mut r = Pcg32 { state: 0, inc: (stream << 1) | 1 };
        r.next_u32();
        r.state = r.state.wrapping_add(seed);
        r.next_u32();
        r
    }

    pub fn next_u32(&mut self) -> u32 {
        let old = self.state;
        self.state = old.wrapping_mul(6364136223846793005).wrapping_add(self.inc);
        let xorshifted = (((old >> 18) ^ old) >> 27) as u32;
        xorshifted.rotate_right((old >> 59) as u32)
    }

    /// Uniform in [0, 1): the top 24 bits, exactly representable in f32.
    pub fn next_f32(&mut self) -> f32 {
        (self.next_u32() >> 8) as f32 * (1.0 / 16777216.0)
    }
}

/// The whole game behind three calls. `tick` consumes this tick's commands;
/// `snapshot` is a PURE read (side-effect-free — pinned per game: it must
/// never advance RNG); `state_hash` is the replay equality oracle (FNV over
/// canonical field order, implemented per game).
pub trait Simulation {
    type Command: Clone;
    type Snapshot;
    fn tick(&mut self, t: Tick, cmds: &[Self::Command]);
    fn snapshot(&self) -> Self::Snapshot;
    fn state_hash(&self) -> u64;
}

/// Headless driver: feed a tick-stamped trace, run n ticks — no window, no
/// GPU, no clock. Commands drain PER TICK, not per batch, so live play and
/// trace replay agree on delivery (pinned by test: split runs hash equal).
pub struct Runner<S: Simulation> {
    pub sim: S,
    queue: InputQueue<S::Command>,
    tick: Tick,
}

impl<S: Simulation> Runner<S> {
    pub fn new(sim: S) -> Runner<S> {
        Runner { sim, queue: InputQueue::new(), tick: Tick(0) }
    }

    pub fn feed(&mut self, trace: Vec<(Tick, S::Command)>) -> &mut Runner<S> {
        for (t, c) in trace {
            self.queue.push(t, c);
        }
        self
    }

    /// Run `n` ticks from where the runner stands; returns the post-run
    /// `state_hash` (the replay oracle).
    pub fn run_ticks(&mut self, n: u64) -> u64 {
        for _ in 0..n {
            let cmds = self.queue.drain_for(self.tick);
            self.sim.tick(self.tick, &cmds);
            self.tick.0 += 1;
        }
        self.sim.state_hash()
    }

    /// The next tick to be simulated.
    pub fn tick(&self) -> Tick {
        self.tick
    }
}

/// Audio cue id — static names ("door_open", "pistol_fire", ...). The game's
/// audio system maps domain events to cues; a sink plays them. Nothing else
/// crosses the audio boundary.
#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug)]
pub struct CueId(pub &'static str);

#[derive(Clone, Copy, PartialEq, Debug)]
pub struct AudioCue {
    pub id: CueId,
    pub pos: Option<Vec3>, // world position for panning; None = UI/global
    pub gain: f32,
}

pub trait AudioSink {
    fn play(&mut self, cue: AudioCue);
}

/// Test sink — tests assert exact cue contents and order.
#[derive(Default)]
pub struct VecSink(pub Vec<AudioCue>);

impl AudioSink for VecSink {
    fn play(&mut self, cue: AudioCue) {
        self.0.push(cue);
    }
}

/// Silent sink — the viewer's default until a real backend (e.g. rodio) lands.
pub struct NullSink;

impl AudioSink for NullSink {
    fn play(&mut self, _cue: AudioCue) {}
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The FROZEN public surface, sorted. Anything sim-core newly exports must
    /// be added here AND to the pinned string below — that diff is the review
    /// gate against framework creep (ARCHITECTURE.md).
    const PUBLIC_API: &[&str] = &[
        "AudioCue", "AudioSink", "Bundle", "CommandBuffer", "Component", "CueId", "DynamicBundle", "Entity", "EntityBuilder", "Events", "FixedLoop", "InputQueue", "MAX_FRAME_DT", "NullSink", "Pcg32", "Query", "QueryBorrow", "Ref", "RefMut", "Runner", "Simulation", "Tick", "VecSink", "With", "Without", "World",
    ];

    // Removals/renames of exported items break compilation HERE; additions
    // must extend PUBLIC_API. (Generic params cover the traits; value params
    // cover the types; With/Without are query adapters, hence PhantomData.)
    #[allow(dead_code, clippy::too_many_arguments)]
    fn surface_exists<C: Component, B: Bundle, D: DynamicBundle, Q: Query, S: Simulation>(
        _: Tick, _: FixedLoop, _: InputQueue<()>, _: Events<()>, _: Pcg32,
        _: AudioCue, _: CueId, _: VecSink, _: NullSink, _: &mut dyn AudioSink,
        _: Runner<S>, _: World, _: Entity, _: CommandBuffer, _: EntityBuilder,
        _: QueryBorrow<'_, &'static u32>, _: Ref<'_, u32>, _: RefMut<'_, u32>,
        _: std::marker::PhantomData<(With<&'static u32, ()>, Without<&'static u32, ()>)>,
    ) -> f32 {
        MAX_FRAME_DT
    }

    #[test]
    fn public_api_snapshot() {
        let mut sorted = PUBLIC_API.to_vec();
        sorted.sort_unstable();
        assert_eq!(sorted, PUBLIC_API, "keep PUBLIC_API sorted");
        assert_eq!(
            PUBLIC_API.join(" "),
            "AudioCue AudioSink Bundle CommandBuffer Component CueId DynamicBundle \
             Entity EntityBuilder Events FixedLoop InputQueue MAX_FRAME_DT NullSink \
             Pcg32 Query QueryBorrow Ref RefMut Runner Simulation Tick VecSink \
             With Without World",
        );
    }

    #[test]
    fn fixed_loop_ticks_and_carries_remainder() {
        // exact-binary dt and deltas (all < MAX_FRAME_DT): the counts are exact
        let mut fl = FixedLoop::new(1.0 / 32.0);
        assert_eq!(fl.advance(5.0 / 64.0), 2); // 2.5 ticks -> 2, 1/64 carried
        assert_eq!(fl.advance(1.0 / 64.0), 1); // carry + 1/64 = exactly one tick
        assert_eq!(fl.advance(1.0 / 64.0), 0); // half a tick carried
        assert_eq!(fl.advance(1.0 / 64.0), 1);
        assert_eq!(fl.advance(0.0), 0);
        assert_eq!(fl.tick(), Tick(4)); // no time lost or invented
    }

    #[test]
    fn fixed_loop_clamps_runaway_frames() {
        // the clamp value itself is part of the contract
        assert_eq!(MAX_FRAME_DT, 0.1);
        let dt = 1.0 / 32.0; // exact in binary: no float noise in the counts
        let n_huge = FixedLoop::new(dt).advance(1e9);
        let n_clamp = FixedLoop::new(dt).advance(MAX_FRAME_DT);
        assert_eq!(n_huge, n_clamp, "a hitch must cost at most MAX_FRAME_DT");
        assert_eq!(n_huge, 3); // floor(0.1 / (1/32))
        // negative deltas (clock weirdness) are inert, not time travel
        assert_eq!(FixedLoop::new(dt).advance(-5.0), 0);
    }

    #[test]
    fn input_queue_preserves_push_order_and_tick_gating() {
        let mut q = InputQueue::new();
        q.push(Tick(1), "a");
        q.push(Tick(0), "b");
        q.push(Tick(1), "c");
        q.push(Tick(4), "d");
        assert_eq!(q.drain_for(Tick(0)), vec!["b"]);
        // same-tick commands come out in PUSH order, not stamp order
        assert_eq!(q.drain_for(Tick(1)), vec!["a", "c"]);
        assert_eq!(q.drain_for(Tick(2)), Vec::<&str>::new());
        // a late-stamped command is delivered on the next drain, never dropped
        q.push(Tick(1), "late");
        assert_eq!(q.drain_for(Tick(3)), vec!["late"]);
        assert!(!q.is_empty()); // "d" still queued for tick 4
        assert_eq!(q.drain_for(Tick(4)), vec!["d"]);
        assert!(q.is_empty());
    }

    #[test]
    fn events_drain_in_emission_order() {
        let mut ev = Events::new();
        assert!(ev.is_empty());
        ev.emit(1);
        ev.emit(2);
        ev.emit(3);
        assert_eq!(ev.len(), 3);
        assert_eq!(ev.drain(), vec![1, 2, 3]);
        assert!(ev.is_empty());
        assert_eq!(ev.drain(), Vec::<i32>::new());
    }

    #[test]
    fn pcg32_pinned_first_16() {
        // First 6 are the published pcg32-global-demo values for
        // srandom(42, 54) — external cross-check of the algorithm; the rest
        // pin OUR stream so any change to new()/next_u32 is a reviewed diff.
        let mut r = Pcg32::new(42);
        let got: Vec<u32> = (0..16).map(|_| r.next_u32()).collect();
        assert_eq!(
            got,
            [
                0xa15c02b7, 0x7b47f409, 0xba1d3330, 0x83d2f293, 0xbfa4784b, 0xcbed606e, 0xbfc6a3ad, 0x812fff6d,
                0xe61f305a, 0xf9384b90, 0x32db86fe, 0x1dc035f9, 0xed786826, 0x3822441d, 0x2ba113d7, 0x1c5b818b,
            ]
        );
        // next_f32 stays inside [0, 1) and is a pure function of next_u32
        let mut a = Pcg32::new(7);
        let mut b = Pcg32::new(7);
        for _ in 0..100 {
            let f = a.next_f32();
            assert!((0.0..1.0).contains(&f));
            assert_eq!(f, (b.next_u32() >> 8) as f32 * (1.0 / 16777216.0));
        }
        // distinct streams diverge even from the same seed
        assert_ne!(Pcg32::with_stream(1, 2).next_u32(), Pcg32::with_stream(1, 3).next_u32());
    }

    /// Minimal deterministic sim: applies i32 commands to an accumulator,
    /// stirs in RNG every tick, exercises the re-exported ECS for real, and
    /// records the exact (tick, command) delivery schedule.
    struct DummySim {
        world: World,
        rng: Pcg32,
        acc: i64,
        log: Vec<(u64, i32)>,
    }

    impl DummySim {
        fn new() -> DummySim {
            DummySim { world: World::new(), rng: Pcg32::new(99), acc: 0, log: Vec::new() }
        }
    }

    impl Simulation for DummySim {
        type Command = i32;
        type Snapshot = i64;

        fn tick(&mut self, t: Tick, cmds: &[i32]) {
            for &c in cmds {
                self.acc += c as i64;
                self.log.push((t.0, c));
                self.world.spawn((c,));
            }
            self.acc += (self.rng.next_u32() & 0xF) as i64;
        }

        fn snapshot(&self) -> i64 {
            self.acc
        }

        fn state_hash(&self) -> u64 {
            // FNV-1a over canonical field order
            let mut h: u64 = 0xcbf29ce484222325;
            let mut eat = |v: u64| {
                for byte in v.to_le_bytes() {
                    h = (h ^ byte as u64).wrapping_mul(0x100000001b3);
                }
            };
            eat(self.acc as u64);
            for &(t, c) in &self.log {
                eat(t);
                eat(c as u64);
            }
            h
        }
    }

    fn trace() -> Vec<(Tick, i32)> {
        vec![(Tick(0), 10), (Tick(2), 20), (Tick(2), 21), (Tick(5), 50)]
    }

    #[test]
    fn runner_drains_per_tick_in_push_order() {
        let mut r = Runner::new(DummySim::new());
        r.feed(trace());
        r.run_ticks(8);
        // each command lands EXACTLY on its stamped tick, push order kept
        assert_eq!(r.sim.log, vec![(0, 10), (2, 20), (2, 21), (5, 50)]);
        assert_eq!(r.tick(), Tick(8));
    }

    #[test]
    fn runner_replays_to_the_same_hash() {
        let mut a = Runner::new(DummySim::new());
        a.feed(trace());
        let ha = a.run_ticks(8);
        let mut b = Runner::new(DummySim::new());
        b.feed(trace());
        let hb = b.run_ticks(8);
        assert_eq!(ha, hb, "two replays of one trace must hash identically");
        // draining is per tick, so batching cannot matter: 3 + 5 == 8
        let mut c = Runner::new(DummySim::new());
        c.feed(trace());
        c.run_ticks(3);
        assert_eq!(c.run_ticks(5), ha);
        // a different trace is a different world
        let mut d = Runner::new(DummySim::new());
        d.feed(vec![(Tick(1), 10)]);
        assert_ne!(d.run_ticks(8), ha);
    }

    #[test]
    fn vec_sink_records_exact_cues_in_order() {
        let mut sink = VecSink::default();
        let open = AudioCue { id: CueId("door_open"), pos: Some(Vec3::new(1.0, 0.0, -2.0)), gain: 0.8 };
        let hit = AudioCue { id: CueId("target_hit"), pos: None, gain: 1.0 };
        sink.play(open);
        sink.play(hit);
        assert_eq!(sink.0, vec![open, hit]);
        NullSink.play(open); // silent, but must satisfy the trait
    }
}
