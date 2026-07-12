# Larceny — pivot brainstorm v2 (branch `larceny`)

*2026-07-05. Grid-based isometric **tiny world**: 1 wu² = one whole building
(Civ-map scale, Into-the-Breach look). Realtime. Stealth + stealing with
KCD2-style NPC memory ("he saw me casing, he'll connect the dots"), day/night,
gather/buy/sell. Symbolic, imagination-driven — no interiors, ever.*

## Scale decision (v2, supersedes v1)

The world is a small board — say 12×16 tiles — where each tile is a whole
thing: `House`, `Shop`, `Guardhouse`, `Road`, `Field`, `Forest`, `Well`,
`Fence's shack`. The player and NPCs are small figures (~0.3–0.5 wu) moving
**continuously** on the board (existing `collide_and_slide`); only the
*semantics* are tile-quantized. Buildings are chunky sculpted props (the
box-built greybox kit, same as the player droid) — a 1-wu house you never
enter. Into the Breach is the visual reference: tiny readable diorama, strong
tile reading, chunky pixels — which is exactly what the pixel-perfect iso
renderer with NEAREST upscale already produces.

This scale is a huge scope cut vs v1: no interiors, no doors, no floorplans,
no trespass volumes. A "burglary" is a channel on a tile, not a navigation
problem. All the design weight lands where the user wants it: **who saw what,
when.**

## The interaction grammar: everything is a channel

One unifying verb: stand adjacent to a tile → channel → progress meter →
periodic result ticks. All actions share this shape and differ only in
legality and visibility:

| Channel | Tile | Result per tick | Legal? | Visibility while doing it |
|---|---|---|---|---|
| **Case** | house/shop | reveal one item inside ("silver candlestick…") | grey — loitering | looks suspicious to watchers |
| **Burgle** | cased house | take a revealed item | crime | very suspicious; red-handed if seen |
| **Gather** | field/forest/well | mushroom/wood/water | legal | boringly normal |
| **Trade** | shop/fence | buy/sell UI | legal | normal (fence: shady) |

Casing is symbolic, exactly as specified: a progress meter over the tile, and
every few seconds one line of intel — the house's hidden inventory revealed
item by item. You can only steal **what you know is there**, so casing depth =
loot access. Deeper casing = more time exposed to sightlines. That's the core
bet: the tension isn't in a lockpick minigame, it's in *standing there*.

Gathering is the honest, slow income (mushrooms sell for pennies); theft is
the tempting fast path. Same verb, wildly different consequences — the
economy's soul.

## Memory: the KCD "connect the dots" model

Two-phase guilt, which is the whole point:

1. **Sightings** (realtime): each NPC with line of sight to the player logs
   what they saw: `Saw { player, activity: Casing(house H) | Burgling(H) |
   Loitering | Nothing, tick, distance, light }`. Seeing you *case* is not a
   crime — it's a memory. Bubble shows it forming ("👁 hmm").
2. **Discovery + correlation** (event-driven): a theft isn't known until
   discovered — the owner returns home / morning check → town event
   `Burgled(H, window [T1,T2])`. Every NPC then greps their memory: a sighting
   of you casing or lurking at H inside/near the window → **they connect the
   dots**. Bubble: "❗ it was him." Result is *circumstantial heat* (guard
   questions you, watches you, fine on strong evidence), vs **red-handed**
   (seen mid-burgle) which is immediate chase.

Properties that make it KCD-true: unwitnessed + unconnected theft has zero
consequence; guilt can arrive *hours later* when dots connect; memories decay
over in-game days (heat cools, stolen goods become sellable to the shop
again; the fence never cared). Post-MVP: gossip — witnesses share memories on
NPC↔NPC contact, so the *social graph* spreads your description.

Symmetry worth keeping: the player's casing journal ("I know house H has a
candlestick") and the NPC's sighting log are the same data shape. Both sides
play a memory game. That's the genre identity — **readable minds**, powered by
the existing thinking-bubble tech (`hud.rs::bubble`).

