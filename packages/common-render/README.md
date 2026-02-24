# @common/render

Shared rendering utilities used across experiments and apps, including shared-scissor rendering (`SharedScissorStage`) and pane adapters.

## Shared Scissor Host Contract (Important)

`@common/render` handles render math (pane rect measurement, scissor rects, viewport behavior, draw lifecycle).

The host HTML/CSS must provide a stable layout/stacking environment. Most "scissor looks wrong" bugs are host-side CSS issues, not renderer math.

### Responsibilities

- `@common/render`: scissor math, viewport/scissor correctness, per-pane rendering lifecycle
- Host HTML/CSS: sizing, overflow, clipping, transparency, z-index, stacking contexts, scroll behavior

### Renderer Invariants (Important)

- Shared scissor rendering must treat the pane viewport and the visible clip/scissor rect as separate concepts during partial offscreen rendering.
- Use the pane's full (unclipped) viewport origin/size for viewport-relative placement.
- Use the clipped visible rect only for `setScissor(...)`.
- If the clipped rect is reused as the pane viewport origin, content can appear "sticky" at scroll boundaries when panes start clipping offscreen.

### Host Discipline Checklist

1. Pane elements are anchors, not canvases
- The shared canvas renders behind DOM.
- Pane DOM elements are measured (`getBoundingClientRect`) and provide chrome/input hit areas.

2. Keep the pane-to-stage path transparent
- Any opaque background between the pane surface and the scissor stage mount can visually hide the shared canvas.
- Prefer borders/box-shadows for pane chrome instead of opaque fills in pane render regions.

3. Be intentional about clipping
- `overflow: hidden` and `border-radius` on pane frames clip the shared canvas visually.
- If the rendered content should appear rectangular, use square corners (`border-radius: 0`).

4. Contain overlays to the stage
- If an experiment mounts a shared scissor overlay with `position: fixed`, the host stage container must create a containing/paint boundary.
- Recommended stage-host CSS:

```css
.stage-host {
  position: relative;
  contain: paint;
  isolation: isolate;
}
```

5. Reserve higher layers for page chrome
- Headers/toolbars outside the stage should have a higher local layer than stage content (use `position` + `z-index`).
- Shared overlay `z-index` should only be high enough to sit above pane shells, not page headers.

6. Do not accidentally collapse pane sizing
- Pane hosts must have real width/height.
- Be careful with reusable `height: 100%` styles unless the parent is explicitly sized.

7. Scroll clipping should crop, not squeeze
- Partially offscreen panes should be visually clipped, not resized/compressed.
- This depends on both:
  - correct library behavior (clipped scissor + unclipped viewport)
  - stable host layout (no unintended CSS changes that alter pane geometry)

8. Avoid surprising transforms in pane ancestors
- CSS transforms on pane ancestors can change measured rects and complicate scissor alignment.
- Use intentionally and verify scissor mapping if transforms are present.

### Debugging Order (Recommended)

When a shared-scissor pane looks wrong:

1. Check host CSS first (backgrounds, overflow, border radius, z-index, containment).
2. Confirm pane rects are measured correctly and sizes are non-zero.
3. Confirm clipping is cropping (not squeezing) when panes are partially offscreen.
4. Only then debug camera/aspect/render math.
