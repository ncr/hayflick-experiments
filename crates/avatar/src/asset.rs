//! The two character assets, embedded in the binary: `player.skin` (the
//! skinned mesh, `tools/character/build_mesh.py`) and `player.anim` (the
//! skeleton + the retargeted motion-capture clips, `tools/character/bake.py`).
//! Both formats are documented at the top of the script that writes them.
use glam::{Quat, Vec3};

/// One bone of the skeleton. Rest rotations are the identity, so a bone is
/// fully described by where its joint (`head`) and its end (`tail`) sit in
/// the bind pose.
#[derive(Clone, Debug)]
pub struct Bone {
    pub name: String,
    pub parent: Option<usize>,
    pub head: Vec3,
    pub tail: Vec3,
}

#[derive(Clone, Debug)]
pub struct Skeleton {
    pub bones: Vec<Bone>,
    /// Heel and ball contact points relative to the ankle, in the foot
    /// bone's frame (both on the ground when the rest foot stands flat).
    pub heel: Vec3,
    pub ball: Vec3,
}

impl Skeleton {
    pub fn index(&self, name: &str) -> usize {
        self.bones.iter().position(|b| b.name == name).unwrap_or_else(|| panic!("no bone {name:?}"))
    }
    pub fn len(&self, i: usize) -> f32 {
        (self.bones[i].tail - self.bones[i].head).length()
    }
}

/// One clip sample: the pelvis offset in the clip's heading frame
/// (x lateral, y height above the ground, z along travel minus the straight
/// line), the two feet's contact (0..1, left then right) and the bone
/// rotations — the pelvis's relative to the heading, the rest to their parent.
#[derive(Clone, Debug)]
pub struct Sample {
    pub root: Vec3,
    pub contact: [f32; 2],
    pub rot: Vec<Quat>,
}

#[derive(Clone, Debug)]
pub struct Clip {
    pub name: String,
    /// A locomotion cycle (phase-driven, one cycle = `stride` metres) or an
    /// idle loop (time-driven, `duration` seconds).
    pub cyclic: bool,
    pub duration: f32,
    pub stride: f32,
    pub samples: Vec<Sample>,
}

impl Clip {
    /// Natural speed of a locomotion cycle (wu/s).
    pub fn speed(&self) -> f32 {
        self.stride / self.duration
    }
}

#[derive(Clone, Copy, Debug)]
pub struct SkinVertex {
    pub pos: Vec3,
    pub nrm: Vec3,
    pub uv: [f32; 2],
    pub bones: [u8; 4],
    pub weights: [f32; 4],
}

#[derive(Clone, Copy, Debug)]
pub struct Material {
    /// Linear rgb.
    pub color: [f32; 3],
    pub roughness: f32,
    /// `rt-viewer` material flags (4 = MATTE).
    pub flags: u32,
}

#[derive(Clone, Debug)]
pub struct SkinMesh {
    pub materials: Vec<Material>,
    pub vertices: Vec<SkinVertex>,
    /// (material, triangle indices into `vertices`).
    pub groups: Vec<(u32, Vec<u32>)>,
}

struct Reader<'a>(&'a [u8]);

impl<'a> Reader<'a> {
    fn take(&mut self, n: usize) -> &'a [u8] {
        let (a, b) = self.0.split_at(n);
        self.0 = b;
        a
    }
    fn u32(&mut self) -> u32 {
        u32::from_le_bytes(self.take(4).try_into().unwrap())
    }
    fn i32(&mut self) -> i32 {
        i32::from_le_bytes(self.take(4).try_into().unwrap())
    }
    fn f32(&mut self) -> f32 {
        f32::from_le_bytes(self.take(4).try_into().unwrap())
    }
    fn vec3(&mut self) -> Vec3 {
        Vec3::new(self.f32(), self.f32(), self.f32())
    }
    fn name(&mut self) -> String {
        let n = self.u32() as usize;
        String::from_utf8(self.take(n).to_vec()).unwrap()
    }
}

