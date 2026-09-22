//! The ground's grass, as a density map baked from natural growth + brush
//! strokes. Two channels per texel: `green` (how much grass stands here, 0..1
//! — the shade pass roots that fraction of its candidate blades) and `dry`
//! (how much of it is straw, 0..1 — blade colour, and a little shorter).

use crate::{noise, smooth};

/// Density texels per world unit (a texel is a quarter-wu square; the shade
/// pass's blade cells are 0.7 wu, so a brush edge lands between blades, not
/// through a clump).
pub const TX: f32 = 4.0;
/// The map is a fixed square of `DIM × DIM` texels (64 wu) at the level's
/// origin, so the shader needs no size uniform. Levels are smaller than this.
pub const DIM: usize = 256;

/// A ground brush.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Brush {
    /// Grow green grass (raises `green`, pulls `dry` down).
    Grass,
    /// Dry what grows here out to straw (raises `dry`; grows a little where
    /// there was nothing, the way dead grass stands in a dry patch).
    Dry,
    /// Cut it all down (lowers `green`).
    Mow,
}

impl Brush {
    pub const ALL: [Brush; 3] = [Brush::Grass, Brush::Dry, Brush::Mow];
    pub fn name(self) -> &'static str {
        match self {
            Brush::Grass => "grass",
            Brush::Dry => "dry",
            Brush::Mow => "mow",
        }
    }
    pub fn by_name(s: &str) -> Option<Brush> {
        Brush::ALL.into_iter().find(|b| b.name() == s)
    }
}

/// One ground dab: world (x, z) and radius.
#[derive(Clone, Copy, PartialEq, Debug)]
pub struct Stroke {
    pub brush: Brush,
    pub x: f32,
    pub z: f32,
    pub r: f32,
}

pub struct Density {
    pub green: Vec<f32>,
    pub dry: Vec<f32>,
}

/// A dab's footprint: soft, with a rim broken by noise so a painted patch has
/// a ragged edge instead of a compass circle.
fn dab(s: &Stroke, x: f32, z: f32) -> f32 {
    let d = ((x - s.x).powi(2) + (z - s.z).powi(2)).sqrt() / s.r.max(1e-3);
    if d > 1.5 {
        return 0.0;
    }
    let n = noise(x * 2.3, z * 2.3, 77) - 0.5;
    1.0 - smooth(0.45, 1.0, d + 0.5 * n)
}

impl Density {
    /// Bake the map: `natural(x, z) -> (green, dry)` is the level's own growth
    /// (the adapter knows soil from pavement), then every stroke in order.
    /// Pure — same inputs, same map.
    pub fn bake(natural: &dyn Fn(f32, f32) -> (f32, f32), strokes: &[Stroke]) -> Density {
        let n = DIM * DIM;
        let (mut green, mut dry) = (vec![0.0f32; n], vec![0.0f32; n]);
        for j in 0..DIM {
            for i in 0..DIM {
                let (x, z) = ((i as f32 + 0.5) / TX, (j as f32 + 0.5) / TX);
                let (g, d) = natural(x, z);
                green[j * DIM + i] = g.clamp(0.0, 1.0);
                dry[j * DIM + i] = d.clamp(0.0, 1.0);
            }
        }
        for s in strokes {
            let reach = s.r * 1.5;
            let c = |v: f32| ((v * TX).max(0.0) as usize).min(DIM);
            for j in c(s.z - reach)..c(s.z + reach + 1.0 / TX) {
                for i in c(s.x - reach)..c(s.x + reach + 1.0 / TX) {
                    let (x, z) = ((i as f32 + 0.5) / TX, (j as f32 + 0.5) / TX);
                    let a = dab(s, x, z);
                    if a <= 0.0 {
                        continue;
                    }
                    let k = j * DIM + i;
                    // grown grass is patchy at the blade scale, never a lawn
                    let clump = 0.7 + 0.3 * noise(x * 3.1, z * 3.1, 5);
                    match s.brush {
                        Brush::Grass => {
                            // grass ADDS: painting over thin growth thickens it
                            green[k] = (green[k] + a * clump).min(1.0);
                            dry[k] *= 1.0 - a;
                        }
                        Brush::Dry => {
                            dry[k] = dry[k].max(a);
                            green[k] = green[k].max(a * 0.55 * clump);
                        }
                        Brush::Mow => green[k] *= 1.0 - a,
                    }
                }
            }
        }
        Density { green, dry }
    }

    /// Packed for the GPU: byte 0 green, byte 1 dry — `DIM` texels per row.
    /// The adapter copies these rows into the scene atlas's reserved corner.
    pub fn pack(&self) -> Vec<u32> {
        self.green.iter().zip(&self.dry).map(|(g, d)| (g * 255.0 + 0.5) as u32 | ((d * 255.0 + 0.5) as u32) << 8).collect()
    }

    pub fn green_at(&self, x: f32, z: f32) -> f32 {
        let (i, j) = (((x * TX) as usize).min(DIM - 1), ((z * TX) as usize).min(DIM - 1));
        self.green[j * DIM + i]
    }

    pub fn dry_at(&self, x: f32, z: f32) -> f32 {
        let (i, j) = (((x * TX) as usize).min(DIM - 1), ((z * TX) as usize).min(DIM - 1));
        self.dry[j * DIM + i]
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn bare(_: f32, _: f32) -> (f32, f32) {
        (0.0, 0.0)
    }

    #[test]
    fn grass_grows_where_painted_and_mowing_takes_it_back() {
        let s = Stroke { brush: Brush::Grass, x: 5.0, z: 5.0, r: 1.0 };
        let d = Density::bake(&bare, &[s]);
        assert!(d.green_at(5.0, 5.0) > 0.6, "{}", d.green_at(5.0, 5.0));
        assert_eq!(d.green_at(9.0, 9.0), 0.0, "untouched ground stays bare");
        let m = Density::bake(&bare, &[s, Stroke { brush: Brush::Mow, x: 5.0, z: 5.0, r: 1.2 }]);
        assert!(m.green_at(5.0, 5.0) < 0.05, "mowed: {}", m.green_at(5.0, 5.0));
    }

    #[test]
    fn dry_turns_grass_to_straw_and_green_brings_it_back() {
        let lawn = |_: f32, _: f32| (0.8, 0.0);
        let d = Density::bake(&lawn, &[Stroke { brush: Brush::Dry, x: 3.0, z: 3.0, r: 0.8 }]);
        assert!(d.dry_at(3.0, 3.0) > 0.8 && d.green_at(3.0, 3.0) >= 0.8, "dry keeps the grass standing");
        let g = Density::bake(&lawn, &[Stroke { brush: Brush::Dry, x: 3.0, z: 3.0, r: 0.8 }, Stroke { brush: Brush::Grass, x: 3.0, z: 3.0, r: 0.8 }]);
        assert!(g.dry_at(3.0, 3.0) < 0.1);
    }

    #[test]
    fn the_natural_growth_is_the_base_and_the_bake_is_pure() {
        let nat = |x: f32, _: f32| (if x < 10.0 { 0.5 } else { 0.0 }, 0.2);
        let a = Density::bake(&nat, &[Stroke { brush: Brush::Grass, x: 12.0, z: 2.0, r: 0.6 }]);
        let b = Density::bake(&nat, &[Stroke { brush: Brush::Grass, x: 12.0, z: 2.0, r: 0.6 }]);
        assert_eq!(a.pack(), b.pack());
        assert_eq!(a.green_at(3.0, 3.0), 0.5);
        assert_eq!(a.pack().len(), DIM * DIM);
    }
}
