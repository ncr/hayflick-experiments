//! THE STRUCTURAL TWIN DIFF — "the two shaders ARE the same program".
//!
//! # Why this exists
//!
//! `crates/rt-probe/src/shaders/*.comp` (GLSL/Vulkan) and
//! `crates/rt-viewer/src/shaders_metal/*.metal` (MSL) are line-for-line twins,
//! and the project's whole workflow rests on that: one hardware session runs
//! one backend, so every round leaves the OTHER twin unverified. Until
//! 2026-07-28 the only guard was a fragment whitelist — a `contains()` scan of
//! ~23 remembered strings over ONE file at a time. It never compared the twins
//! to each other and it covered 2 of the 6 sources, so an edit to any line
//! nobody had thought to remember shipped a different image on the other
//! backend and passed every test. (Proven by mutation during the 2026-07-28
//! audit: four image-changing edits to `shade.metal` alone — the stain tint,
//! the glaze web's line width, the mud strength and the damage field's rise
//! term — each passed the full suite.)
//!
//! # What it does
//!
//! For each of the three pairs (shade, tonemap, probes) it reads both sources
//! at compile time, splits them into TOP-LEVEL ITEMS (functions, structs,
//! file-scope constants), normalizes each item's token stream through a fixed
//! GLSL↔MSL map, and asserts the two streams are EQUAL token for token. The
//! item set must match too, so a whole function appearing on one side only is
//! as loud as a changed constant.
//!
//! # The normalization, and why each step is not drift
//!
//! Every rule below erases a difference the two DIALECTS force; none of them
//! can erase a difference in the math or the control flow.
//!
//! - **Comments** are stripped (a commented-out gate is a deletion).
//! - **Types**: `vec3`/`float3`/`packed_float3` → one token, likewise vec2/4,
//!   ivec/int2-4, uvec/uint2-3.
//! - **Names**: MSL renames what MSL must (`sky`→`skyCol`, `hash`→`hashp`; the
//!   entry point is `main` in GLSL and the kernel's own name in MSL).
//! - **Numbers** are canonicalized by VALUE (`0x0Au` and `10`, `0.` and `0.0`,
//!   `1e9` and `1000000000` are one token), and integer/float suffixes drop.
//! - **Swizzles**: `.rgb`/`.a` and `.xyz`/`.w` are one spelling (only the pure
//!   rgba alphabet maps — `.t`, `.pos`, `.mat` are struct fields and untouched).
//! - **Single-argument vector/scalar constructors** are dropped on BOTH sides.
//!   MSL needs casts GLSL does not (`float3(v0.nrm)` off a `packed_float3`,
//!   `int(gid.x)` off a `uint2` thread id) and a splat is spelled the same on
//!   both sides, so dropping them is symmetric. THE ONE THING THIS COSTS: a
//!   cast added on one side only is invisible. Multi-argument constructors are
//!   compared normally.
//! - **Resource parameters**: MSL threads `accel`/`verts`/`indices`/`geoms`/
//!   `mats`/`lights`/`pd`/`pc`/the G-buffers through every call site where GLSL
//!   has globals. An argument (or parameter) whose last token names a resource
//!   is dropped, at declarations and call sites alike — so what gets compared
//!   is the arguments that carry MATH.
//! - **Storage access**: `imageLoad(colorImg, px)` and `outRadiance[idx]` both
//!   become `RAD[IDX]`; `imageStore(...)` / `buf[..] = ..` / `outTex.write(..)`
//!   become one assignment. The INDEX arithmetic differs by construction (a 2D
//!   image coordinate vs a flat buffer offset) and is elided with it, together
//!   with the integer temps that exist only to name it (`q`, `qa`, `qb`, `li`,
//!   `idx`).
//! - **Push-constant fields** are aliased to SEMANTIC names per side, because
//!   the two hosts pack them differently on purpose (shade.metal's `misc2` is
//!   not the Vulkan `ShadePush`'s `misc2` — see that file's header). A wrong
//!   alias would make the bodies mismatch, so the table cannot lie quietly.
//! - **Ray-cast setup** — `rayQueryEXT`/`rayQueryInitializeEXT`/the proceed
//!   loop against `ray`+`intersector`+`intersect` — has no common spelling and
//!   is elided. Its RESULT accessors are mapped to one spelling
//!   (`HIT_T`/`HIT_INST`/`HIT_PRIM`/`HIT_BARY`/`HIT_TYPE`/`HIT_NONE`), so
//!   everything the trace DOES with a hit is still compared. **What this
//!   costs**: the ray range and the two hard-coded masks inside `occluded` /
//!   `aoVis` (`0xFF`) and `probes` (`PROBE_MASK`) are not compared — every
//!   other mask rides a `trace(…)` argument and IS compared.
//! - **Dialect-local aliases**: a declaration that only names a value the twin
//!   spells inline (`ivec2 px = …` in GLSL where MSL takes `gid` as a kernel
//!   parameter; `uint idx`, `int lowW/lowH`, `uint frame` in MSL) is dropped
//!   and its uses expanded, so the two read the same.
//!
//! # The allowlist
//!
//! [`ALLOW`] is what is left: named, contiguous token rewrites for genuine
//! formatting divergence. Each states WHY it is not drift and MUST fire
//! exactly the stated number of times — an entry that stops matching fails the
//! test, so the list cannot rot into a whitelist that quietly waves things
//! through.
//!
//! # What this test does NOT cover
//!
//! The resource-declaration preamble: `#version`/`#include`, `layout(...)`
//! bindings, the `Push`/`ProbePush` structs. Those ARE the dialect (a Vulkan
//! descriptor set against Metal buffer indices) and there is nothing to
//! compare; the push blocks' field SEMANTICS are pinned by the alias table
//! above instead. Nor does it see a host/shader disagreement — that is the
//! job of the fragment guards that name a host value (`crate::flags`).
//!
//! # Home
//!
//! This module lived inside `wear.rs` (the wear pipeline's material codec)
//! until 2026-09-22, when the wear/crack pipeline was deleted; the twin diff
//! is the part of it that outlives the pipeline, so it moved here with the
//! two backend-agreement guards that were not about wear.

