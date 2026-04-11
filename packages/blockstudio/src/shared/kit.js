import { createStyleProfile } from "./style.js";
import { deriveTextureProfile, normalizeGameRenderContract } from "./texel-density.js";
import { deepClone, ensureArray, makeId, readNumber, readString, slugify, sortByName } from "./utils.js";

export const SUPPORTED_MODULAR_KIT_KINDS = ["wall_kit", "ground"];
export const WALL_KIT_REQUIRED_PARTS = [
  "wall",
  "corner",
  "window_left",
  "window_middle",
  "window_right",
  "door",
  "floor_tile"
];

const DEFAULT_BASE_UNIT = 128;
const DEFAULT_WALL_HEIGHT = 280;
const DEFAULT_WALL_THICKNESS = 32;
const DEFAULT_FLOOR_THICKNESS = 6;
const DEFAULT_DOOR_WIDTH = 90;
const DEFAULT_DOOR_HEIGHT = 220;
const DEFAULT_DOOR_FRAME_THICKNESS = 16;
const DEFAULT_DOOR_FRAME_PROTRUSION = 3;
const DEFAULT_WINDOW_NARROW_WIDTH = 32;
const DEFAULT_WINDOW_GLASS_THICKNESS = 4;

export function normalizeModularKitSpec(input = {}) {
  const kind = normalizeKitKind(input.kind);
  switch (kind) {
    case "wall_kit": {
      const spec = normalizeWallKitSpec(input);
      spec.kind = kind;
      return spec;
    }
    case "ground": {
      const spec = normalizeGroundKitSpec(input);
      spec.kind = kind;
      return spec;
    }
    default:
      throw new Error(`Unsupported modular kit kind "${kind}".`);
  }
}

export function normalizeWallKitSpec(input = {}) {
  const baseUnit = positive(
    readNumber(
      input.baseUnit ?? input.baseUnitCm ?? input.cellSize ?? input.logicalCellSize ?? DEFAULT_BASE_UNIT,
      DEFAULT_BASE_UNIT
    ),
    DEFAULT_BASE_UNIT
  );
  const authoringUnitsPerBaseUnit = positive(
    readNumber(
      input.authoringUnitsPerBaseUnit ??
        input.gridUnit ??
        input.renderContract?.modelUnitsPerBaseUnit ??
        baseUnit,
      baseUnit
    ),
    baseUnit
  );
  const wallSpan = positive(
    readNumber(input.tileWidth ?? input.wallSpan ?? input.logicalSpan ?? baseUnit, baseUnit),
    baseUnit
  );
  const wallHeight = positive(readNumber(input.wallHeight, DEFAULT_WALL_HEIGHT), DEFAULT_WALL_HEIGHT);
  const wallThickness = positive(readNumber(input.wallThickness, DEFAULT_WALL_THICKNESS), DEFAULT_WALL_THICKNESS);
  const floorThickness = positive(readNumber(input.floorThickness, DEFAULT_FLOOR_THICKNESS), DEFAULT_FLOOR_THICKNESS);
  const renderContract = normalizeGameRenderContract({
    ...(input.renderContract || {}),
    baseUnitCm: baseUnit,
    modelUnitsPerBaseUnit: authoringUnitsPerBaseUnit
  });
  const anchorPolicy = normalizeAnchorPolicy(input.anchorPolicy ?? input.pivotPolicy);
  const door = normalizeDoor(input.door, {
    wallSpan,
    wallHeight,
    wallThickness
  });
  const windowFamilies = normalizeWindowFamilies(input.windowFamilies ?? input.windows, {
    baseUnit,
    wallSpan,
    wallHeight,
    wallThickness,
    defaultWindowNarrowWidth: positive(
      readNumber(input.windowDefaults?.narrowWidth, DEFAULT_WINDOW_NARROW_WIDTH),
      DEFAULT_WINDOW_NARROW_WIDTH
    ),
    defaultGlassThickness: positive(
      readNumber(input.windowDefaults?.glassThickness, DEFAULT_WINDOW_GLASS_THICKNESS),
      DEFAULT_WINDOW_GLASS_THICKNESS
    )
  });
  const catalogWindowSource = normalizeCatalogWindowSource(input.catalogWindowSource, windowFamilies);

  const spec = {
    id: makeId("spec"),
    kind: "wall_kit",
    name: readString(input.name, "wall_kit"),
    baseUnit,
    authoringUnitsPerBaseUnit,
    wallSpan,
    wallHeight,
    wallThickness,
    floorThickness,
    renderContract,
    anchorPolicy,
    door,
    windowFamilies,
    catalogWindowSource,
    includeFloorTile: input.includeFloorTile !== false,
    includeWindowRight: input.includeWindowRight !== false,
    includeCorners: input.includeCorners !== false,
    includeEndCaps: input.includeEndCaps === true,
    textureProfile: deriveTextureProfile({
      authoringUnitsPerBaseUnit,
      wallSpan,
      wallHeight,
      textureProfile: input.textureProfile || {},
      renderContract
    })
  };

  spec.parts = buildPartCatalog(spec);
  return spec;
}

