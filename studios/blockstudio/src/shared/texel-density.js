import { ensureArray, isPlainObject, readNumber, readString } from "./utils.js";

const DEFAULT_BASE_UNIT_CM = 128;
const DEFAULT_GAME_PIXELS_PER_BASE_UNIT = {
  horizontal: 32,
  vertical: 16
};
const DEFAULT_MODEL_UNITS_PER_BASE_UNIT = 128;
const DEFAULT_DENSITY_AXIS = "horizontal";
const DEFAULT_DISPLAY_SCALE = 2;
const DEFAULT_PIXELS_PER_GAME_PIXEL = {
  minimum: 1,
  default: 2,
  presets: [1, 2, 4]
};

export function normalizeGameRenderContract(input = {}) {
  const densityInput = normalizeDensityInput(input.texturePixelsPerGamePixel);
  const projection = normalizeProjection(input.projection);
  const baseUnitCm = positive(readNumber(input.baseUnitCm, DEFAULT_BASE_UNIT_CM), DEFAULT_BASE_UNIT_CM);
  const modelUnitsPerBaseUnit = positive(
    readNumber(
      input.modelUnitsPerBaseUnit ?? input.authoringUnitsPerBaseUnit ?? input.gridUnit,
      DEFAULT_MODEL_UNITS_PER_BASE_UNIT
    ),
    DEFAULT_MODEL_UNITS_PER_BASE_UNIT
  );
  const gamePixelsPerBaseUnit = {
    horizontal: positive(
      readNumber(
        input.gamePixelsPerBaseUnit?.horizontal,
        DEFAULT_GAME_PIXELS_PER_BASE_UNIT.horizontal
      ),
      DEFAULT_GAME_PIXELS_PER_BASE_UNIT.horizontal
    ),
    vertical: positive(
      readNumber(
        input.gamePixelsPerBaseUnit?.vertical,
        DEFAULT_GAME_PIXELS_PER_BASE_UNIT.vertical
      ),
      DEFAULT_GAME_PIXELS_PER_BASE_UNIT.vertical
    )
  };
  const densityAxis = normalizeAxis(input.densityAxis);
  const defaultDisplayScale = positive(
    readNumber(input.defaultDisplayScale ?? input.basePixelZoom, DEFAULT_DISPLAY_SCALE),
    DEFAULT_DISPLAY_SCALE
  );
  const minimumPixelsPerGamePixel = positive(
    readNumber(
      densityInput.minimum,
      DEFAULT_PIXELS_PER_GAME_PIXEL.minimum
    ),
    DEFAULT_PIXELS_PER_GAME_PIXEL.minimum
  );
  const defaultPixelsPerGamePixel = positive(
    readNumber(
      densityInput.default,
      DEFAULT_PIXELS_PER_GAME_PIXEL.default
    ),
    DEFAULT_PIXELS_PER_GAME_PIXEL.default
  );
  const presets = normalizePresetValues(
    densityInput.presets,
    [minimumPixelsPerGamePixel, defaultPixelsPerGamePixel, ...DEFAULT_PIXELS_PER_GAME_PIXEL.presets]
  );

  const derived = buildDerivedMetrics({
    baseUnitCm,
    gamePixelsPerBaseUnit,
    modelUnitsPerBaseUnit,
    densityAxis,
    texturePixelsPerGamePixelPresets: presets,
    defaultDisplayScale
  });

  return {
    projection,
    baseUnitCm,
    gamePixelsPerBaseUnit,
    modelUnitsPerBaseUnit,
    densityAxis,
    defaultDisplayScale,
    texturePixelsPerGamePixel: {
      minimum: minimumPixelsPerGamePixel,
      default: defaultPixelsPerGamePixel,
      presets
    },
    derived
  };
}

