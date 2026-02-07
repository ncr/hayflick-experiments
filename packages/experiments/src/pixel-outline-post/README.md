# Pixel Outline Post

## Goal
Reimplement the Godot edge shader behavior as a Three.js screen-space postprocess pass, now layered on top of a retro toon-lit demo scene.

## Notes
- Uses custom toon materials with subtle screen-space dithering for non-photoreal shading.
- Uses real shadow mapping for object shadows on the desk.
- Adds a stronger key/fill/rim + hemisphere light rig for better depth and shape readability.
- Applies a subtle ordered dither in the postprocess so it survives pixelization.
- Renders scene color + depth, then a separate normal pass.
- Pixelizes by sampling one representative texel per block.
- Detects one-sided edges using depth and normal differences with deterministic tie-breaks.
- Camera continuously orbits the center composition.
