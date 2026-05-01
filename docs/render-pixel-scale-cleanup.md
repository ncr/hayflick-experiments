# Render pixel-scale cleanup + Material-Studio prompt tightening

**Status:** parked. Picked up Friday 2026-05-01, paused mid-design.
Re-engage Monday 2026-05-04 (reminder scheduled).

This doc captures two intertwined pieces of work that came up in
conversation. Neither is implementation-ready yet — both have
open decisions that need to be made before code lands. The point of
this file is to keep the analysis from evaporating between sessions.

---

## 1. Why we're doing this

### Trigger A — Texture style drift

Material-Studio's AI-generated albedos drift toward photoreal /
noisy / softly-shaded outputs. We want clean, retro pixel-art:
Dieter-Rams-style flat panels, 2–3 tones, no baked lighting,
hard negative-prompt rules. A revised recipe was developed in chat
(see §3 below).

### Trigger B — Pixel scale is unclean

While reconciling the recipe's "1 texel ≈ 8 cm" line against the
actual project scale, we found that the IsoGameView reference
resolution gives:

- **R = 240 / (4.8·√2) = 25·√2** lowpixels per world unit
- **25 H / 12.5 V** lowpixels per 128 cm world unit (the source of
  the 2:1 iso screen ratio)
- **5.12 cm horizontal / 4.18 cm vertical** per atlas texel (exact)

Two problems with this:

1. The numbers aren't integer powers of two. 12.5 isn't even an
   integer. Hard to reason about, hard to write down in prompts.
2. Root `CLAUDE.md` claims "1 world tile edge (128 cm) = 32 px H,
   16 V" — that's stale and disagrees with the code (which is
   25 / 12.5). The level-editor's `LEVEL_EDITOR_PIXELS_PER_UNIT_*`
   constants (64 / 32) are for a separate top-down editor viewport
   and don't apply to IsoGameView.

The user wants the renderer's pixel scale fixed to clean integer
powers of two before the prompt change lands, because the prompt's
"cm per texel" line should reference the new clean scale.

---

## 2. Pixel-scale math (verified)

Renderer parameters (in `packages/common-render/src/pixel-perfect-types.ts`):

```
yaw              = π/4
pitch            = π/6
fixedRenderHeight = 240   (lowpixels)
baseOrthoHeight  = 4.8·√2 (world units)
```

Derived (in `packages/experiments/src/material-studio/uv-template/prepare.ts:77-82`):

```
R = fixedRenderHeight / baseOrthoHeight = 240 / (4.8·√2) = 25·√2
                                                       ≈ 35.36 lowpixels per world unit
```

For a 1 world unit edge (= 128 cm):

| World axis | Screen-axis projection (px/unit) | cm per texel (exact) |
|---|---|---|
| X (or Z) horizontal | `R·cos(π/4) = 25` | **128 / 25 = 5.12 cm** |
| X (or Z) vertical (2:1 collapse) | `R·cos(π/4)·sin(π/6) = 12.5` | — |
| Y vertical | `R·cos(π/6) = 25·√6/2 ≈ 30.62` | **256 / (25·√6) ≈ 4.18 cm** |

`computeCellsPerIsland` (`prepare.ts:170`) uses `max(|sx|, |sy|)`
of each UV axis's projected world derivative (the dominant
screen-axis extent, NOT the slanted Euclidean length) — this
matters because NEAREST sampling along scanlines requires it.
The "column 9 disappears" bug fixed earlier (see comment line 167)
relies on this dominant-axis sizing logic.

### Why pitch=π/6 gives "2:1 iso"

With yaw=π/4 and pitch=θ, world-X projects to
`(cos π/4, -cos π/4·sin θ) · R`. The screen H:V ratio for a
horizontal world edge is `1 / sin(θ)`. At θ=π/6, that's exactly 2.
True 2:1 iso "by name" — the screen-pixel ratio is locked.
World-Y vertical projection (`cos θ = √3/2`) is irrational
*regardless* of R, so the Y/X ratio between world axes will
never be a clean integer.