use std::collections::BTreeMap;

/// The two shade twins' SOURCES, read at compile time. Shared by every
/// source-level guard (this module's and `crate::flags`' flag-value check) so
/// a new guard cannot quietly check only one backend.
pub fn twin_sources() -> [(&'static str, &'static str); 2] {
    [("shade.comp", include_str!("../../rt-probe/src/shaders/shade.comp")), ("shade.metal", include_str!("shaders_metal/shade.metal"))]
}

/// ALL THREE shader pairs' sources, read at compile time — the input to
/// [`twins_are_structurally_identical`]. [`twin_sources`] is the shade pair
/// alone, kept for the fragment guards that are about that one file.
pub fn twin_pairs() -> [(&'static str, &'static str, &'static str); 3] {
    [
        ("shade", include_str!("../../rt-probe/src/shaders/shade.comp"), include_str!("shaders_metal/shade.metal")),
        ("tonemap", include_str!("../../rt-probe/src/shaders/tonemap.comp"), include_str!("shaders_metal/tonemap.metal")),
        ("probes", include_str!("../../rt-probe/src/shaders/probes.comp"), include_str!("shaders_metal/probes.metal")),
    ]
}

/// A shader source's lines with COMMENTS DROPPED. "comment the blind twin out
/// while bisecting on the spawner, forget to restore" is the single likeliest
/// way a guarded line dies on one backend.
pub fn code_lines(src: &str) -> Vec<&str> {
    src.lines().filter(|l| !l.trim_start().starts_with("//")).collect()
}

/// The fog integrator is compared as one executable block (whitespace and the
/// MSL resource parameter aside): the air is a primary-ray effect both
/// backends must integrate identically.
#[test]
fn atmosphere_transport_matches_between_backends() {
    let bodies: Vec<String> = twin_sources()
        .iter()
        .map(|(_, source)| {
            let start = source.find("if (pc.env0.z > 0.0)").unwrap();
            let tail = &source[start..];
            let end = tail.find("\n\n").unwrap();
            code_lines(&tail[..end]).join("\n").replace("float3", "vec3").replace("float2", "vec2").replace(", accel", "").split_whitespace().collect::<String>()
        })
        .collect();
    assert_eq!(bodies[0], bodies[1], "Metal and GLSL must integrate the same air");
}

/// The world-anchored surface materials (survivor, painted atlas, meadow) are
/// compared as one executable block: changing a frequency, mask or filter in
/// just one twin fails.
#[test]
fn procedural_surface_math_matches_between_backends() {
    let twins = twin_sources();
    let normalized = |src: &str, start: &str, end: &str| {
        let block = src.split_once(start).expect(start).1.split_once(end).expect(end).0;
        block.lines().map(|l| l.split("//").next().unwrap_or("")).collect::<String>().replace("float3", "vec3").replace("float2", "vec2").split_whitespace().collect::<String>()
    };
    let (start, end) = ("// SURFACE MATERIALS:", "bool greybox =");
    assert_eq!(normalized(twins[0].1, start, end), normalized(twins[1].1, start, end), "surface twins diverged at {start}");
}
// ---- lexing --------------------------------------------------------------

fn strip_comments(src: &str) -> String {
    let mut out = String::with_capacity(src.len());
    let mut it = src.chars().peekable();
    while let Some(c) = it.next() {
        if c == '/' {
            match it.peek() {
                Some('/') => {
                    for c in it.by_ref() {
                        if c == '\n' {
                            out.push('\n');
                            break;
                        }
                    }
                    continue;
                }
                Some('*') => {
                    it.next();
                    let mut prev = ' ';
                    for c in it.by_ref() {
                        if prev == '*' && c == '/' {
                            break;
                        }
                        prev = c;
                    }
                    out.push(' ');
                    continue;
                }
                _ => {}
            }
        }
        out.push(c);
    }
    out
}

const OPS: &[&str] = &[
    "<<=", ">>=", "::", "<<", ">>", "<=", ">=", "==", "!=", "&&", "||", "++", "--", "+=", "-=", "*=", "/=", "%=", "&=", "|=", "^=",
];

fn tokenize(src: &str) -> Vec<String> {
    let c: Vec<char> = src.chars().collect();
    let mut out = Vec::new();
    let mut i = 0;
    while i < c.len() {
        let ch = c[i];
        if ch.is_whitespace() {
            i += 1;
            continue;
        }
        if ch.is_ascii_digit() || (ch == '.' && c.get(i + 1).is_some_and(|d| d.is_ascii_digit())) {
            let s = i;
            if ch == '0' && matches!(c.get(i + 1), Some('x') | Some('X')) {
                i += 2;
                while c.get(i).is_some_and(|d| d.is_ascii_hexdigit()) {
                    i += 1;
                }
            } else {
                while c.get(i).is_some_and(|d| d.is_ascii_digit()) {
                    i += 1;
                }
                if c.get(i) == Some(&'.') {
                    i += 1;
                    while c.get(i).is_some_and(|d| d.is_ascii_digit()) {
                        i += 1;
                    }
                }
                if matches!(c.get(i), Some('e') | Some('E')) {
                    let mut j = i + 1;
                    if matches!(c.get(j), Some('+') | Some('-')) {
                        j += 1;
                    }
                    if c.get(j).is_some_and(|d| d.is_ascii_digit()) {
                        i = j;
                        while c.get(i).is_some_and(|d| d.is_ascii_digit()) {
                            i += 1;
                        }
                    }
                }
            }
            while matches!(c.get(i), Some('u') | Some('U') | Some('f') | Some('F')) {
                i += 1;
            }
            out.push(c[s..i].iter().collect());
            continue;
        }
        if ch.is_ascii_alphabetic() || ch == '_' {
            let s = i;
            while c.get(i).is_some_and(|d| d.is_ascii_alphanumeric() || *d == '_') {
                i += 1;
            }
            out.push(c[s..i].iter().collect());
            continue;
        }
        let rest: String = c[i..(i + 3).min(c.len())].iter().collect();
        match OPS.iter().find(|op| rest.starts_with(**op)) {
            Some(op) => {
                out.push((*op).to_string());
                i += op.len();
            }
            None => {
                out.push(ch.to_string());
                i += 1;
            }
        }
    }
    out
}

/// Canonicalize a numeric literal BY VALUE, so `0x0Au` and `10`, or `0.`
/// and `0.0`, are one token. Hex is decoded before the suffix strip — a
/// trailing `f` in `0xFF` is a DIGIT, not a float suffix.
fn numnorm(t: &str) -> String {
    let low = t.to_ascii_lowercase();
    if let Some(rest) = low.strip_prefix("0x") {
        if let Ok(v) = u64::from_str_radix(rest.trim_end_matches('u'), 16) {
            return v.to_string();
        }
    }
    let s = low.trim_end_matches(['u', 'f']);
    if let Ok(v) = s.parse::<f64>() {
        if v.fract() == 0.0 && v.abs() < 1e15 {
            return format!("{}", v as i64);
        }
        return format!("{v:?}");
    }
    t.to_string()
}

fn is_ident(t: &str) -> bool {
    t.as_bytes().first().is_some_and(|c| c.is_ascii_alphabetic() || *c == b'_')
}
fn is_num(t: &str) -> bool {
    t.as_bytes().first().is_some_and(|c| c.is_ascii_digit() || *c == b'.')
}

// ---- token-stream helpers -------------------------------------------------

/// `t[lp]` is `(`. Returns the comma-separated argument groups (outer parens
/// stripped) and the index just past the matching `)`.
fn split_call(t: &[String], lp: usize) -> (Vec<Vec<String>>, usize) {
    let (mut args, mut cur, mut d, mut k) = (Vec::new(), Vec::new(), 0i32, lp);
    while k < t.len() {
        let x = t[k].as_str();
        if matches!(x, "(" | "[" | "{") {
            d += 1;
        } else if matches!(x, ")" | "]" | "}") {
            d -= 1;
            if d == 0 {
                args.push(cur);
                return (args, k + 1);
            }
        }
        if d == 1 && x == "," {
            args.push(std::mem::take(&mut cur));
        } else if !(d == 1 && x == "(" && k == lp) {
            cur.push(t[k].clone());
        }
        k += 1;
    }
    args.push(cur);
    (args, k)
}

fn seq_replace(t: &[String], from: &[&str], to: &[&str]) -> (Vec<String>, usize) {
    let (mut o, mut k, mut n) = (Vec::new(), 0usize, 0usize);
    while k < t.len() {
        if t[k..].len() >= from.len() && t[k..k + from.len()].iter().zip(from).all(|(a, b)| a == b) {
            o.extend(to.iter().map(|s| (*s).to_string()));
            k += from.len();
            n += 1;
        } else {
            o.push(t[k].clone());
            k += 1;
        }
    }
    (o, n)
}

/// Split a run into statements: each ends at a `;` or a `}` seen at depth 0.
fn statements(t: &[String]) -> Vec<Vec<String>> {
    let (mut out, mut cur, mut d) = (Vec::new(), Vec::new(), 0i32);
    for x in t {
        cur.push(x.clone());
        match x.as_str() {
            "(" | "[" | "{" => d += 1,
            ")" | "]" | "}" => d -= 1,
            _ => {}
        }
        if (x == ";" || x == "}") && d == 0 {
            out.push(std::mem::take(&mut cur));
        }
    }
    if !cur.is_empty() {
        out.push(cur);
    }
    out
}

/// Walk the statement tree, dropping every statement `drop` accepts and
/// recursing into the body of every one it does not.
fn map_stmts(t: &[String], drop: &dyn Fn(&[String]) -> bool) -> Vec<String> {
    let mut o = Vec::new();
    for s in statements(t) {
        if drop(&s) {
            continue;
        }
        match s.iter().position(|x| x == "{") {
            Some(i) => {
                let (mut d, mut j) = (0i32, i);
                while j < s.len() {
                    match s[j].as_str() {
                        "{" => d += 1,
                        "}" => {
                            d -= 1;
                            if d == 0 {
                                break;
                            }
                        }
                        _ => {}
                    }
                    j += 1;
                }
                o.extend_from_slice(&s[..=i]);
                o.extend(map_stmts(&s[i + 1..j], drop));
                o.extend_from_slice(&s[j..]);
            }
            None => o.extend_from_slice(&s),
        }
    }
    o
}

// ---- top-level items ------------------------------------------------------

type Key = (&'static str, String);

/// Split a source into top-level items keyed by kind + name. `layout(...)`
/// blocks, `#`-lines and `using namespace` are the resource preamble and are
/// not items (see the module doc).
fn items(toks: &[String]) -> BTreeMap<Key, Vec<String>> {
    let mut out = BTreeMap::new();
    let (mut i, n) = (0usize, toks.len());
    while i < n {
        let start = i;
        while i < n {
            if toks[i] == "{" {
                i += 1;
                let mut d = 1;
                while i < n && d > 0 {
                    match toks[i].as_str() {
                        "{" => d += 1,
                        "}" => d -= 1,
                        _ => {}
                    }
                    i += 1;
                }
                if toks.get(i).map(String::as_str) == Some(";") {
                    i += 1;
                }
                break;
            }
            if toks[i] == ";" {
                i += 1;
                break;
            }
            i += 1;
        }
        let stmt = &toks[start..i];
        if stmt.is_empty() {
            break;
        }
        let head: Vec<&str> = stmt.iter().map(String::as_str).filter(|x| !matches!(*x, "static" | "inline")).collect();
        match head.first().copied() {
            None | Some("layout") | Some("using") | Some("precision") => {}
            Some("struct") => {
                out.insert(("struct", head[1].to_string()), stmt.to_vec());
            }
            Some("const") | Some("constant") => {
                out.insert(("const", head[2].to_string()), stmt.to_vec());
            }
            _ => {
                if let (Some(p), true) = (head.iter().position(|x| *x == "("), head.contains(&"{")) {
                    out.insert(("fn", head[p - 1].to_string()), stmt.to_vec());
                }
            }
        }
    }
    out
}

// ---- normalization tables -------------------------------------------------

const TYPES: &[(&str, &str)] = &[
    ("vec2", "f2"),
    ("float2", "f2"),
    ("vec3", "f3"),
    ("float3", "f3"),
    ("packed_float3", "f3"),
    ("vec4", "f4"),
    ("float4", "f4"),
    ("ivec2", "i2"),
    ("int2", "i2"),
    ("ivec3", "i3"),
    ("int3", "i3"),
    ("ivec4", "i4"),
    ("int4", "i4"),
    ("uvec2", "u2"),
    ("uint2", "u2"),
    ("uvec3", "u3"),
    ("uint3", "u3"),
    ("mat3", "m3"),
    ("float3x3", "m3"),
];
const NAMES: &[(&str, &str)] =
    &[("skyCol", "sky"), ("hashp", "hash"), ("shade", "main"), ("tonemap", "main"), ("bake_probes", "main"), ("constant", "const"), ("lerp_", "lp")];
/// File-scope constants MSL hoists that GLSL spells as literals.
const EXPAND_CONST: &[(&str, &[&str])] = &[("PI", &["3.14159265"]), ("TWOPI", &["6.2831853"]), ("TIE", &["1.0", "/", "64.0"])];
const SWIZ: &[(&str, &str)] = &[("r", "x"), ("g", "y"), ("b", "z"), ("a", "w"), ("rg", "xy"), ("rgb", "xyz"), ("rgba", "xyzw")];
const CASTS: &[&str] = &["f2", "f3", "f4", "i2", "i3", "i4", "u2", "u3", "float", "int", "uint"];
const INT_TYPES: &[&str] = &["i2", "i3", "i4", "u2", "u3", "int", "uint"];
/// Names whose only role is addressing a buffer or image.
const INDEX_TEMPS: &[&str] = &["q", "qa", "qb", "li", "idx"];
const KEYWORDS: &[&str] = &["if", "for", "while", "return", "switch", "do", "else"];
const DROP_QUALIFIERS: &[&str] = &["static", "inline", "readonly", "device", "thread", "out", "inout", "kernel", "precise"];

/// Statements that set a ray query up — no common spelling between
/// `rayQueryEXT` and `intersector<>`, so they are elided (module doc).
const SETUP_STARTERS: &[&str] = &["rayQueryEXT", "rayQueryInitializeEXT", "intersector", "intersection_result", "ray", "isect", "rayQueryProceedEXT"];
/// …and the hit ACCESSORS, mapped to one spelling so everything the trace
/// DOES with a hit is still compared.
const ACCESSORS: &[(&[&str], &str)] = &[
    (&["rayQueryGetIntersectionTypeEXT", "(", "rq", ",", "true", ")"], "HIT_TYPE"),
    (&["it", ".", "type"], "HIT_TYPE"),
    (&["gl_RayQueryCommittedIntersectionNoneEXT"], "HIT_NONE"),
    (&["intersection_type", "::", "none"], "HIT_NONE"),
    (&["rayQueryGetIntersectionTEXT", "(", "rq", ",", "true", ")"], "HIT_T"),
    (&["it", ".", "distance"], "HIT_T"),
    (&["rayQueryGetIntersectionInstanceCustomIndexEXT", "(", "rq", ",", "true", ")"], "HIT_INST"),
    (&["it", ".", "instance_id"], "HIT_INST"),
    (&["rayQueryGetIntersectionPrimitiveIndexEXT", "(", "rq", ",", "true", ")"], "HIT_PRIM"),
    (&["it", ".", "primitive_id"], "HIT_PRIM"),
    (&["rayQueryGetIntersectionBarycentricsEXT", "(", "rq", ",", "true", ")"], "HIT_BARY"),
    (&["it", ".", "triangle_barycentric_coord"], "HIT_BARY"),
    // the hit instance's world-to-object transform (2026-09-05: articulated
    // dynamic runs shade with their own rotation). TYPES has already
    // mapped `mat3`/`float3x3` to `m3` when these run.
    (&["m3", "(", "rayQueryGetIntersectionWorldToObjectEXT", "(", "rq", ",", "true", ")", ")"], "HIT_W2O"),
    (
        &[
            "m3", "(", "it", ".", "world_to_object_transform", "[", "0", "]", ",", "it", ".", "world_to_object_transform", "[", "1", "]", ",", "it", ".",
            "world_to_object_transform", "[", "2", "]", ")",
        ],
        "HIT_W2O",
    ),
];

/// Per-pair resource names: an argument or parameter whose last token is one
/// of these is dropped (MSL threads them; GLSL has globals). `px`/`gid`/
/// `idx` are here too — they are this thread's texel address, spelled as a
/// 2D image coordinate on one side and a flat buffer offset on the other.
fn resources(pair: &str) -> &'static [&'static str] {
    match pair {
        "shade" => &["accel", "verts", "indices", "geoms", "mats", "lights", "pd", "pc", "outRadiance", "outAlbedo", "outPos", "tlas", "px", "idx", "gid"],
        "tonemap" => &["pc", "colorBuf", "albedoBuf", "posBuf", "outTex", "frame", "colorImg", "albedoImg", "posImg", "outImg", "gid"],
        _ => &["accel", "verts", "indices", "geoms", "mats", "lights", "pd", "pc", "tlas", "gid"],
    }
}
/// Storage objects → the one channel name both dialects reduce to.
fn storage(pair: &str) -> &'static [(&'static str, &'static str)] {
    match pair {
        "shade" => &[
            ("colorImg", "RAD"),
            ("albedoImg", "ALB"),
            ("posImg", "POS"),
            ("outRadiance", "RAD"),
            ("outAlbedo", "ALB"),
            ("outPos", "POS"),
        ],
        "tonemap" => &[
            ("colorImg", "RAD"),
            ("albedoImg", "ALB"),
            ("posImg", "POS"),
            ("outImg", "OUT"),
            ("colorBuf", "RAD"),
            ("albedoBuf", "ALB"),
            ("posBuf", "POS"),
            ("outTex", "OUT"),
        ],
        _ => &[],
    }
}
/// Push-constant fields → SEMANTIC names. The two hosts pack `misc2`/`misc3`
/// differently on purpose (shade.metal's header says so), so without this
/// every push read would read as drift — and a WRONG entry here makes the
/// bodies mismatch, so the table cannot lie quietly.
fn pc_alias(pair: &str, msl: bool) -> &'static [(&'static str, &'static str, &'static str)] {
    match (pair, msl) {
        ("shade", false) => &[
            ("misc2", "x", "roomLights"),
            ("misc2", "y", "lightCount"),
            ("misc2", "z", "reflBlock"),
            ("misc2", "w", "floorCutY"),
            ("misc3", "x", "wallCutY"),
            ("misc3", "y", "levelW"),
            ("misc3", "z", "levelH"),
        ],
        ("shade", true) => &[
            ("misc2", "x", "lightCount"),
            ("misc2", "y", "roomLights"),
            ("misc2", "z", "reflBlock"),
            ("misc3", "x", "floorCutY"),
            ("misc3", "y", "wallCutY"),
            ("misc3", "z", "levelW"),
            ("misc3", "w", "levelH"),
        ],
        _ => &[],
    }
}
/// Declarations that only give a dialect-local NAME to something the twin
/// spells inline; dropped, and their uses expanded by [`alias_expand`].
fn alias_decls(pair: &str, msl: bool) -> &'static [&'static str] {
    match (pair, msl) {
        ("shade", false) => &["px", "TIE"],
        ("shade", true) => &["idx"],
        ("tonemap", true) => &["lowW", "lowH", "frame", "li"],
        ("probes", false) => &["gid"],
        _ => &[],
    }
}
fn alias_expand(pair: &str, msl: bool) -> &'static [(&'static str, &'static [&'static str])] {
    match (pair, msl) {
        ("shade", true) => &[("gid", &["px"])],
        ("tonemap", true) => &[
            ("lowW", &["pc", ".", "dims", ".", "x"]),
            ("lowH", &["pc", ".", "dims", ".", "y"]),
            ("frame", &["pc", ".", "fcfg", ".", "z"]),
            ("gid", &["gl_GlobalInvocationID", ".", "xy"]),
        ],
        _ => &[],
    }
}

