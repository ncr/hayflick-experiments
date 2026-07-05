//! The snapshot→renderer adapter half of the sim module: everything that
//! turns the cached `GameSnapshot` (plus the presentation [`super::fx::Fx`]
//! state) into renderer-facing data — instance transforms for the reserved
//! pools, the goo metaball slices, and the per-blob RT lights. All of it is a
//! pure read; nothing here feeds back into the sim. `goo_balls` float order
//! feeds frame bytes (the SDF composite), so bodies here move verbatim.

use super::fx::{SPARK_LIFE, SPLAT_LIFE};
use super::GameLoop;
use glam::{Mat4, Vec3};
use house_game::DoorId;
use rt_probe::{GooBall, GooFrame, InstanceKey, SceneHandles};

/// Vertical flatten applied to the goo metaballs so the body lies on the floor
/// as a spread puddle: the resting-height math `floor + radius·squash` is shared
/// by the CPU ball placement (`goo_balls`) AND the Metal proxy/shader squash, so
/// they MUST agree. Single source of truth — `metal_backend` imports these (it
/// is macOS-gated; `sim` always compiles, so the canonical home is here). A
/// `goo_render_consts_agree` test pins them.
pub(crate) const GOO_SQUASH: f32 = 0.74;
/// Floor plane Y (kit floorThickness 6 cm) — the goo's flat underside.
pub(crate) const GOO_FLOOR_Y: f32 = 6.0 / 128.0;

/// One frame's OWNED goo composite data, built by [`GameLoop::goo_balls`].
/// The renderer consumes it as borrowed slices via [`GooFrameData::frame`]
/// (`rt_probe::GooFrame` — the FrameState field). Same parallel-slice
/// semantics as the borrowed view; see its field docs.
pub struct GooFrameData {
    pub balls: Vec<GooBall>,
    pub glow: Vec<f32>,
    pub vscale: Vec<f32>,
    pub bounds: Vec<GooBall>,
    pub tint: Vec<[f32; 4]>,
}

impl GooFrameData {
    /// Borrow as the FrameState-facing slice bundle.
    pub fn frame(&self) -> GooFrame<'_> {
        GooFrame { balls: &self.balls, glow: &self.glow, vscale: &self.vscale, bounds: &self.bounds, tint: &self.tint }
    }
}

/// Per-door render binding: the renderer instance handle for the leaf, plus the
/// hinge + signed swing axis the per-frame transform needs (the snapshot gives
/// only the angle). Built from the spec's DoorSpecs joined onto the scene's
/// named dynamic instances.
pub struct DoorRender {
    pub id: DoorId,
    pub inst: InstanceKey,
    pub hinge: Vec3,
    pub axis_y: f32,
}

impl GameLoop {
    /// This frame's door leaf instance transforms: for each bound door, the
    /// snapshot's swing angle through `door_instance` (rotate about the hinge).
    /// record_frame patches each only on a bit-change, so idle doors never
    /// rebuild the TLAS.
    pub fn door_instances(&self) -> Vec<(InstanceKey, Mat4)> {
        self.doors
            .iter()
            .map(|dr| {
                let angle = self.snap.doors.iter().find(|(id, _)| *id == dr.id).map(|(_, a)| *a).unwrap_or(0.0);
                (dr.inst, crate::game_scene::door_instance(dr.hinge, dr.axis_y, angle))
            })
            .collect()
    }

    /// Per-frame goo blob instances: skin one emissive ellipsoid onto each live
    /// blob's particle nodes, then collapse every unused pool slot to zero
    /// scale (invisible). The Y scale (and the matching lift, so the lump
    /// stays grounded) tracks the blob's `vscale` — the same per-blob height
    /// breathing the SDF composite draws, so the fallback shows the gait
    /// flatten / jelly bounce too. Presentation-only — a pure read of the
    /// snapshot's hashed particle field; nothing here feeds back into the sim.
    pub fn goo_instances(&self) -> Vec<(InstanceKey, Mat4)> {
        let xforms = self.snap.mobs.iter().flat_map(|m| {
            let ry = m.part_radius * m.vscale;
            m.parts.iter().map(move |part| Mat4::from_translation(Vec3::new(part.x, ry, part.z)) * Mat4::from_scale(Vec3::new(m.part_radius, ry, m.part_radius)))
        });
        skin_pool(&self.goo_slots, xforms)
    }