export function deriveTextureProfile({
  authoringUnitsPerBaseUnit,
  wallSpan,
  wallHeight,
  textureProfile = {},
  renderContract = {}
} = {}) {
  const resolvedAuthoringUnitsPerBaseUnit = positive(
    readNumber(
      authoringUnitsPerBaseUnit ??
        renderContract.modelUnitsPerBaseUnit ??
        renderContract.authoringUnitsPerBaseUnit ??
        renderContract.gridUnit,
      DEFAULT_MODEL_UNITS_PER_BASE_UNIT
    ),
    DEFAULT_MODEL_UNITS_PER_BASE_UNIT
  );
  const resolvedWallSpan = positive(
    readNumber(
      wallSpan ?? textureProfile.wallSpan ?? textureProfile.tileWidth,
      resolvedAuthoringUnitsPerBaseUnit
    ),
    resolvedAuthoringUnitsPerBaseUnit
  );
  const resolvedWallHeight = positive(
    readNumber(wallHeight, resolvedWallSpan),
    resolvedWallSpan
  );
  const contract = normalizeGameRenderContract({
    ...(renderContract || {}),
    modelUnitsPerBaseUnit: resolvedAuthoringUnitsPerBaseUnit
  });
  const densityAxis = normalizeAxis(textureProfile.densityAxis || contract.densityAxis);
  const texturePixelsPerGamePixel = positive(
    readNumber(
      textureProfile.texturePixelsPerGamePixel,
      contract.texturePixelsPerGamePixel.default
    ),
    contract.texturePixelsPerGamePixel.default
  );
  const fallbackUvSize = Math.max(
    1,
    Math.round(
      positive(
        readNumber(
          textureProfile.uvSize,
          Math.max(resolvedWallSpan, resolvedWallHeight, resolvedAuthoringUnitsPerBaseUnit)
        ),
        Math.max(resolvedWallSpan, resolvedWallHeight, resolvedAuthoringUnitsPerBaseUnit)
      )
    )
  );
  const uvWidth = Math.max(
    1,
    Math.round(
      positive(readNumber(textureProfile.uvWidth ?? textureProfile.uvSize, fallbackUvSize), fallbackUvSize)
    )
  );
  const uvHeight = Math.max(
    1,
    Math.round(
      positive(readNumber(textureProfile.uvHeight ?? textureProfile.uvSize, fallbackUvSize), fallbackUvSize)
    )
  );
  const gamePixelsPerModelUnit =
    contract.gamePixelsPerBaseUnit[densityAxis] / contract.modelUnitsPerBaseUnit;
  const targetTexelsPerModelUnit = gamePixelsPerModelUnit * texturePixelsPerGamePixel;
  const defaultResolution = Math.max(
    1,
    Math.round(Math.max(uvWidth, uvHeight) * targetTexelsPerModelUnit)
  );
  const resolution = Math.max(
    1,
    Math.round(
      positive(readNumber(textureProfile.resolution, defaultResolution), defaultResolution)
    )
  );
  const texelsPerModelUnit = {
    x: round(resolution / uvWidth),
    y: round(resolution / uvHeight)
  };
  const density = {
    x: round(texelsPerModelUnit.x * 16),
    y: round(texelsPerModelUnit.y * 16)
  };
  const centimetersPerModelUnit = contract.baseUnitCm / contract.modelUnitsPerBaseUnit;
  const centimetersPerTexturePixel = {
    x: round(centimetersPerModelUnit / texelsPerModelUnit.x),
    y: round(centimetersPerModelUnit / texelsPerModelUnit.y)
  };
  const gamePixelsPerTexturePixel = {
    horizontal: round(
      centimetersPerTexturePixel.x / contract.derived.centimetersPerGamePixel.horizontal
    ),
    vertical: round(
      centimetersPerTexturePixel.y / contract.derived.centimetersPerGamePixel.vertical
    )
  };

  return {
    wallMaterial: readString(textureProfile.wallMaterial, "plaster"),
    trimMaterial: readString(textureProfile.trimMaterial, "wood"),
    accentMaterial: readString(textureProfile.accentMaterial, "painted_wood"),
    // Ground kits (and anything with per-tile materials) pass a map keyed
    // by tile name. Forward it untouched so downstream consumers can hand
    // it to buildBlenderMaterialMap().
    tileMaterials:
      textureProfile.tileMaterials && typeof textureProfile.tileMaterials === "object"
        ? { ...textureProfile.tileMaterials }
        : undefined,
    resolution,
    uvWidth,
    uvHeight,
    uvSize: uvWidth === uvHeight ? uvWidth : undefined,
    densityAxis,
    texturePixelsPerGamePixel,
    texelsPerModelUnit,
    density,
    densityLabel:
      density.x === density.y ? `${density.x}x` : `${density.x}x/${density.y}x`,
    centimetersPerTexturePixel,
    gamePixelsPerTexturePixel,
    renderContract: summarizeContract(contract)
  };
}

