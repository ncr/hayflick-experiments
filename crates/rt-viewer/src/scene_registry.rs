//! The scene registry: ONE row per scene for everything the shell keys off a
//! scene NAME — the LevelSpec builder, the wall/camera classifiers, collision
//! inflation, and the spec-scene lighting mood. Adding a scene = adding one
//! [`SceneEntry`] row here (plus a `SceneLook` row in rt-probe's config.rs,
//! which owns the RENDER defaults — rt-probe cannot see house-game, so the
//! two tables split along the crate boundary).
//!
//! Names not in the table take [`ENTRY_DEFAULT`]: no spec (the legacy
//! `rt_probe::build_scene` path), auto-perimeter walls, follow-cam on —
//! exactly the fallbacks the old scattered `matches!` lists produced.

use house_game::LevelSpec;
use rt_probe::Config;

pub struct SceneEntry {
    pub name: &'static str,
    /// Builds the authored/procedural LevelSpec (collision + visuals share
    /// it). `None` = legacy textured scene (grid/lab/house): the renderer's
    /// own `build_scene` + the interim collision mirror run instead.
    pub spec: Option<fn(&Config) -> LevelSpec>,
    /// GENERATED boundary walls (one slab per floor↔void edge, dollhouse
    /// cut-aways) instead of the rectangular auto-perimeter. playground joins
    /// so the perimeter is skipped — it authors its OWN far-edge walls.
    pub dollhouse: bool,
    /// Bare open "studio" stage for filming/inspecting goo: bright even sky
    /// fill, no fog (arena/drain join for the even fill — a skill-shooter's
    /// readability wants it).
    pub open_studio: bool,
    /// PLAYER-LESS goo film stage: hidden player marker, fixed camera.
    pub film_stage: bool,
    /// Inflate the COLLISION solids by the player half-extent (generated
    /// thin-wall scenes, where the sim collides a point against 0.25 slabs).
    /// The authored game/house keep their own tuned collision + goldens.
    pub inflate_collision: bool,
    /// Follow-cam pans with the player (off for the fixed-camera grid
    /// rematch; film stages are already fixed via `film_stage`).
    pub follow_cam: bool,
    /// Scene lighting env [sun, sky, fog, fog_h] for SPEC-BUILT scenes (the
    /// `build_game` path; `spec: None` rows never read it). Moods, from the
    /// old if-chain: open studio [0,9,0,0.5]; cave dungeon [0,2.2,0.26,0.45];
    /// daylit dollhouse [0,5.5,0.30,0.42]; lamp-lit house [0,5,0.18,0.5].
    pub lighting: [f32; 4],
}

const LIGHT_STUDIO: [f32; 4] = [0.0, 9.0, 0.0, 0.5];
const LIGHT_CAVE: [f32; 4] = [0.0, 2.2, 0.26, 0.45];
const LIGHT_DAYLIT: [f32; 4] = [0.0, 5.5, 0.30, 0.42];
const LIGHT_HOUSE: [f32; 4] = [0.0, 5.0, 0.18, 0.5];

/// The fallback row — also the base every table row overrides from.
const ENTRY_DEFAULT: SceneEntry = SceneEntry { name: "", spec: None, dollhouse: false, open_studio: false, film_stage: false, inflate_collision: false, follow_cam: true, lighting: LIGHT_HOUSE };

