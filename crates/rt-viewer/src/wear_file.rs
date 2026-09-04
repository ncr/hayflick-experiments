//! Wear-as-data: a level's authored wear ([`crate::wall::LevelWear`]) as a
//! TEXT FILE — hand-parsed, `#` comments, errors carry 1-based line numbers,
//! and `serialize(parse(f)) == f` on every checked-in file so a panel save
//! stays diff-stable. The same discipline as the gym traces and the level
//! file: no serde, the grammar IS the doc.
//!
//! WHY A FILE: before 2026-07-27 the authored wear lived as `&'static` consts
//! in demos.rs, and every panel drag DIED ON EXIT — authoring that cannot be
//! saved is not authoring, it is dialing a demo. This file is the first brick
//! of the owner's modular effect system: the workflow "pick a wall, dial its
//! wear, come back tomorrow" needs a place for tomorrow to read.
//!
//! WHY A SIDECAR and not a section of gym.level: `LevelWear` speaks the wall
//! module's authoring vocabulary, which is an rt-viewer concept, and
//! house-game must stay renderer-blind (ARCHITECTURE.md). The level file
//! keeps the sim grid; the wear file keeps what the walls look like; the two
//! meet only through WORLD POINTS (`WallAt::at`) — exactly how `specs_of`
//! already addresses runs, so re-cutting a level never silently moves what
//! an author named.
//!
//! # Grammar (whitespace-separated, one statement per line)
//!
//! ```text
//! base <w> <s> <c>        level base story                  (default 0 0 0)
//! spread <v>              ± story spread between runs       (default 0)
//! wall <x> <z> [label…]   opens a wall block at a world point
//!   story <w> <s> <c>     the wall's own causes             (default 0 0 0)
//!   scrub <v>             the VARIANT dial, 0..1 (default 0 = the run's hash)
//!   band <lo> <hi>        the damage band's edges, 0..1     (default 0 1)
//!   pin <layer> <v>       stain|web|cracks|chips|spall|mud — an authored amount
//!   mudtop <v>            mud's splash-band top edge, 0..1  (default 0.35)
//!   breaks <n> [<at>]     a COUNT and optionally a PLACE (0..1 along the run)
//!   shell <u> <y> [back]  ONE artillery hit: run-space place, up to 3 lines
//!   caliber <v>           the hits' shared crater radius, wu (default 0.3)
//!   grain <v>             plate size, world units
//!   relief <v>            groove depth, 0..1
//!   pattern <name> [p…]   lightning|craquelure|mosaic + its native params
//!   paint_only            stamp the paint, skip the geometry pass
//! ```
//!
//! CANONICAL FORM (what [`serialize`] emits and the round-trip tests pin):
//! defaults are omitted, walls sort by (z, x), block statements come in the
//! grammar's order, blocks are separated by one blank line. Hand-written
//! comments survive a parse but not a save.

use crate::wall::{Breaks, Layer, LevelWear, Shape, Story, WallAt, WallSpec};
use std::sync::OnceLock;

/// One checked-in wear file: the baked source (`include_str!`, so cargo
/// rebuilds when it changes), the repo-relative path a save writes back to,
/// and a parse-once cache — a wear file is read at boot and leaked, so every
/// consumer keeps holding plain `&'static` data.
///
/// `WEAR_FILE=<path>` (harness) overrides BOTH the load source and the save
/// target — "boot my dialing from here, keep saving there". A path that does
/// not exist yet loads the baked default and saves to the new file, so the
/// override can start a fresh variant. It applies to whichever wear files the
/// process actually loads; a harness run boots exactly one demo.
pub struct WearFile {
    /// The demo the file belongs to (messages only).
    pub name: &'static str,
    /// Baked source, the default when no override is present.
    pub src: &'static str,
    /// Repo-relative load/save path (`bin/run` runs from the repo root).
    pub path: &'static str,
    cache: OnceLock<&'static LevelWear>,
}

impl WearFile {
    pub const fn new(name: &'static str, src: &'static str, path: &'static str) -> WearFile {
        WearFile { name, src, path, cache: OnceLock::new() }
    }

