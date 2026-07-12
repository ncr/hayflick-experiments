//! Fairness & solvability validation (docs/spec/03-world-model.md).
//!
//! "Fully algorithmic" generation is only safe because every candidate town
//! must PROVE these invariants before it is accepted; violators are re-rolled
//! (bounded) by [`super::towngen::generate_town`]. The same checks double as
//! headless test oracles over M seeds (docs/spec/12 — generation fairness
//! oracle family).
//!
//! v0 invariant set (M0 spike):
//!   1. building count within the params band;
//!   2. streets: ≥ 2 extraction gates, and EVERY outdoor cell reaches a gate
//!      (extraction is never walled off);
//!   3. every building interior is fully reachable from its front door
//!      (thief-level passability — picks allowed);
//!   4. every locked target has ≥ 2 distinct approaches (distinct entry
//!      portals — door / non-shuttered window / exterior climb — from the
//!      street that reach the target cell);
//!   5. hiding-spot density floor near every target (≥ 2 within the target's
//!      room's building floor).
//!
//! Patrol-gap / forced-sightline invariants land with schedules (module 04)
//! at M1/M3 — they need patrols to exist first.

use super::grid::{CellKind, CellPos, Passage, DIRS};
use super::towngen::{Building, TownSpec};
use std::collections::VecDeque;

/// Empty `failures` = the town is fair.
#[derive(Debug, Default)]
pub struct FairnessReport {
    pub failures: Vec<String>,
}

/// A way into a building from the public street: the entry cell just inside,
/// plus a human-readable label for failure messages.
struct Portal {
    entry: CellPos,
    label: String,
}

/// Thief-level passability: anything short of a hard wall (locks are
/// pickable, windows openable, low walls vaultable — module 07 verbs).
fn thief_pass(p: Passage) -> bool {
    p != Passage::No
}

pub fn validate_town(spec: &TownSpec) -> FairnessReport {
    let mut failures = Vec::new();

    // 1 · Building count.
    if spec.buildings.len() < spec.params.min_buildings {
        failures.push(format!("only {} buildings (min {})", spec.buildings.len(), spec.params.min_buildings));
    }

    // 2 · Streets & gates.
    check_streets(spec, &mut failures);

    // 3 · Interiors.
    for b in &spec.buildings {
        check_interior(spec, b, &mut failures);
    }

    // 4+5 · Targets.
    for t in &spec.targets {
        let b = &spec.buildings[t.building as usize];
        check_target_approaches(spec, b, t.cell, t.id, &mut failures);
        check_hiding_density(spec, b, t.cell, t.id, &mut failures);
    }

    FairnessReport { failures }
}

fn check_streets(spec: &TownSpec, failures: &mut Vec<String>) {
    let g = &spec.grid;
    if spec.gates.len() < 2 {
        failures.push(format!("{} extraction gates (need ≥ 2)", spec.gates.len()));
        return;
    }
    for &gate in &spec.gates {
        if g.cell(gate).kind != CellKind::Outdoor || !g.cell(gate).walkable() {
            failures.push(format!("gate {gate:?} is not walkable street"));
            return;
        }
    }
    // Flood from the first gate over walkable outdoor ground cells.
    let mut seen = vec![false; g.n_cells()];
    let mut q = VecDeque::new();
    seen[g.flat_index(spec.gates[0])] = true;
    q.push_back(spec.gates[0]);
    while let Some(p) = q.pop_front() {
        for d in DIRS {
            let n = p.step(d);
            if !g.in_bounds(n) || seen[g.flat_index(n)] {
                continue;
            }
            if g.cell(n).kind != CellKind::Outdoor || !g.cell(n).walkable() {
                continue;
            }
            if g.edge(p, d).passage() != Passage::Free {
                continue; // streets must be plainly walkable, no climbing
            }
            seen[g.flat_index(n)] = true;
            q.push_back(n);
        }
    }
    for &gate in &spec.gates[1..] {
        if !seen[g.flat_index(gate)] {
            failures.push(format!("gate {gate:?} disconnected from gate {:?}", spec.gates[0]));
        }
    }
    // Every outdoor cell must reach the gates (no walled-off pockets — the
    // "extraction reachable from anywhere" floor).
    for z in 0..g.h {
        for x in 0..g.w {
            let p = CellPos::new(x, z, 0);
            if g.cell(p).kind == CellKind::Outdoor && g.cell(p).walkable() && !seen[g.flat_index(p)] {
                failures.push(format!("street pocket at {p:?} cannot reach extraction"));
                return; // one example suffices
            }
        }
    }
}