    /// Per-frame projectile tracer instances: skin one small emissive sphere onto
    /// each live projectile (translate · uniform scale), collapsing every unused
    /// pool slot to zero scale. Pure read of the snapshot's hashed projectile
    /// state — the same instance-mover path the goo ellipsoids use.
    pub fn projectile_instances(&self) -> Vec<(InstanceKey, Mat4)> {
        let xforms = self.snap.projectiles.iter().map(|p| {
            let t = Mat4::from_translation(Vec3::new(p.pos.x, p.pos.y, p.pos.z));
            // tracer streak: thin cross-section (floored so fast small rounds
            // never dither below a pixel — the pool sphere's LOCAL radius is
            // 0.4, so visual size = scale × 0.4), length covering ~2 ticks of
            // flight — rounds draw lines from barrel to target, the slow fat
            // slug stays a chunky bolt.
            let speed2 = p.vel.length_squared();
            match (speed2 > 1e-6).then(|| p.vel.normalize()) {
                Some(d) => {
                    let cross = (p.radius * 0.5).max(0.075);
                    let z_half = (p.radius * 1.2).max(speed2.sqrt() * house_game::TICK_DT * 2.2);
                    t * Mat4::from_quat(glam::Quat::from_rotation_arc(Vec3::Z, d)) * Mat4::from_scale(Vec3::new(cross, cross, z_half))
                }
                None => t * Mat4::from_scale(Vec3::splat(p.radius)),
            }
        });
        skin_pool(&self.proj_slots, xforms)
    }

    /// Per-frame dead-chunk instances: one squashed matte dome per solidified
    /// blob (translate to the rect centre, scale to its half-extents; the local
    /// unit sphere's lower half sinks under the floor). Pure snapshot read.
    pub fn chunk_instances(&self) -> Vec<(InstanceKey, Mat4)> {
        let xforms = self.snap.chunks.iter().map(|c| {
            let cx = (c[0] + c[2]) * 0.5;
            let cz = (c[1] + c[3]) * 0.5;
            let hx = (c[2] - c[0]) * 0.5;
            let hz = (c[3] - c[1]) * 0.5;
            Mat4::from_translation(Vec3::new(cx, 0.0, cz)) * Mat4::from_scale(Vec3::new(hx, house_game::GOO_CHUNK_H, hz))
        });
        skin_pool(&self.chunk_slots, xforms)
    }

    /// Per-frame droplet instances: airborne motes are tiny glowing balls;
    /// landed ones flatten into widening, thinning puddle discs (the same
    /// sphere squashed to the floor) that vanish at SPLAT_LIFE.
    pub fn droplet_instances(&self) -> Vec<(InstanceKey, Mat4)> {
        let xforms = self.fx.droplets.iter().map(|d| {
            if d.splat < 0.0 {
                Mat4::from_translation(d.pos) * Mat4::from_scale(Vec3::splat(0.045))
            } else {
                let t = (d.splat / SPLAT_LIFE).min(1.0);
                let r = 0.05 + t * 0.13; // spreads out...
                let h = 0.020 * (1.0 - t) + 0.004; // ...as it drains away
                Mat4::from_translation(d.pos) * Mat4::from_scale(Vec3::new(r, h, r))
            }
        });
        skin_pool(&self.drop_slots, xforms)
    }

    /// Per-frame impact-spark instances: hot motes shrinking over their life.
    pub fn spark_instances(&self) -> Vec<(InstanceKey, Mat4)> {
        let xforms = self.fx.sparks.iter().map(|s| {
            let k = 1.0 - (s.age / SPARK_LIFE).min(1.0);
            Mat4::from_translation(s.pos) * Mat4::from_scale(Vec3::splat(0.018 + 0.030 * k))
        });
        skin_pool(&self.spark_slots, xforms)
    }

