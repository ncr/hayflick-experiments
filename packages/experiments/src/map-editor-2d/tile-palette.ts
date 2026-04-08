// ---------------------------------------------------------------------------
// Tile palette dock — vertical scrollable panel with one section per tileset.
// Sits between the 2D edit pane and the 3D preview pane. Designed to grow
// without stretching the top toolbar (which is reserved for global commands).
// ---------------------------------------------------------------------------

import { ERASER_BRUSH } from "./pointer-tools";
import type { LoadedTileset } from "./tileset-loader";

export const TILE_PALETTE_WIDTH = 240;

const PALETTE_BG = "linear-gradient(180deg, rgba(24, 30, 36, 0.96), rgba(12, 17, 23, 0.98))";
const PALETTE_BORDER = "1px solid rgba(128, 150, 167, 0.4)";
const SECTION_LABEL_FG = "rgba(194, 209, 220, 0.86)";
const SECTION_LABEL_BORDER = "1px solid rgba(128, 150, 167, 0.25)";
const BUTTON_BORDER = "1px solid rgba(128, 151, 169, 0.62)";
const BUTTON_BG = "linear-gradient(180deg, rgba(39, 50, 59, 0.95), rgba(21, 30, 36, 0.95))";
const BUTTON_FG = "#ebf4fa";
const BUTTON_ACTIVE_BG =
  "linear-gradient(180deg, rgba(78, 136, 177, 0.96), rgba(40, 92, 126, 0.94))";
const BUTTON_ACTIVE_BORDER = "rgba(154, 201, 232, 0.98)";
const BUTTON_ACTIVE_FG = "#ffffff";

function tileLabel(name: string): string {
  return name.replace(/_/g, " ");
}

export type TilePaletteOptions = {
  mount: HTMLElement;
  tilesets: LoadedTileset[];
  onSelect(brushKey: string): void;
  focusTarget?: HTMLElement;
  /** Distance from the top of `mount` to the top of the palette (in px). */
  topOffset: number;
};

export type TilePalette = {
  root: HTMLDivElement;
  setActiveBrush(brushKey: string): void;
  /**
   * Brush keys in keyboard-shortcut order: tile brushes first (in display
   * order), eraser last. Mirrors the legacy toolbar ordering so digit
   * shortcuts (1..9) keep selecting the same tile after the refactor.
   */
  orderedBrushKeys: string[];
  destroy(): void;
};

export function createTilePalette(options: TilePaletteOptions): TilePalette {
  const { mount, tilesets, onSelect, focusTarget, topOffset } = options;

  const root = document.createElement("div");
  root.style.position = "absolute";
  root.style.top = `${topOffset}px`;
  root.style.height = `calc(100% - ${topOffset}px)`;
  root.style.right = "45%";
  root.style.width = `${TILE_PALETTE_WIDTH}px`;
  root.style.background = PALETTE_BG;
  root.style.borderLeft = PALETTE_BORDER;
  root.style.borderRight = PALETTE_BORDER;
  root.style.zIndex = "9";
  root.style.display = "flex";
  root.style.flexDirection = "column";
  root.style.overflowY = "auto";
  root.style.overflowX = "hidden";
  root.style.padding = "10px";
  root.style.gap = "12px";
  root.style.boxSizing = "border-box";
  root.style.fontFamily = '"Rajdhani", "IBM Plex Sans", "Segoe UI", sans-serif';
  root.style.color = BUTTON_FG;
  root.style.pointerEvents = "auto";
  mount.appendChild(root);

  const buttonsByKey = new Map<string, HTMLButtonElement>();
  const tileBrushKeys: string[] = [];

  function makeButton(label: string, brushKey: string): HTMLButtonElement {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = label;
    button.style.border = BUTTON_BORDER;
    button.style.background = BUTTON_BG;
    button.style.color = BUTTON_FG;
    button.style.padding = "6px 8px";
    button.style.borderRadius = "6px";
    button.style.minHeight = "30px";
    button.style.cursor = "pointer";
    button.style.fontSize = "11px";
    button.style.fontWeight = "600";
    button.style.letterSpacing = "0.03em";
    button.style.textTransform = "uppercase";
    button.style.boxShadow = "inset 0 1px 0 rgba(255, 255, 255, 0.12)";
    button.style.transition = "filter 90ms ease";
    button.style.textAlign = "left";
    button.style.width = "100%";
    button.style.whiteSpace = "nowrap";
    button.style.overflow = "hidden";
    button.style.textOverflow = "ellipsis";
    button.addEventListener("pointerdown", () => {
      button.style.filter = "brightness(1.12)";
    });
    button.addEventListener("pointerup", () => {
      button.style.filter = "";
    });
    button.addEventListener("pointerleave", () => {
      button.style.filter = "";
    });
    button.addEventListener("click", (event) => {
      event.preventDefault();
      onSelect(brushKey);
      if (focusTarget?.focus) {
        try {
          focusTarget.focus({ preventScroll: true });
        } catch {
          focusTarget.focus();
        }
      }
    });
    buttonsByKey.set(brushKey, button);
    return button;
  }

  function makeSection(): HTMLDivElement {
    const section = document.createElement("div");
    section.style.display = "flex";
    section.style.flexDirection = "column";
    section.style.gap = "4px";
    return section;
  }

  function makeSectionLabel(text: string): HTMLDivElement {
    const labelEl = document.createElement("div");
    labelEl.textContent = text;
    labelEl.style.fontSize = "10px";
    labelEl.style.fontWeight = "700";
    labelEl.style.letterSpacing = "0.08em";
    labelEl.style.textTransform = "uppercase";
    labelEl.style.color = SECTION_LABEL_FG;
    labelEl.style.padding = "2px 2px 4px";
    labelEl.style.borderBottom = SECTION_LABEL_BORDER;
    labelEl.style.marginBottom = "2px";
    return labelEl;
  }

  // Eraser pinned at the top — always available regardless of loaded tilesets.
  const eraserSection = makeSection();
  eraserSection.appendChild(makeSectionLabel("Tools"));
  eraserSection.appendChild(makeButton("Eraser", ERASER_BRUSH));
  root.appendChild(eraserSection);

  // One section per tileset, in load order.
  for (const kit of tilesets) {
    const section = makeSection();
    section.appendChild(makeSectionLabel(tileLabel(kit.manifest.name)));
    for (const [name] of kit.tiles) {
      tileBrushKeys.push(name);
      section.appendChild(makeButton(tileLabel(name), name));
    }
    root.appendChild(section);
  }

  // Tiles first, eraser last — preserves legacy digit-shortcut indices.
  const orderedBrushKeys: string[] = [...tileBrushKeys, ERASER_BRUSH];

  function setActiveBrush(brushKey: string): void {
    for (const [key, btn] of buttonsByKey) {
      const active = key === brushKey;
      if (active) {
        btn.style.background = BUTTON_ACTIVE_BG;
        btn.style.borderColor = BUTTON_ACTIVE_BORDER;
        btn.style.color = BUTTON_ACTIVE_FG;
        btn.style.boxShadow =
          "inset 0 1px 0 rgba(255, 255, 255, 0.22), 0 0 0 1px rgba(154, 201, 232, 0.2)";
      } else {
        btn.style.background = BUTTON_BG;
        btn.style.borderColor = "";
        btn.style.color = BUTTON_FG;
        btn.style.boxShadow = "inset 0 1px 0 rgba(255, 255, 255, 0.12)";
      }
    }
  }

  function destroy(): void {
    root.remove();
  }

  return { root, setActiveBrush, orderedBrushKeys, destroy };
}