export function normalizeGroundKitSpec(input = {}) {
  const baseUnit = positive(
    readNumber(
      input.baseUnit ?? input.baseUnitCm ?? input.cellSize ?? DEFAULT_BASE_UNIT,
      DEFAULT_BASE_UNIT
    ),
    DEFAULT_BASE_UNIT
  );
  const authoringUnitsPerBaseUnit = positive(
    readNumber(
      input.authoringUnitsPerBaseUnit ?? input.gridUnit ?? baseUnit,
      baseUnit
    ),
    baseUnit
  );
  const floorThickness = positive(readNumber(input.floorThickness, DEFAULT_FLOOR_THICKNESS), DEFAULT_FLOOR_THICKNESS);
  const renderContract = normalizeGameRenderContract({
    ...(input.renderContract || {}),
    baseUnitCm: baseUnit,
    modelUnitsPerBaseUnit: authoringUnitsPerBaseUnit
  });
  const anchorPolicy = normalizeAnchorPolicy(input.anchorPolicy ?? input.pivotPolicy);

  const tiles = ensureArray(input.tiles);
  if (tiles.length === 0) {
    tiles.push({ name: "floor_tile" });
  }

  const spec = {
    id: makeId("spec"),
    kind: "ground",
    name: readString(input.name, "ground_kit"),
    baseUnit,
    authoringUnitsPerBaseUnit,
    floorThickness,
    renderContract,
    anchorPolicy,
    tiles: tiles.map((tile) => ({
      name: slugify(readString(tile.name, "tile"))
    })),
    textureProfile: deriveTextureProfile({
      authoringUnitsPerBaseUnit,
      wallSpan: baseUnit,
      wallHeight: baseUnit,
      textureProfile: input.textureProfile || {},
      renderContract
    })
  };

  spec.parts = buildGroundPartCatalog(spec);
  return spec;
}

function buildGroundPartCatalog(spec) {
  return sortByName(
    spec.tiles.map((tile) =>
      createPart({
        name: tile.name,
        kind: "floor_tile",
        role: "floor_tile",
        dimensions: [spec.baseUnit, spec.floorThickness, spec.baseUnit],
        meshEnvelope: [spec.baseUnit, spec.floorThickness, spec.baseUnit],
        anchor: {
          class: spec.anchorPolicy.snap.floor,
          policy: spec.anchorPolicy.policy
        },
        logicalFootprint: {
          type: "cell",
          widthUnits: spec.baseUnit,
          depthUnits: spec.baseUnit,
          widthCells: 1,
          depthCells: 1,
          baseUnit: spec.baseUnit
        }
      })
    )
  );
}

export function createModularKitDefinition({ kind, spec, styleProfile }) {
  const normalizedSpec = normalizeModularKitSpec({
    ...(spec || {}),
    kind: kind || spec?.kind
  });
  const normalizedStyle = styleProfile ? deepClone(styleProfile) : createStyleProfile({});
  return {
    id: makeId("kit"),
    kind: normalizedSpec.kind,
    name: normalizedSpec.name,
    spec: normalizedSpec,
    styleProfileId: normalizedStyle.id,
    partCatalog: normalizedSpec.parts,
    summary: summarizeKit(normalizedSpec)
  };
}