/// Interior BFS at thief level from a set of start cells, constrained to the
/// building's cells. Returns the reached mask (indexed by grid flat index).
fn interior_flood(spec: &TownSpec, b: &Building, starts: &[CellPos]) -> Vec<bool> {
    let g = &spec.grid;
    let in_building = |p: CellPos| -> bool {
        p.floor >= 0 && (p.floor as u8) < b.n_floors && b.lot.contains(p.x, p.z)
    };
    let mut seen = vec![false; g.n_cells()];
    let mut q = VecDeque::new();
    for &s in starts {
        if in_building(s) && g.cell(s).walkable() && !seen[g.flat_index(s)] {
            seen[g.flat_index(s)] = true;
            q.push_back(s);
        }
    }
    while let Some(p) = q.pop_front() {
        for d in DIRS {
            let n = p.step(d);
            if !g.in_bounds(n) || !in_building(n) || seen[g.flat_index(n)] {
                continue;
            }
            if !g.cell(n).walkable() || !thief_pass(g.edge(p, d).passage()) {
                continue;
            }
            seen[g.flat_index(n)] = true;
            q.push_back(n);
        }
        // Vertical links whose both ends are inside the building (stairs).
        for l in &g.links {
            let other = if l.a == p { l.b } else if l.b == p { l.a } else { continue };
            if !in_building(other) || seen[g.flat_index(other)] || !g.cell(other).walkable() {
                continue;
            }
            let gate_ok = match l.gate {
                None => true,
                Some((gp, gd)) => thief_pass(g.edge(gp, gd).passage()),
            };
            if gate_ok {
                seen[g.flat_index(other)] = true;
                q.push_back(other);
            }
        }
    }
    seen
}

fn check_interior(spec: &TownSpec, b: &Building, failures: &mut Vec<String>) {
    let g = &spec.grid;
    let seen = interior_flood(spec, b, &[b.front_door.0]);
    for p in spec.building_cells(b) {
        if g.cell(p).walkable() && !seen[g.flat_index(p)] {
            failures.push(format!("building {}: cell {p:?} unreachable from the front door", b.id));
            return;
        }
    }
}

/// Enumerate the distinct street→building entry portals: ground-floor door
/// and non-Wall window edges from walkable street cells, plus exterior climb
/// links (gated by their window).
fn portals(spec: &TownSpec, b: &Building) -> Vec<Portal> {
    let g = &spec.grid;
    let mut out = Vec::new();
    for z in b.lot.z0..b.lot.z1 {
        for x in b.lot.x0..b.lot.x1 {
            let p = CellPos::new(x, z, 0);
            for d in DIRS {
                let q = p.step(d);
                if !g.in_bounds(q) || b.lot.contains(q.x, q.z) {
                    continue; // interior edge, not a street boundary
                }
                if g.cell(q).kind != CellKind::Outdoor || !g.cell(q).walkable() {
                    continue;
                }
                let e = g.edge(p, d);
                if thief_pass(e.passage()) && g.cell(p).walkable() {
                    out.push(Portal { entry: p, label: format!("{e:?} at {p:?}") });
                }
            }
        }
    }
    for l in &g.links {
        // Climbs: one end on the public street, the other inside `b`.
        let (street, inside) = if l.a.floor == 0 && g.cell(l.a).kind == CellKind::Outdoor {
            (l.a, l.b)
        } else if l.b.floor == 0 && g.cell(l.b).kind == CellKind::Outdoor {
            (l.b, l.a)
        } else {
            continue;
        };
        if !b.lot.contains(inside.x, inside.z) || (inside.floor as u8) >= b.n_floors {
            continue;
        }
        if !g.cell(street).walkable() || !g.cell(inside).walkable() {
            continue;
        }
        let gate_ok = match l.gate {
            None => true,
            Some((gp, gd)) => thief_pass(g.edge(gp, gd).passage()),
        };
        if gate_ok {
            out.push(Portal { entry: inside, label: format!("{:?} climb to {inside:?}", l.kind) });
        }
    }
    out
}

