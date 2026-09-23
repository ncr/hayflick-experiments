//! The gym level as DATA: a plain-text file the game loads and creative mode
//! writes back — diffed in git like any other authored asset. Same no-serde
//! discipline as the trace format ([`super::trace`]): one statement per line,
//! hand-parsed, `#` comments.
//!
//! Grammar (coords are grid integers; `size` must come first):
//! - `size W H` — grid dimensions (cells)
//! - `spawn X Z` — player start cell
//! - `lamp X Z GLOW` — a lamp at cell (X, Z), intensity 1..8; file order is
//!   the lamp identity order (`lamp_0`, `lamp_1`, … NEE names)
//! - `room X Z` — cell (X, Z) is Room (default Outdoor)
//! - `wallx X Z` — Wall on the x-edge at (X, Z): separates (X-1,Z) | (X,Z)
//! - `wallz X Z` — Wall on the z-edge at (X, Z): separates (X,Z-1) | (X,Z)
//! - `paint EFFECT X Y Z SIDE R` — a creative-mode brush dab on a wall face:
//!   effect `rain|soot|spall`, the world point, the face's outward normal
//!   `+x|-x|+z|-z`, the brush radius (floats; file order = paint order)
//! - `grow grass|dry|mow X Z R` — a ground brush dab (floats; file order =
//!   paint order)
//! - `plant tree|bush X Z SEED` — a procedural plant at world (X, Z)
//! - `neighborhood` — build this level as a street: terrain, painted walls,
//!   grass (the "after the rain" pipeline); without it, the greybox gym's
//! - `floor road|walk|soil X0 Z0 X1 Z1` — a ground rectangle, later over
//!   earlier (a building's Room cells are always slab floor)
//! - `pothole X Z R` — a hole in the road
//! - `window X Z` — a window opening centred at world (X, Z) on a wall line
//! - `roof X0 Z0 X1 Z1` — a broken roof slab over a world rect, torn on +z
//! - `prop KIND X Z YAW SEED` — a street prop (car, barrel, crate, tires,
//!   barrier, pole, sign, hydrant, mailbox, bench), turned YAW radians
//!
//! [`serialize`] emits the CANONICAL form (fixed statement order, rooms and
//! walls z-major) — `serialize(parse(f)) == f` for a canonical file, pinned
//! by test so the checked-in file stays diff-stable across editor saves.
//!
//! [`super::sim::gym_level`] IS `parse(GYM_LEVEL_SRC)` since 2026-08-09 — the
//! file replaced the hand-written builder, verified grid-hash-identical and
//! SHOT-byte-identical in the migration round. The other levels (concrete
//! aftermath, after the rain) stay CODE: they are generated.
//!
//! Determinism policy (the 2026-07-23 handoff's watch item): `grid_hash` is
//! the level identity — recorded gym traces and pinned state hashes are valid
//! only for the level content they were recorded on. An owner edit is a
//! reviewable commit to this file; tests that walk the authored level
//! (doorway routes etc.) document that content and fail loudly when it moves.
//!
//! [`EditOp`]/[`apply_op`] are the ONE spec-mutation vocabulary (from the
//! archived editor-v0, moved into the sim crate where it tests headlessly):
//! creative mode's edits, the `EDIT=` harness knob and the tests all go through it.

use super::grid::{CellKind, CellPos, EdgeKind, Grid};
use super::sim::{Floor, FloorKind, GroundStroke, GrowBrush, GymLevel, PaintEffect, PaintStroke, Plant, PlantKind, Prop, PropKind};

/// The checked-in gym level — THE one hand-authored level (owner directive
/// 2026-07-12), embedded at compile time so headless tests, the viewer and
/// the editor all read the same bytes and cargo rebuilds on change.
pub const GYM_LEVEL_SRC: &str = include_str!("gym.level");

/// "after the rain" — the street (2026-09-23: level DATA since the layout
/// file and the code that generated it were retired; everything in it can be
/// built and painted in creative mode).
pub const AFTER_THE_RAIN_SRC: &str = include_str!("after_the_rain.level");

