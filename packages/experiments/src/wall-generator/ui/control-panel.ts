import type { WallGenState, WallGenAction, PreviewMode } from "./state";
import type { PieceKind, MaterialKind, TextureResolution } from "../model/types";
import { ALL_PIECE_KINDS } from "../model/piece-catalog";
import {
  createPanel,
  createSection,
  createSlider,
  createDropdown,
  createColorPicker,
  createCheckbox,
  createNumberInput,
  createButton,
  createToggleRow,
  createProgressBar,
} from "./dom-helpers";
import { hasOpening } from "../model/piece-catalog";

const PIECE_LABELS: Record<PieceKind, string> = {
  "wall-straight": "Wall Straight",
  "wall-corner-inner": "Corner Inner",
  "wall-corner-outer": "Corner Outer",
  "wall-end-cap": "End Cap",
  "wall-window": "Window",
  "wall-door": "Door",
  "fence-straight": "Fence Straight",
  "fence-corner": "Fence Corner",
};

const MATERIAL_LABELS: Record<MaterialKind, string> = {
  brick: "Brick",
  plaster: "Plaster",
  concrete: "Concrete",
  "wood-paneling": "Wood Paneling",
  "corrugated-metal": "Corrugated Metal",
  "chain-link": "Chain Link",
};

const MATERIAL_KINDS: MaterialKind[] = [
  "brick", "plaster", "concrete", "wood-paneling", "corrugated-metal", "chain-link",
];

const TEXTURE_RESOLUTIONS: TextureResolution[] = [256, 512, 1024, 2048];

export type ControlPanelCallbacks = {
  onExportPiece: () => void;
  onExportTileset: () => void;
};

