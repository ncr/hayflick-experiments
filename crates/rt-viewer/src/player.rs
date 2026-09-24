//! The adapter between the `avatar` crate (the player's body: skinned mesh,
//! mocap clips, locomotion, IK) and the renderer: it puts the bind mesh into
//! the scene as ONE dynamic run ("player") and, every fixed tick, feeds the
//! body the sim snapshot and re-skins the mesh into that run's vertices
//! (`FrameState::skin` — the backends upload them and rebuild the run's
//! BLASes). The run's instance transform only carries the translation to the
//! body; rotation and articulation live in the vertices.
use avatar::asset::SkinMesh;
use avatar::skin::{matrices, mesh, skin};
use avatar::{Body, Input};
use glam::{Mat4, Vec2, Vec3};
use rt_probe::scene::Vertex;
use rt_probe::{InstanceKey, Scene, SceneHandles};

/// The dynamic run's name.
pub const RUN: &str = "player";

/// The scene's vertex order for the mesh: each material group's vertices,
/// compacted (a vertex used by two groups appears in both), group after
/// group. `build` lays the run out in exactly this order and the per-tick
/// skin follows it, so the two cannot disagree.
fn layout(m: &SkinMesh) -> Vec<(u32, Vec<u32>, Vec<u32>)> {
    m.groups
        .iter()
        .map(|(mat, idx)| {
            let mut order: Vec<u32> = Vec::new();
            let mut remap = std::collections::HashMap::new();
            let local = idx
                .iter()
                .map(|&i| {
                    *remap.entry(i).or_insert_with(|| {
                        order.push(i);
                        order.len() as u32 - 1
                    })
                })
                .collect();
            (*mat, order, local)
        })
        .collect()
}

/// Add the bind mesh to the scene: its fifteen materials (surface slots
/// -2..-16, the suit detail in `survivor.inc`), one primitive per material
/// group, registered as the dynamic run [`RUN`].
pub fn build(scene: &mut Scene) {
    let m = mesh();
    let base = scene.materials.len() as i32;
    for (i, mat) in m.materials.iter().enumerate() {
        scene.materials.push(rt_probe::scene::Material {
            base_color: [mat.color[0], mat.color[1], mat.color[2], 1.0],
            emissive: [0.0; 4],
            roughness: mat.roughness,
            metallic: 0.0,
            surface: -2 - i as i32,
            _pad: mat.flags as i32,
        });
    }
    let first = scene.primitives.len();
    for (mat, order, local) in layout(&m) {
        let verts: Vec<([f32; 3], [f32; 3])> = order.iter().map(|&i| (m.vertices[i as usize].pos.to_array(), m.vertices[i as usize].nrm.to_array())).collect();
        let v0 = scene.vertices.len();
        scene.add_mesh_world(&verts, &local, base + mat as i32);
        for (v, &i) in scene.vertices[v0..].iter_mut().zip(&order) {
            v.uv = m.vertices[i as usize].uv;
        }
    }
    scene.register_dynamic(RUN, first, scene.primitives.len() - first, Mat4::from_scale(Vec3::ZERO));
}

/// The live body.
pub struct Player {
    pub body: Body,
    mesh: SkinMesh,
    /// Scene vertex order → mesh vertex.
    order: Vec<u32>,
    skinned: Vec<(Vec3, Vec3)>,
    verts: Vec<Vertex>,
    origin: Vec3,
}

impl Player {
    pub fn new(position: Vec2, ground: impl Fn(Vec2) -> f32) -> Player {
        let m = mesh();
        let order = layout(&m).into_iter().flat_map(|(_, o, _)| o).collect();
        let body = Body::new(position, ground);
        let mut p = Player { body, mesh: m, order, skinned: Vec::new(), verts: Vec::new(), origin: Vec3::ZERO };
        p.reskin(position);
        p
    }

    /// One fixed tick: advance the body from the sim snapshot, re-skin.
    pub fn tick(&mut self, input: &Input, ground: impl Fn(Vec2) -> f32) {
        self.body.tick(input, &ground);
        self.reskin(input.position);
    }

    fn reskin(&mut self, position: Vec2) {
        self.origin = Vec3::new(position.x, 0.0, position.y);
        skin(&self.mesh, &matrices(&self.body.skel, &self.body.pose, self.origin), &mut self.skinned);
        self.verts.clear();
        self.verts.extend(self.order.iter().map(|&i| {
            let (p, n) = self.skinned[i as usize];
            Vertex { pos: p.to_array(), nrm: n.to_array(), uv: self.mesh.vertices[i as usize].uv }
        }));
    }

    /// The run's instance transform (the translation the vertices are
    /// relative to).
    pub fn instance(&self, handles: &SceneHandles) -> Option<(InstanceKey, Mat4)> {
        handles.instances.get(RUN).map(|&k| (k, Mat4::from_translation(self.origin)))
    }

    /// This tick's skinned vertices, in the run's scene order.
    pub fn skin(&self, handles: &SceneHandles) -> Option<(InstanceKey, &[Vertex])> {
        handles.instances.get(RUN).map(|&k| (k, &self.verts[..]))
    }

    /// Instance-local skinned vertices (tests).
    #[cfg(test)]
    pub fn vertices(&self) -> &[Vertex] {
        &self.verts
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The run `build` lays out and the vertices `Player` skins every tick
    /// must be the same list — at rest, the skin reproduces the bind mesh.
    #[test]
    fn the_skinned_vertices_match_the_scene_run_they_overwrite() {
        let mut scene = Scene::new();
        build(&mut scene);
        let (_, first, count, _) = scene.dynamics.iter().find(|(n, ..)| n == RUN).cloned().unwrap();
        let run = &scene.primitives[first..first + count];
        let v0 = run[0].vertex_offset as usize;
        let v1 = run.iter().map(|p| (p.vertex_offset + p.vertex_count) as usize).max().unwrap();
        let p = Player::new(Vec2::ZERO, |_| 0.0);
        assert_eq!(p.vertices().len(), v1 - v0, "one skinned vertex per scene vertex of the run");
        for (a, b) in p.vertices().iter().zip(&scene.vertices[v0..v1]) {
            assert_eq!(a.uv, b.uv, "the bind coordinates ride with their vertex");
        }
        scene.validate_acceleration_geometry().unwrap();
    }
}
