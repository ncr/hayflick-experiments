# Concepts — the source aesthetic (owner directive 2026-07-12)

The original Hayflick concept paintings, copied verbatim from the first
repo (`hayflick/Concepts`, January 2026). **These are the aesthetic
anchor for the Faza-1 look work** (docs/VISION.md, filar 1): when a look
decision is open, it resolves toward these images.

## The series

- `tecta.1–7` — the house: one white concrete monolith in a golden field.
  The series runs from grayscale value studies to the `tecta.7.final`
  golden-hour painting. Key reads: a single clean bright volume, dark
  vertical window slots as the only facade rhythm, warm low sun, long soft
  shadows, huge sky with lit clouds, dry golden grassland all around,
  small human figure for scale. Solar panels + a mast as quiet tech props.
- `tecta.garden.1–3` — the flat roof as a lush kitchen garden: raised
  green beds, pale walking slabs, a dish antenna, hazy wind-turbine plain
  beyond the parapet. Life on top of the monolith.
- `tecta.plan` — the owner's floor-plan sketch (garaż, okienka, drzwi na
  wschód, ogródek na północy, solar na południu, "Leon").
- `trip.1–4` — the journey: a lone figure walking vast open country
  (green valley at sunset, moor under big clouds). The world outside the
  house: quiet, huge, unhurried.

## What the renderer should take from this

- **Słoneczny dzień + biel z akcentem** (the VISION anchors, literally
  painted): warm sun as THE light source, near-white architecture, one
  dark accent rhythm (the window slots), golden ground.
- Long soft shadows carry the mood — light does the storytelling, not
  surface clutter.
- Big value separation: bright monolith vs deep sky vs mid-value field.
- Beztroska: nothing in these frames is hostile; the figure rests, tends
  plants, walks. The `tecta` LOOK preset (rt-viewer/src/look.rs) is the
  first greybox translation of this palette.
