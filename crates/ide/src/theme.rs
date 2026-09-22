//! The chrome's visual language: neutral dark panels, so the joyful world
//! stays the loudest thing on screen, with the game's one amber accent carried
//! over (the product's accent lives on the lamps — and on the active tool).

// chrome
pub const BG: u32 = 0x2f2f2f; // panel body
pub const BG_BAR: u32 = 0x1d1d1d; // top bar + panel headers
pub const EDGE: u32 = 0x161616; // panel outline
pub const EDGE_HI: u32 = 0x454545; // inner top/left bevel line

// text
pub const TEXT: u32 = 0xd6d6d0;
pub const TEXT_DIM: u32 = 0x8f8f8a;
pub const TEXT_HEAD: u32 = 0xf0f0ea;

// state
pub const ACCENT: u32 = 0xe8853c; // the game's amber
pub const SEL_ROW: u32 = 0x3d5166; // the active tool's button (cool, Unity-blue-ish)
pub const HOVER_ROW: u32 = 0x3a3a3a;

// metrics (chrome px; text glyphs are 8x8)
pub const PAD: i32 = 5;
