//! The plain-data boundary between the IDE and the game. The adapter (in
//! rt-viewer — the only crate that knows both sides) builds a [`SceneModel`]
//! from the real level and applies the [`Edit`]s the IDE hands back. What is
//! editable is DECLARED here per object by the adapter, so the IDE never
//! holds a game opinion: a slider exists because the adapter said so.

/// Stable object handle. The adapter owns the numbering and must keep an
/// object's id stable across frames and rebuilds (it is the selection).
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct ObjId(pub u32);

/// One scene object as the IDE sees it.
pub struct Obj {
    pub id: ObjId,
    pub name: String,
    /// Hierarchy section this object lists under ("walls", "lamps", ...).
    /// Sections appear in first-encounter order.
    pub group: &'static str,
    /// World-space transform, display-only (edits go through props).
    pub pos: [f32; 3],
    pub size: [f32; 3],
    pub props: Vec<Prop>,
}

/// One declared property row in the inspector.
pub struct Prop {
    /// Adapter-side key, returned verbatim in [`Edit`].
    pub key: &'static str,
    pub label: &'static str,
    pub kind: PropKind,
}

pub enum PropKind {
    /// Read-only line.
    Read(String),
    /// Integer slider (whole steps).
    SliderI { v: i32, min: i32, max: i32 },
    /// f32 slider; values snap to `1/50` of the range (exact f32 steps —
    /// the wear panel's `k / 50` lesson: `k * 0.02` accumulates and the
    /// ugliness lands verbatim in saved files).
    SliderF { v: f32, min: f32, max: f32 },
}

#[derive(Clone, Copy, PartialEq, Debug)]
pub enum PropVal {
    I(i32),
    F(f32),
}

/// One applied change: "set `key` on `obj` to `v`". Emitted on slider
/// RELEASE (geometry/GI cost is per-edit, not per-motion — the input-pacing
/// discipline), never during the drag.
#[derive(Clone, Copy, PartialEq, Debug)]
pub struct Edit {
    pub obj: ObjId,
    pub key: &'static str,
    pub v: PropVal,
}

pub struct SceneModel {
    /// Level name for the top bar.
    pub level: String,
    pub objects: Vec<Obj>,
}

impl SceneModel {
    pub fn obj(&self, id: ObjId) -> Option<&Obj> {
        self.objects.iter().find(|o| o.id == id)
    }
}

/// Snap a 0..1 track fraction onto a slider value. Integer sliders take
/// whole steps; f32 sliders snap to `k / 50` of the range.
pub fn slider_value(kind: &PropKind, frac: f32) -> PropVal {
    let f = frac.clamp(0.0, 1.0);
    match *kind {
        PropKind::SliderI { min, max, .. } => PropVal::I(min + ((max - min) as f32 * f).round() as i32),
        PropKind::SliderF { min, max, .. } => {
            let k = (f * 50.0).round();
            PropVal::F(min + (max - min) * (k / 50.0))
        }
        PropKind::Read(_) => PropVal::F(0.0),
    }
}

/// The track fraction a slider value currently sits at (draw + hit share it).
pub fn slider_frac(kind: &PropKind, pending: Option<PropVal>) -> f32 {
    match (kind, pending) {
        (PropKind::SliderI { min, max, .. }, Some(PropVal::I(p))) => (p - min) as f32 / (max - min).max(1) as f32,
        (PropKind::SliderI { v, min, max }, _) => (v - min) as f32 / (max - min).max(1) as f32,
        (PropKind::SliderF { min, max, .. }, Some(PropVal::F(p))) => (p - min) / (max - min).max(f32::MIN_POSITIVE),
        (PropKind::SliderF { v, min, max }, _) => (v - min) / (max - min).max(f32::MIN_POSITIVE),
        (PropKind::Read(_), _) => 0.0,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn slider_values_snap_exactly() {
        let i = PropKind::SliderI { v: 3, min: 1, max: 8 };
        assert_eq!(slider_value(&i, 0.0), PropVal::I(1));
        assert_eq!(slider_value(&i, 1.0), PropVal::I(8));
        assert_eq!(slider_value(&i, 0.5), PropVal::I(5), "0.5 of 1..8 rounds to 5 (4.5 up)");
        let f = PropKind::SliderF { v: 0.0, min: 0.0, max: 1.0 };
        // k/50 discipline: every reachable value is an exact fraction
        assert_eq!(slider_value(&f, 0.399), PropVal::F(20.0 / 50.0));
        assert_eq!(slider_value(&f, 1.0), PropVal::F(1.0));
        // round-trip: value -> frac -> value is identity for every step
        for k in 0..=50 {
            let v = slider_value(&f, k as f32 / 50.0);
            let back = slider_value(&f, slider_frac(&f, Some(v)));
            assert_eq!(v, back, "k={k}");
        }
    }
}
