//! Rasterize a row of trees and bushes in the game's trimetric projection,
//! flat-shaded, to a PPM (no deps): `cargo run -p flora --example preview -- out.ppm`
use flora::plant::{build, Kind, Tri};

fn main() {
    let path = std::env::args().nth(1).unwrap_or_else(|| "flora_preview.ppm".into());
    let (w, h) = (640usize, 300usize);
    let mut img = vec![[0.55f32, 0.52, 0.45]; w * h];
    let mut depth = vec![f32::MAX; w * h];
    // trimetric: +x -> (40, 10) px, +z -> (-20, 20) px, +y -> 38.73 px up
    let proj = |p: [f32; 3]| (40.0 * p[0] - 20.0 * p[2] + 40.0, 10.0 * p[0] + 20.0 * p[2] - 38.73 * p[1] + 170.0, p[0] + 2.0 * p[2] - p[1] * 0.1);
    let mut draw = |tris: &[Tri], col: [f32; 3]| {
        for t in tris {
            let e1 = [t[1][0] - t[0][0], t[1][1] - t[0][1], t[1][2] - t[0][2]];
            let e2 = [t[2][0] - t[0][0], t[2][1] - t[0][1], t[2][2] - t[0][2]];
            let n = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
            let l = (n[0] * n[0] + n[1] * n[1] + n[2] * n[2]).sqrt().max(1e-9);
            let lit = ((n[0] * 0.4 + n[1] * 0.8 + n[2] * 0.45) / l).abs() * 0.75 + 0.25;
            let p: Vec<(f32, f32, f32)> = t.iter().map(|&v| proj(v)).collect();
            let (x0, x1) = (p.iter().map(|q| q.0).fold(f32::MAX, f32::min).max(0.0) as usize, (p.iter().map(|q| q.0).fold(f32::MIN, f32::max) as usize + 1).min(w));
            let (y0, y1) = (p.iter().map(|q| q.1).fold(f32::MAX, f32::min).max(0.0) as usize, (p.iter().map(|q| q.1).fold(f32::MIN, f32::max) as usize + 1).min(h));
            for y in y0..y1 {
                for x in x0..x1 {
                    let (px, py) = (x as f32 + 0.5, y as f32 + 0.5);
                    let e = |a: (f32, f32, f32), b: (f32, f32, f32)| (b.0 - a.0) * (py - a.1) - (b.1 - a.1) * (px - a.0);
                    let (w0, w1, w2) = (e(p[1], p[2]), e(p[2], p[0]), e(p[0], p[1]));
                    if (w0 >= 0.0 && w1 >= 0.0 && w2 >= 0.0) || (w0 <= 0.0 && w1 <= 0.0 && w2 <= 0.0) {
                        let d = (p[0].2 + p[1].2 + p[2].2) / 3.0;
                        if -d < depth[y * w + x] {
                            depth[y * w + x] = -d;
                            img[y * w + x] = [col[0] * lit, col[1] * lit, col[2] * lit];
                        }
                    }
                }
            }
        }
    };
    for (i, (kind, dry)) in [(Kind::Tree, 0.0), (Kind::Tree, 0.0), (Kind::Tree, 0.3), (Kind::Tree, 0.0), (Kind::Bush, 0.0), (Kind::Bush, 0.9), (Kind::Tree, 1.0)].iter().enumerate() {
        let s = build(*kind, 1.0 + i as f32 * 2.1, 0.0, 1.0 - i as f32 * 0.35, 3 + i as u32 * 17, *dry);
        draw(&s.bark, [0.22, 0.18, 0.14]);
        draw(&s.leaf, [0.22, 0.32, 0.1]);
        draw(&s.dry, [0.5, 0.42, 0.22]);
    }
    let mut out = format!("P6 {w} {h} 255\n").into_bytes();
    for c in img {
        for v in c {
            out.push((v.clamp(0.0, 1.0) * 255.0) as u8);
        }
    }
    std::fs::write(&path, out).unwrap();
}