export function createKitDefinition({ spec, styleProfile }) {
  return createModularKitDefinition({
    kind: spec?.kind || "wall_kit",
    spec,
    styleProfile
  });
}

export function createModularKitVariantFromRequest(kitDefinition, variantRequest = {}) {
  const kind = normalizeKitKind(kitDefinition?.kind || kitDefinition?.spec?.kind);
  if (kind !== "wall_kit") {
    throw new Error(`Unsupported modular kit kind "${kind}".`);
  }

  const nextSpec = deepClone(kitDefinition.spec);
  const targetFamilyName = readString(
    variantRequest.familyName,
    nextSpec.windowFamilies[0]?.name || "window_family"
  );
  const targetFamily = nextSpec.windowFamilies.find((family) => family.name === targetFamilyName);

  if (!targetFamily) {
    throw new Error(`Window family "${targetFamilyName}" does not exist in kit ${kitDefinition.id}`);
  }

  const variant = normalizeWindowVariant(variantRequest.variant, targetFamily);
  targetFamily.variants.push(variant);
  nextSpec.parts = buildPartCatalog(nextSpec);

  return {
    id: makeId("kit"),
    kind,
    name: nextSpec.name,
    spec: nextSpec,
    styleProfileId: kitDefinition.styleProfileId,
    partCatalog: nextSpec.parts,
    summary: summarizeKit(nextSpec)
  };
}

export function createVariantFromRequest(kitDefinition, variantRequest = {}) {
  return createModularKitVariantFromRequest(kitDefinition, variantRequest);
}

export function validateModularKitSpec(spec) {
  const kind = normalizeKitKind(spec?.kind);
  switch (kind) {
    case "wall_kit":
      return validateKitSpec(spec);
    case "ground":
      return validateGroundKitSpec(spec);
    default:
      return [`Unsupported modular kit kind "${kind}".`];
  }
}

function validateGroundKitSpec(spec) {
  const issues = [];
  if (!spec.tiles || spec.tiles.length === 0) {
    issues.push("Ground kit must define at least one tile.");
  }
  const names = new Set();
  for (const tile of spec.tiles || []) {
    if (names.has(tile.name)) {
      issues.push(`Duplicate tile name "${tile.name}".`);
    }
    names.add(tile.name);
  }
  return issues;
}

export function validateKitSpec(spec) {
  const issues = [];
  if (spec.door.width >= spec.wallSpan) {
    issues.push("Door width must be smaller than the logical wall span.");
  }
  if (spec.door.height >= spec.wallHeight) {
    issues.push("Door height must be smaller than the wall height.");
  }
  for (const family of spec.windowFamilies) {
    if (family.sillHeight + family.openingHeight > spec.wallHeight) {
      issues.push(`Window family "${family.name}" exceeds the wall height.`);
    }
    if (family.leftWidth >= spec.wallSpan) {
      issues.push(`Window family "${family.name}" left wall segment must be narrower than one logical wall tile.`);
    }
    if (family.rightWidth >= spec.wallSpan) {
      issues.push(`Window family "${family.name}" right wall segment must be narrower than one logical wall tile.`);
    }
  }
  return issues;
}

export function summarizeKit(spec) {
  return {
    kind: spec.kind || "wall_kit",
    baseUnit: spec.baseUnit,
    wallSpan: spec.wallSpan,
    wallHeight: spec.wallHeight,
    wallThickness: spec.wallThickness,
    anchorPolicy: deepClone(spec.anchorPolicy),
    parts: spec.parts.map((part) => ({
      name: part.name,
      kind: part.kind,
      role: part.role || null,
      anchorClass: part.anchor?.class || null,
      articulation: part.articulation?.type || null
    }))
  };
}

function normalizeAnchorPolicy(input = {}) {
  return {
    policy: readString(input?.policy, "first_logical_unit"),
    snap: {
      floor: readString(input?.snap?.floor, "cell_center"),
      wall: readString(input?.snap?.wall ?? input?.placement, "edge_midpoint"),
      corner: readString(input?.snap?.corner, "vertex"),
      endCap: readString(input?.snap?.endCap, "edge_midpoint")
    },
    articulation: {
      hinged: readString(input?.articulation?.hinged, "hinge_edge"),
      casement_window: readString(input?.articulation?.casement_window, "mounted_side")
    }
  };
}