/// A NAMED formatting divergence. `count` is how many times it must fire —
/// an entry that stops matching FAILS, so this list cannot rot into a
/// whitelist that quietly waves new differences through.
struct Allow {
    pair: &'static str,
    item: &'static str,
    msl: bool,
    from: &'static [&'static str],
    to: &'static [&'static str],
    count: usize,
    /// why this is dialect formatting and not a difference in behaviour —
    /// printed when the entry stops matching, because "this rule no longer
    /// applies" is only actionable next to the reason it was written
    why: &'static str,
}

const ALLOW: &[Allow] = &[
    Allow {
        pair: "*",
        item: "sky",
        msl: true,
        from: &["f3", "c", "=", "(", "d", ".", "y", ">", "0", ")"],
        to: &["return", "(", "d", ".", "y", ">", "0"],
        count: 1,
        why: "MSL binds the sky ternary to a temp; the GLSL twin returns it inline. Same expression, same operands.",
    },
    Allow {
        pair: "*",
        item: "sky",
        msl: true,
        from: &[";", "return", "c", "*"],
        to: &[")", "*"],
        count: 1,
        why: "…the close of that same inline return.",
    },
    Allow {
        pair: "shade",
        item: "rtAO",
        msl: true,
        from: &["rr"],
        to: &["r"],
        count: 3,
        why: "the cosine-hemisphere radius is `r` in GLSL and `rr` in MSL (where `r` is the ray). A local name.",
    },
    Allow {
        pair: "shade",
        item: "main",
        msl: false,
        from: &["f3", "col", ";"],
        to: &[],
        count: 1,
        why: "`col` is declared before the fog block in GLSL and after it in MSL; neither side reads it before assigning it.",
    },
    Allow {
        pair: "shade",
        item: "main",
        msl: true,
        from: &["f3", "col", ";"],
        to: &[],
        count: 1,
        why: "(the same declaration, the other side of the fog block)",
    },
    Allow {
        pair: "shade",
        item: "probeE",
        msl: true,
        from: &["if", "(", "dims", ".", "x", "<", "1", "||", "dims", ".", "y", "<", "1", "||", "dims", ".", "z", "<", "1", ")", "return", "0", ";"],
        to: &[],
        count: 1,
        why: "MSL-ONLY M1 bring-up guard: a dummy probe header (dims 0) returns black. \
               Inert on any real bank — every shipped path binds a baked grid — and the last \
               sibling of the `hasProbes` gate deleted 2026-07-28. Reported, not deleted: this \
               box cannot compile MSL, and the round's bar is a byte-identical image.",
    },
    Allow {
        pair: "tonemap",
        item: "main",
        msl: false,
        from: &["pc", ".", "dims", ".", "zw"],
        to: &["f2", "(", "pc", ".", "dims", ".", "z", ",", "pc", ".", "dims", ".", "w", ")"],
        count: 1,
        why: "the vignette's visible-crop size: GLSL takes the .zw swizzle, MSL's int4 has no two-component swizzle.",
    },
    Allow {
        pair: "tonemap",
        item: "main",
        msl: false,
        from: &["uint", "fr", "=", "pc", ".", "fcfg", ".", "z", ";"],
        to: &[],
        count: 1,
        why: "GLSL names the frame index `fr` inside the analog-noise block; MSL already has it as the kernel-wide `frame`.",
    },
    Allow {
        pair: "tonemap",
        item: "main",
        msl: false,
        from: &["fr", "*", "31337"],
        to: &["pc", ".", "fcfg", ".", "z", "*", "31337"],
        count: 1,
        why: "(that name's luma-noise use)",
    },
    Allow {
        pair: "tonemap",
        item: "main",
        msl: false,
        from: &["fr", "*", "48611"],
        to: &["pc", ".", "fcfg", ".", "z", "*", "48611"],
        count: 1,
        why: "(and its chroma-noise use)",
    },
];

