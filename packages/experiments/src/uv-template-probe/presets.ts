import type { Island, IslandTemplateOptions } from "./uv-template";

/**
 * Pre-cooked island layouts. Three points on the complexity ladder so we can
 * tell where (if anywhere) gpt-image-2 stops respecting the template:
 *
 *  - `two-squares`: trivial sanity check, two well-separated equal squares
 *  - `cube-cross`: classic cube unwrap, six equal squares in a T arrangement
 *  - `pane-unwrap`: front + back + 4 thin edges, mimics the window-pane case
 */

export type Preset = {
  id: string;
  label: string;
  template: IslandTemplateOptions;
  /** Default subject hint per island, in same order as `template.islands`. */
  defaultPrompts: string[];
};

const TEMPLATE_SIZE = 1024;

function makeIsland(
  x: number,
  y: number,
  cellsX: number,
  cellsY: number,
  cellPx: number,
  name: string
): Island {
  return { x, y, cellsX, cellsY, cellPx, name };
}

const twoSquares: Preset = {
  id: "two-squares",
  label: "Two squares (sanity)",
  template: {
    width: TEMPLATE_SIZE,
    height: TEMPLATE_SIZE,
    islands: [
      makeIsland(96, 96, 16, 16, 24, "Region A (top-left)"),
      makeIsland(544, 544, 16, 16, 24, "Region B (bottom-right)")
    ]
  },
  defaultPrompts: [
    "stylised brick wall with mortar joints, two distinct brick tones",
    "cracked sheet of glass, mostly transparent grey with bright crack lines"
  ]
};

const cubeCross: Preset = (() => {
  const cell = 14;
  const cells = 16;
  const islSize = cells * cell;
  const gap = 16;
  // Centre the cross horizontally and vertically.
  // Layout (cells laid out as faces of a cube):
  //          [  +Y  ]
  //  [ -X ][ +Z ][ +X ][ -Z ]
  //          [  -Y  ]
  const rowH = islSize + gap;
  const colW = islSize + gap;
  const cx = TEMPLATE_SIZE / 2;
  const cy = TEMPLATE_SIZE / 2;
  // Row 1 has a single face at column 1 (above +Z).
  // Row 2 has 4 faces.
  // Row 3 has a single face at column 1 (below +Z).
  const startY = cy - 1.5 * rowH;
  const row1Y = startY;
  const row2Y = startY + rowH;
  const row3Y = startY + 2 * rowH;
  const startX = cx - 2 * colW;
  return {
    id: "cube-cross",
    label: "Cube unwrap (6 faces)",
    template: {
      width: TEMPLATE_SIZE,
      height: TEMPLATE_SIZE,
      islands: [
        makeIsland(Math.round(startX + 1 * colW), Math.round(row1Y), cells, cells, cell, "+Y (top)"),
        makeIsland(Math.round(startX + 0 * colW), Math.round(row2Y), cells, cells, cell, "-X (left)"),
        makeIsland(Math.round(startX + 1 * colW), Math.round(row2Y), cells, cells, cell, "+Z (front)"),
        makeIsland(Math.round(startX + 2 * colW), Math.round(row2Y), cells, cells, cell, "+X (right)"),
        makeIsland(Math.round(startX + 3 * colW), Math.round(row2Y), cells, cells, cell, "-Z (back)"),
        makeIsland(Math.round(startX + 1 * colW), Math.round(row3Y), cells, cells, cell, "-Y (bottom)")
      ]
    },
    defaultPrompts: [
      "wooden plank top of a crate viewed from above, brown planks with darker grain",
      "side of a wooden crate with vertical planks and metal corner brackets",
      "front of a wooden crate with a stencilled red arrow",
      "side of a wooden crate with vertical planks and metal corner brackets",
      "back of a wooden crate, plain wooden planks no markings",
      "wooden plank bottom of a crate, plain wooden planks no markings"
    ]
  };
})();

const paneUnwrap: Preset = (() => {
  // Glass pane unwrap: front + back + 4 thin edges.
  // Top/bottom edges are horizontal strips (W × D); left/right are vertical
  // strips (D × H). Sized so everything fits 1024×1024 with breathing room
  // around the magenta outlines.
  //
  //  ┌────────────────┐  ┌────────┐
  //  │                │  │  Back  │
  //  │     Front      │  │ 16×16  │
  //  │     32×32      │  └────────┘
  //  │     18 px      │
  //  │   = 576×576    │  ┌──┐ ┌──┐
  //  │                │  │L │ │R │  vertical
  //  └────────────────┘  │ │ │ │   4×32, 12 px
  //  ┌────────────────┐  └──┘ └──┘
  //  │ Top   32×4     │
  //  └────────────────┘
  //  ┌────────────────┐
  //  │ Bottom 32×4    │
  //  └────────────────┘

  const frontCells = 32;
  const frontCell = 18;
  const frontSize = frontCells * frontCell; // 576

  const backCells = 16;
  const backCell = 18;
  const backSize = backCells * backCell; // 288

  const edgeLong = 32;
  const edgeShort = 4;
  const edgeCell = 12;

  const padX = 32;
  const padY = 32;

  // Front in the top-left
  const frontX = padX;
  const frontY = padY;

  // Back to the right of front
  const backX = frontX + frontSize + 32; // 640
  const backY = padY;

  // Horizontal edges below the front face
  const horizY1 = frontY + frontSize + 32; // 640
  const horizY2 = horizY1 + edgeShort * edgeCell + 32; // 720

  // Vertical edges to the right, below the back face
  const vertY = backY + backSize + 32; // 352
  const leftVX = backX;
  const rightVX = leftVX + edgeShort * edgeCell + 32; // 720

  return {
    id: "pane-unwrap",
    label: "Pane unwrap (front + back + 4 edges)",
    template: {
      width: TEMPLATE_SIZE,
      height: TEMPLATE_SIZE,
      islands: [
        makeIsland(frontX, frontY, frontCells, frontCells, frontCell, "Front face"),
        makeIsland(backX, backY, backCells, backCells, backCell, "Back face"),
        makeIsland(frontX, horizY1, edgeLong, edgeShort, edgeCell, "Top edge (horizontal strip)"),
        makeIsland(frontX, horizY2, edgeLong, edgeShort, edgeCell, "Bottom edge (horizontal strip)"),
        makeIsland(leftVX, vertY, edgeShort, edgeLong, edgeCell, "Left edge (vertical strip)"),
        makeIsland(rightVX, vertY, edgeShort, edgeLong, edgeCell, "Right edge (vertical strip)")
      ]
    },
    defaultPrompts: [
      "cracked glass pane, mostly transparent grey with bright cyan crack lines radiating from a central impact point",
      "cracked glass viewed from behind, same crack pattern mirrored",
      "thin strip of dark metal frame edge",
      "thin strip of dark metal frame edge",
      "thin strip of dark metal frame edge",
      "thin strip of dark metal frame edge"
    ]
  };
})();

export const PRESETS: Preset[] = [twoSquares, cubeCross, paneUnwrap];

export function getPreset(id: string): Preset {
  const p = PRESETS.find((p) => p.id === id);
  if (!p) throw new Error(`Unknown preset: ${id}`);
  return p;
}
