//! Creative mode — the in-game builder's TOOL LOGIC (owner 2026-09-22: "I
//! don't want SolidWorks or Unreal. I want a GAME, and the editor is one of
//! its modes, cut for it — tools worth a good city builder or level editor").
//!
//! This is the whole gesture model, headless: a tool, a press point, a drag
//! point and a button go in; a PREVIEW (what the release would change, drawn
//! as a ghost) and on release the new level come out. The viewer only turns
//! the pointer into a ground point and draws the preview — every decision
//! about what a gesture means lives here and is unit-tested.
//!
//! Gestures are city-builder shaped: press, drag, see the ghost, release to
//! commit, right button to remove, Esc to cancel. Every commit is ONE undo
//! step, and undo is a snapshot stack of the whole [`GymLevel`] — a level is
//! a few hundred bytes of grid, so a snapshot is cheaper and more obviously
//! correct than inverting ops.
//!
//! The spec mutations still go through the grid's own setters, the same
//! addressing as the level file ([`super::level_file`]), so a creative edit
//! saves as an ordinary canonical `.level` diff.

use super::grid::{CellKind, CellPos, EdgeKind};
use super::sim::{GroundStroke, GrowBrush, GymLevel, PaintEffect, PaintStroke, Plant, PlantKind};

/// The toolbar. Order = hotkey order (1..) and the toolbar's left-to-right.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Tool {
    /// Drag between two grid corners: a straight wall along x or z.
    Wall,
    /// Drag a rectangle of cells: a building — floor, perimeter walls and one
    /// doorway on its camera-facing (+z) side.
    Room,
    /// Click a cell: place a lamp (right button removes).
    Lamp,
    /// Click a cell: the player's start cell.
    Spawn,
    /// Drag over a wall: paint an effect onto its surface (right-drag scrubs
    /// paint off). The effect is the tool — one toolbar button each.
    Paint(PaintEffect),
    /// Drag over the ground: grow grass / dry it to straw (right-drag mows).
    Grow(GrowBrush),
    /// Click (or drag, for bushes) to plant; right-click uproots.
    Plant(PlantKind),
}

impl Tool {
    pub const ALL: [Tool; 11] = [
        Tool::Wall,
        Tool::Room,
        Tool::Lamp,
        Tool::Spawn,
        Tool::Paint(PaintEffect::Rain),
        Tool::Paint(PaintEffect::Soot),
        Tool::Paint(PaintEffect::Spall),
        Tool::Grow(GrowBrush::Grass),
        Tool::Grow(GrowBrush::Dry),
        Tool::Plant(PlantKind::Tree),
        Tool::Plant(PlantKind::Bush),
    ];

    pub fn name(self) -> &'static str {
        match self {
            Tool::Wall => "wall",
            Tool::Room => "building",
            Tool::Lamp => "lamp",
            Tool::Spawn => "spawn",
            Tool::Paint(e) => e.name(),
            Tool::Grow(b) => b.name(),
            Tool::Plant(k) => k.name(),
        }
    }

    /// One-line usage hint the toolbar prints for the active tool.
    pub fn hint(self) -> &'static str {
        match self {
            Tool::Wall => "drag: build wall   right-drag: remove",
            Tool::Room => "drag: building   right-drag: demolish",
            Tool::Lamp => "click: place lamp   right-click: remove",
            Tool::Spawn => "click: player start",
            Tool::Paint(PaintEffect::Rain) => "drag on a wall: rain streaks   right-drag: scrub",
            Tool::Paint(PaintEffect::Soot) => "drag on a wall: fire soot   right-drag: scrub",
            Tool::Paint(PaintEffect::Spall) => "drag on a wall: broken cover   right-drag: scrub",
            Tool::Grow(GrowBrush::Grass) => "drag: grow grass   right-drag: mow",
            Tool::Grow(GrowBrush::Dry) => "drag: dry it to straw   right-drag: mow",
            Tool::Grow(GrowBrush::Mow) => "drag: mow",
            Tool::Plant(PlantKind::Tree) => "click: plant a tree   right-click: uproot",
            Tool::Plant(PlantKind::Bush) => "drag: plant bushes   right-drag: uproot",
        }
    }
}

/// Left button builds, right button removes — the one modifier every tool
/// shares, so there is no separate eraser to switch to.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Button {
    Build,
    Remove,
}