/// Top-level items that legitimately exist on ONE side. Everything here is
/// the resource preamble or a constant the other dialect spells as a
/// literal (see [`EXPAND_CONST`]).
const EXPECT_ONLY_MSL: &[(&str, &str, &str)] = &[
    ("shade", "struct", "Push"),
    ("shade", "const", "PI"),
    ("shade", "const", "TWOPI"),
    ("shade", "const", "TIE"),
    ("tonemap", "struct", "Push"),
    ("probes", "struct", "ProbePush"),
    ("probes", "const", "PI"),
    ("probes", "const", "TWOPI"),
];

// ---- the normalizer -------------------------------------------------------

fn lookup<'a>(table: &'a [(&'a str, &'a str)], k: &str) -> Option<&'a str> {
    table.iter().find(|(a, _)| *a == k).map(|(_, b)| *b)
}

fn storage_norm(t: &[String], store: &[(&str, &str)], msl: bool) -> Vec<String> {
    let (mut o, mut k) = (Vec::new(), 0usize);
    fn push(o: &mut Vec<String>, s: &[&str]) {
        o.extend(s.iter().map(|x| (*x).to_string()));
    }
    while k < t.len() {
        let x = t[k].as_str();
        if !msl && matches!(x, "imageLoad" | "imageStore") && t.get(k + 1).map(String::as_str) == Some("(") {
            let (args, nk) = split_call(t, k + 1);
            let name = lookup(store, args[0][0].as_str()).unwrap_or(args[0][0].as_str()).to_string();
            o.push(name);
            push(&mut o, &["[", "IDX", "]"]);
            if x == "imageStore" {
                o.push("=".to_string());
                o.extend(args[2].iter().cloned());
            }
            k = nk;
            continue;
        }
        if msl && x == "outTex" && t.get(k + 1).map(String::as_str) == Some(".") && t.get(k + 2).map(String::as_str) == Some("write") {
            let (args, nk) = split_call(t, k + 3);
            push(&mut o, &["OUT", "[", "IDX", "]", "="]);
            o.extend(args[0].iter().cloned());
            k = nk;
            continue;
        }
        if let (Some(chan), Some("[")) = (lookup(store, x), t.get(k + 1).map(String::as_str)) {
            let (mut d, mut j) = (0i32, k + 1);
            while j < t.len() {
                match t[j].as_str() {
                    "[" => d += 1,
                    "]" => {
                        d -= 1;
                        if d == 0 {
                            break;
                        }
                    }
                    _ => {}
                }
                j += 1;
            }
            o.push(chan.to_string());
            push(&mut o, &["[", "IDX", "]"]);
            k = j + 1;
            continue;
        }
        o.push(t[k].clone());
        k += 1;
    }
    o
}

