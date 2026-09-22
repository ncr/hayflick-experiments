//! Bake one face with every effect and write it as a PPM (no deps):
//! `cargo run -p surface --example preview -- out.ppm`
use surface::*;

fn main() {
    let path = std::env::args().nth(1).unwrap_or_else(|| "surface_preview.ppm".into());
    let spec = FaceSpec { len: 6.0, height: 3.2, tx_u: TX_ALONG_X, tx_v: TX_UP, seed: 11 };
    let strokes = [
        Stroke { effect: Effect::Rain, u: 1.0, v: 2.9, r: 0.45 },
        Stroke { effect: Effect::Rain, u: 1.5, v: 2.9, r: 0.45 },
        Stroke { effect: Effect::Spall, u: 3.0, v: 1.3, r: 0.5 },
        Stroke { effect: Effect::Soot, u: 4.9, v: 0.7, r: 0.4 },
    ];
    let f = Face::bake(spec, &strokes);
    let rgb = f.shade();
    let mut out = format!("P6 {} {} 255\n", f.w, f.h).into_bytes();
    for j in (0..f.h).rev() {
        for i in 0..f.w {
            // display: linear -> sRGB-ish gamma 2.2
            for c in rgb[j * f.w + i] {
                out.push((c.max(0.0).powf(1.0 / 2.2).min(1.0) * 255.0) as u8);
            }
        }
    }
    std::fs::write(&path, out).unwrap();
    println!("wrote {path} ({}x{})", f.w, f.h);
}