/// What a gesture would do if released now. The viewer draws it as a ghost;
/// the release applies exactly this (see [`apply`]) — one function builds
/// both, so the ghost cannot disagree with the commit.
#[derive(Clone, Default, PartialEq, Debug)]
pub struct Preview {
    /// x-edges (level-file `wallx` addressing) to set to Wall / Open.
    pub wall_x: Vec<(i16, i16, EdgeKind)>,
    /// z-edges (level-file `wallz` addressing) to set to Wall / Open.
    pub wall_z: Vec<(i16, i16, EdgeKind)>,
    /// Cells to set to Room / Outdoor.
    pub cells: Vec<(CellPos, CellKind)>,
    /// Lamp placed (true) or removed (false) at a cell.
    pub lamps: Vec<(CellPos, bool)>,
    pub spawn: Option<CellPos>,
}

impl Preview {
    pub fn is_empty(&self) -> bool {
        self.wall_x.is_empty() && self.wall_z.is_empty() && self.cells.is_empty() && self.lamps.is_empty() && self.spawn.is_none()
    }
}

/// The nearest grid CORNER to a ground point, clamped onto the grid — the
/// wall tool's snap (walls live on edges, and edges run corner to corner).
pub fn snap_corner(lv: &GymLevel, x: f32, z: f32) -> (i16, i16) {
    let g = &lv.grid;
    ((x.round() as i16).clamp(0, g.w), (z.round() as i16).clamp(0, g.h))
}

/// The cell under a ground point, clamped onto the grid.
pub fn snap_cell(lv: &GymLevel, x: f32, z: f32) -> CellPos {
    let g = &lv.grid;
    CellPos::new((x.floor() as i16).clamp(0, g.w - 1), (z.floor() as i16).clamp(0, g.h - 1))
}

/// The wall line a drag from corner `a` toward corner `b` means: straight,
/// along whichever axis the drag moved further (ties go to x), starting at
/// `a`. Returns the end corner actually used, so the ghost's end handle sits
/// on the line and not under the cursor.
pub fn wall_line(a: (i16, i16), b: (i16, i16)) -> (i16, i16) {
    if (b.0 - a.0).abs() >= (b.1 - a.1).abs() {
        (b.0, a.1)
    } else {
        (a.0, b.1)
    }
}

/// The preview of one gesture: `tool` pressed at ground point `p0`, the
/// pointer now at `p1`, with `button`. Pure — same inputs, same preview.
pub fn preview(lv: &GymLevel, tool: Tool, button: Button, p0: (f32, f32), p1: (f32, f32)) -> Preview {
    let mut pv = Preview::default();
    let set = |b: Button| if b == Button::Build { EdgeKind::Wall } else { EdgeKind::Open };
    match tool {
        Tool::Wall => {
            let a = snap_corner(lv, p0.0, p0.1);
            let b = wall_line(a, snap_corner(lv, p1.0, p1.1));
            let e = set(button);
            if a.1 == b.1 && a.0 != b.0 {
                // along x at corner row z = a.1: the z-edges (x, z)
                for x in a.0.min(b.0)..a.0.max(b.0) {
                    if a.1 <= lv.grid.h {
                        pv.wall_z.push((x, a.1, e));
                    }
                }
            } else if a.0 == b.0 && a.1 != b.1 {
                for z in a.1.min(b.1)..a.1.max(b.1) {
                    pv.wall_x.push((a.0, z, e));
                }
            }
        }
        Tool::Room => {
            let c0 = snap_cell(lv, p0.0, p0.1);
            let c1 = snap_cell(lv, p1.0, p1.1);
            let (x0, x1) = (c0.x.min(c1.x), c0.x.max(c1.x) + 1); // [x0, x1) cells
            let (z0, z1) = (c0.z.min(c1.z), c0.z.max(c1.z) + 1);
            let build = button == Button::Build;
            let kind = if build { CellKind::Room } else { CellKind::Outdoor };
            for z in z0..z1 {
                for x in x0..x1 {
                    pv.cells.push((CellPos::new(x, z), kind));
                }
            }
            // every edge inside the rect opens; the perimeter is wall on build
            // and open on demolish
            let perim = set(button);
            for z in z0..z1 {
                for x in x0..=x1 {
                    let e = if x == x0 || x == x1 { perim } else { EdgeKind::Open };
                    pv.wall_x.push((x, z, e));
                }
            }
            for z in z0..=z1 {
                for x in x0..x1 {
                    let e = if z == z0 || z == z1 { perim } else { EdgeKind::Open };
                    pv.wall_z.push((x, z, e));
                }
            }
            if build {
                // one doorway, centred on the +z side: the trimetric camera
                // sits on the +x/+z side, so that face is the one you see
                let door = x0 + (x1 - x0 - 1) / 2;
                if let Some(e) = pv.wall_z.iter_mut().find(|(x, z, _)| *x == door && *z == z1) {
                    e.2 = EdgeKind::Open;
                }
            }
        }
        Tool::Lamp => pv.lamps.push((snap_cell(lv, p1.0, p1.1), button == Button::Build)),
        Tool::Spawn => {
            if button == Button::Build {
                pv.spawn = Some(snap_cell(lv, p1.0, p1.1));
            }
        }
        // these gestures are stroke lists, not a press/release pair: see
        // `paint`/`scrub`, `grow`, `plant`/`uproot`
        Tool::Paint(_) | Tool::Grow(_) | Tool::Plant(_) => {}
    }
    pv
}

