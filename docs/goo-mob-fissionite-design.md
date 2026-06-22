# Fissionite — the first NPC mob: a splittable fluorescent goo-toy blob

Research + design report for the **native** hayflick game (`native/crates/house-game` + `native/crates/sim-core` + `native/rt-probe` / `native/crates/rt-viewer`).

Status: design, not code. Decisive and buildable. File:line references are to the real tree.

---

## 1. TL;DR / recommendation

- **Build it native, CPU-deterministic, presentation-on-GPU.** One blob = one `hecs` entity carrying a fixed-size 3-bone / 4-node **Verlet spine** (`f32`, ground-pinned, XZ only) plus tier/HP/AI fields. The spine, AI, and fission are authoritative gameplay state on the fixed `TICK_DT = 1/60` clock; the goo *look* is a pure render-time read. This is exactly the camera-ease / muzzle-flicker / `light_rgb` sim-vs-presentation line the codebase already enforces.
- **Render v1 as a reserved pool of emissive ellipsoid dynamic instances** skinned to the spine — option (c) from the renderer grounding. It ships on both Vulkan and Metal with near-zero new renderer code by reusing the door/player `register_dynamic` + `FrameState.instances` path. Faceted glowing lumps, not smooth refractive goo — that is the accepted v1 tradeoff.
- **Split = D&D/Slay-the-Spire hybrid:** 3 tiers (Large→Medium→Small), HP halves per tier, on death a non-Small blob spawns **exactly two** children one tier down at `parentRadius/√2`, Small is terminal. Max 7 bodies per Large; a global live cap (sized to the instance pool) is the safety net.
- **No GPU sim, no marching cubes, no SDF intersector, no true translucency, no pathfinding, no fixed-point spine.** Each of these is a deliberate refusal backed by the grounding (below GPU break-even; opaque-only renderer with frozen TLAS; dumb Minecraft AI is genre-correct; half-fixed-point is a trap at the f32 `collide_and_slide` boundary).
- **De-risk the runtime-spawn handle round-trip FIRST**, before any spine math or renderer work. `CommandBuffer::spawn` has never been called in `game.rs`; the first-ever runtime gameplay-entity spawn + sorted-handle-Vec reconciliation is the only genuinely novel mechanic and it gates everything. Spike it headless.

