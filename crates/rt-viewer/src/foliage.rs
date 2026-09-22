//! FOLIAGE (creative mode's plants category, 2026-09-22): the adapter between
//! the level's vegetation data and the `flora` crate.
//!
//! - The GRASS DENSITY MAP: the level's natural growth (moved here from the
//!   shade pass, where it was a parcel lookup + noise per blade) plus every
//!   ground brush stroke, baked by `flora::ground` and written into the
//!   atlas's reserved corner (rows `0..DIM`, columns `0..DIM`) — `terrain.inc`
//!   reads it per blade. A brush dab re-bakes this map and re-uploads the
//!   atlas; the blades follow the same frame.
//! - PLANTS: every tree and bush of the level, grown from its seed by
//!   `flora::plant`, merged into one primitive per material (bark, green
//!   leaf, dry leaf). The ground's `dry` under a plant browns its leaves.

use glam::{Vec2, Vec3};
use house_game::gym::neighborhood::{areas, Area};
use house_game::gym::sim::{GrowBrush, GymLevel, PlantKind};
use rt_probe::scene::ATLAS_W;
use rt_probe::Scene;

pub use flora::ground::DIM;

fn smooth(a: f32, b: f32, x: f32) -> f32 {
    let t = ((x - a) / (b - a)).clamp(0.0, 1.0);
    t * t * (3.0 - 2.0 * t)
}

/// The road's crack lines (the same three the shade pass draws on the
/// asphalt): grass only takes root in them.
fn crack_dist(p: Vec2) -> f32 {
    let a = (p.y - (11.05 + 0.36 * (p.x * 0.67).sin() + 0.085 * (p.x * 4.7).sin())).abs();
    let b = (p.x - (7.4 + 0.62 * (p.y * 1.8).sin() + 0.065 * (p.y * 11.0).sin())).abs();
    let c = (p.x - (18.2 + 0.55 * (p.y * 1.4).sin() + 0.11 * (p.y * 7.0).sin())).abs();
    a.min(b).min(c)
}

/// The street's natural growth at a point: (green, dry). Open soil grows in
/// patches, the road only in its cracks, paving and the lots not at all, and
/// the ground around the burnt-out lot is scorched to sparse straw.
pub fn natural(parcels: &[Area], x: f32, z: f32) -> (f32, f32) {
    let p = Vec2::new(x, z);
    let kind = parcels.iter().rev().find(|a| x >= a.rect[0] && z >= a.rect[1] && x < a.rect[2] && z < a.rect[3]).map_or(0, |a| a.kind);
    let burn = parcels
        .iter()
        .filter(|a| a.kind == 3 && a.exposure == 3)
        .map(|a| {
            let q = Vec2::new((a.rect[0] - x).max(x - a.rect[2]).max(0.0), (a.rect[1] - z).max(z - a.rect[3]).max(0.0));
            1.0 - smooth(0.25, 2.0, q.length())
        })
        .fold(0.0f32, f32::max);
    let (green, dry) = match kind {
        0 => {
            let growth = crate::concrete::noise(p * 0.68, 8);
            let straw = crate::concrete::noise(p * 0.9 + Vec2::splat(31.0), 9);
            (smooth(0.36, 0.56, growth) * 0.95, 0.2 + 0.45 * straw)
        }
        1 => ((1.0 - smooth(0.04, 0.1, crack_dist(p))) * 0.9, 0.35),
        _ => (0.0, 0.0),
    };
    (green * (1.0 - 0.8 * burn), dry.max(burn))
}

fn brush(b: GrowBrush) -> flora::ground::Brush {
    match b {
        GrowBrush::Grass => flora::ground::Brush::Grass,
        GrowBrush::Dry => flora::ground::Brush::Dry,
        GrowBrush::Mow => flora::ground::Brush::Mow,
    }
}

/// Bake the level's grass density map (natural growth + ground strokes, plus
/// any `pending` strokes of a drag in flight).
pub fn density(spec: &GymLevel, pending: &[house_game::gym::sim::GroundStroke]) -> flora::ground::Density {
    let parcels = areas();
    let strokes: Vec<flora::ground::Stroke> = spec.ground.iter().chain(pending).map(|g| flora::ground::Stroke { brush: brush(g.brush), x: g.x, z: g.z, r: g.r }).collect();
    flora::ground::Density::bake(&|x, z| natural(&parcels, x, z), &strokes)
}