---

## 3. Material-Studio prompt recipe (developed in chat)

**Replaces** the current `STYLE_PREAMBLE` constant in
`packages/experiments/src/material-studio/api-client.ts:47-53`.

### BASE STYLE PROMPT (sections, prepended to every generation)

- **Style identity** — pixel-art albedo for low-resolution iso 2:1
  game, nearest-neighbor filtering, **~5 cm H / ~4 cm V per texel**
  (number to be revisited once §4 lands), Dieter Rams / Braun-style
  minimalist retro-futuristic architecture.
- **Albedo only** — no lighting, shadows, highlights, gradients,
  AO, bevels.
- **Pixel discipline** — no high-frequency detail, no noise/grain,
  no sub-texel features, min feature size 1 texel (prefer 2–4).
- **Value structure** — 2–3 tones max (4 if necessary), clear
  separation, no smooth transitions, avoid low-contrast mush.
- **Shape language** — large flat areas dominate, panel seams clean
  and consistent, regular grid-aligned spacing, controlled tileable
  repetition.
- **Material definition** — color + simple value variation only,
  optional large-scale variation (≥ 8–16 texels), no micro detail.
- **Constraints** — tileable, no photorealism, no PBR detail,
  no dirt / damage / aging unless explicitly requested.

### NEGATIVE PROMPT (new constant, `STYLE_NEGATIVES`)

OpenAI Responses + `image_generation` tool does not accept a
separate `negative_prompt` field, so embed as a "Do NOT include:"
sentence inside the user message:

> photorealistic, PBR material, high-frequency detail, noise, grain,
> film grain, scratches, cracks, dirt, grunge, weathering, edge
> wear, lighting, shadows, highlights, ambient occlusion, bevel
> shading, normal-map detail, micro detail, texture noise, uneven
> randomness

Splice into `buildPrompt` (`api-client.ts:368-402`) between the
existing "Do NOT redraw…" rules and the per-island region list.

### ROLE_PROMPT_SEEDS — strip to neutral function hints

Current seeds (`api-client.ts:59-63`) bake an aesthetic into the
defaults ("Year 2200 sci-fi", "burnt amber accent"). With the new
base prompt carrying all the style, seeds should be neutral:

```
wall:        "large flat wall panels with thin vertical seam lines"
trim:        "narrow accent stripe at an architectural datum"
floor_tile:  "square floor tiles with thin grid seams"
```

User decision (recorded in chat): strip to bare role hints.

### Optional style boost (hold)

Recipe includes a "looks like hand-authored pixel art for a 90s
isometric game" booster line. Hold off until we have evidence the
base rules aren't enough.

---

## 4. Pixel-scale cleanup options

To get clean integer-power-of-two H projections per world unit, we
need **R = 2ⁿ · √2** for integer n. Then `fixedRenderHeight` and
`baseOrthoHeight` can both be clean if their ratio is R.

| Target H × V | R | Clean (fixedRenderHeight, baseOrthoHeight) | View height (cm) | cm/texel H (exact) |
|---|---|---|---|---|
| 32 × 16 (closest to current) | 32·√2 | (256, 4·√2)  | 724 | **128 / 32 = 4 cm** |
| 64 × 32 (user suggestion)    | 64·√2 | (512, 4·√2)  | 724 | **128 / 64 = 2 cm** |
| 128 × 64 (high-res)          | 128·√2 | (1024, 4·√2) | 724 | **128 / 128 = 1 cm** |

(World-Y vertical projection is `R·√3/2` and stays irrational. The
"V" column above is the 2:1 collapse of horizontal world-X edges,
not the Y-axis projection.)

### Blast radius if we change global IsoGameView defaults

