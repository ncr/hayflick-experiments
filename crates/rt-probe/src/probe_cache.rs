//! Disk cache for baked GI probe banks. The bake is a pure function of (probe
//! grid, geometry, materials, lights, env, ray budget), so a content hash of
//! those inputs keys the result: the interactive viewer loads it instead of
//! re-baking (~4.5 s for a medium cave on the M2's software RT).
//!
//! Only the INTERACTIVE windowed path uses this — headless capture (SHOT / DUMP
//! / DEMO / MOVIE / golden) always bakes fresh, so the "rendered frame is a pure
//! function of the scene" determinism guarantee is untouched. The backend gates
//! the cache on `window.is_some()`.
//!
//! Safety: the key is a fast non-crypto hash, so a collision only costs a
//! needless re-bake; and `load` re-checks the file length against the live probe
//! buffer before use. Bump [`VERSION`] on any change to the bake shaders, bounce
//! count, or probe layout so stale files miss.

use std::fs;
use std::path::PathBuf;

/// Bump on ANY change to the bake algorithm, bounce count, probe layout, or the
/// probe/shade shaders — old cache files then key differently and re-bake.
const VERSION: u64 = 2; // 2: probes.comp/.metal gained the firstProbe sub-range base (Stage-2)

/// Reinterpret a POD slice (`Vertex` / `Material` / `f32` / `u32` / `[f32;N]`)
/// as raw bytes, for feeding [`content_key`].
pub fn bytes_of<T: Copy>(s: &[T]) -> &[u8] {
    unsafe { std::slice::from_raw_parts(s.as_ptr() as *const u8, std::mem::size_of_val(s)) }
}

/// Content hash of the bake inputs → the cache filename. Word-wise FNV-style
/// mix; length-tagged per chunk so concatenations can't alias.
pub fn content_key(chunks: &[&[u8]]) -> u64 {
    const PRIME: u64 = 0x100_0000_01b3;
    let mut h = 0xcbf2_9ce4_8422_2325 ^ VERSION.wrapping_mul(0x9E37_79B9_7F4A_7C15);
    for c in chunks {
        h = (h ^ c.len() as u64).wrapping_mul(PRIME);
        let mut i = 0;
        while i + 8 <= c.len() {
            let w = u64::from_le_bytes(c[i..i + 8].try_into().unwrap());
            h = (h ^ w).wrapping_mul(PRIME);
            h ^= h >> 29;
            i += 8;
        }
        let mut tail = 0u64;
        for (k, &b) in c[i..].iter().enumerate() {
            tail |= (b as u64) << (k * 8);
        }
        h = (h ^ tail).wrapping_mul(PRIME);
    }
    h
}

/// The cache directory, or `None` if disabled. `PROBE_CACHE=0`/`off` disables;
/// `PROBE_CACHE=<dir>` overrides; default `<tmp>/rt-probe-cache`.
pub fn dir() -> Option<PathBuf> {
    match std::env::var("PROBE_CACHE") {
        Ok(v) if v == "0" || v.eq_ignore_ascii_case("off") => None,
        Ok(v) => Some(PathBuf::from(v)),
        Err(_) => Some(std::env::temp_dir().join("rt-probe-cache")),
    }
}

fn path(key: u64) -> Option<PathBuf> {
    dir().map(|d| d.join(format!("{key:016x}.probe")))
}

/// Load cached probe bytes for `key` iff present and exactly `expect_len` long.
pub fn load(key: u64, expect_len: usize) -> Option<Vec<u8>> {
    let bytes = fs::read(path(key)?).ok()?;
    (bytes.len() == expect_len).then_some(bytes)
}

/// Store probe bytes for `key` (best-effort; IO failures are non-fatal).
pub fn store(key: u64, bytes: &[u8]) {
    if let Some(p) = path(key) {
        if let Some(d) = p.parent() {
            fs::create_dir_all(d).ok();
        }
        fs::write(p, bytes).ok();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn key_is_stable_and_input_sensitive() {
        let a = content_key(&[bytes_of(&[1.0f32, 2.0, 3.0]), bytes_of(&[10u32, 20])]);
        let b = content_key(&[bytes_of(&[1.0f32, 2.0, 3.0]), bytes_of(&[10u32, 20])]);
        assert_eq!(a, b, "same inputs → same key");
        let c = content_key(&[bytes_of(&[1.0f32, 2.0, 3.5]), bytes_of(&[10u32, 20])]);
        assert!(a != c, "a changed float must change the key");
        // chunk boundaries matter (length-tagged): [ab],[c] != [a],[bc]
        let d = content_key(&[bytes_of(&[1u8, 2]), bytes_of(&[3u8])]);
        let e = content_key(&[bytes_of(&[1u8]), bytes_of(&[2u8, 3])]);
        assert!(d != e, "chunk split must change the key");
    }
}
