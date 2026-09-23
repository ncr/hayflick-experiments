//! STREET PROPS (creative mode's props category, 2026-09-23): the adapter
//! between the level's placed props and the `props` crate. Every prop of the
//! level is grown from its seed and the triangles merged into one primitive
//! per material; paint colours each get their own material (a handful per
//! level). The sim collides with the same footprints (`Prop::blocks`).

use crate::concrete::{self, Exposure};
use glam::{Vec2, Vec3};
use house_game::gym::sim::{GymLevel, PropKind};
use props::Mat;
use rt_probe::Scene;

fn kind(k: PropKind) -> props::Kind {
    match k {
        PropKind::Car => props::Kind::Car,
        PropKind::Barrel => props::Kind::Barrel,
        PropKind::Crate => props::Kind::Crate,
        PropKind::Tires => props::Kind::Tires,
        PropKind::Barrier => props::Kind::Barrier,
        PropKind::Pole => props::Kind::Pole,
        PropKind::Sign => props::Kind::Sign,
        PropKind::Hydrant => props::Kind::Hydrant,
        PropKind::Mailbox => props::Kind::Mailbox,
        PropKind::Bench => props::Kind::Bench,
    }
}

/// World-space vertices (position, normal) of one material's triangles.
type Verts = Vec<([f32; 3], [f32; 3])>;

/// Grow every prop of the level into `scene`.
pub fn build(scene: &mut Scene, spec: &GymLevel) {
    let mut groups: Vec<(Mat, Verts)> = Vec::new();
    for p in &spec.props {
        let y = crate::terrain::height_at(spec, Vec2::new(p.x, p.z));
        for (m, tris) in props::build(kind(p.kind), p.x, y, p.z, p.yaw, p.seed) {
            let i = match groups.iter().position(|(gm, _)| *gm == m) {
                Some(i) => i,
                None => {
                    groups.push((m, Vec::new()));
                    groups.len() - 1
                }
            };
            for t in tris {
                let (a, b, c) = (Vec3::from(t[0]), Vec3::from(t[1]), Vec3::from(t[2]));
                let n = (b - a).cross(c - a).normalize_or_zero().to_array();
                groups[i].1.extend([(t[0], n), (t[1], n), (t[2], n)]);
            }
        }
    }
    for (m, verts) in groups {
        let id = match m {
            // corroded steel reads through the concrete study's steel shading
            Mat::Rust => concrete::material(scene, Exposure::Corrosion, 1, 7),
            Mat::Concrete => concrete::material(scene, Exposure::Rain, 0, 9),
            Mat::Paint(c) => scene.new_material([c[0], c[1], c[2], 0.0], [0.0; 4], 0.55, 0.0),
            Mat::Steel => scene.new_material([0.16, 0.165, 0.165, 0.0], [0.0; 4], 0.45, 0.6),
            Mat::Rubber => scene.new_material([0.02, 0.02, 0.02, 0.0], [0.0; 4], 0.9, 0.0),
            Mat::Wood => scene.new_material([0.12, 0.08, 0.05, 0.0], [0.0; 4], 0.9, 0.0),
            Mat::Glass => scene.new_material([0.015, 0.02, 0.025, 0.0], [0.0; 4], 0.08, 0.0),
        };
        let idx: Vec<u32> = (0..verts.len() as u32).collect();
        scene.add_mesh_world(&verts, &idx, id);
    }
}