## Day/night is the strategic dilemma

At board scale the cycle creates a clean, legible trade-off:

- **Day**: owners are out (at work/field tiles) → houses are *empty and
  burglable* — but the streets are full of eyes.
- **Night**: streets are empty (only the guard's lamp-lit patrol) — but owners
  are *home*; burgling an occupied house risks instant discovery (MVP: hard
  "occupied = can't burgle, only case"; later: noise/waking mechanics).

So casing happens whenever you dare, and the *steal window* is a schedule
puzzle: know when the owner leaves. Sightlines at night are short
(light-level model), long by day. This dilemma needs no extra mechanics — it
falls out of schedules + perception + the cycle.

## v2.1 additions (same day): disguises, districts, routines

**Disguises — memory is description-based, not identity-based.** A sighting
never stores "the player"; it stores a *description*: `Saw { outfit: OutfitId,
activity, tick, … }`. Correlation at discovery time matches descriptions, and
accusation requires the player to currently match the remembered description.
Changing clothes (at the hideout tile, or bought at the shop — an economy
sink) severs the chain: the farmer remembers *a red-cloaked figure* casing the
manor, and the figure in blue draws no "❗". Sightings carry `outfit` from day
one (cheap field, keeps the data model honest); the change-clothes verb and
outfit stock land with the economy milestone. Post-MVP: close-range face
recognition (KCD2-style) so disguises aren't a full cheese, and gossip spreads
descriptions rather than names.

**Districts — the board has texture.** The hamlet splits into zones with
different risk/reward: a **poor quarter** (hovels, pocket-change loot, no
lamps, nobody cares), a **market row** (shop, well, daytime crowds = eyes),
and a **rich quarter** (manor, high-value loot, lamps at night, guardhouse,
hedge walls funneling approach through a gate). Obstacle tiles are part of the
district language: hedges block movement *and* sight, water blocks movement
only, gates are chokepoints on patrol routes. Per-district loot tables, lamp
density, and patrol coverage make "where do I work tonight" a real decision.
Districts are an authoring convention over the tile grid (a `district` byte
per tile), not a new system.

**Routines — NPCs live a full day.** Each NPC runs a daily loop keyed to
`time_of_day`: wake at home → work tile (field, shop counter, guardhouse) →
midday at the well/market → home at dusk → asleep at night. The guard's loop
is shifted (night patrol through the rich quarter, lamp in hand). Routines are
what make casing *information*: the reveal isn't just "what's inside" but
learning-by-observation "when is nobody home." Already milestone 3; this
confirms its scope.

## The MVP proof clip

> Morning: gather mushrooms (pennies), browse the shop — can't afford the
> lantern. Midday: case the manor from the road; a farmer's bubble shows "👁"
> — he saw you loitering. You learn: silver candlestick inside. Dusk: owner
> walks home — wait. Next morning the owner leaves; you burgle in the empty
> window, unseen. Noon: owner returns — `Burgled!` event — the farmer's
> bubble flips "❗", guard starts shadowing you. Shopkeeper refuses the hot
> candlestick; the fence pays 40%. You buy the lantern. Gold: 0 → positive,
> heat: rising, dots: connected.

That clip proves casing, sighting-memory, correlation, day/night scheduling,
and the two-tier market. Everything else is out of scope.

## Reuse map (v2 deltas from the 2026-07-05 codebase scout)

Still carries over:
- **Stealth AI kit** `tactics.rs`: `los_clear` (segment-vs-AABB — house props
  are AABBs, so buildings block sight for free), `NavField` flow-field for NPC
  walking/chase, deterministic state machine. Un-gate + re-skin.
- **Characters** as box-built figures (player droid pattern). No goo → hash
  oracles and mob-free goldens untouched.
- **Day/night lighting nearly free**: `sky_dim` per frame + the GI probe
  cache's **two-bank lerp** (bank 0 sun/sky, bank 1 lamps) driven by
  time-of-day = physically consistent day↔night crossfade, zero shader edits.
  Tiny board ⇒ probe bake is cheap. Moving sun = later two-backend edit.
- **Inventory/items/Use**, hunger (gives buying bread a reason), full HUD/text
  stack (meters, plates, bubbles — all burn into captures), minimap, trace
  replay, `Pcg32`, scene registry (new scene = 2 table rows + golden).

Demoted from v1 (scale change makes them unnecessary): `village.rs` interiors,
`building.rs`/`floorplan.rs`, the door system. The board is authored directly
in a new tiny spec — a 2D array of tile enums is the natural authoring format.

New work (all headless in `house-game`):
- **Board layer**: `TileKind` grid + per-tile data (owner NPC, hidden
  inventory, schedule anchors). Compiles to LevelSpec: floor rect per tile
  (tint by kind), house props as static solids + visuals.
- **Channel system**: state (target tile, kind, progress), meter HUD, reveal
  ticks; one new `Command` (start/stop channel — `resolve_commands`
  ray-pick-a-tile, door-picking is the template).
- **Sighting log + correlation** (the memory core), suspicion accumulation
  with the sim-side light-level model (ambient(time) + lamp falloff — the sim
  can't read the GPU).
- **Schedules** (home tile ↔ work tile ↔ patrol loop), **discovery events**,
  **gold/shop/fence**, sneak stance.

## Look risk (front-load it)

The one genuinely open question is pixels-per-tile: an Into-the-Breach read
needs a house tile ≈ 32–48 low-res pixels across, with the whole board in
frame. That's a camera-zoom/`SceneLook.pixel` tuning problem, not engine work
— but it decides prop authoring resolution, so **milestone 1 ends with a look
SHOT**, judged before mechanics start. Iso stair invariant (0.0625 wu
multiples) applies to prop boxes as ever.

## Milestones (each lands with headless trace tests)

1. **Board + look test** — `TileKind` grid spec → LevelSpec compiler; author
   one hamlet (houses, shop, guardhouse, fence shack, fields, roads, well);
   `SCENE=hamlet` rows + golden; tune zoom until the noon SHOT reads like a
   tiny diorama. *Gate: the look is judged good.*
2. **Clock + day/night** — tick-derived `time_of_day`; drive `sky_dim`,
   probe-bank scalar, lamp windows. Verify: noon vs midnight SHOTs.
3. **NPCs on the board** — box-figure NPC kind, home/work/patrol schedules,
   NavField walking.
4. **Channel grammar** — case/gather verbs, progress meters, reveal ticks,
   player journal; casing populates from per-house hidden inventories.
5. **Perception + sighting log** — LOS, light-level, suspicion thresholds
   (noticed → suspicious → identified), bubbles showing NPC state. Trace
   test: identical casing run is logged at noon, unlogged at midnight.
6. **Burgle + discovery + correlation** — steal revealed items from empty
   houses; owner-return discovery event; memory grep → heat/accusation;
   red-handed → chase (reused) → confiscate + fine.
7. **Economy** — gold, shop stock/prices, fence discount, bread, mushroom
   gathering as legit baseline income.
8. **Feel pass + the proof clip** (record-gameplay skill): tune day length
   (~4 real minutes), reveal cadence, sightline ranges, prices.

Design risk lives in 4–6; 1–3 are plumbing on proven systems; the renderer is
touched only at content/push-constant level.

## Determinism & discipline notes

- All mechanics headless + trace-tested; `time_of_day` from tick only.
- New spec fields default empty → existing scenes byte-identical
  (`survival: None` gating pattern). New scene gets its own golden.
- No goo anywhere in the hamlet → goo hash oracles untouched.
- Target zero shader edits for MVP (host-side `sky_dim` + probe lerp only);
  any later sun-direction work obeys the two-backend lockstep rule.