    /// Parse (once per process) and leak. A broken CHECKED-IN file is a
    /// panic — the canonical test catches it long before a boot does — and a
    /// broken `WEAR_FILE` override is one too: a harness that asked for a
    /// specific authoring must not silently render a different one.
    pub fn level_wear(&'static self) -> &'static LevelWear {
        self.cache.get_or_init(|| {
            let over = save_path(self);
            let (text, from) = match std::fs::read_to_string(&over) {
                Ok(s) => (s, over.clone()),
                Err(_) if over != self.path => {
                    println!("wear: {over} not found — {} boots its baked authoring", self.name);
                    (self.src.to_string(), self.path.to_string())
                }
                Err(_) => (self.src.to_string(), self.path.to_string()),
            };
            let lw = parse(&text).unwrap_or_else(|e| panic!("wear: {from}: {e}"));
            Box::leak(Box::new(lw))
        })
    }
}

/// Where this file's SAVE goes (and where the load looked first): the
/// `WEAR_FILE` override, else the checked-in path.
fn save_path(file: &WearFile) -> String {
    std::env::var("WEAR_FILE").unwrap_or_else(|_| file.path.to_string())
}

// ---------------------------------------------------------------------------
// parse
// ---------------------------------------------------------------------------

fn layer_of(s: &str) -> Option<Layer> {
    Layer::ALL.into_iter().find(|l| l.name() == s)
}

fn pattern_code_of(s: &str) -> Option<u8> {
    crate::crack_geom::POLICIES.iter().position(|p| *p == s).map(|i| i as u8)
}

/// Parse a wear file. Labels and the wall list are LEAKED — a wear file is
/// loaded once per process (tests leak a few bytes per call, which is fine).
pub fn parse(src: &str) -> Result<LevelWear, String> {
    let mut base = Story::ZERO;
    let mut spread = 0.0f32;
    let mut walls: Vec<WallAt> = Vec::new();
    let mut cur: Option<WallAt> = None;
    for (i, raw) in src.lines().enumerate() {
        let n = i + 1;
        let line = raw.split('#').next().unwrap_or("").trim();
        if line.is_empty() {
            continue;
        }
        let mut it = line.split_whitespace();
        let word = it.next().expect("non-empty line has a first token");
        let rest: Vec<&str> = it.collect();
        let f = |j: usize| -> Result<f32, String> {
            let t = rest.get(j).ok_or(format!("line {n}: `{word}` is missing its value {}", j + 1))?;
            t.parse::<f32>().map_err(|_| format!("line {n}: `{t}` is not a number"))
        };
        match (word, &mut cur) {
            ("wall", cur) => {
                if let Some(w) = cur.take() {
                    walls.push(w);
                }
                let label: &'static str = match rest.len() {
                    0 | 1 => return Err(format!("line {n}: `wall` needs a world point")),
                    2 => "",
                    _ => Box::leak(rest[2..].join(" ").into_boxed_str()),
                };
                *cur = Some(WallAt { at: (f(0)?, f(1)?), label, spec: WallSpec::PRISTINE });
            }
            // ---- level statements (only before the first wall block)
            ("base", None) => base = Story { weather: f(0)?, settlement: f(1)?, cover_loss: f(2)? },
            ("spread", None) => spread = f(0)?,
            // ---- wall statements
            ("story", Some(w)) => w.spec.story = Story { weather: f(0)?, settlement: f(1)?, cover_loss: f(2)? },
            ("scrub", Some(w)) => {
                let v = f(0)?;
                if !(0.0..=1.0).contains(&v) {
                    return Err(format!("line {n}: scrub is a dial, 0..1"));
                }
                w.spec.scrub = v;
            }
            ("band", Some(w)) => {
                let (lo, hi) = (f(0)?, f(1)?);
                if !(0.0..=1.0).contains(&lo) || !(0.0..=1.0).contains(&hi) || lo > hi {
                    return Err(format!("line {n}: a band is 0 <= lo <= hi <= 1 of the wall's height"));
                }
                w.spec.band = (lo, hi);
            }
            ("mudtop", Some(w)) => {
                let v = f(0)?;
                if !(0.0..=1.0).contains(&v) {
                    return Err(format!("line {n}: mudtop is a fraction of the wall's height, 0..1"));
                }
                w.spec.mud_top = v;
            }
            ("pin", Some(w)) => {
                let l = layer_of(rest.first().copied().unwrap_or("")).ok_or(format!("line {n}: unknown layer"))?;
                w.spec.pin = w.spec.pin.area(l, f(1)?);
            }
            ("breaks", Some(w)) => {
                let count = f(0)?;
                if count < 0.0 || count.fract() != 0.0 || count > Breaks::MAX as f32 {
                    return Err(format!("line {n}: a break count is a whole 0..={}", Breaks::MAX));
                }
                let at = rest.get(1).map(|_| f(1)).transpose()?;
                if at.is_some_and(|a| !(0.0..=1.0).contains(&a)) {
                    return Err(format!("line {n}: a break place is a fraction of the run, 0..1"));
                }
                w.spec.pin = w.spec.pin.breaks(Breaks { count: count as u8, at });
            }
            ("shell", Some(w)) => {
                let (u, y) = (f(0)?, f(1)?);
                if !(0.0..=1.0).contains(&u) || !(0.0..=1.0).contains(&y) {
                    return Err(format!("line {n}: a shell place is run-space, 0..1 both ways"));
                }
                let back = match rest.get(2) {
                    None => false,
                    Some(&"back") => true,
                    Some(t) => return Err(format!("line {n}: `{t}` — a shell's third word can only be `back`")),
                };
                if !w.spec.shells.add(crate::wall::Shell { u, y, back }) {
                    return Err(format!("line {n}: a wall holds at most {} shells", crate::wall::Shells::MAX));
                }
            }
            ("caliber", Some(w)) => w.spec.shells.caliber = f(0)?,
            ("grain", Some(w)) => w.spec.shape.grain = f(0)?,
            ("relief", Some(w)) => w.spec.shape.relief = f(0)?,
            ("pattern", Some(w)) => {
                let code = pattern_code_of(rest.first().copied().unwrap_or("")).ok_or(format!("line {n}: unknown pattern"))?;
                let np = crate::crack_geom::POLICY_PARAMS[code as usize].len();
                if rest.len() > 1 + np {
                    return Err(format!("line {n}: `{}` has {np} native params", rest[0]));
                }
                let mut par = crate::crack_geom::param_defaults(code);
                for (j, slot) in par.iter_mut().enumerate().take(rest.len().saturating_sub(1)) {
                    *slot = f(1 + j)?;
                }
                w.spec.shape.pattern = crate::wall::pattern_of(code, par);
            }
            ("paint_only", Some(w)) => w.spec.paint_only = true,
            ("base" | "spread", Some(_)) => return Err(format!("line {n}: `{word}` is a level statement — it goes before the first wall")),
            _ => return Err(format!("line {n}: unknown statement `{word}`")),
        }
    }
    if let Some(w) = cur.take() {
        walls.push(w);
    }
    Ok(LevelWear { base, spread, walls: Box::leak(walls.into_boxed_slice()) })
}

