// Solid-color palette for the waystation scene. No textures; every surface
// reads its color from here. Keeping this tight means the whole scene shifts
// together when we swap moods (dawn/noon/dusk) — change one entry, not
// hundreds of materials.

export const PALETTE = {
  // Sky / atmosphere — cool to contrast warm walls/ground.
  sky: 0x6a7a8a,
  fog: 0x6e7e90,

  // Ground
  grass: 0x5a6a30,
  grassDark: 0x3e4a20,
  dirt: 0x927550,
  dirtDark: 0x6a563b,
  road: 0x3e3a36,
  roadCrack: 0x1e1c1a,
  roadStripe: 0xd4b248,

  // Walls / structure — bleached concrete; warm against cool sky.
  wallExterior: 0xb8a890,
  wallInterior: 0x9c8c74,
  wallBroken: 0x705c46,
  wallTrim: 0x6b5840,
  floor: 0x745c3e,
  roof: 0x6a4830,
  roofRib: 0x4a3220,

  // Glass / emissive
  glassDim: 0x36424c,
  glassWarm: 0xffd17a,
  lampLight: 0xffe69a,
  shaftColor: 0xffd9a0,

  // Props
  metalRust: 0x8a4a32,
  metalDull: 0x5a5048,
  wood: 0x6a4830,
  fabric: 0x6a5a3a,

  // Particles
  dustMote: 0xfff2c0,
  smoke: 0x9a8e80,
  steam: 0xc8d2dc
} as const;

export type PaletteKey = keyof typeof PALETTE;