fn drop_res_groups(t: &[String], res: &[&str]) -> Vec<String> {
    let (mut o, mut k) = (Vec::<String>::new(), 0usize);
    while k < t.len() {
        let is_call = t[k] == "(" && o.last().is_some_and(|p| is_ident(p) && !KEYWORDS.contains(&p.as_str()));
        if is_call {
            let (args, nk) = split_call(t, k);
            o.push("(".to_string());
            let mut first = true;
            for a in args.iter().filter(|a| !a.last().is_some_and(|l| res.contains(&l.as_str()))) {
                if !first {
                    o.push(",".to_string());
                }
                first = false;
                o.extend(drop_res_groups(a, res));
            }
            o.push(")".to_string());
            k = nk;
            continue;
        }
        o.push(t[k].clone());
        k += 1;
    }
    o
}

/// GLSL's `TYPE[N](a, b, …)` array constructor → MSL's `{a, b, …}` (whose
/// trailing comma also goes).
fn array_ctor(t: &[String]) -> Vec<String> {
    let (mut o, mut k) = (Vec::new(), 0usize);
    while k < t.len() {
        let ctor = CASTS.contains(&t[k].as_str())
            && t.get(k + 1).map(String::as_str) == Some("[")
            && t.get(k + 3).map(String::as_str) == Some("]")
            && t.get(k + 4).map(String::as_str) == Some("(");
        if ctor {
            let (args, nk) = split_call(t, k + 4);
            o.push("{".to_string());
            for (j, a) in args.iter().enumerate() {
                if j > 0 {
                    o.push(",".to_string());
                }
                o.extend(a.iter().cloned());
            }
            o.push("}".to_string());
            k = nk;
            continue;
        }
        if t[k] == "," && t.get(k + 1).map(String::as_str) == Some("}") {
            k += 1;
            continue;
        }
        o.push(t[k].clone());
        k += 1;
    }
    o
}