/// Brush radius for hand painting, wu.
pub const BRUSH_R: f32 = 0.45;
/// Ground brush radius, wu — grass is painted in patches, not strokes.
pub const GROW_R: f32 = 1.0;

/// Commit a ground drag (grass, dry or mow dabs). One undo step.
pub fn grow(lv: &mut GymLevel, hist: &mut History, dabs: &[GroundStroke]) -> bool {
    if dabs.is_empty() {
        return false;
    }
    hist.commit(lv.clone());
    lv.ground.extend_from_slice(dabs);
    true
}

/// Minimum distance between two plants of this kind — the scatter brush's
/// spacing and the "one per spot" rule for a click.
pub fn spacing(k: PlantKind) -> f32 {
    match k {
        PlantKind::Tree => 1.4,
        PlantKind::Bush => 0.7,
    }
}

/// Where a scatter drag may put a new plant: not closer than `spacing` to any
/// plant already standing (or already placed in this drag).
pub fn can_plant(lv: &GymLevel, pending: &[Plant], k: PlantKind, x: f32, z: f32) -> bool {
    let d = spacing(k);
    lv.plants.iter().chain(pending).all(|p| (p.x - x).powi(2) + (p.z - z).powi(2) >= (d * 0.5 + spacing(p.kind) * 0.5).powi(2))
}

/// Commit planted plants. One undo step.
pub fn plant(lv: &mut GymLevel, hist: &mut History, new: &[Plant]) -> bool {
    if new.is_empty() {
        return false;
    }
    hist.commit(lv.clone());
    lv.plants.extend_from_slice(new);
    true
}

/// Uproot every plant within `r` of any of `points`. One undo step, none if
/// nothing grew there.
pub fn uproot(lv: &mut GymLevel, hist: &mut History, points: &[(f32, f32)], r: f32) -> bool {
    let hit = |p: &Plant| points.iter().any(|&(x, z)| (p.x - x).powi(2) + (p.z - z).powi(2) < r * r);
    if !lv.plants.iter().any(hit) {
        return false;
    }
    hist.commit(lv.clone());
    lv.plants.retain(|p| !hit(p));
    true
}

/// Commit a paint drag: every dab lands on the level. One undo step.
pub fn paint(lv: &mut GymLevel, hist: &mut History, dabs: &[PaintStroke]) -> bool {
    if dabs.is_empty() {
        return false;
    }
    hist.commit(lv.clone());
    lv.paint.extend_from_slice(dabs);
    true
}

/// Whether a scrub drag's `dabs` take stroke `s` off: same face, within a
/// brush radius (plus half the stroke's own) of any dab. The live preview
/// and the commit share it.
pub fn scrubbed(s: &PaintStroke, dabs: &[PaintStroke]) -> bool {
    dabs.iter().any(|d| {
        let dist = (0..3).map(|k| (s.pos[k] - d.pos[k]).powi(2)).sum::<f32>().sqrt();
        s.axis == d.axis && s.sign == d.sign && dist < d.r + s.r * 0.5
    })
}

/// Commit a scrub drag: remove every stroke on the SAME face within a brush
/// radius of any dab, whatever its effect. One undo step, none if nothing
/// was there.
pub fn scrub(lv: &mut GymLevel, hist: &mut History, dabs: &[PaintStroke]) -> bool {
    let hit = |s: &PaintStroke| scrubbed(s, dabs);
    if !lv.paint.iter().any(hit) {
        return false;
    }
    hist.commit(lv.clone());
    lv.paint.retain(|s| !hit(s));
    true
}