static SCENES: &[SceneEntry] = &[
    // ---- textured legacy trio (renderer-built; golden-pinned)
    SceneEntry { name: "house", ..ENTRY_DEFAULT },
    SceneEntry { name: "lab", ..ENTRY_DEFAULT },
    SceneEntry { name: "grid", follow_cam: false, ..ENTRY_DEFAULT },
    // ---- authored content (game is golden-pinned; goo = game + blobs)
    SceneEntry { name: "game", spec: Some(spec_game), ..ENTRY_DEFAULT },
    SceneEntry { name: "goo", spec: Some(spec_goo), ..ENTRY_DEFAULT },
    // ---- arena-shooter pits (auto-perimeter walls; arena/drain take the
    // even studio fill, squeeze keeps the house mood — pinned by the test)
    SceneEntry { name: "arena", spec: Some(spec_arena), open_studio: true, lighting: LIGHT_STUDIO, ..ENTRY_DEFAULT },
    SceneEntry { name: "drain", spec: Some(spec_drain), open_studio: true, lighting: LIGHT_STUDIO, ..ENTRY_DEFAULT },
    SceneEntry { name: "squeeze", spec: Some(spec_squeeze), ..ENTRY_DEFAULT },
    // ---- goo authoring / film stages (dollhouse: they author their own
    // walls or none; film stages hide the player and fix the camera)
    SceneEntry { name: "playground", spec: Some(spec_playground), dollhouse: true, open_studio: true, lighting: LIGHT_STUDIO, ..ENTRY_DEFAULT },
    SceneEntry { name: "range", spec: Some(spec_range), dollhouse: true, open_studio: true, lighting: LIGHT_STUDIO, ..ENTRY_DEFAULT },
    SceneEntry { name: "goofloor", spec: Some(spec_goofloor), dollhouse: true, open_studio: true, film_stage: true, follow_cam: false, lighting: LIGHT_STUDIO, ..ENTRY_DEFAULT },
    SceneEntry { name: "goonursery", spec: Some(spec_goonursery), dollhouse: true, open_studio: true, film_stage: true, follow_cam: false, lighting: LIGHT_STUDIO, ..ENTRY_DEFAULT },
    SceneEntry { name: "goopair", spec: Some(spec_goopair), dollhouse: true, open_studio: true, film_stage: true, follow_cam: false, lighting: LIGHT_STUDIO, ..ENTRY_DEFAULT },
    // ---- generated walk-around levels (dollhouse walls, inflated collision)
    SceneEntry { name: "cave", spec: Some(spec_cave), dollhouse: true, inflate_collision: true, lighting: LIGHT_CAVE, ..ENTRY_DEFAULT },
    SceneEntry { name: "village", spec: Some(spec_village), dollhouse: true, inflate_collision: true, lighting: LIGHT_DAYLIT, ..ENTRY_DEFAULT },
    SceneEntry { name: "home", spec: Some(spec_home), dollhouse: true, inflate_collision: true, lighting: LIGHT_DAYLIT, ..ENTRY_DEFAULT },
    SceneEntry { name: "hospital", spec: Some(spec_hospital), dollhouse: true, inflate_collision: true, lighting: LIGHT_DAYLIT, ..ENTRY_DEFAULT },
    SceneEntry { name: "office", spec: Some(spec_office), dollhouse: true, inflate_collision: true, lighting: LIGHT_DAYLIT, ..ENTRY_DEFAULT },
    SceneEntry { name: "factory", spec: Some(spec_factory), dollhouse: true, inflate_collision: true, lighting: LIGHT_DAYLIT, ..ENTRY_DEFAULT },
];

pub fn entry(scene: &str) -> &'static SceneEntry {
    SCENES.iter().find(|e| e.name == scene).unwrap_or(&ENTRY_DEFAULT)
}

/// GENERATED-wall scenes (see [`SceneEntry::dollhouse`]).
pub fn is_dollhouse(scene: &str) -> bool {
    entry(scene).dollhouse
}

/// Bare open goo "studio" stages (see [`SceneEntry::open_studio`]).
pub fn is_open_studio_stage(scene: &str) -> bool {
    entry(scene).open_studio
}

/// PLAYER-LESS goo film stages (see [`SceneEntry::film_stage`]).
pub fn is_goo_film_stage(scene: &str) -> bool {
    entry(scene).film_stage
}

// ---- LevelSpec builders (one fn per row; bodies moved verbatim from the old
// viewer.rs SCENE match) --------------------------------------------------