/// A single-argument vector/scalar constructor is a CAST or a SPLAT; both
/// sides lose them (module doc: MSL needs casts GLSL does not).
fn drop_casts(t: &[String]) -> Vec<String> {
    let (mut o, mut k) = (Vec::new(), 0usize);
    while k < t.len() {
        if CASTS.contains(&t[k].as_str()) && t.get(k + 1).map(String::as_str) == Some("(") {
            let (args, nk) = split_call(t, k + 1);
            if args.len() == 1 {
                o.extend(drop_casts(&args[0]));
                k = nk;
                continue;
            }
        }
        o.push(t[k].clone());
        k += 1;
    }
    o
}

fn normalize(stmt: &[String], msl: bool, pair: &str, item: &str, misfires: &mut Vec<String>) -> Vec<String> {
    let mut t = stmt.to_vec();

    // the ENTRY POINT's parameter list IS the resource binding — nothing to compare
    if item == "main" {
        if let Some(p) = t.iter().position(|x| x == "(") {
            let (_, nk) = split_call(&t, p);
            let mut n: Vec<String> = t[..p].to_vec();
            n.push("(".into());
            n.push(")".into());
            n.extend_from_slice(&t[nk..]);
            t = n;
        }
    }
    t.retain(|x| !DROP_QUALIFIERS.contains(&x.as_str()));
    t = t
        .iter()
        .map(|x| lookup(TYPES, x).or_else(|| lookup(NAMES, x)).unwrap_or(x.as_str()).to_string())
        .collect();

    // `[[attribute]]`
    let (mut o, mut k) = (Vec::new(), 0usize);
    while k < t.len() {
        if t[k] == "[" && t.get(k + 1).map(String::as_str) == Some("[") {
            let mut d = 0i32;
            while k < t.len() {
                match t[k].as_str() {
                    "[" => d += 1,
                    "]" => d -= 1,
                    _ => {}
                }
                k += 1;
                if d == 0 {
                    break;
                }
            }
            continue;
        }
        o.push(t[k].clone());
        k += 1;
    }
    t = o;

    // MSL template argument lists
    let (mut o, mut k) = (Vec::new(), 0usize);
    while k < t.len() {
        if t[k] == "<" && k > 0 && matches!(t[k - 1].as_str(), "intersector" | "intersection_result") {
            while k < t.len() && t[k] != ">" {
                k += 1;
            }
            k += 1;
            continue;
        }
        o.push(t[k].clone());
        k += 1;
    }
    t = o;

    // reference declarators: `Hit& h` reads as GLSL's `out Hit h`. (No
    // expression in these sources has `ident & ident`, so this cannot eat a
    // bitwise AND — every one of them has a literal or a `)` on a side.)
    let (mut o, mut k) = (Vec::new(), 0usize);
    while k < t.len() {
        if t[k] == "&" && k > 0 && is_ident(&t[k - 1]) && t.get(k + 1).is_some_and(|n| is_ident(n)) {
            k += 1;
            continue;
        }
        o.push(t[k].clone());
        k += 1;
    }
    t = o;

    // ray-cast plumbing: collapse the MSL intersect call, elide the setup,
    // then map the hit accessors to one spelling
    let (mut o, mut k) = (Vec::new(), 0usize);
    while k < t.len() {
        if t[k] == "isect" && t.get(k + 1).map(String::as_str) == Some(".") && t.get(k + 2).map(String::as_str) == Some("intersect") {
            let (_, nk) = split_call(&t, k + 3);
            o.push("it".to_string());
            k = nk;
            continue;
        }
        o.push(t[k].clone());
        k += 1;
    }
    t = map_stmts(&o, &|s: &[String]| {
        let head = s[0].as_str();
        SETUP_STARTERS.contains(&head)
            || (head == "r" && s.get(1).map(String::as_str) == Some("."))
            || (head == "while" && s.iter().any(|x| x == "rayQueryProceedEXT"))
    });
    for (from, to) in ACCESSORS {
        t = seq_replace(&t, from, &[to]).0;
    }

    // dialect-local alias declarations, then storage access + its index temps
    let names = alias_decls(pair, msl);
    t = map_stmts(&t, &|s: &[String]| {
        let toks: Vec<&str> = s.iter().map(String::as_str).filter(|x| !matches!(*x, "const" | "constant")).collect();
        toks.len() >= 3 && is_ident(toks[0]) && names.contains(&toks[1]) && toks[2] == "="
    });
    t = storage_norm(&t, storage(pair), msl);
    t = map_stmts(&t, &|s: &[String]| {
        s.len() >= 3 && INT_TYPES.contains(&s[0].as_str()) && INDEX_TEMPS.contains(&s[1].as_str()) && s[2] == "="
    });

    // numbers, swizzles, hoisted constants
    t = t.iter().map(|x| if is_num(x) { numnorm(x) } else { x.clone() }).collect();
    let swz: Vec<String> = t
        .iter()
        .enumerate()
        .map(|(i, x)| match (i > 0 && t[i - 1] == ".", lookup(SWIZ, x)) {
            (true, Some(s)) => s.to_string(),
            _ => x.clone(),
        })
        .collect();
    t = swz;
    let mut o = Vec::new();
    for x in &t {
        match EXPAND_CONST.iter().find(|(n, _)| n == x) {
            Some((_, e)) => o.extend(e.iter().map(|s| (*s).to_string())),
            None => o.push(x.clone()),
        }
    }
    t = o;

    // push-constant field semantics
    let pca = pc_alias(pair, msl);
    let (mut o, mut k) = (Vec::new(), 0usize);
    while k < t.len() {
        let sem = if t[k] == "pc" && t.get(k + 1).map(String::as_str) == Some(".") && t.get(k + 3).map(String::as_str) == Some(".") && t.len() > k + 4 {
            pca.iter().find(|(b, c, _)| *b == t[k + 2] && *c == t[k + 4]).map(|(_, _, s)| *s)
        } else {
            None
        };
        match sem {
            Some(s) => {
                o.push(format!("PC_{s}"));
                k += 5;
            }
            None => {
                o.push(t[k].clone());
                k += 1;
            }
        }
    }
    t = o;

    t = array_ctor(&t);
    t = drop_casts(&t);
    t = drop_res_groups(&t, resources(pair));

    // alias expansion runs LAST of the name passes, so a threaded resource
    // parameter is dropped above by its ORIGINAL name
    let exp = alias_expand(pair, msl);
    let mut o = Vec::new();
    for x in &t {
        match exp.iter().find(|(n, _)| n == x) {
            Some((_, e)) => o.extend(e.iter().map(|s| (*s).to_string())),
            None => o.push(x.clone()),
        }
    }
    t = o;

    for a in ALLOW.iter().filter(|a| (a.pair == pair || a.pair == "*") && a.item == item && a.msl == msl) {
        let (n, count) = seq_replace(&t, a.from, a.to);
        if count != a.count {
            let side = if msl { "msl" } else { "glsl" };
            misfires.push(format!(
                "allowlist [{}/{}/{side}] {:?} fired {count}x, expected {}x — it was written because: {}",
                a.pair,
                a.item,
                a.from.join(" "),
                a.count,
                a.why
            ));
        }
        t = n;
    }
    t
}

