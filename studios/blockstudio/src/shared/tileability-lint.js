/**
 * Kit tileability lint.
 *
 * Enumerates adjacent-part combinations for a modular kit and verifies that
 * the declared geometry produces butt joints — no overlap, no gap — at every
 * shared seam. Returns an array of issue descriptions (empty ⇒ all good).
 *
 * The lint is pure and deterministic: it walks ``kit.partCatalog`` and, for
 * wall kits, optionally inspects the generated scene plan to measure a
 * corner's actual XZ contour. Callers do not need Blender or the MCP bridge.
 *
 * See docs/tilekit-improvement-plan.md Phase 3 for the rationale and the
 * list of adjacencies that motivate each check.
 */

import { buildWallKitCatalogScene } from "./scene-plan.js";

const FLOAT_TOL = 0.001;

/**
 * Lint a modular kit for tileability invariants.
 *
 * @param {object} kit - A kit definition as returned by createModularKitDefinition.
 * @returns {string[]} list of human-readable issue descriptions
 */
export function lintKitTileability(kit) {
  if (!kit || !kit.spec || !Array.isArray(kit.partCatalog)) {
    return ["lint: kit has no partCatalog"];
  }
  const kind = kit.kind || kit.spec.kind || "wall_kit";
  switch (kind) {
    case "wall_kit":
      return lintWallKit(kit);
    case "ground":
      return lintGroundKit(kit);
    default:
      return [`lint: unsupported kit kind "${kind}"`];
  }
}

// ---------------------------------------------------------------------------
// Wall kit lint
// ---------------------------------------------------------------------------

function lintWallKit(kit) {
  const issues = [];
  const { spec, partCatalog } = kit;
  const { baseUnit, wallSpan, wallThickness } = spec;

  const wallLikeKinds = new Set(["wall", "door_wall", "window_module", "end_cap"]);

  for (const part of partCatalog) {
    if (!part.meshEnvelope) continue;
    const [envX, , envZ] = part.meshEnvelope;

    if (wallLikeKinds.has(part.kind)) {
      // Edge-run parts must match [wallSpan × wallThickness] in XZ so they
      // tile end-to-end along a wall run without gaps or overlaps.
      if (!approxEq(envX, wallSpan)) {
        issues.push(
          `${part.name}: meshEnvelope width=${envX} does not match wallSpan=${wallSpan} (would gap or overlap adjacent walls along a run)`
        );
      }
      if (!approxEq(envZ, wallThickness) && part.kind !== "end_cap") {
        issues.push(
          `${part.name}: meshEnvelope depth=${envZ} does not match wallThickness=${wallThickness}`
        );
      }
    }

    if (part.kind === "corner") {
      // Corner mesh envelope must fit inside a single base cell. Anything
      // larger overhangs into a neighbouring cell and breaks the grid.
      if (envX > baseUnit + FLOAT_TOL) {
        issues.push(
          `${part.name}: meshEnvelope width=${envX} exceeds baseUnit=${baseUnit} (overhangs into the next cell along X)`
        );
      }
      if (envZ > baseUnit + FLOAT_TOL) {
        issues.push(
          `${part.name}: meshEnvelope depth=${envZ} exceeds baseUnit=${baseUnit} (overhangs into the next cell along Z)`
        );
      }
    }

    if (part.kind === "floor_tile") {
      if (!approxEq(envX, baseUnit) || !approxEq(envZ, baseUnit)) {
        issues.push(
          `${part.name}: floor tile meshEnvelope ${formatVec([envX, envZ])} must be ${baseUnit}×${baseUnit} to tile edge-to-edge`
        );
      }
    }
  }

  // Inspect the scene plan for the corner's ACTUAL geometry (the meshEnvelope
  // only bounds the declared part — the generator could still overshoot).
  issues.push(...lintCornerContourAgainstCell(kit));

  // Window family widths must sum to a whole wall span.
  issues.push(...lintWindowSequence(spec));

  // Pairwise end-to-end adjacency: two copies of each edge-run part, placed
  // into cells (0,0) and (1,0), should touch at x = baseUnit with no slop.
  issues.push(...lintEdgeRunContinuity(partCatalog, baseUnit, wallLikeKinds));

  return issues;
}