// ---------------------------------------------------------------------------
// serialize — the canonical form
// ---------------------------------------------------------------------------

/// Shortest text that round-trips back to the same f32 (`Display` for floats
/// is exactly that in Rust) — the property the canonical fixpoint rests on.
fn num(v: f32) -> String {
    format!("{v}")
}

/// [`serialize_parts`] over a whole `LevelWear` — the round-trip tests' half;
/// the live save assembles its wall list fresh and calls the parts form.
#[cfg(test)]
pub fn serialize(lw: &LevelWear) -> String {
    serialize_parts(lw.base, lw.spread, lw.walls)
}

/// The canonical writer. Takes parts rather than a `LevelWear` because the
/// SAVE path assembles its wall list fresh from the live lab (`lab_walls`)
/// and must not have to leak one to write it.
pub fn serialize_parts(base: Story, spread: f32, walls: &[WallAt]) -> String {
    let mut blocks: Vec<String> = Vec::new();
    let mut head: Vec<String> = Vec::new();
    if base != Story::ZERO {
        head.push(format!("base {} {} {}", num(base.weather), num(base.settlement), num(base.cover_loss)));
    }
    if spread != 0.0 {
        head.push(format!("spread {}", num(spread)));
    }
    if !head.is_empty() {
        blocks.push(head.join("\n"));
    }
    let mut sorted: Vec<&WallAt> = walls.iter().collect();
    sorted.sort_by(|a, b| (a.at.1, a.at.0).partial_cmp(&(b.at.1, b.at.0)).expect("authoring points are finite"));
    for w in sorted {
        let mut b: Vec<String> = Vec::new();
        let head = format!("wall {} {}", num(w.at.0), num(w.at.1));
        b.push(if w.label.is_empty() { head } else { format!("{head} {}", w.label) });
        let s = &w.spec;
        if s.story != Story::ZERO {
            b.push(format!("  story {} {} {}", num(s.story.weather), num(s.story.settlement), num(s.story.cover_loss)));
        }
        if s.scrub != 0.0 {
            b.push(format!("  scrub {}", num(s.scrub)));
        }
        if s.band != (0.0, 1.0) {
            b.push(format!("  band {} {}", num(s.band.0), num(s.band.1)));
        }
        if s.mud_top != WallSpec::MUD_TOP {
            b.push(format!("  mudtop {}", num(s.mud_top)));
        }
        for l in Layer::ALL {
            if let Some(v) = s.pin.get(l) {
                b.push(format!("  pin {} {}", l.name(), num(v)));
            }
        }
        if let Some(brk) = s.pin.get_breaks() {
            match brk.at {
                Some(a) => b.push(format!("  breaks {} {}", brk.count, num(a))),
                None => b.push(format!("  breaks {}", brk.count)),
            }
        }
        for sh in s.shells.iter() {
            b.push(if sh.back { format!("  shell {} {} back", num(sh.u), num(sh.y)) } else { format!("  shell {} {}", num(sh.u), num(sh.y)) });
        }
        if s.shells.caliber != crate::wall::Shells::CALIBER {
            b.push(format!("  caliber {}", num(s.shells.caliber)));
        }
        if s.shape.grain != Shape::DEFAULT.grain {
            b.push(format!("  grain {}", num(s.shape.grain)));
        }
        if s.shape.relief != Shape::DEFAULT.relief {
            b.push(format!("  relief {}", num(s.shape.relief)));
        }
        if s.shape.pattern != Shape::DEFAULT.pattern {
            let code = s.shape.pattern.code();
            let np = crate::crack_geom::POLICY_PARAMS[code as usize].len();
            let par = s.shape.pattern.par();
            let ps: Vec<String> = par.iter().take(np).map(|p| num(*p)).collect();
            b.push(format!("  pattern {} {}", s.shape.pattern.name(), ps.join(" ")));
        }
        if s.paint_only {
            b.push("  paint_only".into());
        }
        blocks.push(b.join("\n"));
    }
    let mut out = blocks.join("\n\n");
    out.push('\n');
    out
}