/// "sandbox" — an empty street to build from nothing in creative mode.
pub const SANDBOX_SRC: &str = include_str!("sandbox.level");

/// Parse a level file. Errors carry the 1-based line number.
pub fn parse(text: &str) -> Result<GymLevel, String> {
    let mut grid: Option<Grid> = None;
    let mut spawn: Option<CellPos> = None;
    let mut lights: Vec<(CellPos, i32)> = Vec::new();
    let mut paint: Vec<PaintStroke> = Vec::new();
    let mut ground: Vec<GroundStroke> = Vec::new();
    let mut plants: Vec<Plant> = Vec::new();
    let mut floors: Vec<Floor> = Vec::new();
    let mut potholes: Vec<[f32; 3]> = Vec::new();
    let mut windows: Vec<[f32; 2]> = Vec::new();
    let mut roofs: Vec<[f32; 4]> = Vec::new();
    let mut neighborhood = false;
    let mut props: Vec<Prop> = Vec::new();
    for (ln, raw) in text.lines().enumerate() {
        let line = raw.split('#').next().unwrap_or("").trim();
        if line.is_empty() {
            continue;
        }
        let mut it = line.split_whitespace();
        let op = it.next().unwrap();
        let mut num = || -> Result<i16, String> {
            it.next()
                .ok_or_else(|| format!("line {}: {op}: missing coordinate", ln + 1))?
                .parse::<i16>()
                .map_err(|_| format!("line {}: {op}: bad number", ln + 1))
        };
        if op == "paint" {
            let err = |m: &str| format!("line {}: paint: {m}", ln + 1);
            let effect = it.next().and_then(PaintEffect::by_name).ok_or_else(|| err("unknown effect"))?;
            let mut f = || -> Result<f32, String> { it.next().and_then(|t| t.parse::<f32>().ok()).filter(|v| v.is_finite()).ok_or_else(|| err("bad number")) };
            let pos = [f()?, f()?, f()?];
            let (axis, sign) = match it.next() {
                Some("+x") => (0, 1),
                Some("-x") => (0, -1),
                Some("+z") => (2, 1),
                Some("-z") => (2, -1),
                _ => return Err(err("side must be +x|-x|+z|-z")),
            };
            let mut f = || -> Result<f32, String> { it.next().and_then(|t| t.parse::<f32>().ok()).filter(|v| v.is_finite() && *v > 0.0).ok_or_else(|| err("bad radius")) };
            paint.push(PaintStroke { effect, pos, axis, sign, r: f()? });
            continue;
        }
        if op == "prop" {
            let err = |m: &str| format!("line {}: prop: {m}", ln + 1);
            let kind = it.next().and_then(PropKind::by_name).ok_or_else(|| err("unknown prop"))?;
            let mut f = || -> Result<f32, String> { it.next().and_then(|t| t.parse::<f32>().ok()).filter(|v| v.is_finite()).ok_or_else(|| err("bad number")) };
            let (x, z, yaw) = (f()?, f()?, f()?);
            let seed = it.next().and_then(|t| t.parse::<u32>().ok()).ok_or_else(|| err("bad seed"))?;
            props.push(Prop { kind, x, z, yaw, seed });
            continue;
        }
        if op == "neighborhood" {
            neighborhood = true;
            continue;
        }
        if matches!(op, "floor" | "pothole" | "window" | "roof") {
            let err = |m: &str| format!("line {}: {op}: {m}", ln + 1);
            let kind = if op == "floor" { Some(it.next().and_then(FloorKind::by_name).ok_or_else(|| err("unknown floor"))?) } else { None };
            let v: Vec<f32> = it.map(|t| t.parse::<f32>().ok().filter(|v| v.is_finite())).collect::<Option<Vec<f32>>>().ok_or_else(|| err("bad number"))?;
            let want = match op {
                "pothole" => 3,
                "window" => 2,
                _ => 4,
            };
            if v.len() != want {
                return Err(err(&format!("expected {want} numbers")));
            }
            match op {
                "floor" => floors.push(Floor { kind: kind.unwrap(), rect: [v[0], v[1], v[2], v[3]] }),
                "pothole" => potholes.push([v[0], v[1], v[2]]),
                "window" => windows.push([v[0], v[1]]),
                _ => roofs.push([v[0], v[1], v[2], v[3]]),
            }
            continue;
        }
        if op == "grow" || op == "plant" {
            let err = |m: &str| format!("line {}: {op}: {m}", ln + 1);
            let name = it.next().ok_or_else(|| err("missing kind"))?;
            let mut f = || -> Result<f32, String> { it.next().and_then(|t| t.parse::<f32>().ok()).filter(|v| v.is_finite()).ok_or_else(|| err("bad number")) };
            let (x, z) = (f()?, f()?);
            if op == "grow" {
                let brush = GrowBrush::by_name(name).ok_or_else(|| err("unknown brush"))?;
                let r = f()?;
                if r <= 0.0 {
                    return Err(err("bad radius"));
                }
                ground.push(GroundStroke { brush, x, z, r });
            } else {
                let kind = PlantKind::by_name(name).ok_or_else(|| err("unknown plant"))?;
                let seed = it.next().and_then(|t| t.parse::<u32>().ok()).ok_or_else(|| err("bad seed"))?;
                plants.push(Plant { kind, x, z, seed });
            }
            continue;
        }
        if op == "size" {
            let (w, h) = (num()?, num()?);
            if grid.is_some() {
                return Err(format!("line {}: duplicate size", ln + 1));
            }
            if w <= 0 || h <= 0 {
                return Err(format!("line {}: degenerate size {w}x{h}", ln + 1));
            }
            grid = Some(Grid::new(w, h));
            continue;
        }
        let g = grid.as_mut().ok_or_else(|| format!("line {}: {op} before size", ln + 1))?;
        let (w, h) = (g.w, g.h);
        let bounds = |x: i16, z: i16, xmax: i16, zmax: i16| -> Result<(), String> {
            if x < 0 || z < 0 || x > xmax || z > zmax {
                return Err(format!("line {}: {op} ({x}, {z}) out of bounds", ln + 1));
            }
            Ok(())
        };
        match op {
            "spawn" => {
                let (x, z) = (num()?, num()?);
                bounds(x, z, w - 1, h - 1)?;
                spawn = Some(CellPos::new(x, z));
            }
            "lamp" => {
                let (x, z, glow) = (num()?, num()?, num()?);
                bounds(x, z, w - 1, h - 1)?;
                lights.push((CellPos::new(x, z), glow as i32));
            }
            "room" => {
                let (x, z) = (num()?, num()?);
                bounds(x, z, w - 1, h - 1)?;
                g.set_cell(CellPos::new(x, z), CellKind::Room);
            }
            "wallx" => {
                let (x, z) = (num()?, num()?);
                bounds(x, z, w, h - 1)?;
                g.set_edge_x(x, z, EdgeKind::Wall);
            }
            "wallz" => {
                let (x, z) = (num()?, num()?);
                bounds(x, z, w - 1, h)?;
                g.set_edge_z(x, z, EdgeKind::Wall);
            }
            _ => return Err(format!("line {}: unknown statement {op:?}", ln + 1)),
        }
    }
    let grid = grid.ok_or("no size statement")?;
    let player_start = spawn.ok_or("no spawn statement")?;
    Ok(GymLevel { props, floors, potholes, windows, roofs, ground, plants, paint, neighborhood, grid, player_start, lights })
}