function lintCornerContourAgainstCell(kit) {
  const corner = kit.partCatalog.find((part) => part.kind === "corner");
  if (!corner) return [];

  let build;
  try {
    build = buildWallKitCatalogScene({ kit });
  } catch (error) {
    return [`corner: failed to build catalog scene for lint (${error.message})`];
  }

  const cornerGroup = (build.scenePlan?.root?.children || []).find(
    (child) => child && child.name === "corner"
  );
  if (!cornerGroup) return ["corner: corner group missing from catalog scene"];

  const cornerBody = (cornerGroup.children || []).find(
    (child) => child && child.type === "polygon_prism"
  );
  if (!cornerBody || !Array.isArray(cornerBody.contour)) {
    return ["corner: corner body has no polygon_prism contour"];
  }

  const contour = cornerBody.contour.map(([x, z]) => [
    x - cornerGroup.origin[0],
    z - cornerGroup.origin[2]
  ]);

  const xs = contour.map((p) => p[0]);
  const zs = contour.map((p) => p[1]);
  const envX = Math.max(...xs) - Math.min(...xs);
  const envZ = Math.max(...zs) - Math.min(...zs);
  const { baseUnit } = kit.spec;

  const issues = [];
  if (envX > baseUnit + FLOAT_TOL) {
    issues.push(
      `corner: actual contour width=${envX} exceeds baseUnit=${baseUnit} (overhangs into neighbouring cell)`
    );
  }
  if (envZ > baseUnit + FLOAT_TOL) {
    issues.push(
      `corner: actual contour depth=${envZ} exceeds baseUnit=${baseUnit} (overhangs into neighbouring cell)`
    );
  }
  return issues;
}

function lintWindowSequence(spec) {
  const issues = [];
  for (const family of spec.windowFamilies || []) {
    const sum = (family.leftWidth || 0) + (family.middleWidth || 0) + (family.rightWidth || 0);
    // The three widths describe the trim segments inside one logical wall
    // module; the glass span is whatever is left over. Gate on the wall span
    // upper bound.
    if (sum > spec.wallSpan + FLOAT_TOL) {
      issues.push(
        `window family "${family.name}": left+middle+right trim widths (${sum}) exceed wallSpan=${spec.wallSpan}`
      );
    }
  }
  return issues;
}

function lintEdgeRunContinuity(partCatalog, baseUnit, edgeKinds) {
  const issues = [];
  for (const part of partCatalog) {
    if (!edgeKinds.has(part.kind) || !part.meshEnvelope) continue;
    const [envX] = part.meshEnvelope;
    // Place two copies at anchors (baseUnit/2) and (3*baseUnit/2) along X —
    // the edge_midpoint of cell (0,0) and cell (1,0) respectively. The
    // envelopes must meet at x = baseUnit exactly.
    const leftMaxX = baseUnit / 2 + envX / 2;
    const rightMinX = 3 * baseUnit / 2 - envX / 2;
    const gap = rightMinX - leftMaxX;
    if (Math.abs(gap) > FLOAT_TOL) {
      if (gap > 0) {
        issues.push(
          `${part.name}: two copies placed end-to-end leave a gap of ${round(gap, 4)} units between cells`
        );
      } else {
        issues.push(
          `${part.name}: two copies placed end-to-end overlap by ${round(-gap, 4)} units at the cell seam`
        );
      }
    }
  }
  return issues;
}

// ---------------------------------------------------------------------------
// Ground kit lint
// ---------------------------------------------------------------------------

function lintGroundKit(kit) {
  const issues = [];
  const { spec, partCatalog } = kit;
  const { baseUnit } = spec;

  for (const part of partCatalog) {
    if (part.kind !== "floor_tile" || !part.meshEnvelope) continue;
    const [envX, , envZ] = part.meshEnvelope;
    if (!approxEq(envX, baseUnit) || !approxEq(envZ, baseUnit)) {
      issues.push(
        `${part.name}: floor tile meshEnvelope ${formatVec([envX, envZ])} must be ${baseUnit}×${baseUnit} to tile edge-to-edge`
      );
    }
  }

  // Ground tiles placed cell-to-cell must touch at the shared seam.
  for (const part of partCatalog) {
    if (part.kind !== "floor_tile" || !part.meshEnvelope) continue;
    const [envX] = part.meshEnvelope;
    // cell (0,0) center is (baseUnit/2, 0, baseUnit/2); cell (1,0) center is
    // (3*baseUnit/2, 0, baseUnit/2). Their envelopes must meet at x=baseUnit.
    const leftMaxX = baseUnit / 2 + envX / 2;
    const rightMinX = 3 * baseUnit / 2 - envX / 2;
    const gap = rightMinX - leftMaxX;
    if (Math.abs(gap) > FLOAT_TOL) {
      if (gap > 0) {
        issues.push(
          `${part.name}: two floor tiles placed edge-to-edge leave a gap of ${round(gap, 4)} units at the shared seam`
        );
      } else {
        issues.push(
          `${part.name}: two floor tiles placed edge-to-edge overlap by ${round(-gap, 4)} units at the shared seam`
        );
      }
    }
  }

  return issues;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function approxEq(a, b) {
  return Math.abs(a - b) <= FLOAT_TOL;
}

function round(value, decimals) {
  const factor = Math.pow(10, decimals);
  return Math.round(value * factor) / factor;
}

function formatVec(values) {
  return `[${values.join(", ")}]`;
}
