/** All plain data types — zero Three.js imports */

export type PieceKind =
  | "wall-straight"
  | "wall-corner-inner"
  | "wall-corner-outer"
  | "wall-end-cap"
  | "wall-window"
  | "wall-door"
  | "fence-straight"
  | "fence-corner";

export type WallDimensions = {
  width: number; // meters, default 1.0
  height: number; // meters, default 2.5
  thickness: number; // meters, default 0.2
};

export type OpeningDesc = {
  offsetX: number; // horizontal offset from center
  offsetY: number; // vertical offset from bottom
  width: number;
  height: number;
  archRadius: number; // 0 = rectangular
};

export type TrimProfile = {
  enabled: boolean;
  depth: number;
  width: number;
  topEnabled: boolean;
  bottomEnabled: boolean;
  openingEnabled: boolean;
};

export type MaterialKind =
  | "brick"
  | "plaster"
  | "concrete"
  | "wood-paneling"
  | "corrugated-metal"
  | "chain-link";

export type MaterialParams = {
  kind: MaterialKind;
  baseColor: [number, number, number]; // RGB 0-1
  accentColor: [number, number, number];
  patternScale: number;
  weathering: number; // 0-1
  grimeIntensity: number; // 0-1
  crackDensity: number; // 0-1
  seed: number;
};

export type Vec3 = [number, number, number];

export type MeshData = {
  positions: Float32Array;
  normals: Float32Array;
  uvs: Float32Array;
  indices: Uint32Array;
};

export type CsgSubtraction = {
  type: "box";
  position: Vec3;
  size: Vec3;
};

export type TextureResolution = 256 | 512 | 1024 | 2048;

export type PieceConfig = {
  kind: PieceKind;
  dimensions: WallDimensions;
  material: MaterialParams;
  opening: OpeningDesc;
  trim: TrimProfile;
  textureResolution: TextureResolution;
};

export type PieceConnectionPoint = {
  position: Vec3;
  direction: Vec3; // outward normal
  label: string;
};

export type PieceMetadata = {
  id: string;
  kind: PieceKind;
  materialKind: MaterialKind;
  gridSize: number;
  dimensions: WallDimensions;
  connections: PieceConnectionPoint[];
  boundingBox: { min: Vec3; max: Vec3 };
};

export type TextureShaderUniforms = {
  uBaseColor: Vec3;
  uAccentColor: Vec3;
  uPatternScale: number;
  uWeathering: number;
  uGrimeIntensity: number;
  uCrackDensity: number;
  uSeed: number;
  uAspect: number;
};

export type TilesetConfig = {
  pieces: PieceKind[];
  dimensions: WallDimensions;
  material: MaterialParams;
  opening: OpeningDesc;
  trim: TrimProfile;
  textureResolution: TextureResolution;
};

export type BatchResult = {
  pieces: Array<{
    config: PieceConfig;
    metadata: PieceMetadata;
    glb: ArrayBuffer;
  }>;
  index: { gridSize: number; pieces: string[] };
};