fn check_target_approaches(spec: &TownSpec, b: &Building, target: CellPos, tid: u16, failures: &mut Vec<String>) {
    let g = &spec.grid;
    let ports = portals(spec, b);
    let mut reaching = 0;
    for portal in &ports {
        let seen = interior_flood(spec, b, &[portal.entry]);
        if seen[g.flat_index(target)] {
            reaching += 1;
        }
    }
    if reaching < 2 {
        let labels: Vec<&str> = ports.iter().map(|p| p.label.as_str()).collect();
        failures.push(format!(
            "target {tid} in building {}: only {reaching} of {} approaches reach it (need ≥ 2); portals: {labels:?}",
            b.id,
            ports.len()
        ));
    }
}

fn check_hiding_density(spec: &TownSpec, b: &Building, target: CellPos, tid: u16, failures: &mut Vec<String>) {
    let g = &spec.grid;
    let mut spots = 0;
    for z in b.lot.z0..b.lot.z1 {
        for x in b.lot.x0..b.lot.x1 {
            let p = CellPos::new(x, z, target.floor);
            if g.cell(p).prop == super::grid::Prop::HidingSpot {
                spots += 1;
            }
        }
    }
    if spots < 2 {
        failures.push(format!("target {tid}: {spots} hiding spots on its floor (need ≥ 2)"));
    }
}

#[cfg(test)]
mod tests {
    use super::super::grid::{EdgeKind, LinkKind};
    use super::super::towngen::{generate_town, TownParams};
    use super::*;

    #[test]
    fn a_generated_town_validates_clean() {
        let spec = generate_town(&TownParams::default(), 11).unwrap();
        let report = validate_town(&spec);
        assert!(report.failures.is_empty(), "{:?}", report.failures);
    }

    #[test]
    fn sealing_a_target_building_fails_validation() {
        // Take a fair town and wall up every portal of a target's building:
        // the ≥2-approaches invariant must catch it.
        let mut spec = generate_town(&TownParams::default(), 11).unwrap();
        let t = spec.targets[0];
        let b = spec.buildings[t.building as usize].clone();
        for z in b.lot.z0..b.lot.z1 {
            for x in b.lot.x0..b.lot.x1 {
                for f in 0..b.n_floors as i8 {
                    let p = CellPos::new(x, z, f);
                    for d in DIRS {
                        let q = p.step(d);
                        if !b.lot.contains(q.x, q.z) && spec.grid.in_bounds(q) {
                            spec.grid.set_edge(p, d, EdgeKind::Wall);
                        }
                    }
                }
            }
        }
        spec.grid.links.retain(|l| {
            !(l.kind == LinkKind::Climb && b.lot.contains(l.b.x, l.b.z))
        });
        let report = validate_town(&spec);
        assert!(
            report.failures.iter().any(|f| f.contains(&format!("target {}", t.id))),
            "sealed building must fail the approach invariant: {:?}",
            report.failures
        );
    }

    #[test]
    fn walling_off_a_gate_fails_validation() {
        let mut spec = generate_town(&TownParams::default(), 5).unwrap();
        // Wall the last gate off from the world on all four sides.
        let gate = *spec.gates.last().unwrap();
        for d in DIRS {
            spec.grid.set_edge(gate, d, EdgeKind::Wall);
        }
        let report = validate_town(&spec);
        assert!(
            report.failures.iter().any(|f| f.contains("disconnected") || f.contains("pocket")),
            "{:?}",
            report.failures
        );
    }
}
