//! Rasterize every prop kind (three seeds each) in the game's trimetric
//! projection, flat-shaded, to a PPM: `cargo run -p props --example preview -- out.ppm`
use props::{build, Kind, Mat, Tri};

fn main() {
    let path = std::env::args().nth(1).unwrap_or_else(|| "props_preview.ppm".into());
    let (w, h) = (1100usize, 640usize);
    let mut img = vec![[0.55f32, 0.52, 0.45]; w * h];
    let mut depth = vec![f32::MAX; w * h];
    // trimetric: +x -> (40, 10) px, +z -> (-20, 20) px, +y -> 38.73 px up
    let proj = |p: [f32; 3]| (40.0 * p[0] - 20.0 * p[2] + 160.0, 10.0 * p[0] + 20.0 * p[2] - 38.73 * p[1] + 170.0, p[0] + 2.0 * p[2] - p[1] * 0.1);
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
    for (i, kind) in Kind::ALL.iter().enumerate() {
        for s in 0..3u32 {
            let (x, z) = ((i % 5) as f32 * 5.0 + s as f32 * 0.0, (i / 5) as f32 * 7.0 + s as f32 * 2.2 - 1.0);
            let x = x + if matches!(kind, Kind::Car) { 0.0 } else { s as f32 * 0.4 };
            for (m, tris) in build(*kind, x, 0.0, z, 0.3, 11 + s * 7 + i as u32) {
                let col = match m {
                    Mat::Paint(c) => [c[0] * 2.0, c[1] * 2.0, c[2] * 2.0],
                    Mat::Rust => [0.42, 0.18, 0.08],
                    Mat::Steel => [0.35, 0.36, 0.36],
                    Mat::Rubber => [0.06, 0.06, 0.06],
                    Mat::Wood => [0.36, 0.26, 0.16],
                    Mat::Concrete => [0.55, 0.54, 0.5],
                    Mat::Glass => [0.08, 0.1, 0.12],
                };
                draw(&tris, col);
            }
        }
    }
    let mut out = format!("P6 {w} {h} 255\n").into_bytes();
    for c in img {
        for v in c {
            out.push((v.clamp(0.0, 1.0) * 255.0) as u8);
        }
    }
    std::fs::write(&path, out).unwrap();
}
