//! Click-to-move routing: a world-space path and the steering that walks it.
//!
//! This is the second half of the continuous mover. The keyboard half turns
//! held keys straight into a direction; the mouse half has to derive one, and
//! before 2026-08-09 it did that on a different mover entirely — a cell BFS
//! feeding `Command::Move`, which TELEPORTED the player to a cell centre on a
//! fixed cadence. So the same player walked two ways depending on which device
//! moved them: smooth under WASD, snapping under the mouse.
//!
//! The route is planned on the grid and then LEAVES it. [`Route::plan`] runs
//! the same 4-direction BFS the old planner did — the grid is what knows about
//! walls — and then STRING-PULLS the cell-centre polyline: a waypoint whose
//! neighbours can see each other in a straight line is not a corner, so it
//! goes. What survives is the corners, and the mover walks straight lines
//! between them at whatever angle they lie. A cell-centre path zigzags on a
//! diagonal (the BFS steps one axis at a time); a string-pulled one does not,
//! which is the whole visible difference.
//!
//! Sight lines are tested against the SAME predicate the collide-and-slide
//! integrator uses ([`crate::gym::grid::Grid::blocked_point`] at
//! [`crate::gym::sim::PLAYER_RADIUS`]), so a shortcut the route takes is one
//! the body can physically walk. Testing anything else — cell openness, a
//! point without the radius — produces paths that steer into a doorjamb and
//! stall there, with the mover and the planner each behaving correctly.
//!
//! It lives in `house-game` because it is game logic and has to be testable
//! without a window. The viewer's job is now only to hand a click's world
//! point in and push the resulting direction onto the command queue.

use super::grid::{CellPos, Dir, Grid};
use glam::Vec2;

/// How far apart sight-line samples are taken, in world units. The grid's
/// finest feature is a wall edge on a 1-wu cell boundary and the body carries
/// `PLAYER_RADIUS` of clearance, so a step well under that radius cannot
/// tunnel a sample past a wall. Smaller costs plan time on a path that is
/// re-planned on every click; larger risks a shortcut through a jamb.
const SIGHT_STEP: f32 = 0.1;

/// Distance at which a waypoint counts as reached. One `PLAYER_RADIUS` is the
/// body's own half-width: closer than that and the mover is already inside the
/// waypoint, and steering at a point you are standing on produces a direction
/// that spins.
const ARRIVE_R: f32 = 0.26;

/// A planned route in WORLD space: the corners left after string-pulling,
/// walked in order. Empty is not representable — [`Route::plan`] returns
/// `None` rather than an empty route, so a live route always has a target.
#[derive(Clone, Debug, PartialEq)]
pub struct Route {
    /// Remaining corners, nearest first. Never empty.
    points: Vec<Vec2>,
}

impl Route {
    /// Plan a walk from `from` to the cell containing `to`. `None` when the
    /// goal is off the grid, inside a solid, or unreachable — the caller
    /// leaves the player standing rather than walking at a wall.
    pub fn plan(grid: &Grid, from: Vec2, to: Vec2) -> Option<Route> {
        let goal = cell_of(grid, to)?;
        let start = cell_of(grid, from)?;
        if goal == start {
            return None;
        }
        let cells = bfs(grid, start, goal)?;
        // The goal is the CLICKED point, not its cell centre: a click near a
        // wall should walk to where it was aimed. Every other waypoint is a
        // cell centre, because that is all the BFS knows.
        let mut pts: Vec<Vec2> = cells.iter().map(|c| Vec2::new(c.x as f32 + 0.5, c.z as f32 + 0.5)).collect();
        if let Some(last) = pts.last_mut() {
            if !blocked(grid, to) {
                *last = to;
            }
        }
        let points = string_pull(grid, from, pts);
        (!points.is_empty()).then_some(Route { points })
    }