/// Write a density map into the atlas's reserved corner, growing the atlas to
/// at least `DIM` rows.
pub fn write_density(atlas: &mut Vec<u32>, d: &flora::ground::Density) {
    let need = DIM * ATLAS_W as usize;
    if atlas.len() < need {
        atlas.resize(need, 0);
    }
    let packed = d.pack();
    for j in 0..DIM {
        let row = j * ATLAS_W as usize;
        atlas[row..row + DIM].copy_from_slice(&packed[j * DIM..(j + 1) * DIM]);
    }
}

/// Grow every plant of the level into `scene`: three primitives (bark, green
/// leaf, dry leaf) for the whole level.
pub fn plants(scene: &mut Scene, spec: &GymLevel, d: &flora::ground::Density) {
    let mut bark: Vec<([f32; 3], [f32; 3])> = Vec::new();
    let mut leaf = Vec::new();
    let mut dry = Vec::new();
    let push = |out: &mut Vec<([f32; 3], [f32; 3])>, tris: &[flora::plant::Tri]| {
        for t in tris {
            let (a, b, c) = (Vec3::from(t[0]), Vec3::from(t[1]), Vec3::from(t[2]));
            let n = (b - a).cross(c - a).normalize_or_zero().to_array();
            out.extend([(t[0], n), (t[1], n), (t[2], n)]);
        }
    };
    for p in &spec.plants {
        let kind = match p.kind {
            PlantKind::Tree => flora::plant::Kind::Tree,
            PlantKind::Bush => flora::plant::Kind::Bush,
        };
        let y = crate::terrain::height_at(Vec2::new(p.x, p.z));
        let soup = flora::plant::build(kind, p.x, y, p.z, p.seed, d.dry_at(p.x, p.z));
        push(&mut bark, &soup.bark);
        push(&mut leaf, &soup.leaf);
        push(&mut dry, &soup.dry);
    }
    for (verts, color, rough) in [(bark, [0.07, 0.055, 0.042, 0.0], 0.9), (leaf, [0.05, 0.075, 0.022, 0.0], 0.95), (dry, [0.11, 0.085, 0.04, 0.0], 0.95)] {
        if verts.is_empty() {
            continue;
        }
        let m = scene.new_material(color, [0.0; 4], rough, 0.0);
        // foliage never shines (the meadow's rule)
        scene.materials[m as usize]._pad = crate::flags::MATTE;
        let idx: Vec<u32> = (0..verts.len() as u32).collect();
        scene.add_mesh_world(&verts, &idx, m);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_street_grows_on_soil_and_in_road_cracks_but_not_on_paving() {
        let parcels = areas();
        let d = density(&house_game::gym::neighborhood::level(), &[]);
        // a sidewalk strip (kind 2 at z 8.5..10) is bare everywhere
        for i in 0..20 {
            assert_eq!(d.green_at(2.0 + i as f32, 9.2), 0.0);
        }
        // somewhere on open soil grass grows
        assert!((0..26).any(|x| d.green_at(x as f32 + 0.5, 20.5) > 0.3));
        // and the road is bare off its cracks
        let off = (0..26).map(|x| (x as f32 + 0.5, 13.5)).filter(|&(x, z)| crack_dist(Vec2::new(x, z)) > 0.3);
        for (x, z) in off {
            assert_eq!(natural(&parcels, x, z).0, 0.0);
        }
    }

    #[test]
    fn the_density_map_lands_in_the_atlas_corner_only() {
        let mut atlas = vec![7u32; ATLAS_W as usize * 300];
        let d = density(&house_game::gym::neighborhood::level(), &[]);
        write_density(&mut atlas, &d);
        assert_eq!(atlas[DIM], 7, "column DIM of row 0 is not the map's");
        assert_eq!(atlas[DIM * ATLAS_W as usize], 7, "row DIM is not the map's");
    }
}
