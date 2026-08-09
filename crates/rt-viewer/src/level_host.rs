//! Level-as-data, host side: load the authored level, apply the harness's
//! edit ops, and write the owner's IDE edits back to the file — the
//! `wear_file` discipline applied to GEOMETRY (grid, lamps, spawn).
//!
//! The authored spec and the BOOT spec are not the same thing: a demo boots
//! with its own spawn (the crack lab at (9, 11), the catalogue at (20, 20)),
//! and that override is presentation for the demo, never the authoring — the
//! AgeWall lesson (docs/AGENT_LEARNINGS.md 2026-07-27): the first surface
//! that saved "whatever is live" froze a demo's ramp state into the owner's
//! file. So [`load`] remembers the AUTHORED spawn and [`level_save`](crate::viewer::Viewer::level_save)
//! writes THAT, unless the owner explicitly moved it (an IDE spawn edit
//! updates both).
//!
//! Only the GYM is file-backed. The catalogue is generated code (its slabs
//! grow with the effect system), so edits there stay session-only and the
//! save says so once.

use house_game::gym::grid::CellPos;
use house_game::gym::level_file;
use house_game::gym::sim::GymLevel;

/// Every env knob the LEVEL path reads, with the "writes the authored spec"
/// column that drives [`env_overridden`] — the `wear_file::env` discipline:
/// a knob that writes what the owner would have authored BLOCKS the save, so
/// a SHOT recipe cannot freeze itself into `gym.level`. `LEVEL_FILE`
/// redirects load AND save to another path and deliberately does not block —
/// redirecting is what it is for. `IDE_EDIT` also replays level edits
/// (lamp/spawn statements ride the same `ide_apply`); it blocks here exactly
/// as it blocks the wear save.
pub mod env {
    /// `LEVEL_FILE=<path>` — boot (and save) an alternate level file. A
    /// missing file boots the baked default and saves to the new path.
    pub const LEVEL_FILE: &str = "LEVEL_FILE";
    /// `EDIT="wallx 9 9; room 1 1; lamp 2 2 5; spawn 4 4"` — apply level ops
    /// at boot ([`house_game::gym::level_file::parse_ops`]).
    pub const EDIT: &str = "EDIT";
    /// `IDE_EDIT` — declared in `wear_file::env` (one name, one home); listed
    /// in [`ALL`] because its statements reach the level spec too.
    pub const IDE_EDIT: &str = crate::wear_file::env::IDE_EDIT;

    /// (name, writes-the-authored-spec).
    pub const ALL: &[(&str, bool)] = &[(LEVEL_FILE, false), (EDIT, true), (IDE_EDIT, true)];
}

fn env_overridden() -> bool {
    env::ALL.iter().filter(|(_, writes)| *writes).any(|(k, _)| std::env::var(k).is_ok())
}

/// The repo-relative path an unredirected save writes — the same bytes
/// `include_str!` bakes in, so a saved edit lands as a `git diff` on the
/// checked-in file.
const GYM_LEVEL_PATH: &str = "crates/house-game/src/gym/gym.level";

/// Level bookkeeping on the [`Viewer`](crate::viewer::Viewer).
pub struct LevelState {
    /// The AUTHORED spawn — what a save writes. A demo's boot spawn is an
    /// override on the way in and never lands here; an IDE spawn edit does.
    pub authored_spawn: CellPos,
    /// Only the gym has a file behind it; catalogue edits are session-only.
    pub file_backed: bool,
    /// An INTERACTIVE level edit happened since the last save. Harness
    /// replays (`IDE_EDIT=`) restore it, demos never set it.
    pub dirty: bool,
}

/// Build the boot spec for a level: the authored base (file or code), then
/// the `EDIT=` ops. The DEMO's spawn override is applied by the caller — this
/// function's spec IS the authoring, and its spawn is what a save writes.
pub fn load(level: crate::demos::Level) -> (GymLevel, LevelState) {
    let file_backed = matches!(level, crate::demos::Level::Gym);
    let mut spec = if file_backed {
        match std::env::var(env::LEVEL_FILE) {
            Ok(path) => match std::fs::read_to_string(&path) {
                Ok(text) => level_file::parse(&text).unwrap_or_else(|e| panic!("LEVEL_FILE {path}: {e}")),
                Err(_) => {
                    println!("level: {path} not found — booting the baked gym.level (a save will create it)");
                    level.spec()
                }
            },
            Err(_) => level.spec(),
        }
    } else {
        level.spec()
    };
    if let Ok(ops) = std::env::var(env::EDIT) {
        let ops = level_file::parse_ops(&ops).unwrap_or_else(|e| panic!("{e}"));
        let n = ops.iter().filter(|&&op| level_file::apply_op(&mut spec, op)).count();
        println!("EDIT: {n} of {} ops applied", ops.len());
    }
    let state = LevelState { authored_spawn: spec.player_start, file_backed, dirty: false };
    (spec, state)
}

impl crate::viewer::Viewer {
    /// Persist the owner's level edits — called after every IDE level edit,
    /// a no-op unless an INTERACTIVE edit happened since the last save.
    /// Mirrors [`wear_save`](crate::viewer::Viewer::wear_save): the dirty flag
    /// gates, an env override that writes the authoring blocks, and the
    /// serialized form is canonical so saves are diff-stable.
    pub fn level_save(&mut self) {
        if !self.level.dirty {
            return;
        }
        self.level.dirty = false;
        if env_overridden() {
            println!("level: env override active — edits stay in this session only");
            return;
        }
        if !self.level.file_backed {
            println!("level: this level is generated code — edits stay in this session only");
            return;
        }
        // The demo's spawn override must not be saved as authoring.
        let mut authored = self.gym.spec.clone();
        authored.player_start = self.level.authored_spawn;
        let text = level_file::serialize(&authored);
        let path = std::env::var(env::LEVEL_FILE).unwrap_or_else(|_| GYM_LEVEL_PATH.to_string());
        match std::fs::write(&path, &text) {
            Ok(()) => println!("level: saved to {path}"),
            Err(e) => eprintln!("level: could not save {path}: {e} — edits stay in this session only"),
        }
    }
}

#[cfg(test)]
mod tests {
    /// The wear guard's source-scan, on this module: every env read spells a
    /// name from [`super::env`], so a new knob cannot join the load or save
    /// path without declaring whether it writes the authoring.
    #[test]
    fn every_level_env_read_names_a_knob_from_the_table() {
        let bare = format!("env::var{}{}", '(', '"');
        let src = include_str!("level_host.rs");
        for (i, line) in src.lines().enumerate() {
            assert!(!line.contains(&bare), "level_host.rs:{}: a bare env name — declare it in `level_host::env`:\n  {}", i + 1, line.trim());
        }
        for (k, _) in super::env::ALL {
            assert!(src.contains(&format!("env::{k})")) || src.contains(&format!("({k}, ")), "{k} is in the table but nothing reads it");
        }
    }

    /// The save path is the include_str path: what a save writes is what the
    /// next build bakes in. (The viewer runs from the repo root — bin/run
    /// cd's there — so the path is repo-relative; the test resolves it from
    /// the crate dir.)
    #[test]
    fn the_save_path_is_the_baked_source() {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../..").join(super::GYM_LEVEL_PATH);
        let text = std::fs::read_to_string(&path).expect("the save path must be the checked-in file");
        assert_eq!(text, house_game::gym::level_file::GYM_LEVEL_SRC);
    }
}