    /// The direction to walk this tick, and whether the route is finished.
    ///
    /// Waypoints are consumed as they are reached, so the route shortens as
    /// the body advances. `None` means ARRIVED — the caller stops feeding
    /// input and the sim's own braking brings the body to rest. Handing back
    /// a direction until the goal is underfoot would overshoot it by the
    /// stopping distance and then oscillate.
    pub fn steer(&mut self, pos: Vec2, stop_dist: f32) -> Option<Vec2> {
        while let Some(&p) = self.points.first() {
            let last = self.points.len() == 1;
            let d = p - pos;
            let near = if last { stop_dist.max(ARRIVE_R) } else { ARRIVE_R };
            if d.length() <= near {
                if last {
                    return None;
                }
                self.points.remove(0);
                continue;
            }
            return Some(d.normalize_or_zero());
        }
        None
    }

    /// The final destination — what a replan aims at.
    pub fn goal(&self) -> Vec2 {
        *self.points.last().expect("a route is never empty")
    }

    /// Remaining corners, for tests and editor overlays.
    pub fn points(&self) -> &[Vec2] {
        &self.points
    }
}

fn cell_of(grid: &Grid, p: Vec2) -> Option<CellPos> {
    let (x, z) = (p.x.floor() as i32, p.y.floor() as i32);
    (x >= 0 && z >= 0 && x < grid.w as i32 && z < grid.h as i32).then(|| CellPos::new(x as i16, z as i16))
}

fn blocked(grid: &Grid, p: Vec2) -> bool {
    grid.blocked_point(p.x, p.y, super::sim::PLAYER_RADIUS)
}

/// Shortest 4-direction route over the grid (deterministic scan order); wall
/// edges and the grid boundary block. Returns the cells to visit AFTER `from`.
fn bfs(grid: &Grid, from: CellPos, to: CellPos) -> Option<Vec<CellPos>> {
    let (w, h) = (grid.w as i32, grid.h as i32);
    let idx = |p: CellPos| (p.z as i32 * w + p.x as i32) as usize;
    let mut prev: Vec<Option<CellPos>> = vec![None; (w * h) as usize];
    let mut seen = vec![false; (w * h) as usize];
    let mut q = std::collections::VecDeque::new();
    seen[idx(from)] = true;
    q.push_back(from);
    'search: while let Some(p) = q.pop_front() {
        for dir in [Dir::Xp, Dir::Xm, Dir::Zp, Dir::Zm] {
            if !grid.open(p, dir) {
                continue;
            }
            let n = p.step(dir);
            if seen[idx(n)] {
                continue;
            }
            seen[idx(n)] = true;
            prev[idx(n)] = Some(p);
            if n == to {
                break 'search;
            }
            q.push_back(n);
        }
    }
    if !seen[idx(to)] {
        return None;
    }
    let mut cells = vec![to];
    let mut cur = to;
    while let Some(p) = prev[idx(cur)] {
        if p == from {
            break;
        }
        cells.push(p);
        cur = p;
    }
    cells.reverse();
    Some(cells)
}

/// Can the body walk the straight segment `a` → `b` without hitting anything?
/// Sampled at [`SIGHT_STEP`] against the mover's own blocking predicate, ends
/// included.
fn clear_line(grid: &Grid, a: Vec2, b: Vec2) -> bool {
    let d = b - a;
    let len = d.length();
    if len <= f32::EPSILON {
        return !blocked(grid, a);
    }
    let steps = (len / SIGHT_STEP).ceil() as i32;
    (0..=steps).all(|i| !blocked(grid, a + d * (i as f32 / steps as f32)))
}