/// Wall-synthesis options for floor-plan scenes: `DOORS=1` keeps swinging door
/// leaves; otherwise openings are plain arches (the walkable default).
fn wall_opts() -> house_game::WallOpts {
    house_game::WallOpts { keep_door_leaves: std::env::var("DOORS").is_ok(), ..house_game::WallOpts::default() }
}

fn spec_game(_: &Config) -> LevelSpec {
    house_game::game_level()
}

/// The goo-mob demo: the five-room house populated with crawling, splittable
/// fluorescent blobs (same geometry as `game`).
fn spec_goo(_: &Config) -> LevelSpec {
    house_game::goo_level()
}

/// The goo ARENA: walled 20×20 pit, arsenal controls (LMB shoots, keys 1–5
/// select), mixed-tier squad — the arena-shooter playtest.
fn spec_arena(cfg: &Config) -> LevelSpec {
    let mut sp = house_game::arena_level();
    sp.seed = cfg.game.cave_seed; // SEED env: drafts + goo jitter
    sp
}

/// HOLD THE DRAIN: the containment variant — plug the sieve.
fn spec_drain(cfg: &Config) -> LevelSpec {
    let mut sp = house_game::drain_level();
    sp.seed = cfg.game.cave_seed;
    sp
}

/// The squeeze film stage: one Large + the slotted north wall, the player
/// standing guard south (the show-your-friend clip).
fn spec_squeeze(_: &Config) -> LevelSpec {
    house_game::squeeze_level()
}

/// A clean open stage for goo authoring (far walls only).
fn spec_playground(_: &Config) -> LevelSpec {
    house_game::playground_level()
}

/// The physical-projectile shooting range (lane + discs + goo targets).
fn spec_range(_: &Config) -> LevelSpec {
    house_game::shooting_range_level()
}

/// A bare playerless floor — the simplest goo filming stage (no pillar, no
/// walls, fixed camera).
fn spec_goofloor(_: &Config) -> LevelSpec {
    house_game::goofloor_level()
}

fn spec_goonursery(_: &Config) -> LevelSpec {
    house_game::goonursery_level()
}

/// Two Larges dropped superimposed — the contact-repulsion showcase.
fn spec_goopair(_: &Config) -> LevelSpec {
    house_game::goopair_level()
}

fn spec_cave(cfg: &Config) -> LevelSpec {
    house_game::cave_level_with(cfg.game.cave_seed, house_game::CaveParams { thick_walls: cfg.game.cave_thick, ..house_game::CaveParams::for_rooms(cfg.game.cave_rooms, cfg.game.cave_loops) })
}

fn spec_village(cfg: &Config) -> LevelSpec {
    house_game::village_level(cfg.game.cave_seed)
}

// Floor-plan-derived levels: a believable PLAN (rooms + doors) run through
// `floorplan::enclose` to synthesize walls + collision. Each is fully
// playable; future plan generators slot in the same way.
fn spec_home(cfg: &Config) -> LevelSpec {
    house_game::enclose(house_game::house_floor(cfg.game.cave_seed), wall_opts())
}

fn spec_hospital(cfg: &Config) -> LevelSpec {
    house_game::enclose(house_game::building_floor(cfg.game.cave_seed, house_game::BuildingParams::hospital()), wall_opts())
}

fn spec_office(cfg: &Config) -> LevelSpec {
    house_game::enclose(house_game::building_floor(cfg.game.cave_seed, house_game::BuildingParams::office()), wall_opts())
}

