import type {
  PieceKind,
  WallDimensions,
  OpeningDesc,
  TrimProfile,
  MaterialParams,
  PieceConfig,
  TextureResolution,
} from "./types";

export const DEFAULT_DIMENSIONS: WallDimensions = {
  width: 1.0,
  height: 2.5,
  thickness: 0.2,
};

export const DEFAULT_OPENING: OpeningDesc = {
  offsetX: 0,
  offsetY: 0.8,
  width: 0.6,
  height: 1.2,
  archRadius: 0,
};

export const DEFAULT_TRIM: TrimProfile = {
  enabled: false,
  depth: 0.02,
  width: 0.05,
  topEnabled: true,
  bottomEnabled: true,
  openingEnabled: true,
};

export const DEFAULT_MATERIAL: MaterialParams = {
  kind: "brick",
  baseColor: [0.65, 0.22, 0.15],
  accentColor: [0.55, 0.55, 0.5],
  patternScale: 1.0,
  weathering: 0.3,
  grimeIntensity: 0.2,
  crackDensity: 0.1,
  seed: 42,
};

export const ALL_PIECE_KINDS: PieceKind[] = [
  "wall-straight",
  "wall-corner-inner",
  "wall-corner-outer",
  "wall-end-cap",
  "wall-window",
  "wall-door",
  "fence-straight",
  "fence-corner",
];

export const PHASE1_PIECES: PieceKind[] = [
  "wall-straight",
  "wall-corner-inner",
  "wall-corner-outer",
  "wall-end-cap",
  "wall-window",
  "wall-door",
];

export function hasOpening(kind: PieceKind): boolean {
  return kind === "wall-window" || kind === "wall-door";
}

export function isFence(kind: PieceKind): boolean {
  return kind === "fence-straight" || kind === "fence-corner";
}

export function isCorner(kind: PieceKind): boolean {
  return kind === "wall-corner-inner" || kind === "wall-corner-outer" || kind === "fence-corner";
}

export function defaultPieceConfig(
  kind: PieceKind = "wall-straight",
  overrides?: Partial<PieceConfig>,
): PieceConfig {
  return {
    kind,
    dimensions: overrides?.dimensions ?? { ...DEFAULT_DIMENSIONS },
    material: overrides?.material ?? { ...DEFAULT_MATERIAL },
    opening: overrides?.opening ?? { ...DEFAULT_OPENING },
    trim: overrides?.trim ?? { ...DEFAULT_TRIM },
    textureResolution: overrides?.textureResolution ?? (512 as TextureResolution),
  };
}