    /// This frame's goo metaballs for the screen-space SDF composite, plus the
    /// parallel per-ball birth-glow and vertical-scale slices and the per-BLOB
    /// bounding spheres. One metaball per fluid particle — the solved fluid
    /// distribution IS the surface. Centres sit at the blob's flattened resting
    /// height (`floor + radius·squash·vscale`) so the shader's vertical squash
    /// and floor clamp settle each lump flat on the ground while the body
    /// breathes in height (gait lunge flattens, jelly wobble bounces, birth
    /// tension draws up — see `MobRender.vscale`). Each bound encloses its
    /// blob's whole merged surface — every ball plus its radius at the LARGEST
    /// axis scale, plus the outward smin bulge — so the shader's two-level
    /// march can trust it as a conservative distance proxy. Pure read of the
    /// hashed field.
    #[allow(clippy::type_complexity)] // five parallel SoA slices; bundling into a GooFrame struct is queued follow-up work
    pub fn goo_balls(&self) -> GooFrameData {
        // Outward bulge of the smin union past the plain sphere union: at most
        // k/4 (k = the shader's GOO_SMIN_K 0.14 → 0.035), plus slack. A too-
        // generous margin only expands a blob's balls a step early — never a
        // visual change — so this need not track k exactly.
        const GOO_BOUND_MARGIN: f32 = 0.06;
        let mut out = Vec::new();
        let mut glow = Vec::new(); // PARALLEL to `out`: per-ball birth-glow 0..1
        let mut vscales = Vec::new(); // PARALLEL to `out`: per-ball vertical scale
        let mut bounds = Vec::new(); // one per BLOB (mob order = ball group order)
        let mut tints = Vec::new(); // PARALLEL to `out`: per-ball species tint
        for m in &self.snap.mobs {
            // species tint, desaturated toward a dull gray-teal as cure stacks
            // build (the visible "solidifying" read; full gray never quite hits)
            let kt = goo_kind_body_tint(m.kind);
            let k = (m.cure as f32 / house_game::GOO_CURE_MAX as f32) * 0.8;
            const GRAY: [f32; 3] = [0.55, 0.09, 0.26]; // × GOO_EMIS ≈ dull stone-teal
            let mut tint = [kt[0] + (GRAY[0] - kt[0]) * k, kt[1] + (GRAY[1] - kt[1]) * k, kt[2] + (GRAY[2] - kt[2]) * k, kt[3]];
            // comm-pact telegraph: flash the whole body toward a hot signal
            // white (deliberately NOT the amber birth tint) by the pulse —
            // both pact members share a strike tick, so they blink in sync.
            if m.comm > 0.0 {
                const FLASH: [f32; 3] = [2.6, 2.9, 3.4];
                for (t, f) in tint.iter_mut().zip(FLASH) {
                    *t += (f - *t) * m.comm;
                }
            }
            // hit flash: a shot that connected blinks the body hot white for
            // a beat (shell-side decay off the arena event tap — the comm
            // pulse pattern, just faster and per-hit)
            if let Some((_, f)) = self.fx.hit_flash.iter().find(|(id, _)| *id == m.id) {
                const HOT: [f32; 3] = [3.1, 3.2, 3.5];
                for (t, h) in tint.iter_mut().zip(HOT) {
                    *t += (h - *t) * f;
                }
            }
            // netcode-lag glitch: a WEAK blob renders its CACHED body (the true
            // hitbox crawls on — shots resolve against the sim, not the draw),
            // dimming as the snapshot ages so the pop-forward reads as a stutter
            // and not a renderer bug.
            let (parts, vscale) = match self.fx.glitch.iter().find(|e| e.id == m.id) {
                Some(e) if m.weak => {
                    let stale = self.fx.fx_frame.wrapping_sub(e.refreshed) as f32;
                    let dim = (1.0 - 0.04 * stale).max(0.55);
                    tint = [tint[0] * dim, tint[1] * dim, tint[2] * dim, tint[3]];
                    (&e.parts, e.vscale)
                }
                _ => (&m.parts, m.vscale),
            };
            let pr = m.part_radius;
            let y = GOO_FLOOR_Y + pr * GOO_SQUASH * vscale;
            let mut c = Vec3::ZERO;
            for p in parts.iter() {
                c += *p;
            }
            let c = c / parts.len() as f32;
            // enclosing-sphere radius of one squashed ball: the ellipsoid's
            // largest semi-axis (horizontal pr, or vertical pr·squash·vscale —
            // the jelly wobble can bulge the body above neutral)
            let ball_r = pr * (GOO_SQUASH * vscale).max(1.0);
            let mut reach = 0.0f32;
            for p in parts.iter() {
                let dx = p.x - c.x;
                let dz = p.z - c.z;
                reach = reach.max((dx * dx + dz * dz).sqrt());
            }
            bounds.push(rt_probe::GooBall { center: [c.x, y, c.z], radius: reach + ball_r + GOO_BOUND_MARGIN });
            for (p, &gl) in parts.iter().zip(m.glow.iter()) {
                out.push(rt_probe::GooBall { center: [p.x, y, p.z], radius: pr });
                glow.push(gl);
                vscales.push(vscale);
                tints.push(tint);
            }
        }
        GooFrameData { balls: out, glow, vscale: vscales, bounds, tint: tints }
    }

