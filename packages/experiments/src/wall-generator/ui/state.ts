import type {
  PieceKind,
  WallDimensions,
  MaterialParams,
  MaterialKind,
  OpeningDesc,
  TrimProfile,
  TextureResolution,
  PieceConfig,
} from "../model/types";
import {
  DEFAULT_DIMENSIONS,
  DEFAULT_MATERIAL,
  DEFAULT_OPENING,
  DEFAULT_TRIM,
} from "../model/piece-catalog";

export type PreviewMode = "orbit" | "isometric";

export type WallGenState = {
  kind: PieceKind;
  dimensions: WallDimensions;
  material: MaterialParams;
  opening: OpeningDesc;
  trim: TrimProfile;
  textureResolution: TextureResolution;
  previewMode: PreviewMode;
  exporting: boolean;
  exportProgress: number; // 0-1
};

export type WallGenAction =
  | { type: "SET_KIND"; kind: PieceKind }
  | { type: "SET_WIDTH"; value: number }
  | { type: "SET_HEIGHT"; value: number }
  | { type: "SET_THICKNESS"; value: number }
  | { type: "SET_MATERIAL_KIND"; kind: MaterialKind }
  | { type: "SET_BASE_COLOR"; color: [number, number, number] }
  | { type: "SET_ACCENT_COLOR"; color: [number, number, number] }
  | { type: "SET_PATTERN_SCALE"; value: number }
  | { type: "SET_WEATHERING"; value: number }
  | { type: "SET_GRIME"; value: number }
  | { type: "SET_CRACK_DENSITY"; value: number }
  | { type: "SET_SEED"; value: number }
  | { type: "SET_OPENING_WIDTH"; value: number }
  | { type: "SET_OPENING_HEIGHT"; value: number }
  | { type: "SET_OPENING_OFFSET_X"; value: number }
  | { type: "SET_OPENING_OFFSET_Y"; value: number }
  | { type: "SET_TRIM_ENABLED"; value: boolean }
  | { type: "SET_TRIM_DEPTH"; value: number }
  | { type: "SET_TRIM_WIDTH"; value: number }
  | { type: "SET_TRIM_TOP"; value: boolean }
  | { type: "SET_TRIM_BOTTOM"; value: boolean }
  | { type: "SET_TRIM_OPENING"; value: boolean }
  | { type: "SET_TEXTURE_RESOLUTION"; value: TextureResolution }
  | { type: "SET_PREVIEW_MODE"; mode: PreviewMode }
  | { type: "SET_EXPORTING"; value: boolean }
  | { type: "SET_EXPORT_PROGRESS"; value: number };

export function initialState(): WallGenState {
  return {
    kind: "wall-straight",
    dimensions: { ...DEFAULT_DIMENSIONS },
    material: { ...DEFAULT_MATERIAL },
    opening: { ...DEFAULT_OPENING },
    trim: { ...DEFAULT_TRIM },
    textureResolution: 512,
    previewMode: "orbit",
    exporting: false,
    exportProgress: 0,
  };
}

export function wallGenReducer(state: WallGenState, action: WallGenAction): WallGenState {
  switch (action.type) {
    case "SET_KIND":
      return { ...state, kind: action.kind };
    case "SET_WIDTH":
      return { ...state, dimensions: { ...state.dimensions, width: action.value } };
    case "SET_HEIGHT":
      return { ...state, dimensions: { ...state.dimensions, height: action.value } };
    case "SET_THICKNESS":
      return { ...state, dimensions: { ...state.dimensions, thickness: action.value } };
    case "SET_MATERIAL_KIND":
      return { ...state, material: { ...state.material, kind: action.kind } };
    case "SET_BASE_COLOR":
      return { ...state, material: { ...state.material, baseColor: action.color } };
    case "SET_ACCENT_COLOR":
      return { ...state, material: { ...state.material, accentColor: action.color } };
    case "SET_PATTERN_SCALE":
      return { ...state, material: { ...state.material, patternScale: action.value } };
    case "SET_WEATHERING":
      return { ...state, material: { ...state.material, weathering: action.value } };
    case "SET_GRIME":
      return { ...state, material: { ...state.material, grimeIntensity: action.value } };
    case "SET_CRACK_DENSITY":
      return { ...state, material: { ...state.material, crackDensity: action.value } };
    case "SET_SEED":
      return { ...state, material: { ...state.material, seed: action.value } };
    case "SET_OPENING_WIDTH":
      return { ...state, opening: { ...state.opening, width: action.value } };
    case "SET_OPENING_HEIGHT":
      return { ...state, opening: { ...state.opening, height: action.value } };
    case "SET_OPENING_OFFSET_X":
      return { ...state, opening: { ...state.opening, offsetX: action.value } };
    case "SET_OPENING_OFFSET_Y":
      return { ...state, opening: { ...state.opening, offsetY: action.value } };
    case "SET_TRIM_ENABLED":
      return { ...state, trim: { ...state.trim, enabled: action.value } };
    case "SET_TRIM_DEPTH":
      return { ...state, trim: { ...state.trim, depth: action.value } };
    case "SET_TRIM_WIDTH":
      return { ...state, trim: { ...state.trim, width: action.value } };
    case "SET_TRIM_TOP":
      return { ...state, trim: { ...state.trim, topEnabled: action.value } };
    case "SET_TRIM_BOTTOM":
      return { ...state, trim: { ...state.trim, bottomEnabled: action.value } };
    case "SET_TRIM_OPENING":
      return { ...state, trim: { ...state.trim, openingEnabled: action.value } };
    case "SET_TEXTURE_RESOLUTION":
      return { ...state, textureResolution: action.value };
    case "SET_PREVIEW_MODE":
      return { ...state, previewMode: action.mode };
    case "SET_EXPORTING":
      return { ...state, exporting: action.value, exportProgress: action.value ? 0 : state.exportProgress };
    case "SET_EXPORT_PROGRESS":
      return { ...state, exportProgress: action.value };
    default:
      return state;
  }
}

/**
 * Derive a PieceConfig from current state.
 */
export function stateToConfig(state: WallGenState): PieceConfig {
  return {
    kind: state.kind,
    dimensions: state.dimensions,
    material: state.material,
    opening: state.opening,
    trim: state.trim,
    textureResolution: state.textureResolution,
  };
}
