//! CPU linear-blend skinning of the player mesh.
use crate::asset::{parse_skin, SkinMesh, Skeleton, SKIN_BYTES};
use crate::pose::Globals;
use glam::{Mat4, Vec3};

/// The embedded player mesh.
pub fn mesh() -> SkinMesh {
    parse_skin(SKIN_BYTES).0
}

/// Per-bone skinning matrices for a solved pose, relative to `origin` (the
/// mesh is emitted in coordinates around it, so an instance transform can
/// carry the translation and the vertex values stay small).
pub fn matrices(skel: &Skeleton, g: &Globals, origin: Vec3) -> Vec<Mat4> {
    skel.bones
        .iter()
        .enumerate()
        .map(|(i, b)| Mat4::from_rotation_translation(g.rot[i], g.head[i] - origin) * Mat4::from_translation(-b.head))
        .collect()
}

/// Skin every vertex: (position, unit normal) in `origin`-relative space.
pub fn skin(mesh: &SkinMesh, m: &[Mat4], out: &mut Vec<(Vec3, Vec3)>) {
    out.clear();
    out.extend(mesh.vertices.iter().map(|v| {
        let mut p = Vec3::ZERO;
        let mut n = Vec3::ZERO;
        for k in 0..4 {
            let w = v.weights[k];
            if w == 0.0 {
                continue;
            }
            let mat = &m[v.bones[k] as usize];
            p += mat.transform_point3(v.pos) * w;
            n += mat.transform_vector3(v.nrm) * w;
        }
        (p, n.normalize_or(v.nrm))
    }));
}
