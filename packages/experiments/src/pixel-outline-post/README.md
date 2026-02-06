# Pixel Outline Post

## Goal
Reimplement the Godot edge shader behavior as a Three.js screen-space postprocess pass.

## Notes
- Renders scene color + depth, then a separate normal pass.
- Pixelizes by sampling one representative texel per block.
- Detects one-sided edges using depth and normal differences with deterministic tie-breaks.