fn spec_factory(cfg: &Config) -> LevelSpec {
    house_game::enclose(house_game::factory_floor(cfg.game.cave_seed), wall_opts())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The registry must answer exactly what the pre-registry scattered lists
    /// answered. Expectations transcribed FROM the deleted code, not from the
    /// table: dollhouse was cave|village|home|hospital|office|factory|
    /// playground|range|goofloor|goonursery|goopair; open-studio was
    /// playground|range|goofloor|goonursery|goopair|arena|drain; film was
    /// goofloor|goonursery|goopair; collision-inflate was cave|village|home|
    /// hospital|office|factory; follow-cam was `scene != "grid" && !film`;
    /// spec builders existed for every scene but house|lab|grid; lighting was
    /// the build_game if-chain: open-studio → [0,9,0,0.5], cave →
    /// [0,2.2,0.26,0.45], other dollhouse → [0,5.5,0.30,0.42], else
    /// [0,5,0.18,0.5] (squeeze deliberately keeps the house mood — it was
    /// never in the open-studio list).
    #[test]
    fn registry_matches_legacy_dispatch() {
        // (name, spec, dollhouse, studio, film, inflate, follow, lighting)
        type EntryRow = (&'static str, bool, bool, bool, bool, bool, bool, [f32; 4]);
        #[rustfmt::skip]
        let legacy: &[EntryRow] = &[
            ("house",      false, false, false, false, false, true,  [0.0, 5.0, 0.18, 0.5]),
            ("lab",        false, false, false, false, false, true,  [0.0, 5.0, 0.18, 0.5]),
            ("grid",       false, false, false, false, false, false, [0.0, 5.0, 0.18, 0.5]),
            ("game",       true,  false, false, false, false, true,  [0.0, 5.0, 0.18, 0.5]),
            ("goo",        true,  false, false, false, false, true,  [0.0, 5.0, 0.18, 0.5]),
            ("arena",      true,  false, true,  false, false, true,  [0.0, 9.0, 0.0, 0.5]),
            ("drain",      true,  false, true,  false, false, true,  [0.0, 9.0, 0.0, 0.5]),
            ("squeeze",    true,  false, false, false, false, true,  [0.0, 5.0, 0.18, 0.5]),
            ("playground", true,  true,  true,  false, false, true,  [0.0, 9.0, 0.0, 0.5]),
            ("range",      true,  true,  true,  false, false, true,  [0.0, 9.0, 0.0, 0.5]),
            ("goofloor",   true,  true,  true,  true,  false, false, [0.0, 9.0, 0.0, 0.5]),
            ("goonursery", true,  true,  true,  true,  false, false, [0.0, 9.0, 0.0, 0.5]),
            ("goopair",    true,  true,  true,  true,  false, false, [0.0, 9.0, 0.0, 0.5]),
            ("cave",       true,  true,  false, false, true,  true,  [0.0, 2.2, 0.26, 0.45]),
            ("village",    true,  true,  false, false, true,  true,  [0.0, 5.5, 0.30, 0.42]),
            ("home",       true,  true,  false, false, true,  true,  [0.0, 5.5, 0.30, 0.42]),
            ("hospital",   true,  true,  false, false, true,  true,  [0.0, 5.5, 0.30, 0.42]),
            ("office",     true,  true,  false, false, true,  true,  [0.0, 5.5, 0.30, 0.42]),
            ("factory",    true,  true,  false, false, true,  true,  [0.0, 5.5, 0.30, 0.42]),
            ("nonesuch",   false, false, false, false, false, true,  [0.0, 5.0, 0.18, 0.5]),
        ];
        for &(name, spec, dollhouse, studio, film, inflate, follow, lighting) in legacy {
            let e = entry(name);
            assert_eq!(e.spec.is_some(), spec, "{name} spec presence");
            assert_eq!(e.dollhouse, dollhouse, "{name} dollhouse");
            assert_eq!(e.open_studio, studio, "{name} open_studio");
            assert_eq!(e.film_stage, film, "{name} film_stage");
            assert_eq!(e.inflate_collision, inflate, "{name} inflate_collision");
            assert_eq!(e.follow_cam, follow, "{name} follow_cam");
            assert_eq!(e.lighting, lighting, "{name} lighting");
        }
    }
}