fn show(t: &[String]) -> String {
    t.join(" ")
}

/// Where two token streams first part company, with context — a diff
/// message a reader can act on.
fn first_divergence(a: &[String], b: &[String]) -> String {
    let i = a.iter().zip(b).position(|(x, y)| x != y).unwrap_or(a.len().min(b.len()));
    let lo = i.saturating_sub(12);
    format!("    …{}\n    GLSL: {}\n     MSL: {}", show(&a[lo..i]), show(&a[i..(i + 16).min(a.len())]), show(&b[i..(i + 16).min(b.len())]))
}

fn keyed(src: &str) -> BTreeMap<Key, Vec<String>> {
    // Preprocessor lines are the preamble (module doc). They must go as
    // whole LINES: since the shared `*.inc` sources (2026-09-22) both twins
    // carry `#define`/`#include`/`#undef` blocks, and a `#`-line left in the
    // token stream glues itself onto the next item and hides it.
    let code: String = strip_comments(src).lines().filter(|l| !l.trim_start().starts_with('#')).collect::<Vec<_>>().join("\n");
    items(&tokenize(&code))
        .into_iter()
        .map(|(k, v)| ((k.0, lookup(NAMES, &k.1).unwrap_or(k.1.as_str()).to_string()), v))
        .collect()
}