pub const SKIN_BYTES: &[u8] = include_bytes!("../../../assets/characters/player.skin");
pub const ANIM_BYTES: &[u8] = include_bytes!("../../../assets/characters/player.anim");

pub fn parse_anim(bytes: &[u8]) -> (Skeleton, Vec<Clip>) {
    let mut r = Reader(bytes);
    assert_eq!(r.take(8), b"HFANIM01");
    let nb = r.u32() as usize;
    let bones: Vec<Bone> = (0..nb)
        .map(|_| {
            let name = r.name();
            let parent = r.i32();
            Bone { name, parent: (parent >= 0).then_some(parent as usize), head: r.vec3(), tail: r.vec3() }
        })
        .collect();
    let heel = r.vec3();
    let ball = r.vec3();
    let nc = r.u32();
    let clips = (0..nc)
        .map(|_| {
            let name = r.name();
            let cyclic = r.u32() != 0;
            let duration = r.f32();
            let stride = r.f32();
            let ns = r.u32();
            let samples = (0..ns)
                .map(|_| {
                    let root = r.vec3();
                    let contact = [r.f32(), r.f32()];
                    let rot = (0..nb).map(|_| Quat::from_xyzw(r.f32(), r.f32(), r.f32(), r.f32()).normalize()).collect();
                    Sample { root, contact, rot }
                })
                .collect();
            Clip { name, cyclic, duration, stride, samples }
        })
        .collect();
    assert!(r.0.is_empty(), "unconsumed animation data");
    (Skeleton { bones, heel, ball }, clips)
}

pub fn parse_skin(bytes: &[u8]) -> (SkinMesh, usize) {
    let mut r = Reader(bytes);
    assert_eq!(r.take(8), b"HFSKIN01");
    let nm = r.u32();
    let materials = (0..nm).map(|_| Material { color: [r.f32(), r.f32(), r.f32()], roughness: r.f32(), flags: r.u32() }).collect();
    let nbones = r.u32() as usize;
    let nv = r.u32();
    let vertices = (0..nv)
        .map(|_| {
            let pos = r.vec3();
            let nrm = r.vec3();
            let uv = [r.f32(), r.f32()];
            let b = r.take(4);
            let bones = [b[0], b[1], b[2], b[3]];
            let weights = [r.f32(), r.f32(), r.f32(), r.f32()];
            SkinVertex { pos, nrm, uv, bones, weights }
        })
        .collect();
    let ng = r.u32();
    let groups = (0..ng)
        .map(|_| {
            let m = r.u32();
            let n = r.u32();
            (m, (0..n).map(|_| r.u32()).collect())
        })
        .collect();
    assert!(r.0.is_empty(), "unconsumed skin data");
    (SkinMesh { materials, vertices, groups }, nbones)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_assets_parse_and_agree_on_the_skeleton() {
        let (skel, clips) = parse_anim(ANIM_BYTES);
        let (mesh, nbones) = parse_skin(SKIN_BYTES);
        assert_eq!(nbones, skel.bones.len());
        for name in ["idle", "walk", "brisk", "run", "sneak"] {
            assert!(clips.iter().any(|c| c.name == name), "missing clip {name}");
        }
        for v in &mesh.vertices {
            let s: f32 = v.weights.iter().sum();
            assert!((s - 1.0).abs() < 1e-4, "weights must sum to one");
            assert!(v.bones.iter().all(|&b| (b as usize) < nbones));
            assert!((v.nrm.length() - 1.0).abs() < 1e-3);
        }
        for (m, idx) in &mesh.groups {
            assert!((*m as usize) < mesh.materials.len());
            assert!(idx.iter().all(|&i| (i as usize) < mesh.vertices.len()));
        }
        // parents come first, so a single forward pass is forward kinematics
        for (i, b) in skel.bones.iter().enumerate() {
            assert!(b.parent.is_none_or(|p| p < i));
        }
    }
}
