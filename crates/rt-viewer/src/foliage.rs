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
use house_game::gym::sim::{GrowBrush, GymLevel, PlantKind};
use rt_probe::scene::ATLAS_W;
use rt_probe::Scene;

pub use flora::ground::DIM;

fn smooth(a: f32, b: f32, x: f32) -> f32 {
    let t = ((x - a) / (b - a)).clamp(0.0, 1.0);
    t * t * (3.0 - 2.0 * t)
}

/// `concrete.inc`'s `cnHash` / `cnNoise`, bit for bit in f32: the road's
/// cracks are drawn by the shade pass and seeded with grass here, and the two
/// have to agree on where a crack runs.
fn cn_hash(p: [f32; 3]) -> f32 {
    let fr = |v: f32| v - v.floor();
    let mut q = [fr(p[0] * 0.1031), fr(p[1] * 0.1031), fr(p[2] * 0.1031)];
    let d = q[0] * (q[1] + 33.33) + q[1] * (q[2] + 33.33) + q[2] * (q[0] + 33.33);
    q = [q[0] + d, q[1] + d, q[2] + d];
    fr((q[0] + q[1]) * q[2])
}

fn cn_noise(p: [f32; 3]) -> f32 {
    let i = p.map(f32::floor);
    let f = [p[0] - i[0], p[1] - i[1], p[2] - i[2]].map(|f| f * f * (3.0 - 2.0 * f));
    let h = |dx: f32, dy: f32, dz: f32| cn_hash([i[0] + dx, i[1] + dy, i[2] + dz]);
    let mix = |a: f32, b: f32, t: f32| a + (b - a) * t;
    mix(
        mix(mix(h(0.0, 0.0, 0.0), h(1.0, 0.0, 0.0), f[0]), mix(h(0.0, 1.0, 0.0), h(1.0, 1.0, 0.0), f[0]), f[1]),
        mix(mix(h(0.0, 0.0, 1.0), h(1.0, 0.0, 1.0), f[0]), mix(h(0.0, 1.0, 1.0), h(1.0, 1.0, 1.0), f[0]), f[1]),
        f[2],
    )
}

/// Distance-like measure to the road's crack network (`terrain.inc`'s
/// `terrainCrack`): the contour where a slow noise crosses one half, so any
/// road anywhere gets cracks, not three hand-placed lines.
pub fn crack_dist(p: Vec2) -> f32 {
    let field = |p: Vec2| cn_noise([p.x * 0.42, p.y * 0.42, 3.0]) + 0.16 * (cn_noise([p.x * 2.3, p.y * 2.3, 9.0]) - 0.5);
    let n = field(p);
    let (gx, gz) = (field(p + Vec2::new(0.02, 0.0)) - n, field(p + Vec2::new(0.0, 0.02)) - n);
    (n - 0.5).abs() / ((gx * gx + gz * gz).sqrt() / 0.02).max(0.25)
}

/// The street's natural growth at a point: (green, dry). Open soil grows in
/// patches, the road only in its cracks, paving and building floors not at
/// all. (Scorched ground is a brush stroke now, not a property of a lot.)
pub fn natural(spec: &GymLevel, x: f32, z: f32) -> (f32, f32) {
    let p = Vec2::new(x, z);
    match crate::terrain::kind_at(spec, x, z) {
        crate::terrain::SOIL => {
            let growth = crate::concrete::noise(p * 0.68, 8);
            let straw = crate::concrete::noise(p * 0.9 + Vec2::splat(31.0), 9);
            (smooth(0.36, 0.56, growth) * 0.95, 0.2 + 0.45 * straw)
        }
        crate::terrain::ROAD => ((1.0 - smooth(0.04, 0.1, crack_dist(p))) * 0.9, 0.35),
        _ => (0.0, 0.0),
    }
}

fn brush(b: GrowBrush) -> flora::ground::Brush {
    match b {
        GrowBrush::Grass => flora::ground::Brush::Grass,
        GrowBrush::Dry => flora::ground::Brush::Dry,
        GrowBrush::Mow => flora::ground::Brush::Mow,
        GrowBrush::Scorch => flora::ground::Brush::Scorch,
    }
}