function normalizeDoor(input = {}, context) {
  const width = positive(readNumber(input?.width, DEFAULT_DOOR_WIDTH), DEFAULT_DOOR_WIDTH);
  const height = positive(readNumber(input?.height, DEFAULT_DOOR_HEIGHT), DEFAULT_DOOR_HEIGHT);
  return {
    width,
    height,
    frameThickness: positive(
      readNumber(input?.frameThickness, DEFAULT_DOOR_FRAME_THICKNESS),
      DEFAULT_DOOR_FRAME_THICKNESS
    ),
    frameProtrusion: positive(
      readNumber(input?.frameProtrusion, DEFAULT_DOOR_FRAME_PROTRUSION),
      DEFAULT_DOOR_FRAME_PROTRUSION
    ),
    thickness: positive(
      readNumber(input?.thickness, Math.max(4, Math.round(context.wallThickness / 6))),
      Math.max(4, Math.round(context.wallThickness / 6))
    ),
    hingeSide: normalizeHingeSide(input?.hingeSide),
    openAngle: readNumber(input?.openAngle, 90)
  };
}

function normalizeWindowFamilies(input, context) {
  const families = ensureArray(input);
  if (families.length === 0) {
    return [
      normalizeWindowFamily(
        {
          name: "vertical_black_panel",
          leftWidth: DEFAULT_DOOR_FRAME_THICKNESS,
          middleWidth: context.defaultWindowNarrowWidth,
          rightWidth: DEFAULT_DOOR_FRAME_THICKNESS,
          sillHeight: 0,
          openingHeight: context.wallHeight,
          variants: [{ name: "fixed", articulation: { type: "fixed" } }]
        },
        context
      )
    ];
  }

  return sortByName(
    families.map((family) => normalizeWindowFamily(family, context))
  );
}

function normalizeWindowFamily(input = {}, context) {
  return {
    name: readString(input.name, "window_family"),
    leftWidth: positive(readNumber(input.leftWidth, DEFAULT_DOOR_FRAME_THICKNESS), DEFAULT_DOOR_FRAME_THICKNESS),
    middleWidth: positive(readNumber(input.middleWidth, context.defaultWindowNarrowWidth), context.defaultWindowNarrowWidth),
    rightWidth: positive(readNumber(input.rightWidth, DEFAULT_DOOR_FRAME_THICKNESS), DEFAULT_DOOR_FRAME_THICKNESS),
    sillHeight: positive(readNumber(input.sillHeight, 0), 0),
    openingHeight: positive(readNumber(input.openingHeight, context.wallHeight), context.wallHeight),
    frameThickness: positive(readNumber(input.frameThickness, DEFAULT_DOOR_FRAME_THICKNESS), DEFAULT_DOOR_FRAME_THICKNESS),
    glassThickness: positive(readNumber(input.glassThickness, context.defaultGlassThickness), context.defaultGlassThickness),
    repeatableMiddlePanels: positive(readNumber(input.repeatableMiddlePanels, 1), 1),
    variants: ensureArray(input.variants).length > 0
      ? ensureArray(input.variants).map((variant) => normalizeWindowVariant(variant, input))
      : [normalizeWindowVariant({ name: "fixed", articulation: { type: "fixed" } }, input)]
  };
}

function normalizeWindowVariant(input = {}, family = {}) {
  const name = readString(input.name, "variant");
  const articulationType = readString(input.articulation?.type, "fixed");
  return {
    name,
    trimStyle: readString(input.trimStyle, "plain"),
    mullionStyle: readString(input.mullionStyle, "single"),
    articulation: {
      type: articulationType,
      hingeSide: normalizeHingeSide(input.articulation?.hingeSide),
      pivotRole: articulationType.startsWith("casement")
        ? "hinge_edge"
        : articulationType === "sliding"
          ? "rail"
          : "none"
    },
    repeatableMiddlePanels: positive(readNumber(input.repeatableMiddlePanels, family.repeatableMiddlePanels ?? 1), family.repeatableMiddlePanels ?? 1)
  };
}