/// Emit the canonical text form: header, size, spawn, lamps (identity order),
/// rooms z-major, wallx z-major, wallz z-major. Creative mode's save writes this.
pub fn serialize(spec: &GymLevel) -> String {
    let g = &spec.grid;
    let mut out = String::from(
        "# Hayflick level - creative mode writes this file back; review edits with\n\
         # git diff. grid_hash is the level identity: editing the grid invalidates\n\
         # recorded traces and pinned state hashes for this level.\n\
         # Grammar: size W H | spawn X Z | lamp X Z GLOW | room X Z | wallx X Z | wallz X Z\n\
         #          paint rain|soot|spall X Y Z +x|-x|+z|-z R\n\
         #          grow grass|dry|mow|scorch X Z R | plant tree|bush X Z SEED\n\
         #          neighborhood | floor road|walk|soil X0 Z0 X1 Z1 | pothole X Z R\n\
         #          window X Z | roof X0 Z0 X1 Z1 | prop KIND X Z YAW SEED\n",
    );
    out.push_str(&format!("size {} {}\n", g.w, g.h));
    if spec.neighborhood {
        out.push_str("neighborhood\n");
    }
    out.push_str(&format!("spawn {} {}\n", spec.player_start.x, spec.player_start.z));
    for (c, glow) in &spec.lights {
        out.push_str(&format!("lamp {} {} {}\n", c.x, c.z, glow));
    }
    for z in 0..g.h {
        for x in 0..g.w {
            if g.cell(CellPos::new(x, z)) == CellKind::Room {
                out.push_str(&format!("room {x} {z}\n"));
            }
        }
    }
    for z in 0..g.h {
        for x in 0..=g.w {
            if g.edge_x(x, z) == EdgeKind::Wall {
                out.push_str(&format!("wallx {x} {z}\n"));
            }
        }
    }
    for z in 0..=g.h {
        for x in 0..g.w {
            if g.edge_z(x, z) == EdgeKind::Wall {
                out.push_str(&format!("wallz {x} {z}\n"));
            }
        }
    }
    for s in &spec.paint {
        let side = match (s.axis, s.sign > 0) {
            (0, true) => "+x",
            (0, false) => "-x",
            (_, true) => "+z",
            (_, false) => "-z",
        };
        // `{}` is Rust's shortest round-tripping float text: canonical
        out.push_str(&format!("paint {} {} {} {} {side} {}\n", s.effect.name(), s.pos[0], s.pos[1], s.pos[2], s.r));
    }
    for g in &spec.ground {
        out.push_str(&format!("grow {} {} {} {}\n", g.brush.name(), g.x, g.z, g.r));
    }
    for p in &spec.plants {
        out.push_str(&format!("plant {} {} {} {}\n", p.kind.name(), p.x, p.z, p.seed));
    }
    for f in &spec.floors {
        out.push_str(&format!("floor {} {} {} {} {}\n", f.kind.name(), f.rect[0], f.rect[1], f.rect[2], f.rect[3]));
    }
    for h in &spec.potholes {
        out.push_str(&format!("pothole {} {} {}\n", h[0], h[1], h[2]));
    }
    for w in &spec.windows {
        out.push_str(&format!("window {} {}\n", w[0], w[1]));
    }
    for r in &spec.roofs {
        out.push_str(&format!("roof {} {} {} {}\n", r[0], r[1], r[2], r[3]));
    }
    for p in &spec.props {
        out.push_str(&format!("prop {} {} {} {} {}\n", p.kind.name(), p.x, p.z, p.yaw, p.seed));
    }
    out
}