export function buildControlPanel(
  container: HTMLElement,
  state: WallGenState,
  dispatch: (action: WallGenAction) => void,
  callbacks: ControlPanelCallbacks,
): {
  panel: HTMLDivElement;
  update: (state: WallGenState) => void;
} {
  const panel = createPanel(container);

  // -- Piece Type --
  const pieceSection = createSection(panel, "Piece Type");
  createDropdown(
    pieceSection,
    "Type",
    ALL_PIECE_KINDS.map((k) => ({ value: k, label: PIECE_LABELS[k] })),
    state.kind,
    (v) => dispatch({ type: "SET_KIND", kind: v as PieceKind }),
  );

  // -- Dimensions --
  const dimsSection = createSection(panel, "Dimensions");
  createSlider(dimsSection, "Width", 0.5, 4, 0.1, state.dimensions.width, (v) =>
    dispatch({ type: "SET_WIDTH", value: v }),
  );
  createSlider(dimsSection, "Height", 1, 5, 0.1, state.dimensions.height, (v) =>
    dispatch({ type: "SET_HEIGHT", value: v }),
  );
  createSlider(dimsSection, "Thickness", 0.05, 0.5, 0.01, state.dimensions.thickness, (v) =>
    dispatch({ type: "SET_THICKNESS", value: v }),
  );

  // -- Material --
  const matSection = createSection(panel, "Material");
  createDropdown(
    matSection,
    "Type",
    MATERIAL_KINDS.map((k) => ({ value: k, label: MATERIAL_LABELS[k] })),
    state.material.kind,
    (v) => dispatch({ type: "SET_MATERIAL_KIND", kind: v as MaterialKind }),
  );
  createColorPicker(matSection, "Base", state.material.baseColor, (v) =>
    dispatch({ type: "SET_BASE_COLOR", color: v }),
  );
  createColorPicker(matSection, "Accent", state.material.accentColor, (v) =>
    dispatch({ type: "SET_ACCENT_COLOR", color: v }),
  );

  // -- Surface --
  const surfaceSection = createSection(panel, "Surface");
  createSlider(surfaceSection, "Pattern", 0.1, 3, 0.1, state.material.patternScale, (v) =>
    dispatch({ type: "SET_PATTERN_SCALE", value: v }),
  );
  createSlider(surfaceSection, "Weathering", 0, 1, 0.05, state.material.weathering, (v) =>
    dispatch({ type: "SET_WEATHERING", value: v }),
  );
  createSlider(surfaceSection, "Grime", 0, 1, 0.05, state.material.grimeIntensity, (v) =>
    dispatch({ type: "SET_GRIME", value: v }),
  );
  createSlider(surfaceSection, "Cracks", 0, 1, 0.05, state.material.crackDensity, (v) =>
    dispatch({ type: "SET_CRACK_DENSITY", value: v }),
  );

  // -- Opening (conditionally visible) --
  const openingSection = createSection(panel, "Opening");
  const openingSectionEl = openingSection;
  createSlider(openingSection, "Width", 0.2, 2, 0.05, state.opening.width, (v) =>
    dispatch({ type: "SET_OPENING_WIDTH", value: v }),
  );
  createSlider(openingSection, "Height", 0.3, 3, 0.05, state.opening.height, (v) =>
    dispatch({ type: "SET_OPENING_HEIGHT", value: v }),
  );
  createSlider(openingSection, "Offset X", -1.5, 1.5, 0.05, state.opening.offsetX, (v) =>
    dispatch({ type: "SET_OPENING_OFFSET_X", value: v }),
  );
  createSlider(openingSection, "Offset Y", 0, 2, 0.05, state.opening.offsetY, (v) =>
    dispatch({ type: "SET_OPENING_OFFSET_Y", value: v }),
  );

  // -- Trim --
  const trimSection = createSection(panel, "Trim");
  createCheckbox(trimSection, "Enabled", state.trim.enabled, (v) =>
    dispatch({ type: "SET_TRIM_ENABLED", value: v }),
  );
  createSlider(trimSection, "Depth", 0.005, 0.05, 0.005, state.trim.depth, (v) =>
    dispatch({ type: "SET_TRIM_DEPTH", value: v }),
  );
  createSlider(trimSection, "Width", 0.02, 0.15, 0.01, state.trim.width, (v) =>
    dispatch({ type: "SET_TRIM_WIDTH", value: v }),
  );
  createCheckbox(trimSection, "Top", state.trim.topEnabled, (v) =>
    dispatch({ type: "SET_TRIM_TOP", value: v }),
  );
  createCheckbox(trimSection, "Bottom", state.trim.bottomEnabled, (v) =>
    dispatch({ type: "SET_TRIM_BOTTOM", value: v }),
  );
  createCheckbox(trimSection, "Opening", state.trim.openingEnabled, (v) =>
    dispatch({ type: "SET_TRIM_OPENING", value: v }),
  );

  // -- Texture Resolution --
  const texSection = createSection(panel, "Texture");
  createDropdown(
    texSection,
    "Resolution",
    TEXTURE_RESOLUTIONS.map((r) => ({ value: String(r), label: `${r}x${r}` })),
    String(state.textureResolution),
    (v) => dispatch({ type: "SET_TEXTURE_RESOLUTION", value: parseInt(v) as TextureResolution }),
  );

  // -- Seed --
  const seedSection = createSection(panel, "Seed");
  createNumberInput(seedSection, "Seed", state.material.seed, (v) =>
    dispatch({ type: "SET_SEED", value: v }),
  );

  // -- Preview --
  const previewSection = createSection(panel, "Preview");
  createToggleRow(previewSection, ["orbit", "isometric"], state.previewMode, (v) =>
    dispatch({ type: "SET_PREVIEW_MODE", mode: v as PreviewMode }),
  );

  // -- Export --
  const exportSection = createSection(panel, "Export");
  const exportPieceBtn = createButton(exportSection, "Export This Piece", callbacks.onExportPiece);
  const exportTilesetBtn = createButton(
    exportSection, "Export Full Tileset", callbacks.onExportTileset, "wg-btn secondary",
  );
  const progress = createProgressBar(exportSection);

  // Update function — show/hide opening section, update progress
  function update(newState: WallGenState) {
    openingSectionEl.style.display = hasOpening(newState.kind) ? "block" : "none";
    exportPieceBtn.disabled = newState.exporting;
    exportTilesetBtn.disabled = newState.exporting;
    progress.setProgress(newState.exportProgress);
  }

  // Initial state
  update(state);

  return { panel, update };
}