function normalizeCatalogWindowSource(input = {}, windowFamilies = []) {
  const fallbackFamily = windowFamilies[0] || null;
  if (!fallbackFamily) {
    return null;
  }

  const familyName = readString(input?.familyName, fallbackFamily.name);
  const family = windowFamilies.find((entry) => entry.name === familyName) || fallbackFamily;
  const fallbackVariant = family.variants[0] || null;
  if (!fallbackVariant) {
    return null;
  }

  const variantName = readString(input?.variantName, fallbackVariant.name);
  const variant = family.variants.find((entry) => entry.name === variantName) || fallbackVariant;

  return {
    familyName: family.name,
    variantName: variant.name
  };
}

function resolveCatalogWindowSource(spec) {
  const fallbackFamily = spec?.windowFamilies?.[0] || null;
  if (!fallbackFamily) {
    return null;
  }
  const source = spec?.catalogWindowSource || {};
  const family =
    spec.windowFamilies.find((entry) => entry.name === source.familyName) || fallbackFamily;
  const variant =
    family.variants.find((entry) => entry.name === source.variantName) || family.variants[0] || null;

  if (!variant) {
    return null;
  }

  return {
    family,
    variant
  };
}

function buildPartCatalog(spec) {
  const parts = [];

  if (spec.includeFloorTile) {
    parts.push(
      createPart({
        name: "floor_tile",
        kind: "floor_tile",
        role: "floor_tile",
        dimensions: [spec.baseUnit, spec.floorThickness, spec.baseUnit],
        meshEnvelope: [spec.baseUnit, spec.floorThickness, spec.baseUnit],
        anchor: {
          class: spec.anchorPolicy.snap.floor,
          policy: spec.anchorPolicy.policy
        },
        logicalFootprint: {
          type: "cell",
          widthUnits: spec.baseUnit,
          depthUnits: spec.baseUnit,
          widthCells: 1,
          depthCells: 1,
          baseUnit: spec.baseUnit
        }
      })
    );
  }

  parts.push(
    createPart({
      name: "wall",
      kind: "wall",
      role: "wall",
      dimensions: [spec.wallSpan, spec.wallHeight, spec.wallThickness],
      meshEnvelope: [spec.wallSpan, spec.wallHeight, spec.wallThickness],
      anchor: {
        class: spec.anchorPolicy.snap.wall,
        policy: spec.anchorPolicy.policy
      },
      logicalFootprint: {
        type: "edge_run",
        runUnits: spec.wallSpan,
        runCells: roundRatio(spec.wallSpan, spec.baseUnit),
        baseUnit: spec.baseUnit
      }
    }),
    createPart({
      name: "door",
      kind: "door_wall",
      role: "door",
      dimensions: [spec.wallSpan, spec.wallHeight, spec.wallThickness],
      meshEnvelope: [spec.wallSpan, spec.wallHeight, spec.wallThickness],
      anchor: {
        class: spec.anchorPolicy.snap.wall,
        policy: spec.anchorPolicy.policy
      },
      logicalFootprint: {
        type: "edge_run",
        runUnits: spec.wallSpan,
        runCells: roundRatio(spec.wallSpan, spec.baseUnit),
        baseUnit: spec.baseUnit
      },
      articulation: {
        type: "hinged",
        target: "door_leaf",
        hingeSide: spec.door.hingeSide
      }
    })
  );

  if (spec.includeCorners) {
    parts.push(
      createPart({
        name: "corner",
        kind: "corner",
        role: "corner",
        dimensions: [spec.baseUnit, spec.wallHeight, spec.baseUnit],
        meshEnvelope: [spec.baseUnit, spec.wallHeight, spec.baseUnit],
        anchor: {
          class: spec.anchorPolicy.snap.corner,
          policy: spec.anchorPolicy.policy
        },
        logicalFootprint: {
          type: "corner_vertex",
          xRunUnits: spec.baseUnit,
          zRunUnits: spec.baseUnit,
          xRunCells: 1,
          zRunCells: 1,
          baseUnit: spec.baseUnit
        }
      })
    );
  }

  if (spec.includeEndCaps) {
    parts.push(
      createPart({
        name: "end_cap",
        kind: "end_cap",
        role: "end_cap",
        dimensions: [spec.wallThickness, spec.wallHeight, spec.wallThickness],
        meshEnvelope: [spec.wallThickness, spec.wallHeight, spec.wallThickness],
        anchor: {
          class: spec.anchorPolicy.snap.endCap,
          policy: spec.anchorPolicy.policy
        },
        logicalFootprint: {
          type: "edge_cap",
          runUnits: spec.wallThickness,
          runCells: roundRatio(spec.wallThickness, spec.baseUnit),
          baseUnit: spec.baseUnit
        }
      })
    );
  }

  const catalogWindow = resolveCatalogWindowSource(spec);
  if (catalogWindow) {
    const { family, variant } = catalogWindow;
    parts.push(
      createPart({
        name: "window_left",
        kind: "window_module",
        role: "window_left",
        dimensions: [spec.wallSpan, spec.wallHeight, spec.wallThickness],
        meshEnvelope: [spec.wallSpan, spec.wallHeight, spec.wallThickness],
        anchor: {
          class: spec.anchorPolicy.snap.wall,
          policy: spec.anchorPolicy.policy
        },
        logicalFootprint: {
          type: "edge_run",
          runUnits: spec.wallSpan,
          runCells: roundRatio(spec.wallSpan, spec.baseUnit),
          baseUnit: spec.baseUnit
        },
        familyName: family.name,
        variantName: variant.name
      }),
      createPart({
        name: "window_middle",
        kind: "window_module",
        role: "window_middle",
        dimensions: [spec.wallSpan, spec.wallHeight, spec.wallThickness],
        meshEnvelope: [spec.wallSpan, spec.wallHeight, spec.wallThickness],
        anchor: {
          class: spec.anchorPolicy.snap.wall,
          policy: spec.anchorPolicy.policy
        },
        logicalFootprint: {
          type: "edge_run",
          runUnits: spec.wallSpan,
          runCells: roundRatio(spec.wallSpan, spec.baseUnit),
          baseUnit: spec.baseUnit
        },
        familyName: family.name,
        variantName: variant.name,
        articulation: variant.articulation
      }),
      createPart({
        name: "window_right",
        kind: "window_module",
        role: "window_right",
        dimensions: [spec.wallSpan, spec.wallHeight, spec.wallThickness],
        meshEnvelope: [spec.wallSpan, spec.wallHeight, spec.wallThickness],
        anchor: {
          class: spec.anchorPolicy.snap.wall,
          policy: spec.anchorPolicy.policy
        },
        logicalFootprint: {
          type: "edge_run",
          runUnits: spec.wallSpan,
          runCells: roundRatio(spec.wallSpan, spec.baseUnit),
          baseUnit: spec.baseUnit
        },
        familyName: family.name,
        variantName: variant.name
      })
    );
  }

  return sortByName(parts);
}