/// Bake the level's grass density map (natural growth + ground strokes, plus
/// any `pending` strokes of a drag in flight).
pub fn density(spec: &GymLevel, pending: &[house_game::gym::sim::GroundStroke]) -> flora::ground::Density {
    let strokes: Vec<flora::ground::Stroke> = spec.ground.iter().chain(pending).map(|g| flora::ground::Stroke { brush: brush(g.brush), x: g.x, z: g.z, r: g.r }).collect();
    flora::ground::Density::bake(&|x, z| natural(spec, x, z), &strokes)
}

/// Byte 2 of a map texel: the ground surface kind (bits 0-1) and how deep a
/// pothole sits there (bits 2-7, 0..63) — `terrain.inc`'s `terrainParcel` and
/// `terrainRoadHeight` read them.
fn ground_byte(spec: &GymLevel, x: f32, z: f32) -> u32 {
    let kind = crate::terrain::kind_at(spec, x, z) as u32;
    let hole = if kind == crate::terrain::ROAD as u32 { (crate::terrain::pothole(spec, Vec2::new(x, z)) * 63.0 + 0.5) as u32 } else { 0 };
    kind | hole << 2
}

/// Write the level's ground map into the atlas's reserved corner (growing the
/// atlas to at least `DIM` rows): the density map's green / dry / burn plus
/// the ground kind and potholes in byte 2.
pub fn write_density(atlas: &mut Vec<u32>, spec: &GymLevel, d: &flora::ground::Density) {
    let need = DIM * ATLAS_W as usize;
    if atlas.len() < need {
        atlas.resize(need, 0);
    }
    let packed = d.pack();
    for j in 0..DIM {
        let row = j * ATLAS_W as usize;
        for i in 0..DIM {
            let (x, z) = ((i as f32 + 0.5) / flora::ground::TX, (j as f32 + 0.5) / flora::ground::TX);
            let ground = if x < spec.grid.w as f32 && z < spec.grid.h as f32 { ground_byte(spec, x, z) } else { 0 };
            atlas[row + i] = packed[j * DIM + i] | ground << 16;
        }
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
        let y = crate::terrain::height_at(spec, Vec2::new(p.x, p.z));
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

    fn street() -> GymLevel {
        crate::demos::Level::Neighborhood.spec()
    }

    #[test]
    fn the_street_grows_on_soil_and_in_road_cracks_but_not_on_paving() {
        let spec = street();
        let d = density(&spec, &[]);
        // a sidewalk strip (z 8.5..10) is bare everywhere
        for i in 0..20 {
            assert_eq!(d.green_at(2.0 + i as f32, 9.2), 0.0);
        }
        // somewhere on open soil grass grows
        assert!((0..26).any(|x| d.green_at(x as f32 + 0.5, 20.5) > 0.3));
        // the road is bare off its cracks and grows in some
        let road: Vec<(f32, f32)> = (0..104).map(|i| (i as f32 * 0.25, 12.0)).collect();
        assert!(road.iter().filter(|&&(x, z)| crack_dist(Vec2::new(x, z)) > 0.3).all(|&(x, z)| natural(&spec, x, z).0 == 0.0));
        assert!(road.iter().any(|&(x, z)| natural(&spec, x, z).0 > 0.5), "cracks cross the road");
    }

    #[test]
    fn the_ground_map_lands_in_the_atlas_corner_and_carries_the_ground_kind() {
        let spec = street();
        let mut atlas = vec![7u32; ATLAS_W as usize * 300];
        let d = density(&spec, &[]);
        write_density(&mut atlas, &spec, &d);
        assert_eq!(atlas[DIM], 7, "column DIM of row 0 is not the map's");
        assert_eq!(atlas[DIM * ATLAS_W as usize], 7, "row DIM is not the map's");
        let at = |x: f32, z: f32| atlas[(z * 4.0) as usize * ATLAS_W as usize + (x * 4.0) as usize];
        assert_eq!((at(12.0, 12.0) >> 16) & 3, crate::terrain::ROAD as u32);
        assert_eq!((at(12.0, 9.0) >> 16) & 3, crate::terrain::WALK as u32);
        assert_eq!((at(5.0, 5.0) >> 16) & 3, crate::terrain::SLAB as u32, "a building's room is slab floor");
        assert!((at(8.3, 11.8) >> 18) & 63 > 30, "the pothole is deep at its centre");
    }
}