/// One level mutation — the SINGLE spec-mutation path, shared by the editor's
/// gestures, the `EDIT=` harness ops and the tests. Toggles rather than
/// set/clear pairs: the authoring gesture is "click the thing", and a toggle
/// makes every op its own undo.
#[derive(Clone, Copy, PartialEq, Debug)]
pub enum EditOp {
    /// Toggle the x-edge at (x, z) — separates cells (x-1, z) | (x, z).
    ToggleWallX { x: i16, z: i16 },
    /// Toggle the z-edge at (x, z) — separates cells (x, z-1) | (x, z).
    ToggleWallZ { x: i16, z: i16 },
    /// Toggle cell (x, z) between Outdoor and Room.
    ToggleRoom { x: i16, z: i16 },
    /// Place a lamp at cell (x, z) with `glow`, or remove the one standing
    /// there (the identity order shifts for the lamps after it — lamp names
    /// are positional).
    ToggleLamp { x: i16, z: i16, glow: i32 },
    /// Move the spawn cell (applies to the NEXT restart, not the live player).
    SetSpawn { x: i16, z: i16 },
}

/// Apply one op to the level spec. Returns whether anything changed
/// (out-of-bounds coords and no-op spawns don't).
pub fn apply_op(spec: &mut GymLevel, op: EditOp) -> bool {
    let g = &mut spec.grid;
    let (w, h) = (g.w, g.h);
    match op {
        EditOp::ToggleWallX { x, z } => {
            if x < 0 || x > w || z < 0 || z >= h {
                return false;
            }
            let e = if g.edge_x(x, z) == EdgeKind::Wall { EdgeKind::Open } else { EdgeKind::Wall };
            g.set_edge_x(x, z, e);
            true
        }
        EditOp::ToggleWallZ { x, z } => {
            if x < 0 || x >= w || z < 0 || z > h {
                return false;
            }
            let e = if g.edge_z(x, z) == EdgeKind::Wall { EdgeKind::Open } else { EdgeKind::Wall };
            g.set_edge_z(x, z, e);
            true
        }
        EditOp::ToggleRoom { x, z } => {
            let p = CellPos::new(x, z);
            if !g.in_bounds(p) {
                return false;
            }
            let c = if g.cell(p) == CellKind::Room { CellKind::Outdoor } else { CellKind::Room };
            g.set_cell(p, c);
            true
        }
        EditOp::ToggleLamp { x, z, glow } => {
            let p = CellPos::new(x, z);
            if !g.in_bounds(p) {
                return false;
            }
            if let Some(i) = spec.lights.iter().position(|(c, _)| *c == p) {
                spec.lights.remove(i);
            } else {
                spec.lights.push((p, glow.clamp(1, 8)));
            }
            true
        }
        EditOp::SetSpawn { x, z } => {
            let p = CellPos::new(x, z);
            if !g.in_bounds(p) || spec.player_start == p {
                return false;
            }
            spec.player_start = p;
            true
        }
    }
}

