# Fallout Waystation

Iso pixel-art scene built from solid-color tinted boxes. No textures
anywhere — every surface reads its color from `palette.ts` and per-face
vertex tints. Anchor for iterating on lighting, shadows, fog, god rays,
dust motes, and emissive flicker via a `lil-gui` panel (top-right).

## What's in here

- `palette.ts` — single source of truth for every color in the scene.
- `box.ts` — `createTintedBox()` with per-face vertex tints (top
  brightest, bottom darkest, sun-side warmer than shadow-side) plus
  optional per-vertex jitter for tonal noise on big walls.
- `ground.ts` — composite ground plane: grass + dirt path + cracked road
  with a dashed centerline. All variation comes from per-vertex colors on
  one PlaneGeometry.
- `building.ts` — three rooms (entrance / bunkroom / broken back room),
  partial roof. **Iso cutaway trick:** camera-near walls and the roof are
  on `INVISIBLE_LAYER` (1), which the main camera doesn't render but the
  sun's shadow pass does. So the floor catches window-shaped sunlit pools
  and the roof-hole god-ray cone for free.
- `props.ts` — lamp post (with flicker), chimney, broken pipe, crates,
  door.
- `light-shafts.ts` — additive tapered prisms (two crossed quads each)
  through every exterior window and the roof hole. Volumetric shafts
  faked as geometry — works at low resolution and inside the existing
  pipeline without a new post-pass.
- `particles.ts` — CPU-stepped `THREE.Points` fields for dust motes,
  chimney smoke, and pipe steam.
- `gui.ts` — `lil-gui` panel + `localStorage` persistence
  (`fallout-waystation-config-v1`). Reset button reverts to defaults.

## Running

Open `#/fallout-waystation` in the hub.

## Iteration knobs (GUI)

Sun azimuth/elevation/intensity/color · ambient · hemisphere
sky/ground · fill · fog density/color · god-ray intensity/color/falloff
· dust opacity/size · smoke/steam · lamp flicker · window glow ·
background.