| Site | Impact |
|---|---|
| `packages/common-render/src/pixel-perfect-types.ts:86-88` | Defaults change |
| Renderer math chain (`computeOrthoHeightForLowResolution`) | ✅ Clean — scales by ratio, no hardcoded magic |
| `packages/experiments/src/material-studio/uv-template/prepare.ts:77-82` | ⚠️ `ISO_R` and 5 derived coefficients hardcode 240/4.8·√2; must re-derive (or import constants) |
| `packages/experiments/src/material-studio/uv-template/prepare.ts:167` (comment) | ⚠️ References "25-px parallelogram" / "sqrt(25² + 12.5²) ≈ 28" — re-verify dominant-axis sizing under new scale |
| 27 e2e golden images under `e2e/render-invariants/*` | ⚠️ All `maxDiffPixels: 0`, will need regeneration |
| `assets/textured-meshes/*` shipped artifacts | ⚠️ Atlases sized at old 25/12.5; needs rebake or accept cosmetic mis-sampling |
| `packages/common-level-editor/src/constants.ts` (64/32) | ✅ Independent (top-down editor viewport), unaffected |
| `packages/common-render/src/presets/framing.ts` `PROP_PREVIEW_FRAMING` | ✅ Independently tuned (270, 5.966) — leave alone |
| `packages/common-render/src/tileset-viewer-config.ts` | ✅ Independent (360, 10.24) |

### Local-only override is wrong

Considered overriding only the material-studio authoring scene's
IsoGameView. Rejected — atlas pixels MUST match in-game render
pixels for the NEAREST 1:1 invariant; otherwise textures sized
in-studio won't sample 1:1 in-game. Studio scale and game scale
must be the same number. Therefore: global change.

---

## 5. Open questions (decide Monday)

1. **Target scale** — 32×16, 64×32, or 128×64 per world unit?
   - 64×32 was the user's first suggestion. 2 cm per texel
     horizontal. ~4× pixels vs current — meaningful GPU bump
     but probably fine on modern hardware. Default
     recommendation.
   - 32×16 keeps the chunky-pixel-art feel of current
     (5 cm → 4 cm per texel). Lowest blast radius.
   - 128×64 is fine pixel-art but probably overkill; atlas
     storage and GPU cost both grow ~16×.

2. **Re-bake policy for shipped textured-meshes** — re-bake all,
   leave them stale until next regen, or wipe and re-author?

3. **Any other IsoGameView consumers we need to recalibrate?**
   `PROP_PREVIEW_FRAMING` and `tileset-viewer-config` were tuned
   independently — leaving them alone unless tests fail. Verify.

4. **Update root CLAUDE.md** — the "32×16 px per tile" line is
   stale. Either fix it now while changing the actual scale, or
   delete it (since it's documented in code constants anyway).

---

## 6. Order of operations (proposed)

Once questions in §5 are resolved:

1. Update `pixel-perfect-types.ts` defaults to the chosen
   (fixedRenderHeight, baseOrthoHeight).
2. Re-derive `ISO_R` and 5 coefficients in `prepare.ts` from those
   defaults (ideally import them rather than rederive).
3. Regenerate `e2e/render-invariants/*` golden images.
4. Rebake (or delete) `assets/textured-meshes/*` per §5.2.
5. Update root `CLAUDE.md` invariant #3.
6. THEN — apply the §3 prompt changes
   (`STYLE_PREAMBLE` rewrite + `STYLE_NEGATIVES` + role seed strip).
7. Manual visual check via `pnpm dev` + Material Studio:
   small user prompt, compare against pre-change cache outputs.

---

## 7. Files involved

- `packages/common-render/src/pixel-perfect-types.ts:86-88`
- `packages/experiments/src/material-studio/api-client.ts:47-67, 368-402`
- `packages/experiments/src/material-studio/uv-template/prepare.ts:77-82, 100-176`
- `packages/experiments/src/material-studio/engine/authoring-scene.ts:218-234`
- `packages/common-level-editor/src/constants.ts` (reference only — independent)
- `e2e/render-invariants/*.spec.ts` (snapshot regen)
- `CLAUDE.md` (root) — pixel-perfect invariant #3 stale
- `assets/textured-meshes/*` (rebake or wipe)