/// Parse an `EDIT=` op list: statements split on `;`, each `<op> <x> <z>
/// [<glow>]` with the op names spelled as the file grammar's wall/room words
/// plus `lamp` and `spawn`. Errors name the statement.
pub fn parse_ops(text: &str) -> Result<Vec<EditOp>, String> {
    let mut out = Vec::new();
    for stmt in text.split(';') {
        let stmt = stmt.trim();
        if stmt.is_empty() {
            continue;
        }
        let mut it = stmt.split_whitespace();
        let op = it.next().unwrap();
        let mut num = || -> Result<i16, String> {
            it.next().ok_or_else(|| format!("EDIT {stmt:?}: missing coordinate"))?.parse::<i16>().map_err(|_| format!("EDIT {stmt:?}: bad number"))
        };
        out.push(match op {
            "wallx" => EditOp::ToggleWallX { x: num()?, z: num()? },
            "wallz" => EditOp::ToggleWallZ { x: num()?, z: num()? },
            "room" => EditOp::ToggleRoom { x: num()?, z: num()? },
            "lamp" => {
                let (x, z) = (num()?, num()?);
                let glow = num().unwrap_or(6) as i32;
                EditOp::ToggleLamp { x, z, glow }
            }
            "spawn" => EditOp::SetSpawn { x: num()?, z: num()? },
            _ => return Err(format!("EDIT {stmt:?}: unknown op")),
        });
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::gym::grid::Dir;
    use crate::gym::sim::DOORWAY;

    /// The checked-in file parses and stays CANONICAL: an editor save of the
    /// unedited level must be byte-identical to the file (diff-stable saves).
    #[test]
    fn checked_in_level_is_canonical() {
        let spec = parse(GYM_LEVEL_SRC).expect("gym.level must parse");
        assert_eq!(serialize(&spec), GYM_LEVEL_SRC, "gym.level must be in canonical serialize order");
        assert!(spec.grid.open(DOORWAY, Dir::Zp), "the doorway must stay open");
    }

    /// Full round-trip at the spec level: serialize → parse reproduces the
    /// exact grid (hash), lamps and spawn — the editor's save/reload identity.
    #[test]
    fn serialize_parse_round_trips() {
        let mut spec = parse(GYM_LEVEL_SRC).unwrap();
        // perturb: an extra wall, a room cell, a lamp, a moved spawn
        spec.grid.set_edge_z(9, 9, EdgeKind::Wall);
        spec.grid.set_cell(CellPos::new(1, 1), CellKind::Room);
        spec.lights.push((CellPos::new(2, 12), 4));
        spec.player_start = CellPos::new(0, 0);
        let text = serialize(&spec);
        let back = parse(&text).unwrap();
        assert_eq!(back.grid.grid_hash(), spec.grid.grid_hash());
        assert_eq!(back.lights, spec.lights);
        assert_eq!(back.player_start, spec.player_start);
        assert_eq!(serialize(&back), text, "canonical form is a fixed point");
    }

    /// Paint strokes survive a save/load exactly (shortest round-trip floats)
    /// and bad ones are rejected with the line number.
    #[test]
    fn paint_strokes_round_trip_and_reject_garbage() {
        let mut spec = parse(GYM_LEVEL_SRC).unwrap();
        spec.paint.push(PaintStroke { effect: PaintEffect::Spall, pos: [3.1, 1.25, 7.1], axis: 2, sign: 1, r: 0.4 });
        spec.paint.push(PaintStroke { effect: PaintEffect::Rain, pos: [12.1, 2.9, 4.0], axis: 0, sign: -1, r: 0.35 });
        let text = serialize(&spec);
        let back = parse(&text).unwrap();
        assert_eq!(back.paint, spec.paint);
        assert_eq!(serialize(&back), text);
        assert!(parse("size 4 4\nspawn 1 1\npaint glitter 1 1 1 +x 0.3\n").is_err());
        assert!(parse("size 4 4\nspawn 1 1\npaint rain 1 1 1 up 0.3\n").is_err());
        assert!(parse("size 4 4\nspawn 1 1\npaint rain 1 1 1 +x 0\n").err().is_some_and(|e| e.contains("line 3")));
    }

    #[test]
    fn street_data_round_trips() {
        let mut spec = parse(GYM_LEVEL_SRC).unwrap();
        spec.neighborhood = true;
        spec.floors.push(Floor { kind: FloorKind::Road, rect: [0.0, 10.0, 26.0, 14.0] });
        spec.potholes.push([8.3, 11.8, 1.25]);
        spec.windows.push([3.1, 7.0]);
        spec.roofs.push([2.0, 2.0, 9.0, 4.25]);
        spec.props.push(Prop { kind: PropKind::Car, x: 7.25, z: 11.5, yaw: 0.785, seed: 17 });
        spec.ground.push(GroundStroke { brush: GrowBrush::Scorch, x: 1.0, z: 2.0, r: 1.5 });
        let text = serialize(&spec);
        let back = parse(&text).unwrap();
        assert!(back.neighborhood);
        assert_eq!((back.floors, back.potholes, back.windows, back.roofs, back.ground), (spec.floors.clone(), spec.potholes.clone(), spec.windows.clone(), spec.roofs.clone(), spec.ground.clone()));
        assert_eq!(back.props, spec.props);
        assert!(parse("size 4 4\nspawn 1 1\nfloor lava 0 0 1 1\n").is_err());
        assert!(parse("size 4 4\nspawn 1 1\nwindow 1\n").is_err());
    }

    #[test]
    fn ground_strokes_and_plants_round_trip() {
        let mut spec = parse(GYM_LEVEL_SRC).unwrap();
        spec.ground.push(GroundStroke { brush: GrowBrush::Dry, x: 3.25, z: 7.5, r: 1.0 });
        spec.plants.push(Plant { kind: PlantKind::Tree, x: 12.1, z: 4.0, seed: 4_000_000_001 });
        let text = serialize(&spec);
        let back = parse(&text).unwrap();
        assert_eq!(back.ground, spec.ground);
        assert_eq!(back.plants, spec.plants);
        assert_eq!(serialize(&back), text);
        assert!(parse("size 4 4\nspawn 1 1\ngrow weed 1 1 1\n").is_err());
        assert!(parse("size 4 4\nspawn 1 1\nplant tree 1 1 -3\n").is_err());
    }

    #[test]
    fn parse_rejects_malformed_input() {
        assert!(parse("").is_err(), "empty: no size");
        assert!(parse("size 4 4\n").is_err(), "no spawn");
        assert!(parse("spawn 1 1\nsize 4 4\n").is_err(), "statement before size");
        assert!(parse("size 4 4\nsize 4 4\nspawn 1 1\n").is_err(), "duplicate size");
        assert!(parse("size 4 4\nspawn 9 1\n").is_err(), "spawn out of bounds");
        assert!(parse("size 4 4\nspawn 1 1\nwallx 5 0\n").is_err(), "edge out of bounds");
        assert!(parse("size 4 4\nspawn 1 1\ndoor 1 1\n").is_err(), "unknown statement");
        assert!(parse("size 4 4\nspawn 1 1\nwallx one 0\n").is_err(), "bad number");
        // boundary edges ARE addressable: x = w for wallx, z = h for wallz
        assert!(parse("size 4 4\nspawn 1 1\nwallx 4 0\nwallz 0 4\n").is_ok());
        // comments and blank lines are ignored
        assert!(parse("# hi\nsize 4 4\n\nspawn 1 1 # trailing\n").is_ok());
    }

    /// Every op mutates, applies as its own undo, and rejects out-of-bounds
    /// coords without touching the spec.
    #[test]
    fn ops_toggle_and_reject_out_of_bounds() {
        let mut spec = parse(GYM_LEVEL_SRC).unwrap();
        let h0 = spec.grid.grid_hash();
        for op in [
            EditOp::ToggleWallX { x: 9, z: 9 },
            EditOp::ToggleWallZ { x: 9, z: 9 },
            EditOp::ToggleRoom { x: 1, z: 1 },
            EditOp::ToggleLamp { x: 2, z: 2, glow: 5 },
        ] {
            assert!(apply_op(&mut spec, op), "{op:?} must apply");
            assert!(apply_op(&mut spec, op), "{op:?} must apply again");
        }
        assert_eq!(spec.grid.grid_hash(), h0, "a toggle pair is a no-op");
        assert_eq!(spec.lights.len(), parse(GYM_LEVEL_SRC).unwrap().lights.len());
        for op in [
            EditOp::ToggleWallX { x: 99, z: 0 },
            EditOp::ToggleWallZ { x: 0, z: 99 },
            EditOp::ToggleRoom { x: -1, z: 0 },
            EditOp::ToggleLamp { x: 99, z: 99, glow: 5 },
            EditOp::SetSpawn { x: 99, z: 0 },
        ] {
            assert!(!apply_op(&mut spec, op), "{op:?} must reject");
        }
        assert_eq!(spec.grid.grid_hash(), h0, "rejected ops touch nothing");
    }

    /// The op list grammar: statements split on `;`, errors name the
    /// statement, and applying a parsed list edits the level.
    #[test]
    fn edit_op_lists_parse_and_apply() {
        let ops = parse_ops("wallx 9 9; room 1 1;; spawn 2 2").unwrap();
        assert_eq!(ops.len(), 3);
        let mut spec = parse(GYM_LEVEL_SRC).unwrap();
        for op in ops {
            assert!(apply_op(&mut spec, op));
        }
        assert_eq!(spec.player_start, CellPos::new(2, 2));
        assert_eq!(spec.grid.cell(CellPos::new(1, 1)), CellKind::Room);
        assert!(parse_ops("fly 1 2").unwrap_err().contains("fly"), "the error names the statement");
    }
}

