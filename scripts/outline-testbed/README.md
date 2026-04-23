# Outline regression testbed

Harness for catching regressions in the outline pipeline
(`@common/render`'s `PixelPerfectOutlinedView` + edge-detection shader).

## Usage

Start the dev server (`pnpm dev`), then:

```bash
# Capture a run (screenshots + ASCII grids + report.md).
pnpm outline:testbed --label <name>

# Capture with the world-position same-surface gate instead of the depth gate.
pnpm outline:testbed --label <name> --suppress world-position

# Capture + diff against a previous run.
pnpm outline:testbed --label after --diff before
```

Output lands in `out/<label>/` (gitignored):

- `<scene>-edges.png` — full-screen edge-only (debug mode 5) screenshot
- `<scene>-edges.txt` — ASCII classification (`#` = outline, `.` = no edge),
  cropped to the bounding box of the outlines so the signal is readable
- `<scene>-final.png` — full composite (debug mode 0) for visual inspection
- `report.md` — concatenated ASCII grids for every scene in the run

`--diff` prints a per-scene pass/fail with row-level change counts. For
deep-dive inspection of a single grid:

```bash
node scripts/outline-testbed/annotate.mjs out/<label>/<scene>-edges.txt
# or restrict to a row range:
node scripts/outline-testbed/annotate.mjs out/<label>/<scene>-edges.txt 40 60
```

## Scene matrix

14 scenes covering the V-gap reproducer, same-group silhouette cases,
tile-top flush seams, and the full room — each at 1–4 rotations. Defined
in `run.mjs`.

## Probing pixels at runtime

`outline-walls` exposes `window.__outlineProbe__(bufX, bufY, stride?)`
when visited with `?outlineProbe=0,0`. Returns a center sample plus
4 neighbours with decoded linear-depth, normal, and id values, plus
buffer size + rendered-fraction metadata for sanity-checking coords.

`probe.mjs` is a working example that drives this via Playwright. Edit
the `SCENES` array to target whatever pixels you're investigating; see
the inline comment for the LR → buffer coord conversion.

## Invariants the testbed catches

- V-gap at inner concave corners (`full-room` row 53, cols 70-75).
- Horizontal stripe regressions at flush tile-top seams under rotation
  (was the failure mode of the too-tight-threshold attempt).
- Same-group silhouettes being swallowed when the front and back meshes
  share an outline group and normal (`two-corners-q2/q3`).

See `docs/AGENT_LEARNINGS.md` entries tagged 2026-04-22 for the full
history.
