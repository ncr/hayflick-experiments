# Pixel Outline Post

## Goal
Reimplement the Godot edge shader behavior as a Three.js screen-space postprocess pass, now layered on top of a retro toon-lit demo scene.

## Notes
- Uses custom toon materials with subtle screen-space dithering for non-photoreal shading.
- Adds stylized contact shadows that stay readable with the retro look.
- Renders scene color + depth, then a separate normal pass.
- Pixelizes by sampling one representative texel per block.
- Detects one-sided edges using depth and normal differences with deterministic tie-breaks.
- Camera continuously orbits the center composition.
