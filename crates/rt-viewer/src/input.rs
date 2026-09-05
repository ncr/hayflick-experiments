//! Physical held keys. Text, Shift/Caps Lock and keyboard layout cannot change
//! the identity of a release. Aliases and left/right modifiers stay independent.
use std::collections::BTreeSet;
use winit::keyboard::KeyCode;

#[derive(Default)]
pub struct Keyboard {
    down: BTreeSet<KeyCode>,
}

impl Keyboard {
    pub fn update(&mut self, key: KeyCode, down: bool, repeat: bool, active: bool) -> bool {
        use KeyCode::*;
        if !matches!(
            key,
            KeyW | KeyS
                | KeyA
                | KeyD
                | ArrowUp
                | ArrowDown
                | ArrowLeft
                | ArrowRight
                | ShiftLeft
                | ShiftRight
                | ControlLeft
                | ControlRight
        ) {
            return false;
        }
        if !down {
            self.down.remove(&key);
        } else if active && !repeat {
            self.down.insert(key);
        }
        true
    }
    pub fn clear(&mut self) {
        self.down.clear();
    }
    pub fn movement(&self) -> [bool; 4] {
        use KeyCode::*;
        [
            (KeyW, ArrowUp),
            (KeyS, ArrowDown),
            (KeyA, ArrowLeft),
            (KeyD, ArrowRight),
        ]
        .map(|(a, b)| self.down.contains(&a) || self.down.contains(&b))
    }
    pub fn run(&self) -> bool {
        self.down.contains(&KeyCode::ShiftLeft) || self.down.contains(&KeyCode::ShiftRight)
    }
    pub fn crouch(&self) -> bool {
        self.down.contains(&KeyCode::ControlLeft) || self.down.contains(&KeyCode::ControlRight)
    }
}

pub fn camera_turn(key: KeyCode, repeat: bool) -> Option<i32> {
    if repeat {
        return None;
    }
    match key {
        KeyCode::KeyQ => Some(-1),
        KeyCode::KeyE => Some(1),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use KeyCode::*;
    #[test]
    fn releasing_w_while_shift_is_held_cannot_latch_walk() {
        let mut k = Keyboard::default();
        k.update(KeyW, true, false, true);
        k.update(ShiftLeft, true, false, true);
        // Same physical key even when winit's logical text changed to "W".
        k.update(KeyW, false, false, true);
        assert_eq!(k.movement(), [false; 4]);
        assert!(k.run());
    }
    #[test]
    fn aliases_and_both_shift_keys_release_independently() {
        let mut k = Keyboard::default();
        for key in [KeyW, ArrowUp, ShiftLeft, ShiftRight] {
            k.update(key, true, false, true);
        }
        k.update(KeyW, false, false, true);
        k.update(ShiftLeft, false, false, true);
        assert!(k.movement()[0] && k.run());
        k.update(ArrowUp, false, false, true);
        k.update(ShiftRight, false, false, true);
        assert_eq!(k.movement(), [false; 4]);
        assert!(!k.run());
    }
    #[test]
    fn modal_releases_and_focus_clear_cannot_be_resurrected_by_repeat() {
        let mut k = Keyboard::default();
        k.update(KeyW, true, false, true);
        k.update(KeyW, false, false, false);
        assert_eq!(k.movement(), [false; 4]);
        k.update(KeyD, true, false, true);
        k.clear();
        k.update(KeyD, true, true, true);
        assert_eq!(k.movement(), [false; 4]);
        k.update(KeyD, true, false, false);
        assert_eq!(k.movement(), [false; 4]);
    }
    #[test]
    fn camera_turn_is_one_quarter_per_press_even_while_running() {
        assert_eq!(camera_turn(KeyQ, false), Some(-1));
        assert_eq!(camera_turn(KeyE, false), Some(1));
        assert_eq!(camera_turn(KeyQ, true), None);
        assert_eq!(camera_turn(KeyE, true), None);
    }
}