/// Drop every waypoint that is not a corner: walk forward from the body and
/// keep only the last point still visible from the current anchor. What is
/// left are the turns.
fn string_pull(grid: &Grid, from: Vec2, pts: Vec<Vec2>) -> Vec<Vec2> {
    let mut out: Vec<Vec2> = Vec::new();
    let mut anchor = from;
    let mut i = 0;
    while i < pts.len() {
        // The farthest point still reachable in a straight line from `anchor`.
        let mut far = i;
        for j in (i..pts.len()).rev() {
            if clear_line(grid, anchor, pts[j]) {
                far = j;
                break;
            }
        }
        out.push(pts[far]);
        anchor = pts[far];
        // `far == i` means even the next point is not visible — the sampled
        // sight line disagrees with the BFS, which can happen at a jamb the
        // radius cannot pass diagonally. Keep it and move on: the segment is
        // one cell long, so the mover's own collide-and-slide handles it.
        i = far + 1;
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::gym::sim::gym_level;

    fn centre(c: CellPos) -> Vec2 {
        Vec2::new(c.x as f32 + 0.5, c.z as f32 + 0.5)
    }

    /// Open ground with no walls at all: the fixture for the properties that
    /// are about the ROUTE rather than about the gym's layout.
    fn open() -> Grid {
        Grid::new(16, 16)
    }

    /// The gym's doorway is the only way into the building, so a route from
    /// outside to inside must exist AND must thread the door — the property
    /// the old cell planner was pinned on, kept across the move.
    #[test]
    fn a_route_into_the_building_threads_the_doorway() {
        let lvl = gym_level();
        let from = centre(lvl.player_start);
        let inside = Vec2::new(6.5, 5.5);
        assert!(!blocked(&lvl.grid, inside), "fixture: the target must be standable");
        let r = Route::plan(&lvl.grid, from, inside).expect("the doorway makes this reachable");
        // Every leg is walkable in a straight line — which is exactly what
        // makes the route followable by a mover that only knows directions.
        let mut a = from;
        for &p in r.points() {
            assert!(clear_line(&lvl.grid, a, p), "leg {a:?} -> {p:?} crosses a wall");
            a = p;
        }
        assert_eq!(a, r.goal(), "the last corner is the goal");
    }

    /// String-pulling is the point: an open diagonal must come back as ONE
    /// leg, where the BFS polyline would zigzag one axis at a time.
    #[test]
    fn an_open_diagonal_pulls_to_a_single_leg() {
        let g = open();
        let (from, to) = (Vec2::new(2.5, 2.5), Vec2::new(6.5, 6.5));
        let r = Route::plan(&g, from, to).expect("reachable");
        assert_eq!(r.points(), [to], "an open diagonal is one straight leg, got {:?}", r.points());
    }

    /// A route is planned to the CLICKED point, not to its cell centre.
    #[test]
    fn the_goal_is_the_clicked_point_not_its_cell_centre() {
        let r = Route::plan(&open(), Vec2::new(2.5, 2.5), Vec2::new(4.2, 4.8)).expect("reachable");
        assert_eq!(r.goal(), Vec2::new(4.2, 4.8));
    }

    /// Unreachable and degenerate asks produce no route at all, so the caller
    /// never has to represent an empty one.
    #[test]
    fn off_grid_solid_and_same_cell_asks_produce_no_route() {
        let g = open();
        let from = Vec2::new(2.5, 2.5);
        assert!(Route::plan(&g, from, Vec2::new(-1.0, 2.5)).is_none(), "off the grid");
        assert!(Route::plan(&g, from, Vec2::new(2.7, 2.7)).is_none(), "the cell already stood in");
    }

    /// Steering consumes corners as they are reached and reports arrival once,
    /// so the caller can stop feeding input and let the sim brake.
    #[test]
    fn steering_consumes_corners_and_then_reports_arrival() {
        let g = open();
        let (from, to) = (Vec2::new(2.5, 2.5), Vec2::new(6.5, 6.5));
        let mut r = Route::plan(&g, from, to).expect("reachable");
        let d = r.steer(from, 0.0).expect("a fresh route steers");
        assert!((d.length() - 1.0).abs() < 1.0e-5, "the direction is normalized");
        assert!(d.x > 0.0 && d.y > 0.0, "it points at the goal, got {d:?}");
        assert!(r.steer(to, 0.0).is_none(), "standing on the goal is arrival");
    }

    /// The stopping distance widens the LAST waypoint's arrival radius only —
    /// a route must not shed its corners early just because the body is fast.
    #[test]
    fn the_stopping_distance_never_cuts_a_corner() {
        let lvl = gym_level();
        let from = centre(gym_level().player_start);
        let inside = Vec2::new(6.5, 5.5);
        let mut fast = Route::plan(&lvl.grid, from, inside).expect("reachable");
        let mut slow = Route::plan(&lvl.grid, from, inside).expect("reachable");
        assert!(fast.points().len() > 1, "fixture: this route must have a corner to cut");
        let a = fast.steer(from, 2.0).expect("steering");
        let b = slow.steer(from, 0.0).expect("steering");
        assert_eq!(a, b, "a large stop distance must not skip the first corner");
        assert_eq!(fast.points().len(), slow.points().len());
    }
}