/// Default glow for a lamp placed by hand (the level file's 1..8 scale).
pub const LAMP_GLOW: i32 = 6;

/// Apply a preview to a level. Returns whether anything changed — a gesture
/// that changes nothing must not cost an undo step or a scene rebuild.
pub fn apply(lv: &mut GymLevel, pv: &Preview) -> bool {
    let mut changed = false;
    for &(x, z, e) in &pv.wall_x {
        if x >= 0 && x <= lv.grid.w && z >= 0 && z < lv.grid.h && lv.grid.edge_x(x, z) != e {
            lv.grid.set_edge_x(x, z, e);
            changed = true;
        }
    }
    for &(x, z, e) in &pv.wall_z {
        if x >= 0 && x < lv.grid.w && z >= 0 && z <= lv.grid.h && lv.grid.edge_z(x, z) != e {
            lv.grid.set_edge_z(x, z, e);
            changed = true;
        }
    }
    for &(p, k) in &pv.cells {
        if lv.grid.in_bounds(p) && lv.grid.cell(p) != k {
            lv.grid.set_cell(p, k);
            changed = true;
        }
    }
    for &(p, place) in &pv.lamps {
        let at = lv.lights.iter().position(|(c, _)| *c == p);
        match (place, at) {
            (true, None) if lv.grid.in_bounds(p) => {
                lv.lights.push((p, LAMP_GLOW));
                changed = true;
            }
            (false, Some(i)) => {
                lv.lights.remove(i);
                changed = true;
            }
            _ => {}
        }
    }
    if let Some(p) = pv.spawn {
        if lv.grid.in_bounds(p) && lv.player_start != p {
            lv.player_start = p;
            changed = true;
        }
    }
    changed
}

/// Undo/redo as whole-level snapshots. `commit` is called with the level as
/// it was BEFORE a change; `undo`/`redo` swap the live level in place.
#[derive(Default)]
pub struct History {
    undo: Vec<GymLevel>,
    redo: Vec<GymLevel>,
}

/// Enough for an afternoon of building; the oldest step falls off.
const HISTORY_MAX: usize = 200;

impl History {
    pub fn commit(&mut self, before: GymLevel) {
        self.undo.push(before);
        if self.undo.len() > HISTORY_MAX {
            self.undo.remove(0);
        }
        self.redo.clear();
    }

    /// Step back. Returns whether there was a step.
    pub fn undo(&mut self, lv: &mut GymLevel) -> bool {
        match self.undo.pop() {
            Some(prev) => {
                self.redo.push(std::mem::replace(lv, prev));
                true
            }
            None => false,
        }
    }

    pub fn redo(&mut self, lv: &mut GymLevel) -> bool {
        match self.redo.pop() {
            Some(next) => {
                self.undo.push(std::mem::replace(lv, next));
                true
            }
            None => false,
        }
    }

    pub fn can_undo(&self) -> bool {
        !self.undo.is_empty()
    }

    pub fn can_redo(&self) -> bool {
        !self.redo.is_empty()
    }
}