function createPart({
  name,
  kind,
  role,
  dimensions,
  meshEnvelope,
  anchor,
  logicalFootprint,
  familyName,
  variantName,
  articulation
}) {
  return {
    name: slugify(name),
    kind,
    role: role || null,
    dimensions,
    meshEnvelope,
    anchor,
    logicalFootprint,
    familyName: familyName || null,
    variantName: variantName || null,
    articulation: articulation || null
  };
}

function resolveLogicalWallSpan(spec, openingWidth) {
  const minimumSpan = Math.max(spec.wallSpan, openingWidth);
  const cells = Math.max(1, Math.ceil(minimumSpan / spec.baseUnit));
  return cells * spec.baseUnit;
}

function roundRatio(value, divisor) {
  if (!Number.isFinite(value) || !Number.isFinite(divisor) || divisor === 0) {
    return null;
  }
  return Math.round((value / divisor) * 1000) / 1000;
}

function normalizeHingeSide(value) {
  const hingeSide = readString(value, "left");
  return hingeSide === "right" ? "right" : "left";
}

function normalizeKitKind(value) {
  const kind = readString(value, "wall_kit");
  if (kind === "wall" || kind === "wallkit") {
    return "wall_kit";
  }
  if (kind === "ground" || kind === "ground_kit" || kind === "floor") {
    return "ground";
  }
  return kind || "wall_kit";
}

function positive(value, fallback) {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return value;
  }
  return fallback;
}