// ---------------------------------------------------------------------------
// save — the live lab back into level-wear text
// ---------------------------------------------------------------------------

/// The wall list a SAVE writes: every run a named wall addresses keeps its
/// authored point and label with the run's LIVE spec (the panel's truth), and
/// every run the owner has edited by hand ([`crate::crack::CrackLab::authored`])
/// without the level naming it gets a synthesized point — the run rect's
/// centre, which `holds` accepts by construction. Un-named, un-edited runs
/// stay derived from `base ± spread`, exactly as before the save.
pub fn lab_walls(lw: &LevelWear, runs: &[crate::wall::RunRect], lab: &crate::crack::CrackLab) -> Vec<WallAt> {
    // the forward map, exactly as `specs_of` runs it: first run that holds the
    // point, first claim wins
    let mut named: Vec<Option<&WallAt>> = vec![None; runs.len()];
    for w in lw.walls {
        if let Some(i) = runs.iter().position(|r| r.holds(w.at.0, w.at.1)) {
            if named[i].is_none() {
                named[i] = Some(w);
            }
        }
    }
    let mut out = Vec::new();
    for (r, rect) in runs.iter().enumerate() {
        let Some(spec) = lab.spec.get(r).copied() else { continue };
        match named[r] {
            Some(w) => out.push(WallAt { at: w.at, label: w.label, spec }),
            None if lab.authored.get(r).copied().unwrap_or(false) => {
                let at = ((rect.lo.x + rect.hi.x) * 0.5, (rect.lo.z + rect.hi.z) * 0.5);
                out.push(WallAt { at, label: "", spec });
            }
            None => {}
        }
    }
    out
}

/// Any wear env override poisons a save: the live specs then carry the
/// harness's asked-for state, not the owner's authoring, and freezing that
/// into the file would make one SHOT recipe permanent.
fn env_overridden() -> bool {
    // IDE_EDIT is here too: its wall statements ride the same spec, so a
    // replayed SHOT recipe must not freeze itself into the authoring either
    ["STORY", "SHAPE", "SPALL", "SPREAD", "SCRUB", "BAND", "HOLE", "WEAR_EDIT", "IDE_EDIT"].iter().any(|k| std::env::var(k).is_ok())
}