The "aim-high" true-translucent-goo SDF intersector (Approach 3's Phases 3-4) is a **separate, deferred, multi-week renderer research project** with real risk of not landing. It must never gate the gameplay mob. We keep the door open for it cheaply (material-encoding trick, §5) but ship the ellipsoid look first, always.

---

## 2. Context & constraints

### Two runtimes; native is the target

The repo has a **web** stack (`packages/*`, three.js 0.173 WebGL, Rapier 2D kinematic, pixel-perfect iso rasterizer) and a **native** stack (`native/`, Rust workspace, `hecs` ECS, two real hardware ray tracers — Vulkan `rt-probe` + Metal `rt-viewer`).

The goo blob must ship native, and the web stack is not a prototyping shortcut:

- **Rapier has no soft-body / FEM / fluid** (verified: `dynamics/` is rigid-body only; repo-wide grep for `softbody|deformable|fem|mass-spring|metaball|marching` → zero hits). A web goo would be a rigid capsule + cosmetic vertex wobble — findings don't transfer.
- **No WebGPU / compute anywhere** (zero hits for `webgpu|GPUComputePipeline|navigator.gpu`). The user's "RTX/Metal for the simulation" only exists native.
- **The pixel-perfect iso contract** (NEAREST, integer scale, no smooth gradients) actively forbids the volumetric/emissive/translucent look.
- **Native is the live target:** 59/100 recent commits are `native:`, the 10 most recent are all native, and `native/ARCHITECTURE.md` is the binding design doc. Web is now an asset/tooling layer.

At most, web is a disposable `mode: free` logic sketch (kinematic capsule + billboard) for iso footprint reads. The sim and the look do not port.

### The hard determinism / golden-hash constraint

`HouseGame<S: AudioSink>` (`game.rs:240-253`) is the whole game: `world: World`, `res: Res`, `player: Entity`, and four **spec-order, StableId-sorted** handle Vecs (`doors`, `lights`, `targets`, `items`). Iteration is ALWAYS over these sorted Vecs, never raw archetype order (`ARCHITECTURE.md:74-82`). This is the determinism backbone.

| Invariant | Where | What it forces on a mob |
|---|---|---|
| Fixed `TICK_DT = 1/60` | `game.rs:16`, sim time `t.0*TICK_DT` (`game.rs:840`) | No wall clock; spine evolves on integer ticks |
| One RNG, `Pcg32` seeded from `LevelSpec.seed` | `game.rs:312` | All AI/split randomness draws from `self.res.rng`, in id-sorted order |
| `state_hash()` is the equality oracle | FNV-1a, hand-written canonical order, `game.rs:881-937` | Mob state MUST fold in, id-sorted, or replay goldens go blind |
| `snapshot()` is a pure read, never advances RNG/state | `game.rs:857-876`, pinned by `snapshot_twice_is_side_effect_free` (`game.rs:1301`) | Mob pose must be precomputed in a system + cached (like `light_rgb`) |
| ONE structural-change flush point | `buf.run_on(&mut self.world)` after `audio_system` (`game.rs:851-854`) | All spawn/despawn route through `self.res.buf` |
| Ordered Vecs only, no HashMap iteration | `spec.rs:1`, `ARCHITECTURE.md` | The mob handle Vec stays id-sorted |

The 10-system `tick()` order (`game.rs:839-855`): `resolve_commands → door → walk → pickup → use → shoot → flashlight → light → needs → audio → buf.run_on`.

**f32 caveat (load-bearing for §4):** f32 bit-exactness is **same-machine / same-binary only**; the CI-able invariant is the *logical headless hash* (`ARCHITECTURE.md:98-100`). The existing player path is f32 and lives with this. The mob inherits the same property — see §4 for why we accept it rather than chase fixed-point.

---

## 3. The core idea: deterministic spine + presentation-only goo skin

The single most important decision is **where the sim/presentation line falls**, and it falls exactly where the codebase already draws it for `light_rgb` (computed in `light_system`, cached, read purely by `snapshot`), for camera-ease, and for the muzzle flash flicker.

```
            ┌──────────────────────── GAMEPLAY STATE ────────────────────────┐
            │  (CPU, in hecs component, folded into state_hash, replayable)   │
            │                                                                 │
   Goo {    │   4 spine node pos[4] + prev[4]  (f32, XZ; Y = floor+radius)    │
   component│   rest_len, tier:u8, hp:u16                                     │
            │   AI: state:GooState, timer:u16, heading:Vec2                   │
            └─────────────────────────────────────────────────────────────────┘
                          │  goo_system precomputes →
                          ▼
            ┌──────────────── PRESENTATION-ONLY (cached in Res) ──────────────┐
            │  (NOT hashed, NOT replayed — same category as light_rgb/flicker) │
            │                                                                 │
   render   │   per-segment ellipsoid Mat4 (translate·rotate·scale)           │
            │   velocity-aligned squash/stretch radii                         │
            │   emissive pulse (driven off FrameState.time)                   │
            │   split "taffy" elongation (150ms timer)                        │
            └─────────────────────────────────────────────────────────────────┘
                          │  snapshot() clones the cache (pure read)
                          ▼
            ┌──────────────────────── GPU (render only) ──────────────────────┐
            │  FrameState.instances Mat4 patch + TLAS rebuild-on-dirty         │
            │  FrameState.light_emission animates the fluorescent glow         │
            └─────────────────────────────────────────────────────────────────┘
```

**Gameplay state** (CPU, hashed, replayable): the 4 node positions + prev positions, rest length, tier, hp, AI state/timer/heading, and the seeded `next_mob_id` counter. Evolved by a new deterministic `goo_system` on the fixed clock, drawing RNG only from `self.res.rng` in id-sorted order.

**Presentation-only** (GPU visual, never hashed, harmless if it diverges): the metaball/ellipsoid radii, squash-stretch, jiggle overshoot of the *skin*, emissive flicker, split taffy-stretch. None of this affects hitboxes, AI, or collision — those read the spine directly. The "goo skin" is a render-time *mapping* of the 3-bone spine, not a separate simulation.

The free win: Verlet already carries `(p - prev)` as velocity, so when the head turns the trailing nodes overshoot automatically — inertial jiggle is free *in the gameplay spine itself*, and the renderer layers cosmetic skin overshoot on top (driven by `FrameState.time` so it stays replayable w.r.t. the golden RT harness).

---

## 4. Spine & locomotion model

### Structure

3 bones = **4 nodes** (head H, mid1, mid2, tail T), 3 distance "stick" constraints. Stored as plain fixed-size arrays inside one `Goo` component — **not** a particle system, **not** a tet mesh, **not** shape-matching. XZ only; Y is pinned to `floor + radius`.

```rust
// house-game/src/game.rs (new component, alongside Pos/Facing/etc. at game.rs:65-138)
enum GooState { Wander, Seek, Idle }

struct Goo {
    id: MobId,                 // stable, from spec or seeded counter
    pos:  [Vec2; 4],           // XZ spine nodes  (gameplay state)
    prev: [Vec2; 4],           // XZ Verlet prev  (gameplay state)
    rest_len: f32,
    tier: u8,                  // 0=Large 1=Medium 2=Small
    hp:   u16,
    state: GooState,
    timer: u16,                // integer ticks
    heading: Vec2,
}
```

### The `goo_system` (per tick)

Inserted into the fixed `tick()` order **right after `walk_system`** (`game.rs:844`) — it is a mover, and must run **before `shoot_system`** so hit tests see the current pose. Iterates the id-sorted `self.mobs: Vec<Entity>`.

1. **AI heading** (deliberately dumb — Minecraft / RoR2 model, genre-correct):
   - **WANDER:** every ~60 ticks re-pick `heading` from `self.res.rng`.
   - **SEEK:** if player within `aggro_radius` (squared-distance compare), lerp `heading` toward the player by a capped turn rate (~120°/s) — gummy turn, not instant.
   - **IDLE:** occasionally stop for 1–3s (RoR2 "look busy").
   - Optional lateral sine sway on the heading for a slither read.
2. **Verlet integrate** each node: `p' = p + (p - prev)*0.98 + a*dt²`. Head `a` = steering accel along `heading`; mid/tail `a = 0` (gravity-free, ground-pinned). Use `mul_add` consistently for FMA stability *within the binary* (this gives same-binary consistency, NOT cross-arch — see note below).
3. **Head collision:** move the head via `collide_and_slide` (`lib.rs:90`, already closure-abstracted over a `blocked` predicate) against `walk_blocked` (`game.rs:355`, honors level rect + `static_solids` + door `dyn_solids`). 3-whisker `is_blocked` sampling for wall-dodge steering. **Use `walk_blocked`/`is_blocked`, never the raw `Level.floor` rect** — `floor` is the bounding box of all rooms and includes non-walkable void for cave/L-plans; the real walls live in `static_solids`.
4. **Constraint relaxation, 2 iterations** (the goo sweet spot — fewer = floppier, more = stiffer): Jakobsen half-correction stick solve, **head pinned** so followers take the full correction → trailing follow-the-leader crawl.
5. **Cache presentation:** compute per-segment ellipsoid Mat4s + velocity-aligned squash/stretch + emissive pulse into a `Res` Vec (so `snapshot` stays pure).

### Params (starting point)

| Param | Value | Source |
|---|---|---|
| nodes / sticks | 4 / 3 | research B (3-bone) |
| constraint iters | 2 | Jakobsen "goo sweet spot" |
| Verlet damp | 0.98 | research C |
| gait freq ω | 2–4 rad/s | research B |
| head turn rate | ~120°/s | research B |
| WANDER re-pick | ~60 ticks | Minecraft cadence |
| aggro radius | 8–12 world units | research §3 |

> **Decision — f32, not fixed-point (rejecting Approach 2's Q16.16 spine).** The critique is decisive: a fixed-point spine is bit-identical cross-platform *only if the whole gameplay path is float-free*. But `collide_and_slide` and `walk_blocked` are f32 (`lib.rs:90`), and the mob's wall-slide *displacement* (not just the boolean blocked test) re-enters the spine as position. You cannot have a bit-exact-cross-platform fixed-point spine that moves through f32 collide-and-slide without reimplementing collide-and-slide in fixed-point — large, unscoped, not worth it for a toy mob. Half-fixed-point pays the LUT-trig/i64/Q16.16 debugging tax for a guarantee it doesn't hold. We use plain f32 and accept the **established, golden-tested, same-binary-only** determinism that the player path already lives with. The CI invariant remains the logical headless hash.

---

## 5. Goo skin & rendering

### Chosen approach: a few rigid emissive ellipsoids skinned to the spine — option (c)

This is the **only** approach that ships today on both backends with near-zero new renderer code, and it maps 1:1 onto the existing dynamic-instance system.

- Author N ellipsoid prims (UV-sphere GLB `place_dynamic`'d, or `add_box_local` blockout) as named dynamic runs via `scene.place_dynamic` / `register_dynamic` (`scene.rs:385-396`). Each gets an `InstanceKey`.
- Per frame, `build_game` (`game_scene.rs:77`) reads the cached mob pose Vec from the snapshot and feeds `FrameState.instances` a `Mat4` per segment = `translate(node) · rotate(toward next node) · scale(rx,ry,rz)` — exactly `door_instance` (`game_scene.rs:318`) but with **non-uniform scale** for ellipsoid radii and velocity-aligned squash/stretch.
- **Material = high `emissive.rgb`** (sickly fluorescent green). The camera sees it directly (`col = m.emissive.rgb`, `shade.comp:393`), so the radioactive glow is free. Dynamic-run prims are **auto-excluded** from the NEE `scan_lights` (emissive ≥ 3.0, `render.rs:255`) and the frozen 2-bank probe bake (`gpu_scene.rs:105`), so a glowing blob contributes direct emissive without polluting NEE/GI.
- The split "taffy" stretch is faked by briefly elongating the two children's nearest ellipsoids toward each other for ~150ms (presentation timer off `FrameState.time`).

### Why ellipsoids, and what's rejected

| Option | Verdict | Why |
|---|---|---|
| **(c) Skinned emissive ellipsoids** | **CHOSEN (v1)** | Ships today; reuses door dynamic-instance path verbatim; zero new renderer API. Faceted opaque lumps — weakest look, accepted tradeoff. |
| (a) Per-frame marching cubes → BLAS rebuild | Rejected | Topology churn forces a **full BLAS rebuild every frame** (no refit path exists; `vbuf`/`ibuf` are immutable device-local, uploaded once at build, `render.rs:478`). Costliest, off the fast path. |
| (a') Surface Nets / Dual Contouring | Rejected | Same per-frame full BLAS rebuild as MC, just fewer tris. Refinement, not a category change. |
| (b) Analytic SDF/metaball intersection shader | **Deferred (aim-high)** | Best look (true smooth deforming surface), but **entirely unbuilt on both backends**: triangle-only BLAS, `intersection_function_table_offset: 0` hardcoded (`metal_backend.rs:255`), every trace opaque, the metal-rt spike proves only the *triangle* intersector. Needs new AABB BLAS + IFT + new shading branch in `shade.comp` AND `shade.metal` AND probes. Multi-week renderer research project. |

### True translucency is NOT attempted in v1

The `Material` struct is hard-locked at 48 B with `packed_float3`, asserted in 3+ places (`main.rs:47`, `metal_backend.rs:175`, `render.rs:841` `ShadePush=176`). `_pad` is **not free** — it's the CAVE_ROI occluder-wall flag (`shade.comp:266`). Every ray-query is opaque (`gl_RayFlagsOpaqueEXT` / `force_opacity(opaque)`). Real translucency means synchronized Rust + GLSL + MSL edits plus new any-hit/transmittance logic in both shaders. Out of scope for v1.

> **Graft from Approach 3 — keep the door open cheaply.** Even though v1 is opaque ellipsoids, **identify the goo material via the currently-unused `base_color.w` / `emissive.w`** (passed to the shaders but only `.rgb` is read). These carry a goo-id / IOR that only a future goo shading branch decodes — keeping the 48 B layout and the 3-way byte-match intact, never touching `_pad`. This is the correct, struct-preserving answer if/when the SDF intersector lands.

### Honest limitation: v1 glow does not light the room

Because dynamic-run prims are auto-excluded from NEE, the blob is **camera-visible-emissive but casts no light on the room**. The "radioactive glow spills green onto the walls" promise is **unmet in v1**. Getting room spill requires an explicit bounding-sphere NEE light (sample the visible cap with MIS) — deferred with the SDF work. State plainly: v1 glow is self-emissive only; indirect bounce into the frozen 2-bank probe GI is stale-by-design (the documented mover-vs-frozen-GI limitation, `render.rs:230-236`).

---

## 6. GPU (Metal/RTX) plan

**Verdict: no new GPU compute. Nothing in the gameplay sim touches the GPU.**

The honest break-even math: a blob is ~4 nodes; a few dozen blobs is ~100 particles total — **3–4 orders of magnitude below the GPU amortization point** (~10⁵ particles). Per the GPU-vs-CPU research:

- Kernel-launch latency is independent of problem size, so it dominates small workloads. CPU SIMD/AVX is flat vs N and *beats* GPU for N ≲ 10³. GPU speedup only ramps past ~10⁵–10⁶ particles.
- A per-tick Metal/Vulkan dispatch + `wait_until_completed` readback into gameplay would cost **more** than the CPU solve — that CPU↔GPU sync is the silent killer for small per-frame sims.
- **A GPU sim cannot be authoritative anyway:** parallel float reductions/atomics are non-associative and order-/hardware-dependent, breaking cross-hardware lockstep. Cross-GPU bit-identity costs ~20–30% and is effectively unattainable across vendors/drivers. GPU sim is structurally presentation-only.

So the spine sim is **CPU scalar f32** — not even worth `std::simd` at 4 nodes/mob.

The only GPU touch is the **existing render path**, all pre-wired:
- Ellipsoid instance transforms patched per-frame via `FrameState.instances` + TLAS-rebuild-on-dirty (`render.rs:669-679`, `metal_backend.rs:556-581`).
- Emissive animated via `FrameState.light_emission` (`render.rs:706`).

Explicitly skipped: GPU goo-fluid, per-frame marching cubes, the analytic-SDF intersector. The metal-rt spike (`spikes/metal-rt`) proves the compute-dispatch + GPU-AS plumbing we'd reuse *if* a future cosmetic high-particle "drip" skin (thousands+ particles, presentation-only, seeded from the CPU spine) ever justified it — explicitly out of scope for v1.

**One cost to watch:** `record_tlas_rebuild` is a full BUILD, not a refit (`render.rs:728`). Crawling blobs dirty their instances every tick → full TLAS rebuild every frame. The ~0.05 ms/5080 figure is for the current handful of doors+player; it scales with instance count. Keep the pool modest (§7) and this stays fine.

---

## 7. The split mechanic

### Hook point

`shoot_system` (`game.rs:695-757`) today iterates `self.targets` doing a ray-vs-disc plane test. Add a **second loop** over the id-sorted `self.mobs` doing a **ray-vs-sphere** test (sphere centered on the spine midpoint, radius = tier radius — correct vs the wall-mounted infinite-plane disc), nearest hit past the muzzle, then the **same strict-inequality occluder test** already used for targets (`static_occluders` ∪ door `dyn_solids`, `game.rs:741`).

### Ruleset (D&D / Slay-the-Spire hybrid)

| Tier | Radius | HP | On death |
|---|---|---|---|
| Large (0) | `r` | 16 | spawn 2× Medium |
| Medium (1) | `r/√2` | 8 | spawn 2× Small |
| Small (2) | `r/2` | 4 | **terminal — despawn only** |

- On hit: decrement `hp`. If `hp > 0`, register the hit (knockback impulse into the head node's `prev` for jiggle) + emit `GameEvent::MobHit`.
- If `hp == 0`: branch on tier. Small → `self.res.buf.despawn(parent)` + `MobKilled`. Large/Medium → spawn **exactly two** children one tier down.
- **Cascade cap:** 3 tiers, 2-way → max **1+2+4 = 7 bodies** per Large. Tier depth is the real brake (not mass conservation — children are half-size but two of them; Minecraft model, deliberately loose).
- **Global live cap** sized to the instance pool (see "count cap" below): at cap, an over-cap "split" downgrades to a plain kill.

### Child sizing & separation

- `childRadius = parentRadius / √2` (area-conserving 2-way split).
- Rebuild a fresh 4-node spine at the child radius (don't partition the parent's nodes — far more stable).
- Offset child centers by `±0.6·parentRadius` along the axis **perpendicular to the shot ray** ("split along the bullet"), so they birth non-overlapping.
- Bake outward separation into `prev` (Verlet velocity = ~3·childRadius/s) + inherited parent COM velocity.
- 150ms squash-and-pop taffy tell (presentation).

### Runtime-spawn requirement (the novel part)

- Child ids come from a **seeded monotonic `next_mob_id: u32` counter in `Res`** (two increments, fixed order) — **never** from hecs `Entity` bits or archetype order.
- All spawns/despawn route through `self.res.buf` (`buf.spawn` ×2 children + `buf.despawn(parent)`) and land at the ONE `buf.run_on` flush (`game.rs:852`). Never mutate `self.world` mid-system (iteration invalidation + single-structural-point invariant).
- **The `self.mobs` handle Vec is maintained by hand around the flush.** This is the one piece with no precedent: `pickup_system` only ever *shrinks* (`items.retain`, `game.rs:614`); a mob Vec both grows and shrinks. See §9 for the exact round-trip — this is the thing to spike first.

This establishes the **first-ever runtime gameplay-entity spawn in the codebase** (`CommandBuffer::spawn` is never called in `game.rs` today).

---

## 8. Level integration

Mirror `items` / `lights` / `targets` exactly.

1. **Spec.** Add `pub mobs: Vec<MobSpec>` to `LevelSpec` (`spec.rs:155`, next to `items`) and `MobSpec { id: MobId(u32), tier: u8, pos: Vec3 }` mirroring `ItemSpec` (`spec.rs:33`). A new `MobId(u32)` stable-id type.
2. **Hash stability.** Keep `mobs` **EMPTY** on `fixture()` / `game_level()` so existing `state_hash` / replay goldens (e.g. `0xf3783d2d43fe4009`) stay byte-identical — the exact precaution survival-items took (`spec.rs:42`). Every `LevelSpec {..}` literal site must add the field (`spec.rs:182/237/319`, `cave.rs:342`, `building.rs:169/325/364`, floorplan tests); `survival_level` inherits via `..game_level()`.
3. **Consume in `HouseGame::new`** (`game.rs:271`-style loop): spawn one `Goo`+`Pos` entity per `MobSpec`, collect into an id-sorted `self.mobs: Vec<Entity>` like doors/targets/items. Seed `Res.next_mob_id` to `max(authored MobId) + 1` so runtime children never collide with spec ids. Init spine nodes collapsed at `pos` (all 4 coincident, `prev == pos` ⇒ zero velocity).
4. **Render** in `build_game` (`game_scene.rs:77`): a placement loop next to targets/lights/items; the player marker pillar (`game_scene.rs:158`) is the static template, `place_door`/`dynamics` (`game_scene.rs:296`) the dynamic one.
5. **Generators** emit mobs in a per-room loop like the per-room lamp loops (`cave.rs:336`, `building.rs:165`): filter to **non-corridor** rooms (`r.id.0 < CORRIDOR_ROOM_ID_BASE` = 1_000_000, and `< SERVICE_ROOM_ID_BASE`), place at `room_center` or a seeded jittered point inside `floor_rect`, gated by `is_blocked` so it never spawns in a wall slab.

**Crawling / nav.** No pathfinding/navmesh exists or is built. The blob uses the dumb Minecraft model: straight-line SEEK toward the player + 3-whisker `is_blocked` raycasts for wall-dodge + `collide_and_slide` for the move. **Walkability uses `walk_blocked`/`is_blocked`, never the raw `Level.floor` bounding rect** (which includes void for cave/L-plans; real walls are `static_solids`). A shared BFS flow field from the player tile is deferred unless crowds appear.

**Generator ordering trap:** `building_floor`/`house_floor`/`factory_floor` emit `static_solids: Vec::new()` and rely on `floorplan::enclose` (`floorplan.rs:47`) to synthesize walls. Mobs must be consumed **after** enclosure, or the blob sees no interior collision.

---

## 9. What the architecture is MISSING today

| Gap | Today | New surface needed |
|---|---|---|
| **Runtime dynamic spawn of a gameplay entity** | `CommandBuffer::spawn` is *never called* in `game.rs`; only `insert_one`/`remove_one`/`despawn`. The path is wired (`buf` flushed once/tick) but unused for creation. | First use of `buf.spawn`. Seeded `next_mob_id` counter in `Res`. |
| **Sorted handle-Vec maintenance on grow** | `doors/lights/targets` built once; `items` only shrinks (`items.retain`). No sorted-*insert*. | A sorted-insert reconciled with `buf.run_on` timing (the genuinely novel bit; spike it). |
| **Recovering spawned `Entity` handles** | `CommandBuffer::spawn` does **not** return the `Entity` it creates. | A post-flush reconcile: after `buf.run_on`, query the World for entities-with-`Goo`-not-yet-in-`self.mobs`, sort the resulting set by `MobId`, insert. Archetype iteration is fine here because it only *builds* a set that is then **sorted by `MobId`** before becoming iteration order — never used as hash material directly. |
| **Per-entity AI / self-movement** | Only the `player` moves, hardcoded `self.player` in `walk_system` (`game.rs:345-351`). No per-entity mover loop, no steering. | `goo_system` iterating the mob Vec; reuse `collide_and_slide` (`lib.rs:90`). |
| **Hitscan against mobs** | `shoot_system` only tests `self.targets` discs. | Ray-vs-sphere branch + divide-on-death queued to `buf`. |
| **`state_hash` + `snapshot` extension** | Canonical order ends at targets + rng probe (`game.rs:881-937`); snapshot reports cached Vecs. | Feature-gated mob block in `state_hash` (id-sorted, zero bytes when empty); system-cached mob pose Vec for snapshot. |
| **Translucent/emissive material** | `Material` 48 B, opaque-only, `_pad` taken. | None for v1 (emissive ellipsoids suffice). Future: goo-id/IOR in unused `base_color.w`/`emissive.w`. |
| **Renderer dynamic-instance / grow-TLAS** | `InstanceKey`/TLAS frozen at scene build (`render.rs:548`, `gpu_scene.rs:91`); no runtime add. | **No new API** — a fixed reserved-slot pool (the cap). Unused slots hidden by off-screen transform. The pool size is a hard ceiling on simultaneous live blobs. |

### Pool / cap arithmetic (fixing Approach 1's inconsistency)

Approach 1 conflated "~24 ellipsoids" (pool) with "~24 live blobs" (cap) — 24 blobs × 4–6 segments = 96–144 instances, not 24. **Pick concrete, reconciled numbers:**

- **Pool = 72 reserved ellipsoid instance slots.**
- **Segments per blob = 6** (4 nodes + 2 interpolated).
- **Global live-blob cap = floor(72 / 6) = 12.**

12 live blobs comfortably exceeds the 7-body worst case from one Large, with headroom for multiple spawned Larges. The renderer constraint `live_cap × segments_per_blob ≤ pool` holds by construction. Tune later, but ship with these.

---

## 10. Phased build plan

Every phase leaves `cargo test -p house-game` green. The headless sim + trace replay validate the entire mob **with no renderer at all**.

| Phase | Deliverable | Golden state |
|---|---|---|
| **Spike (FIRST — de-risk)** | The runtime-spawn → handle-Vec reconciliation round-trip, headless test only. Via `self.res.buf`: spawn 2 `Goo` entities + despawn a parent at the flush, **recover the children's `Entity` handles**, sorted-insert by seeded `MobId`, retain-out the parent. Assert (a) `self.mobs` id-sorted, (b) `state_hash` identical across two runs, (c) existing goldens byte-identical when `spec.mobs` empty. | Existing goldens untouched (empty mobs). |
| **P0 — headless scaffolding** | `MobSpec`/`MobId` on `LevelSpec` (empty everywhere), `Goo` component, `Res.next_mob_id` + cached pose Vec, `HouseGame::new` spawn loop + id-sorted `self.mobs`. | All existing goldens byte-identical. |
| **P1 — `goo_system` (spine + AI)** | Verlet integrate + 2-iter stick solve, WANDER/SEEK/IDLE drawing from `res.rng` in id-sorted order, `collide_and_slide` vs `walk_blocked`. Fold mob state into `state_hash` in a gated (`if !self.mobs.is_empty()`) block, id-sorted: `id, tier, hp, state_tag, timer`, then 4×`(pos.x,pos.y,prev.x,prev.y)`, then `heading`. Add cached mob Vec to `GameSnapshot`; assert `snapshot_twice_is_side_effect_free` still holds. | New fixture level WITH mobs; pin a NEW golden. Empty levels still byte-identical. |
| **P2 — split mechanic** | Ray-vs-sphere hit branch in `shoot_system`, hp/tier logic, 2-child spawn via `buf` with seeded ids, sorted-insert reconcile after `buf.run_on`, global live cap. Extend `trace.rs` op table if mobs add commands. | Headless replay test: shoot a Large → assert deterministic 1→2→4 (≤7) cascade + pinned hash. |
| **P3 — render (ships the look)** | Reserve 72-slot ellipsoid pool at scene build (`place_dynamic`). Cache per-segment Mat4 + squash/stretch + emissive in `goo_system`. Feed `FrameState.instances` / `light_emission` in `build_game`. Hide unused slots off-screen. Encode goo-id/IOR in `base_color.w`/`emissive.w` now (door open for future SDF). | Visual-only; no headless golden change. Regen RT goldens. |
| **P4 — polish (optional)** | Split taffy-stretch tell, jiggle tuning, `MobSplit`/`MobKilled` audio cues via `GameEvent`, generator emission into rooms (post-enclose). | RT goldens as needed. |
| **P5 — aim-high (deferred, separate milestone)** | The SDF metaball intersector: AABB-primitive BLAS + IFT (Metal) / `rayQueryGenerateIntersectionEXT` candidate loop (Vulkan), sphere-traced `smin` of node spheres, translucent shading branch (emissive-by-thickness, IOR~1.4 + green Beer-Lambert, thin-wall fake-SSS, Fresnel rim) in `shade.comp` AND `shade.metal` AND probes, optional bounding-sphere NEE for room spill. **Multi-week renderer research; never gates the gameplay mob.** | Regen both backends' goldens. |

**The FIRST de-risking spike is named above:** the runtime-spawn handle round-trip — not the renderer. The renderer's frozen-TLAS wall is a *known constraint* with a boring answer (reserved pool) all designs already adopt. The handle round-trip is the only mechanic that is genuinely novel (first `CommandBuffer::spawn`), has no copy-paste precedent (pickup only shrinks), and is under-specified by every design (how you get the `Entity` back). It depends on zero renderer work and zero spine-math choices, and it gates every approach identically.

---

## 11. Open questions / decisions for the owner

1. **Handle recovery strategy.** Confirm the post-flush "query World for `Goo`-entities-not-in-`self.mobs`, sort by `MobId`" approach (§9) vs an alternative (e.g. staging `MobId`s and re-finding, or extending `sim-core` with a spawn-returning helper — but `sim-core` is FROZEN and additions are reviewed diffs, `lib.rs:265-295`). This is the spike's central question.
2. **Pool size / live cap.** Ship with pool=72 / cap=12 / 6 segments-per-blob? Or fewer richer segments? The cap is a real gameplay ceiling — unbounded division works headless but cannot be drawn past the pool.
3. **f32 vs the cross-machine hash.** Accept same-binary-only f32 determinism (matching the player path) as final? Any cross-machine golden would diverge once a mob exists — confirm there are none that must hold cross-machine, or that the logical headless hash is the only CI gate.
4. **Door interplay.** `door_system`'s anti-trap only checks the *player* AABB (`game.rs:450`). A crawling blob can be trapped by, or have a door close through, it. Acceptable for a toy mob v1, or do we extend anti-trap to mobs? (Out of scope recommended for v1; mobs treat closed leaves as walls via `dyn_solids` in `is_blocked`.)
5. **Room spill.** Is "self-emissive glow but no room illumination" acceptable for v1 (§5)? Room spill requires the deferred bounding-sphere NEE light. Likely yes for v1.
6. **Is the SDF intersector (P5) ever in scope?** It's the only path to true smooth translucent radioactive goo, but it's the largest single change in the renderer's history (net-new AABB/IFT on both backends + translucent shading + probe consistency + golden regen). Decide whether to budget it as a dedicated rendering milestone or leave the ellipsoid look as final.
7. **Generator aggression.** How many mobs per room, which level types seed them, and whether corridors ever spawn mobs (currently filtered out). Tuning, deferrable to P4/P5.
