/** Parameters for PBR map derivation from a baseColor image. */
export type PbrParams = {
  /** Normal map strength multiplier (Sobel gradient scale). */
  strength: number;
  /** Base roughness level (darker pixels add on top of this). */
  baseRoughness: number;
  /** How much roughness varies with luminance. */
  roughnessRange: number;
  /** Minimum AO value — prevents harsh crevice darkening under ACES. */
  aoFloor: number;
  /** AO edge magnitude multiplier. */
  aoMultiplier: number;
};

/** Derived PBR map set. */
export type GeneratedMaps = {
  baseColor: ImageData;
  normal: ImageData;
  arm: ImageData;
};

/** A material role within a kit, mapping to a blockstudio_<role> material name. */
export type MaterialRole = {
  /** Role key — e.g. "wall", "trim", "asphalt". Used as blockstudio_{role} in GLBs. */
  role: string;
  /** Registry material ID — e.g. "white_plaster_02". */
  materialId: string;
};

/** Tileset info extracted from tileset.json for the control panel. */
export type KitInfo = {
  id: string;
  name: string;
  kind: "wall_kit" | "ground";
  roles: MaterialRole[];
};

export const DEFAULT_PBR_PARAMS: PbrParams = {
  strength: 1.5,
  baseRoughness: 0.75,
  roughnessRange: 0.15,
  aoFloor: 0.55,
  aoMultiplier: 1.5
};