/// One whole gesture, press → release: build the preview and, if it changes
/// the level, record the undo step and apply it. The viewer calls this on
/// release; the headless tests and the harness call it directly.
pub fn commit(lv: &mut GymLevel, hist: &mut History, tool: Tool, button: Button, p0: (f32, f32), p1: (f32, f32)) -> bool {
    let pv = preview(lv, tool, button, p0, p1);
    let before = lv.clone();
    if apply(lv, &pv) {
        hist.commit(before);
        true
    } else {
        false
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::gym::grid::{Dir, DIRS};
    use crate::gym::level_file;

    fn empty() -> GymLevel {
        level_file::parse("size 10 8\nspawn 1 1\n").unwrap()
    }

    #[test]
    fn a_wall_drag_snaps_to_corners_and_runs_along_the_longer_axis() {
        let mut lv = empty();
        let mut h = History::default();
        // mostly-x drag from near (2,3) to near (6,3.4): the z-edges x=2..5 on row 3
        assert!(commit(&mut lv, &mut h, Tool::Wall, Button::Build, (2.2, 2.9), (6.1, 3.4)));
        for x in 2..6 {
            assert_eq!(lv.grid.edge_z(x, 3), EdgeKind::Wall, "x={x}");
        }
        assert_eq!(lv.grid.edge_z(1, 3), EdgeKind::Open);
        assert_eq!(lv.grid.edge_z(6, 3), EdgeKind::Open);
        // mostly-z drag builds x-edges
        assert!(commit(&mut lv, &mut h, Tool::Wall, Button::Build, (8.0, 1.0), (8.3, 4.0)));
        for z in 1..4 {
            assert_eq!(lv.grid.edge_x(8, z), EdgeKind::Wall, "z={z}");
        }
    }

    #[test]
    fn right_drag_removes_and_a_click_changes_nothing() {
        let mut lv = empty();
        let mut h = History::default();
        commit(&mut lv, &mut h, Tool::Wall, Button::Build, (2.0, 3.0), (6.0, 3.0));
        // cut a one-segment doorway
        assert!(commit(&mut lv, &mut h, Tool::Wall, Button::Remove, (3.0, 3.0), (4.0, 3.0)));
        assert_eq!(lv.grid.edge_z(3, 3), EdgeKind::Open);
        assert_eq!(lv.grid.edge_z(2, 3), EdgeKind::Wall);
        // a zero-length wall drag is not an edit (no undo step spent)
        let n = h.undo.len();
        assert!(!commit(&mut lv, &mut h, Tool::Wall, Button::Build, (5.0, 5.0), (5.1, 5.2)));
        assert_eq!(h.undo.len(), n);
    }

    #[test]
    fn a_building_is_closed_except_one_doorway_facing_the_camera() {
        let mut lv = empty();
        let mut h = History::default();
        assert!(commit(&mut lv, &mut h, Tool::Room, Button::Build, (2.5, 1.5), (5.5, 4.5)));
        // cells 2..=5 x 1..=4
        for z in 1..5 {
            for x in 2..6 {
                assert_eq!(lv.grid.cell(CellPos::new(x, z)), CellKind::Room);
            }
        }
        // the only way out is the doorway on the +z side
        let door = CellPos::new(3, 4);
        assert!(lv.grid.open(door, Dir::Zp), "doorway on the +z side");
        let exits: usize = (1..5)
            .flat_map(|z| (2..6).map(move |x| CellPos::new(x, z)))
            .flat_map(|c| DIRS.map(move |d| (c, d)))
            .filter(|&(c, d)| {
                let n = c.step(d);
                lv.grid.open(c, d) && !(2..6).contains(&n.x) | !(1..5).contains(&n.z)
            })
            .count();
        assert_eq!(exits, 1, "exactly one exit");
        // demolish takes it all back
        assert!(commit(&mut lv, &mut h, Tool::Room, Button::Remove, (2.5, 1.5), (5.5, 4.5)));
        assert_eq!(lv.grid.grid_hash(), empty().grid.grid_hash());
    }

    #[test]
    fn a_building_dragged_in_any_direction_is_the_same_building() {
        let (mut a, mut b) = (empty(), empty());
        let mut h = History::default();
        commit(&mut a, &mut h, Tool::Room, Button::Build, (2.5, 1.5), (5.5, 4.5));
        commit(&mut b, &mut h, Tool::Room, Button::Build, (5.5, 4.5), (2.5, 1.5));
        assert_eq!(a.grid.grid_hash(), b.grid.grid_hash());
    }

    #[test]
    fn lamps_place_once_and_remove_and_spawn_moves() {
        let mut lv = empty();
        let mut h = History::default();
        assert!(commit(&mut lv, &mut h, Tool::Lamp, Button::Build, (3.5, 3.5), (3.5, 3.5)));
        assert!(!commit(&mut lv, &mut h, Tool::Lamp, Button::Build, (3.2, 3.8), (3.2, 3.8)), "one lamp per cell");
        assert_eq!(lv.lights, vec![(CellPos::new(3, 3), LAMP_GLOW)]);
        assert!(commit(&mut lv, &mut h, Tool::Lamp, Button::Remove, (3.5, 3.5), (3.5, 3.5)));
        assert!(lv.lights.is_empty());
        assert!(commit(&mut lv, &mut h, Tool::Spawn, Button::Build, (7.5, 6.5), (7.5, 6.5)));
        assert_eq!(lv.player_start, CellPos::new(7, 6));
    }

    #[test]
    fn undo_and_redo_walk_the_snapshots_exactly() {
        let mut lv = empty();
        let mut h = History::default();
        let s0 = lv.grid.grid_hash();
        commit(&mut lv, &mut h, Tool::Wall, Button::Build, (1.0, 1.0), (5.0, 1.0));
        let s1 = lv.grid.grid_hash();
        commit(&mut lv, &mut h, Tool::Room, Button::Build, (6.5, 3.5), (8.5, 6.5));
        let s2 = lv.grid.grid_hash();
        assert!(h.undo(&mut lv));
        assert_eq!(lv.grid.grid_hash(), s1);
        assert!(h.undo(&mut lv));
        assert_eq!(lv.grid.grid_hash(), s0);
        assert!(!h.undo(&mut lv), "nothing left");
        assert!(h.redo(&mut lv));
        assert!(h.redo(&mut lv));
        assert_eq!(lv.grid.grid_hash(), s2);
        // a new edit after an undo drops the redo branch
        h.undo(&mut lv);
        commit(&mut lv, &mut h, Tool::Lamp, Button::Build, (0.5, 0.5), (0.5, 0.5));
        assert!(!h.can_redo());
    }

    #[test]
    fn out_of_grid_drags_clamp_onto_the_grid() {
        let mut lv = empty();
        let mut h = History::default();
        assert!(commit(&mut lv, &mut h, Tool::Wall, Button::Build, (-3.0, 0.0), (40.0, 0.2)));
        for x in 0..10 {
            assert_eq!(lv.grid.edge_z(x, 0), EdgeKind::Wall);
        }
        assert!(commit(&mut lv, &mut h, Tool::Room, Button::Build, (-5.0, -5.0), (50.0, 50.0)));
        assert_eq!(lv.grid.cell(CellPos::new(9, 7)), CellKind::Room);
    }

    #[test]
    fn painting_adds_one_undo_step_and_scrubbing_takes_only_that_face() {
        let mut lv = empty();
        let mut h = History::default();
        let dab = |x: f32, sign: i8| PaintStroke { effect: PaintEffect::Soot, pos: [x, 1.0, 3.0], axis: 2, sign, r: BRUSH_R };
        assert!(paint(&mut lv, &mut h, &[dab(2.0, 1), dab(2.2, 1), dab(2.0, -1)]));
        assert_eq!(lv.paint.len(), 3);
        assert!(!paint(&mut lv, &mut h, &[]), "an empty drag is no edit");
        // scrub the +z face only
        assert!(scrub(&mut lv, &mut h, &[dab(2.1, 1)]));
        assert_eq!(lv.paint, vec![dab(2.0, -1)], "the back face keeps its paint");
        assert!(!scrub(&mut lv, &mut h, &[dab(8.0, 1)]), "scrubbing bare wall is no edit");
        assert!(h.undo(&mut lv));
        assert_eq!(lv.paint.len(), 3);
    }

    #[test]
    fn planting_keeps_its_spacing_and_uprooting_takes_only_what_is_near() {
        let mut lv = empty();
        let mut h = History::default();
        let t = |x: f32, z: f32| Plant { kind: PlantKind::Tree, x, z, seed: 1 };
        assert!(plant(&mut lv, &mut h, &[t(2.0, 2.0), t(6.0, 2.0)]));
        assert!(!can_plant(&lv, &[], PlantKind::Tree, 2.5, 2.2), "too close to a tree");
        assert!(can_plant(&lv, &[], PlantKind::Bush, 4.0, 2.0), "room between them");
        assert!(uproot(&mut lv, &mut h, &[(2.2, 2.1)], 0.6));
        assert_eq!(lv.plants, vec![t(6.0, 2.0)]);
        assert!(!uproot(&mut lv, &mut h, &[(9.0, 9.0)], 0.6), "nothing there, no undo step");
        let n = h.undo.len();
        assert!(grow(&mut lv, &mut h, &[GroundStroke { brush: GrowBrush::Grass, x: 3.0, z: 3.0, r: GROW_R }]));
        assert_eq!(h.undo.len(), n + 1);
    }

    #[test]
    fn a_creative_edit_saves_and_reloads_as_the_same_level() {
        let mut lv = empty();
        let mut h = History::default();
        commit(&mut lv, &mut h, Tool::Room, Button::Build, (1.5, 1.5), (4.5, 3.5));
        commit(&mut lv, &mut h, Tool::Lamp, Button::Build, (7.5, 6.5), (7.5, 6.5));
        let text = level_file::serialize(&lv);
        let back = level_file::parse(&text).unwrap();
        assert_eq!(back.grid.grid_hash(), lv.grid.grid_hash());
        assert_eq!(back.lights, lv.lights);
    }
}
