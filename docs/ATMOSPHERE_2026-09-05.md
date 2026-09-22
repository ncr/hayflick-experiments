# Dusty daylight

The lighting refinement keeps the aftermath sunlight direction and exposure.
Sky fill rises from 1.65 to 1.85, sun strength eases from 1.05 to 1.02, and
contrast eases from 1.08 to 1.06. Shadowed damage stays readable while sunlight
still separates the concrete faces. Material colors and the player are unchanged
by this lighting pass.

## Air and grain

The former one-point fog approximation is replaced by eight front-to-back
single-scattering segments along the camera ray. Each segment integrates an
exponential height profile, attenuates the background by its transmittance,
and adds sky-lit and sun-lit aerosol scattering. Real shadow queries against
the Metal/Vulkan scene block the sun contribution behind walls. A normalized
Henyey-Greenstein phase function supplies the viewing-angle response.

Two world-space noise scales produce uneven density banks and smaller wisps.
They advect at 0.12/0.055 world units per second along X/Z using the same fixed
simulation clock as neighborhood vegetation. Sample positions are seeded from
the world-space ray line and never re-roll with the frame number. Earlier levels
without the vegetation clock retain stationary air. There is no history buffer,
denoising, primary-ray jitter or silhouette blending.

The default aftermath density is 0.026 and height scale is 2.6 world units.
Marching begins within five height scales of the ground: the arbitrary distance
to the orthographic eye does not waste samples in the empty sky. That truncation
omits at most 0.67% of an unmodulated full vertical aerosol column. Density is
constant below ground instead of growing exponentially. Very short/horizontal
segments use a cancellation-safe analytic limit, and zero height is bounded.

The existing low-resolution post grain is enabled at 0.055, one game texel per
grain sample, monochrome and weighted toward shadows. Its plate is frozen and
world anchored, so it gives texture without TV-static animation. The haze's
density is the slowly moving layer. Integer nearest upscale and zero AA remain.

ESC → Settings exposes **air density**, **haze height**, and **film grain**.
Air density and grain can each go to zero for comparison. These adjustments
apply immediately without geometry rebuilds or GI baking. Harness equivalents
are `FOG`, `FOG_H`, and `GRAIN`; small settings retain three decimal places.

This is a bounded single-scattering approximation. It does not simulate aerosol
fluid dynamics, multiple scattering, individual dust particles or lamp shafts.
Sky in-scatter uses the authored dome average; sun visibility is traced at eight
locations, so very narrow shafts are represented approximately. It is tuned for
the low-resolution, downward-looking neighborhood camera.

## Verification and review

- 212 workspace tests pass, including Metal/GLSL transport parity and settings
  precision. The existing Blender motion exporter remains an ignored manual test.
- `python3 bin/check-atmosphere` compiles the actual shared scalar shader source
  as C++ and compares it to numerical quadrature in 420 cases. The previous
  shader failed 148; the new integral passes all cases.
- Release builds compile GLSL. Metal runtime compilation, matched clear/hazy
  captures and a 930-tick walk/run/wall-contact capture pass on Apple M2 Pro.
  Vulkan runtime was not available on this Mac.
- Two alternating clear/air timing pairs, 180 frames each with the first 30
  excluded, at 2560×1600 output / 704×464 low resolution (PIXEL=4): clear mean
  13.54–14.02 ms, air mean 16.04–16.05 ms. Added cost is 2.03–2.51 ms in these
  runs. These measure the blocking headless render call, not a guarantee of
  windowed FPS; system load affected the earlier measurements substantially.
- Review artifacts are ignored under `output/atmosphere/`: `scene.png`,
  `clear.png`, `player-before.png`, `player-after.png`, `walkthrough.mp4`, and
  `motion-review.png`. The player before-image is from the previous task; the
  clear comparison uses the new lighting with fog and grain both switched off.

Reproduce the main capture:

```sh
LEVEL='after the rain' WINDOW=1280x800 PIXEL=2 \
  SHOT=output/atmosphere/scene.png target/release/viewer
```

Create the output directory first. For the clear control add `FOG=0 GRAIN=0`.