    /// One real RT light per live blob (streamed into reserved NEE slots), so
    /// the goo genuinely illuminates the scene and casts ray-traced shadows. A
    /// wide downward green cone sitting just above each blob's centroid: it
    /// pools green light on the floor around the body and — via the shade pass's
    /// per-light shadow rays — the player pillar, walls, and (with the goo proxy
    /// geometry) the blobs themselves cast real shadows. Presentation-only:
    /// a pure read of the snapshot, never baked into the static GI probes.
    pub fn goo_lights(&self) -> Vec<rt_probe::Spotlight> {
        const LIFT: f32 = 0.40; // light height above the floor (wu)
        // Wide downward green cone. Power = base + per-radius boost, so bigger
        // blobs glow a touch brighter; the area-light radius (the shade pass
        // reads posRad.w) tracks the body size and drives the soft-shadow
        // penumbra. The tint is FIXED so the pool colour never flickers.
        const POWER_BASE: f32 = 9.0;
        const POWER_PER_RADIUS: f32 = 3.0;
        const CONE_DEG: f32 = 115.0;
        const SHADOW_RADIUS_FRAC: f32 = 0.8;
        const SHADOW_RADIUS_MIN: f32 = 0.25;
        // per-species pool colour (matches the body tint mapping below)
        let mut out = Vec::with_capacity(self.snap.mobs.len());
        for m in &self.snap.mobs {
            if m.parts.is_empty() {
                continue;
            }
            let c = m.centroid();
            let centroid = Vec3::new(c.x, LIFT, c.z);
            // the comm blink also drives the floor pool: brighter and pulled
            // toward white while signalling (readable even when the body is
            // partly behind cover — which is exactly when pacts happen)
            let power = (POWER_BASE + POWER_PER_RADIUS * m.radius) * (1.0 + 1.4 * m.comm);
            let mut tint = goo_kind_light_tint(m.kind);
            for t in tint.iter_mut() {
                *t += (1.0 - *t) * (0.7 * m.comm);
            }
            out.push(rt_probe::Spotlight {
                pos: centroid,
                dir: Vec3::new(0.0, -1.0, 0.0),
                cone_cos: CONE_DEG.to_radians().cos(),
                power,
                radius: (m.radius * SHADOW_RADIUS_FRAC).max(SHADOW_RADIUS_MIN),
                tint,
            });
        }
        out
    }
}

/// Species → body-emissive tint: a channel-wise multiplier on the shader's
/// green GOO_EMIS, REWEIGHTED so the product is genuinely red/blue (the base
/// is green-heavy — a naive red multiplier would land on orange). Green is
/// exactly white = the historical look, bit-identical.
fn goo_kind_body_tint(kind: house_game::GooKind) -> [f32; 4] {
    match kind {
        house_game::GooKind::Green => [1.0, 1.0, 1.0, 1.0],
        // GOO_EMIS (0.55, 3.3, 1.15) × this ≈ (3.5, 0.6, 0.5) — hot red
        house_game::GooKind::Runner => [6.4, 0.18, 0.43, 1.0],
        // × this ≈ (0.45, 1.15, 4.0) — deep blue
        house_game::GooKind::Tank => [0.8, 0.35, 3.5, 1.0],
    }
}

/// Species → floor-pool light colour (the per-blob cone in `goo_lights`).
fn goo_kind_light_tint(kind: house_game::GooKind) -> [f32; 3] {
    match kind {
        house_game::GooKind::Green => [0.32, 1.0, 0.5], // the historical green
        house_game::GooKind::Runner => [1.0, 0.22, 0.28],
        house_game::GooKind::Tank => [0.25, 0.45, 1.0],
    }
}

/// Discover a reserved named instance pool ("<prefix>_0", "<prefix>_1", …) in
/// slot order, stopping at the first gap. Empty when the scene authored no pool.
/// Shared by the goo-ellipsoid and projectile-tracer slot discovery.
pub(super) fn discover_pool(handles: &SceneHandles, prefix: &str) -> Vec<InstanceKey> {
    let mut slots: Vec<InstanceKey> = Vec::new();
    while let Some(&k) = handles.instances.get(&format!("{prefix}_{}", slots.len())) {
        slots.push(k);
    }
    slots
}

/// Skin an ordered pool of reserved instance slots onto a stream of per-item
/// transforms: fill the slots in order from `xforms`, then collapse every
/// leftover slot to zero scale (invisible). Transforms beyond the pool size are
/// dropped (the pool caps how many items draw at once). Shared by the
/// goo-ellipsoid and projectile-tracer movers — a pure read of the snapshot.
pub(super) fn skin_pool(slots: &[InstanceKey], mut xforms: impl Iterator<Item = Mat4>) -> Vec<(InstanceKey, Mat4)> {
    slots.iter().map(|&slot| (slot, xforms.next().unwrap_or_else(|| Mat4::from_scale(Vec3::ZERO)))).collect()
}