impl crate::viewer::Viewer {
    /// Persist the owner's wear edits — called on every release, a no-op
    /// unless an INTERACTIVE edit happened since the last save
    /// ([`crate::crack::CrackLab::dirty`]; the age-ramp beat and the
    /// `WEAR_EDIT` replay never set it, so demos and harness runs do not
    /// write files).
    pub fn wear_save(&mut self) {
        if !self.crack.dirty {
            return;
        }
        self.crack.dirty = false;
        if env_overridden() {
            println!("wear: env override active — edits stay in this session only");
            return;
        }
        let Some(file) = self.cur_demo.and_then(|d| d.wear) else { return };
        let lw = file.level_wear();
        let walls = lab_walls(lw, &self.crack.runs, &self.crack);
        let text = serialize_parts(lw.base, lw.spread, &walls);
        let path = save_path(file);
        match std::fs::write(&path, &text) {
            Ok(()) => println!("wear: saved {} walls to {path}", walls.len()),
            Err(e) => eprintln!("wear: could not save {path}: {e} — edits stay in this session only"),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::wall::{Pattern, Pins};

    /// A spec with every statement in play — the round-trip has to carry all
    /// of it, and the second serialize has to be the fixpoint.
    #[test]
    fn a_wear_file_round_trips_and_serialize_is_a_fixpoint() {
        let mut pin = Pins::NONE.area(Layer::Cracks, 0.6).area(Layer::Spall, 0.012);
        pin = pin.breaks(Breaks { count: 2, at: Some(0.25) });
        let mut shells = crate::wall::Shells::NONE;
        shells.caliber = 0.42;
        shells.add(crate::wall::Shell { u: 0.3, y: 0.6, back: false });
        shells.add(crate::wall::Shell { u: 0.75, y: 0.4, back: true });
        static_assertless_walls_round_trip(LevelWear {
            base: Story { weather: 0.55, settlement: 0.35, cover_loss: 0.65 },
            spread: 0.4,
            walls: Box::leak(Box::new([
                WallAt::pristine((12.0, 4.0), "negative control"),
                WallAt {
                    at: (13.0, 10.0),
                    label: "the works",
                    spec: WallSpec {
                        story: Story { weather: 0.9, settlement: 0.1, cover_loss: 0.0 },
                        scrub: 0.3,
                        band: (0.1, 0.55),
                        mud_top: 0.5,
                        shells,
                        pin,
                        shape: Shape { grain: 0.2, relief: 0.7, pattern: Pattern::Craquelure { wave: 0.5 } },
                        paint_only: true,
                    },
                },
            ])),
        });
    }
    fn static_assertless_walls_round_trip(lw: LevelWear) {
        let text = serialize(&lw);
        let back = parse(&text).expect("serialized wear parses");
        assert_eq!(back, lw, "parse(serialize(x)) == x");
        assert_eq!(serialize(&back), text, "serialize is a fixpoint");
    }

    /// The empty authoring is the empty file — a level with nothing to say
    /// must not acquire statements on a save.
    #[test]
    fn nothing_serializes_to_nothing() {
        let lw = LevelWear { base: Story::ZERO, spread: 0.0, walls: &[] };
        assert_eq!(serialize(&lw), "\n");
        assert_eq!(parse("").expect("an empty file parses"), lw);
        assert_eq!(parse("# only a comment\n").expect("a comment-only file parses"), lw);
    }

    /// Errors carry the 1-based line and say what is wrong — the editor-save
    /// loop turns a silent mis-parse into a mystery wall.
    #[test]
    fn a_parse_error_names_its_line() {
        for (src, needle) in [
            ("base 0.5 0.5\n", "missing its value"),
            ("wall 1\n", "world point"),
            ("spread x\n", "not a number"),
            ("wall 1 2 w\n  pin gloss 0.5\n", "unknown layer"),
            ("wall 1 2 w\n  breaks 7\n", "whole 0..=3"),
            ("wall 1 2 w\n  breaks 1 1.5\n", "fraction of the run"),
            ("wall 1 2 w\n  scrub 2\n", "dial, 0..1"),
            ("wall 1 2 w\n  band 0.8 0.2\n", "lo <= hi"),
            ("wall 1 2 w\n  pattern voronoi\n", "unknown pattern"),
            ("wall 1 2 w\n  pattern craquelure 0.5 0.5\n", "native params"),
            ("wall 1 2 w\n  shell 1.5 0.5\n", "run-space, 0..1"),
            ("wall 1 2 w\n  shell 0.5 0.5 front\n", "can only be `back`"),
            ("wall 1 2 w\n  shell 0.1 0.5\n  shell 0.4 0.5\n  shell 0.7 0.5\n  shell 0.9 0.5\n", "at most 3 shells"),
            ("wall 1 2 w\nbase 0 0 0\n", "level statement"),
            ("nonsense\n", "unknown statement"),
        ] {
            let e = parse(src).expect_err(src);
            assert!(e.contains("line "), "{src:?} → {e}");
            assert!(e.contains(needle), "{src:?} → {e}");
        }
        assert!(parse("wall 1 2 w\n  pin gloss 0.5\n").expect_err("").contains("line 2"), "the line number is the statement's own");
    }

    /// The checked-in files ARE canonical — `serialize(parse(f)) == f`, so an
    /// owner save produces a clean diff and never a whole-file rewrite.
    #[test]
    fn checked_in_wear_files_are_canonical() {
        for file in [&crate::demos::LAB_WEAR_FILE, &crate::demos::CATALOGUE_WEAR_FILE, &crate::demos::COURTYARD_WEAR_FILE] {
            let lw = parse(file.src).unwrap_or_else(|e| panic!("{}: {e}", file.path));
            assert_eq!(serialize(&lw), file.src, "{} is not canonical — save it through `serialize`", file.path);
        }
    }

    /// THE SAVE ROUND-TRIP: what the owner dialed is what the next boot
    /// reads. A named wall keeps its authored point with its LIVE spec; a
    /// hand-edited unnamed run gets a synthesized point that resolves back to
    /// the SAME run; untouched derived runs stay out of the file so the
    /// spread keeps breathing.
    #[test]
    fn a_saved_lab_boots_back_to_the_edited_state() {
        let (mut scene, meta) = crate::gym_scene::build_gym(&house_game::gym::sim::gym_level(), &crate::look::POLANA, true);
        let mut lab = crate::crack::CrackLab::default();
        let lw = crate::demos::lab_wear();
        crate::crack::resolve(Some(lw), &mut lab, &meta.piers, &mut scene, 1);
        assert_eq!(lab.authored.iter().filter(|a| **a).count(), 2, "the two named controls boot authored");

        // the owner edits the NAMED ramped control…
        let named = lab.runs.iter().position(|r| r.holds(13.0, 10.0)).expect("the garden wall");
        lab.spec[named].story = Story { weather: 0.9, settlement: 0.0, cover_loss: 0.1 };
        // …and one DERIVED run by hand
        let derived = lab.authored.iter().position(|a| !a).expect("some run is derived");
        lab.spec[derived].pin = lab.spec[derived].pin.area(Layer::Chips, 0.3);
        lab.authored[derived] = true;

        let walls = lab_walls(lw, &lab.runs, &lab);
        assert_eq!(walls.len(), 3, "two named + one hand-edited");
        let text = serialize_parts(lw.base, lw.spread, &walls);
        let back = parse(&text).expect("a save parses");

        // a fresh boot from the saved text lands on the edited specs
        let mut lab2 = crate::crack::CrackLab::default();
        crate::crack::resolve(Some(&back), &mut lab2, &meta.piers, &mut scene, 1);
        assert_eq!(lab2.spec[named], lab.spec[named], "the named wall's edit survived");
        assert_eq!(lab2.spec[derived], lab.spec[derived], "the synthesized point resolved back to its own run");
        assert!(lab2.authored[derived], "a saved wall boots authored");
        // …and an untouched derived run still derives (not in the file)
        let untouched = (0..lab.runs.len()).find(|r| !lab.authored[*r]).expect("one run stays derived");
        assert_eq!(lab2.spec[untouched], lab.spec[untouched], "derived runs re-derive identically (same base ± spread)");
    }

    /// A partial `pattern` line fills the missing native params from that
    /// pattern's own defaults — the same rule `SHAPE=` uses.
    #[test]
    fn pattern_params_default_per_pattern() {
        let lw = parse("wall 1 2 w\n  pattern lightning 0.9\n").expect("parses");
        let Pattern::Lightning { branch, straight, spread } = lw.walls[0].spec.shape.pattern else { panic!("wrong pattern") };
        assert_eq!(branch, 0.9);
        let Pattern::Lightning { straight: ds, spread: dp, .. } = Pattern::DEFAULTS[0] else { unreachable!() };
        assert_eq!((straight, spread), (ds, dp));
    }
}