/// THE GUARD. Both twins of all three pairs must normalize to the SAME
/// token stream, item for item. See the module doc for the normalization
/// and for what it deliberately does not cover.
#[test]
fn twins_are_structurally_identical() {
    let mut fails: Vec<String> = Vec::new();
    for (pair, glsl_src, msl_src) in twin_pairs() {
        let g = keyed(glsl_src);
        let m = keyed(msl_src);
        assert!(g.len() > 5 && m.len() > 5, "{pair}: the item scanner found almost nothing — it stopped parsing these sources");

        for k in g.keys().filter(|k| !m.contains_key(*k)) {
            fails.push(format!("{pair}: {} `{}` exists ONLY in the GLSL twin", k.0, k.1));
        }
        for k in m.keys().filter(|k| !g.contains_key(*k)) {
            if EXPECT_ONLY_MSL.contains(&(pair, k.0, k.1.as_str())) {
                continue;
            }
            fails.push(format!("{pair}: {} `{}` exists ONLY in the MSL twin", k.0, k.1));
        }
        for (k, gv) in &g {
            let Some(mv) = m.get(k) else { continue };
            let mut misfires = Vec::new();
            let a = normalize(gv, false, pair, &k.1, &mut misfires);
            let b = normalize(mv, true, pair, &k.1, &mut misfires);
            for s in misfires {
                fails.push(format!("{pair}: {s}"));
            }
            if a != b {
                fails.push(format!("{pair}: {} `{}` DIFFERS between the twins\n{}", k.0, k.1, first_divergence(&a, &b)));
            }
        }
    }
    assert!(
        fails.is_empty(),
        "the GLSL and MSL twins are not the same program:\n{}\n\n\
         Port the change to BOTH sources. If the difference is genuine dialect formatting, \
         add a NAMED entry to twin::ALLOW saying why.",
        fails.join("\n")
    );
}

/// The normalizer must not be a shredder: if it collapsed everything to
/// nothing — or if the item scanner quietly stopped finding functions — the
/// equality above would hold VACUOUSLY on both sides at once, which the
/// "only in one twin" check cannot see. So pin how much is actually
/// compared, per pair, that real constants survive it, and that a
/// one-literal change to ONE twin parts the streams.
#[test]
fn the_normalizer_keeps_the_math_it_is_supposed_to_compare() {
    // (items, tokens) floors — the shipped sources are well above each;
    // a fall through one means the scanner or the normalizer regressed,
    // not that a shader shrank.
    for ((pair, glsl_src, _), (min_items, min_toks)) in twin_pairs().into_iter().zip([(20, 3500), (12, 1800), (10, 900)]) {
        let g = keyed(glsl_src);
        let mut misfires = Vec::new();
        let toks: usize = g.iter().map(|(k, v)| normalize(v, false, pair, &k.1, &mut misfires).len()).sum();
        assert!(misfires.is_empty(), "{pair}: {misfires:?}");
        assert!(g.len() >= min_items, "{pair}: only {} top-level items found (floor {min_items}) — the item scanner regressed", g.len());
        assert!(toks >= min_toks, "{pair}: only {toks} tokens compared (floor {min_toks}) — the normalizer is eating the program");
    }

    let (_, glsl_src, msl_src) = twin_pairs()[0];
    let key = ("fn", "main".to_string());
    let mut misfires = Vec::new();
    let a = normalize(&keyed(glsl_src)[&key], false, "shade", "main", &mut misfires);
    assert!(misfires.is_empty(), "{misfires:?}");
    assert!(a.len() > 1500, "the shade kernel normalizes to {} tokens — the normalizer is eating the program", a.len());
    let joined = show(&a);
    for frag in ["0.72 , 0.82 , 0.64", "0.5 , 0.47 , 0.43", "0.299 , 0.587 , 0.114", "0.96 , 0.93 , 0.87", "* 0.16 * bladeVis"] {
        assert!(joined.contains(frag), "{frag:?} did not survive normalization — the guard would be blind to it");
    }
    // …and a single mutated literal in ONE twin must part the streams
    let mutated = msl_src.replace("float3(0.50, 0.47, 0.43)", "float3(0.52, 0.47, 0.43)");
    assert_ne!(mutated, msl_src, "the mutation probe no longer matches shade.metal — update it");
    let b = normalize(&keyed(&mutated)[&key], true, "shade", "main", &mut misfires);
    assert_ne!(a, b, "a changed contact-grime tint in one twin normalized away — the guard is blind");
}