export function defaultGeneralRenderContract() {
  return normalizeGameRenderContract({});
}

function buildDerivedMetrics({
  baseUnitCm,
  gamePixelsPerBaseUnit,
  modelUnitsPerBaseUnit,
  densityAxis,
  texturePixelsPerGamePixelPresets,
  defaultDisplayScale
}) {
  const centimetersPerGamePixel = {
    horizontal: round(baseUnitCm / gamePixelsPerBaseUnit.horizontal),
    vertical: round(baseUnitCm / gamePixelsPerBaseUnit.vertical)
  };
  const centimetersPerModelUnit = round(baseUnitCm / modelUnitsPerBaseUnit);
  const gamePixelsPerModelUnit = {
    horizontal: round(gamePixelsPerBaseUnit.horizontal / modelUnitsPerBaseUnit),
    vertical: round(gamePixelsPerBaseUnit.vertical / modelUnitsPerBaseUnit)
  };

  return {
    centimetersPerGamePixel,
    centimetersPerModelUnit,
    gamePixelsPerModelUnit,
    lowResolutionContract: {
      horizontal: gamePixelsPerBaseUnit.horizontal,
      vertical: gamePixelsPerBaseUnit.vertical
    },
    displayContractAtDefaultScale: {
      horizontal: gamePixelsPerBaseUnit.horizontal * defaultDisplayScale,
      vertical: gamePixelsPerBaseUnit.vertical * defaultDisplayScale
    },
    densityPresets: texturePixelsPerGamePixelPresets.map((value) =>
      createDensityPreset({
        texturePixelsPerGamePixel: value,
        gamePixelsPerModelUnit: gamePixelsPerModelUnit[densityAxis],
        centimetersPerModelUnit,
        centimetersPerGamePixel,
        modelUnitsPerBaseUnit
      })
    )
  };
}

function createDensityPreset({
  texturePixelsPerGamePixel,
  gamePixelsPerModelUnit,
  centimetersPerModelUnit,
  centimetersPerGamePixel,
  modelUnitsPerBaseUnit
}) {
  const texelsPerModelUnit = round(gamePixelsPerModelUnit * texturePixelsPerGamePixel);
  const centimetersPerTexturePixel = round(centimetersPerModelUnit / texelsPerModelUnit);
  return {
    texturePixelsPerGamePixel,
    texelsPerModelUnit,
    texelsPerBaseUnit: round(texelsPerModelUnit * modelUnitsPerBaseUnit),
    density: round(texelsPerModelUnit * 16),
    centimetersPerTexturePixel,
    horizontalGamePixelsPerTexturePixel: round(
      centimetersPerTexturePixel / centimetersPerGamePixel.horizontal
    ),
    verticalGamePixelsPerTexturePixel: round(
      centimetersPerTexturePixel / centimetersPerGamePixel.vertical
    )
  };
}

function summarizeContract(contract) {
  return {
    projection: contract.projection,
    baseUnitCm: contract.baseUnitCm,
    gamePixelsPerBaseUnit: contract.gamePixelsPerBaseUnit,
    modelUnitsPerBaseUnit: contract.modelUnitsPerBaseUnit,
    densityAxis: contract.densityAxis
  };
}

function normalizeDensityInput(value) {
  if (typeof value === "number") {
    return {
      default: value
    };
  }
  if (isPlainObject(value)) {
    return value;
  }
  return {};
}

function normalizePresetValues(input, requiredValues = []) {
  const presets = ensureArray(input)
    .map((value) => Math.round(positive(readNumber(value, NaN), NaN)))
    .filter((value) => Number.isFinite(value) && value > 0);
  const merged = Array.from(new Set([...requiredValues, ...presets]))
    .filter((value) => Number.isFinite(value) && value > 0)
    .sort((left, right) => left - right);
  return merged.length > 0 ? merged : [...DEFAULT_PIXELS_PER_GAME_PIXEL.presets];
}

function normalizeAxis(value) {
  return readString(value, DEFAULT_DENSITY_AXIS) === "vertical"
    ? "vertical"
    : DEFAULT_DENSITY_AXIS;
}

function normalizeProjection(value) {
  return readString(value, "ortho_iso_2_to_1") || "ortho_iso_2_to_1";
}

function positive(value, fallback) {
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function round(value) {
  return Math.round(value * 1000) / 1000;
}
