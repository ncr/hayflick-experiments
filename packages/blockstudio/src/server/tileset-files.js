import fs from "node:fs";
import path from "node:path";

import { WALL_KIT_REQUIRED_PARTS, normalizeWallKitSpec } from "../shared/kit.js";
import { deriveTextureProfile, normalizeGameRenderContract } from "../shared/texel-density.js";
import { deepClone, isPlainObject, slugify, stableStringify } from "../shared/utils.js";

const TILESETS_DIR = "assets/tilesets";
const RULES_DIR = "_rules";
const GENERAL_RULES_FILE = "general.tileset-rules.json";
const GAME_METADATA_FILE = "tileset.game.json";

export function buildTilesetLayout({ repoRoot = process.cwd(), tilesetId, name, fileStem, kind = "wall_kit" }) {
  const id = slugify(tilesetId || name || "tileset");
  const stem = slugify(fileStem || id);
  const rootDir = path.resolve(repoRoot, TILESETS_DIR, id);
  const projectDir = path.join(rootDir, "project");
  const artifactsDir = path.join(rootDir, "artifacts");
  const kitArtifactsDir = path.join(artifactsDir, "kit");
  const tileArtifactsDir = path.join(artifactsDir, "tiles");
  const capturesDir = path.join(projectDir, "captures");
  const texturesDir = path.join(projectDir, "textures");
  const metadataFile = path.join(rootDir, "tileset.json");
  const rulesFile = path.resolve(repoRoot, TILESETS_DIR, RULES_DIR, GENERAL_RULES_FILE);

  return {
    id,
    name: name || tilesetId || "tileset",
    kind,
    rootDir,
    projectDir,
    projectFile: path.join(projectDir, `${stem}.blend`),
    projectManifestFile: path.join(projectDir, `${stem}.manifest.json`),
    texturesDir,
    capturesDir,
    artifactsDir,
    kitArtifactsDir,
    tileArtifactsDir,
    metadataFile,
    rulesFile
  };
}

export function ensureGeneralRules({ repoRoot = process.cwd(), rules } = {}) {
  const rulesFile = path.resolve(repoRoot, TILESETS_DIR, RULES_DIR, GENERAL_RULES_FILE);
  ensureDirectory(path.dirname(rulesFile));

  const current = normalizeGeneralRules(readJsonFile(rulesFile) || defaultGeneralRules());
  const next = normalizeGeneralRules(mergeDeep(current, rules || {}));
  writeJsonFile(rulesFile, minimalGeneralRules(next));

  return {
    file: rulesFile,
    rules: next
  };
}

export function readGeneralRules({ repoRoot = process.cwd() } = {}) {
  const rulesFile = path.resolve(repoRoot, TILESETS_DIR, RULES_DIR, GENERAL_RULES_FILE);
  return {
    file: rulesFile,
    rules: normalizeGeneralRules(readJsonFile(rulesFile) || defaultGeneralRules())
  };
}

export function ensureTilesetWorkspace({
  repoRoot = process.cwd(),
  tilesetId,
  name,
  kind = "wall_kit",
  fileStem,
  profile,
  rules
} = {}) {
  const layout = buildTilesetLayout({
    repoRoot,
    tilesetId,
    name,
    kind,
    fileStem
  });

  ensureGeneralRules({ repoRoot, rules });
  [
    layout.rootDir,
    layout.projectDir,
    layout.texturesDir,
    layout.capturesDir,
    layout.artifactsDir,
    layout.kitArtifactsDir,
    layout.tileArtifactsDir
  ].forEach(ensureDirectory);

  const { rules: normalizedRules } = readGeneralRules({ repoRoot });
  const currentProfile = normalizeTilesetProfile(
    readJsonFile(layout.metadataFile) || defaultTilesetProfile(layout, normalizedRules),
    {
      layout,
      rules: normalizedRules
    }
  );
  const nextProfile = normalizeTilesetProfile(mergeDeep(currentProfile, profile || {}), {
    layout,
    rules: normalizedRules
  });
  nextProfile.id = layout.id;
  nextProfile.name = nextProfile.name || layout.name;
  nextProfile.kind = nextProfile.kind || layout.kind;
  nextProfile.paths = defaultTilesetProfile(layout, normalizedRules).paths;
  writeJsonFile(layout.metadataFile, nextProfile);

  return {
    layout,
    profile: nextProfile,
    rulesFile: layout.rulesFile
  };
}

export function saveTilesetProfile({
  repoRoot = process.cwd(),
  tilesetId,
  name,
  kind = "wall_kit",
  fileStem,
  profile
} = {}) {
  const ensured = ensureTilesetWorkspace({
    repoRoot,
    tilesetId,
    name,
    kind,
    fileStem
  });
  const { rules: normalizedRules } = readGeneralRules({ repoRoot });
  const nextProfile = normalizeTilesetProfile(mergeDeep(ensured.profile, profile || {}), {
    layout: ensured.layout,
    rules: normalizedRules
  });
  nextProfile.id = ensured.layout.id;
  nextProfile.name = nextProfile.name || ensured.layout.name;
  nextProfile.kind = nextProfile.kind || ensured.layout.kind;
  nextProfile.paths = defaultTilesetProfile(ensured.layout, normalizedRules).paths;
  writeJsonFile(ensured.layout.metadataFile, nextProfile);

  return {
    layout: ensured.layout,
    profile: nextProfile,
    rulesFile: ensured.layout.rulesFile
  };
}

export function readTilesetProfile({
  repoRoot = process.cwd(),
  tilesetId,
  name,
  kind = "wall_kit",
  fileStem
} = {}) {
  const layout = buildTilesetLayout({
    repoRoot,
    tilesetId,
    name,
    kind,
    fileStem
  });
  const { rules } = readGeneralRules({ repoRoot });
  const profile = normalizeTilesetProfile(
    readJsonFile(layout.metadataFile) || defaultTilesetProfile(layout, rules),
    {
      layout,
      rules
    }
  );
  return {
    layout,
    profile
  };
}

export function resolveTilesetContextForPath({ repoRoot = process.cwd(), targetPath } = {}) {
  if (!targetPath) {
    return null;
  }

  const absoluteTarget = path.resolve(targetPath);
  const relativePath = path.relative(repoRoot, absoluteTarget);
  if (relativePath.startsWith("..")) {
    return null;
  }

  const segments = relativePath.split(path.sep).filter(Boolean);
  if (segments.length < 3) {
    return null;
  }
  if (segments[0] !== TILESETS_DIR || segments[2] !== "artifacts") {
    return null;
  }

  const tilesetId = segments[1];
  const { layout, profile } = readTilesetProfile({
    repoRoot,
    tilesetId,
    name: tilesetId
  });
  const { rules, file } = readGeneralRules({ repoRoot });
  return {
    tilesetId,
    layout,
    profile,
    rules,
    rulesFile: file
  };
}

export function writeTilesetGameMetadata({
  repoRoot = process.cwd(),
  exportRoot,
  exportResult,
  format,
  generatedAt = new Date().toISOString()
} = {}) {
  const context = resolveTilesetContextForPath({ repoRoot, targetPath: exportRoot });
  if (!context) {
    return null;
  }

  const metadata = buildTilesetGameMetadata({
    context,
    exportRoot,
    exportResult,
    format,
    generatedAt
  });
  const filePath = path.join(exportRoot, GAME_METADATA_FILE);
  writeJsonFile(filePath, metadata);

  return {
    file: filePath,
    metadata,
    context
  };
}

export function defaultGeneralRules() {
  const render = normalizeGameRenderContract({
    baseUnitCm: 128,
    modelUnitsPerBaseUnit: 128
  });
  return {
    units: {
      baseUnitCm: 128,
      authoringUnitsPerBaseUnit: 128,
      exporterScale: 128,
      artifactFormat: "glb"
    },
    render,
    defaults: {
      kind: "wall_kit",
      wallSpan: 128,
      wallHeight: 280,
      wallThickness: 32,
      floorThickness: 6,
      door: {
        width: 90,
        height: 220,
        frameThickness: 16,
        frameProtrusion: 3
      },
      window: {
        narrowWidth: 32,
        glassThickness: 4
      }
    },
    requiredParts: {
      wall_kit: deepClone(WALL_KIT_REQUIRED_PARTS)
    },
    anchors: {
      policy: "first_logical_unit",
      snap: {
        floor: "cell_center",
        wall: "edge_midpoint",
        corner: "vertex",
        endCap: "edge_midpoint"
      },
      articulation: {
        hinged: "hinge_edge",
        casement_window: "mounted_side"
      }
    },
    notes: [
      "128cm is the holy logical base cell for the game grid.",
      "Walls and floors are plain butt joints — no chamfers, no mesh overlap.",
      "Multi-cell and multi-segment assets anchor to the first logical unit, never the geometric center."
    ]
  };
}

export function defaultTilesetProfile(layout, rules = defaultGeneralRules()) {
  const normalizedRules = normalizeGeneralRules(rules);
  const geometry = {
    baseUnit: normalizedRules.units.baseUnitCm,
    authoringUnitsPerBaseUnit: normalizedRules.units.authoringUnitsPerBaseUnit,
    wallSpan: normalizedRules.defaults.wallSpan,
    wallHeight: normalizedRules.defaults.wallHeight,
    wallThickness: normalizedRules.defaults.wallThickness,
    floorThickness: normalizedRules.defaults.floorThickness,
    door: deepClone(normalizedRules.defaults.door),
    window: deepClone(normalizedRules.defaults.window)
  };
  const render = normalizeGameRenderContract({
    ...(normalizedRules.render || {}),
    baseUnitCm: geometry.baseUnit,
    modelUnitsPerBaseUnit: geometry.authoringUnitsPerBaseUnit
  });
  const authoringTextureProfile = deriveTextureProfile({
    authoringUnitsPerBaseUnit: geometry.authoringUnitsPerBaseUnit,
    wallSpan: geometry.wallSpan,
    wallHeight: geometry.wallHeight,
    renderContract: render
  });
  return {
    id: layout.id,
    name: layout.name,
    kind: layout.kind,
    description: "",
    game: {
      artifactFormat: normalizedRules.units.artifactFormat,
      copyFrom: "artifacts",
      copyTilesFrom: "artifacts/tiles",
      copyKitFrom: "artifacts/kit"
    },
    geometry,
    render: {
      projection: render.projection,
      baseUnitCm: render.baseUnitCm,
      gamePixelsPerBaseUnit: deepClone(render.gamePixelsPerBaseUnit),
      modelUnitsPerBaseUnit: render.modelUnitsPerBaseUnit,
      densityAxis: render.densityAxis,
      defaultDisplayScale: render.defaultDisplayScale,
      texturePixelsPerGamePixel: render.texturePixelsPerGamePixel.default,
      presets: deepClone(render.texturePixelsPerGamePixel.presets),
      derived: deepClone(render.derived)
    },
    textures: {
      authoring: authoringTextureProfile
    },
    kitSpec: defaultTilesetKitSpec(layout),
    anchors: {
      policy: normalizedRules.anchors.policy,
      snap: deepClone(normalizedRules.anchors.snap),
      articulation: deepClone(normalizedRules.anchors.articulation),
      notes: []
    },
    requiredParts: deepClone(normalizedRules.requiredParts[layout.kind] || []),
    style: {
      notes: "",
      referenceImages: []
    },
    paths: {
      projectDir: "project",
      projectFile: relativeTo(layout.rootDir, layout.projectFile),
      texturesDir: relativeTo(layout.rootDir, layout.texturesDir),
      capturesDir: relativeTo(layout.rootDir, layout.capturesDir),
      artifactsDir: relativeTo(layout.rootDir, layout.artifactsDir),
      kitArtifactsDir: relativeTo(layout.rootDir, layout.kitArtifactsDir),
      tileArtifactsDir: relativeTo(layout.rootDir, layout.tileArtifactsDir),
      rulesFile: relativeTo(layout.rootDir, layout.rulesFile)
    },
    notes: []
  };
}

export function gameMetadataFileName() {
  return GAME_METADATA_FILE;
}

function relativeTo(rootDir, targetPath) {
  return path.relative(rootDir, targetPath).replace(/\\/g, "/");
}

function ensureDirectory(directoryPath) {
  fs.mkdirSync(directoryPath, { recursive: true });
}

function readJsonFile(filePath) {
  if (!fs.existsSync(filePath)) {
    return null;
  }
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function buildTilesetGameMetadata({ context, exportRoot, exportResult, format, generatedAt }) {
  const kitManifestPath = findSavedPathInDirectory({
    savedEntries: exportResult.saved,
    directory: exportResult.kitDir,
    format: "manifest"
  });
  const tilesManifestPath = findSavedPathBySuffix(
    exportResult.saved,
    path.join("tiles", "tiles.manifest.json")
  );
  const kitManifest = readJsonFile(kitManifestPath);
  const tilesManifest = readJsonFile(tilesManifestPath);

  return {
    schema: "blockstudio/tileset-game-metadata@1",
    generatedAt,
    tileset: {
      id: context.profile.id || context.layout.id,
      name: context.profile.name || context.layout.name,
      kind: context.profile.kind || context.layout.kind,
      description: context.profile.description || ""
    },
    rules: context.rules,
    profile: sanitizeProfileForGame(context.profile, context.layout),
    exports: {
      format: format || inferFormat(exportResult.saved),
      root: ".",
      kitDir: relativeTo(exportRoot, exportResult.kitDir),
      tilesDir: exportResult.tilesDir ? relativeTo(exportRoot, exportResult.tilesDir) : null,
      kitManifest: kitManifestPath ? relativeTo(exportRoot, kitManifestPath) : null,
      tilesManifest: tilesManifestPath ? relativeTo(exportRoot, tilesManifestPath) : null,
      saved: (exportResult.saved || []).map((entry) => ({
        ...entry,
        path: relativeTo(exportRoot, entry.path)
      })),
      kit: summarizeKitManifest({
        manifest: kitManifest,
        exportRoot,
        manifestPath: kitManifestPath
      }),
      tiles: summarizeTiles({
        tiles: exportResult.tiles || [],
        exportRoot,
        tilesManifest
      })
    }
  };
}

function sanitizeProfileForGame(profile, layout) {
  return {
    id: profile.id || layout.id,
    name: profile.name || layout.name,
    kind: profile.kind || layout.kind,
    description: profile.description || "",
    game: deepClone(profile.game || {}),
    geometry: deepClone(profile.geometry || {}),
    render: deepClone(profile.render || {}),
    textures: deepClone(profile.textures || {}),
    kitSpec: deepClone(profile.kitSpec || {}),
    anchors: deepClone(profile.anchors || {}),
    requiredParts: deepClone(profile.requiredParts || []),
    style: {
      notes: profile.style?.notes || "",
      referenceImages: Array.isArray(profile.style?.referenceImages)
        ? profile.style.referenceImages.map((entry) => entry?.label || entry?.path || entry?.uri || "").filter(Boolean)
        : []
    },
    notes: deepClone(profile.notes || [])
  };
}

function summarizeKitManifest({ manifest, exportRoot, manifestPath }) {
  if (!manifest) {
    return null;
  }

  return {
    manifest: manifestPath ? relativeTo(exportRoot, manifestPath) : null,
    kitId: manifest.kitId || null,
    name: manifest.name || null,
    dimensions: manifest.dimensions || null,
    parts: Array.isArray(manifest.parts)
      ? manifest.parts.map((part) => ({
          name: part.name,
          kind: part.kind,
          role: part.role || null,
          dimensions: part.dimensions || null,
          meshEnvelope: part.meshEnvelope || null,
          anchorClass: part.anchorClass || null,
          anchorPolicy: part.anchorPolicy || null,
          logicalFootprint: part.logicalFootprint || null,
          anchor: part.artifactAnchor || part.anchorLocal || null,
          articulationPivot: part.artifactArticulationPivot || part.articulationPivot || null,
          articulationType: part.articulationType || null,
          hingeSide: part.hingeSide || null
        }))
      : []
  };
}

function summarizeTiles({ tiles, exportRoot, tilesManifest }) {
  const manifestByName = new Map();
  if (Array.isArray(tilesManifest?.tiles)) {
    tilesManifest.tiles.forEach((entry) => {
      if (entry?.name) {
        manifestByName.set(entry.name, entry);
      }
    });
  }

  return tiles.map((tile) => {
    const savedFiles = Array.isArray(tile.files) ? tile.files : [];
    const manifestPath =
      savedFiles.find((entry) => entry.format === "manifest")?.path ||
      path.join(tile.directory, `${path.basename(tile.directory)}.manifest.json`);
    const glbPath =
      savedFiles.find((entry) => entry.format === "glb" || entry.format === "gltf")
        ?.path || null;
    const tileManifest = readJsonFile(manifestPath);
    const manifestEntry = manifestByName.get(tile.name) || null;

    return {
      name: tile.name,
      kind: tile.kind,
      role: tileManifest?.part?.role || manifestEntry?.role || tile.role || null,
      directory: relativeTo(exportRoot, tile.directory),
      file: glbPath ? relativeTo(exportRoot, glbPath) : manifestEntry?.files?.find((entry) => entry.path)?.path || null,
      manifest: manifestPath ? relativeTo(exportRoot, manifestPath) : null,
      dimensions: tileManifest?.part?.dimensions || manifestEntry?.dimensions || null,
      meshEnvelope:
        tileManifest?.part?.meshEnvelope ||
        tile.meshEnvelope ||
        null,
      anchorClass:
        tileManifest?.part?.anchorClass ||
        tile.anchorClass ||
        null,
      anchorPolicy:
        tileManifest?.part?.anchorPolicy ||
        tile.anchorPolicy ||
        null,
      logicalFootprint:
        tileManifest?.part?.logicalFootprint ||
        tile.logicalFootprint ||
        null,
      anchor:
        tileManifest?.part?.artifactAnchor ||
        tileManifest?.part?.anchorLocal ||
        tile.anchor ||
        null,
      articulationPivot:
        tileManifest?.part?.artifactArticulationPivot ||
        tileManifest?.part?.articulationPivot ||
        null,
      articulationType: tileManifest?.part?.articulationType || tile.articulationType || null,
      hingeSide: tileManifest?.part?.hingeSide || null
    };
  });
}

function findSavedPathBySuffix(savedEntries, suffix) {
  const normalizedSuffix = suffix ? suffix.replace(/\\/g, "/") : "";
  const match = (savedEntries || []).find((entry) =>
    String(entry.path || "")
      .replace(/\\/g, "/")
      .endsWith(normalizedSuffix)
  );
  return match ? match.path : null;
}

function findSavedPathInDirectory({ savedEntries, directory, format }) {
  if (!directory) {
    return null;
  }
  const normalizedDirectory = `${directory.replace(/\\/g, "/").replace(/\/+$/, "")}/`;
  const match = (savedEntries || []).find((entry) => {
    const entryPath = String(entry.path || "").replace(/\\/g, "/");
    return entry.format === format && entryPath.startsWith(normalizedDirectory);
  });
  return match ? match.path : null;
}

function inferFormat(savedEntries) {
  const assetEntry = (savedEntries || []).find((entry) => !["manifest"].includes(entry.format));
  return assetEntry?.format || null;
}

function writeJsonFile(filePath, value) {
  ensureDirectory(path.dirname(filePath));
  fs.writeFileSync(filePath, stableStringify(value) + "\n", "utf8");
}

function normalizeGeneralRules(input = {}) {
  const merged = mergeDeep(defaultGeneralRules(), input || {});
  const baseUnitCm = positiveNumber(
    merged.units?.baseUnitCm ?? merged.render?.baseUnitCm,
    128
  );
  const authoringUnitsPerBaseUnit = positiveNumber(
    merged.units?.authoringUnitsPerBaseUnit ?? merged.units?.gridUnit ?? merged.render?.modelUnitsPerBaseUnit,
    baseUnitCm
  );
  merged.units.baseUnitCm = baseUnitCm;
  merged.units.authoringUnitsPerBaseUnit = authoringUnitsPerBaseUnit;
  merged.units.exporterScale = positiveNumber(
    merged.units?.exporterScale,
    baseUnitCm
  );
  delete merged.units.gridUnit;
  if (!merged.defaults.wallSpan && merged.defaults.tileWidth) {
    merged.defaults.wallSpan = merged.defaults.tileWidth;
  }
  delete merged.defaults.tileWidth;
  if (!merged.anchors && merged.pivots) {
    merged.anchors = {
      policy: "first_logical_unit",
      snap: {
        floor: "cell_center",
        wall: merged.pivots.placement || "edge_midpoint",
        corner: "vertex",
        endCap: "edge_midpoint"
      },
      articulation: deepClone(merged.pivots.articulation || {})
    };
  }
  delete merged.pivots;
  merged.render = normalizeGameRenderContract({
    ...(merged.render || {}),
    baseUnitCm,
    modelUnitsPerBaseUnit: authoringUnitsPerBaseUnit
  });
  return merged;
}

function minimalGeneralRules(normalized) {
  const minimal = deepClone(normalized);
  if (minimal.render) {
    delete minimal.render.baseUnitCm;
    delete minimal.render.modelUnitsPerBaseUnit;
    delete minimal.render.derived;
  }
  return minimal;
}

function normalizeTilesetProfile(profile, { layout, rules } = {}) {
  const normalizedRules = normalizeGeneralRules(rules || defaultGeneralRules());
  const defaults = defaultTilesetProfile(layout, normalizedRules);
  const next = mergeDeep(defaults, profile || {});
  const geometry = {
    baseUnit: positiveNumber(next.geometry?.baseUnit, defaults.geometry.baseUnit),
    authoringUnitsPerBaseUnit: positiveNumber(
      next.geometry?.authoringUnitsPerBaseUnit,
      defaults.geometry.authoringUnitsPerBaseUnit
    ),
    wallSpan: positiveNumber(next.geometry?.wallSpan ?? next.geometry?.tileWidth, defaults.geometry.wallSpan),
    wallHeight: positiveNumber(next.geometry?.wallHeight, defaults.geometry.wallHeight),
    wallThickness: positiveNumber(next.geometry?.wallThickness, defaults.geometry.wallThickness),
    floorThickness: positiveNumber(next.geometry?.floorThickness, defaults.geometry.floorThickness),
    door: mergeDeep(defaults.geometry.door, next.geometry?.door || {}),
    window: mergeDeep(defaults.geometry.window, next.geometry?.window || {})
  };
  const render = normalizeGameRenderContract({
    ...(normalizedRules.render || {}),
    ...(next.render || {}),
    baseUnitCm: geometry.baseUnit,
    modelUnitsPerBaseUnit: geometry.authoringUnitsPerBaseUnit,
    texturePixelsPerGamePixel:
      next.render?.texturePixelsPerGamePixel ?? normalizedRules.render.texturePixelsPerGamePixel
  });
  const requestedAuthoringDensity =
    next.render?.texturePixelsPerGamePixel ??
    next.textures?.authoring?.texturePixelsPerGamePixel ??
    render.texturePixelsPerGamePixel.default;
  const authoringOverrides = {
    ...(next.textures?.authoring || {})
  };
  if (Number.isFinite(next.render?.texturePixelsPerGamePixel)) {
    delete authoringOverrides.resolution;
    delete authoringOverrides.uvWidth;
    delete authoringOverrides.uvHeight;
    delete authoringOverrides.uvSize;
    delete authoringOverrides.texelsPerModelUnit;
    delete authoringOverrides.density;
    delete authoringOverrides.densityLabel;
    delete authoringOverrides.centimetersPerTexturePixel;
    delete authoringOverrides.gamePixelsPerTexturePixel;
    delete authoringOverrides.renderContract;
  }
  const authoringTextureProfile = deriveTextureProfile({
    authoringUnitsPerBaseUnit: geometry.authoringUnitsPerBaseUnit,
    wallSpan: geometry.wallSpan,
    wallHeight: geometry.wallHeight,
    renderContract: render,
    textureProfile: {
      ...authoringOverrides,
      texturePixelsPerGamePixel: requestedAuthoringDensity
    }
  });

  next.geometry = geometry;
  next.game = {
    ...next.game,
    artifactFormat: next.game?.artifactFormat || normalizedRules.units.artifactFormat
  };
  next.render = {
    projection: render.projection,
    baseUnitCm: render.baseUnitCm,
    gamePixelsPerBaseUnit: deepClone(render.gamePixelsPerBaseUnit),
    modelUnitsPerBaseUnit: render.modelUnitsPerBaseUnit,
    densityAxis: render.densityAxis,
    defaultDisplayScale: render.defaultDisplayScale,
    texturePixelsPerGamePixel: authoringTextureProfile.texturePixelsPerGamePixel,
    presets: deepClone(render.texturePixelsPerGamePixel.presets),
    derived: deepClone(render.derived)
  };
  next.textures = {
    authoring: authoringTextureProfile
  };
  next.kitSpec = normalizeTilesetKitSpec(next.kitSpec, {
    layout,
    geometry,
    render,
    anchors: next.anchors || defaults.anchors,
    textureProfile: authoringTextureProfile
  });
  next.anchors = mergeDeep(defaults.anchors, next.anchors || {});
  delete next.pivots;
  delete next.anchorPolicy;
  if (next.render) {
    delete next.render.gridUnit;
    delete next.render.basePixelZoom;
  }
  if (next.geometry) {
    delete next.geometry.tileWidth;
    delete next.geometry.cellSize;
    delete next.geometry.logicalSpan;
  }
  next.requiredParts =
    Array.isArray(next.requiredParts) && next.requiredParts.length > 0
      ? deepClone(next.requiredParts)
      : deepClone(normalizedRules.requiredParts[next.kind || layout.kind] || []);
  return next;
}

export function buildWallKitSpecFromTilesetProfile(profile, { layout } = {}) {
  const normalizedProfile = normalizeTilesetProfile(profile, {
    layout: layout || buildTilesetLayout({ tilesetId: profile?.id || profile?.name || "tileset" }),
    rules: defaultGeneralRules()
  });

  return normalizeWallKitSpec({
    name: normalizedProfile.kitSpec.name || `${normalizedProfile.id}_kit`,
    kind: normalizedProfile.kind,
    baseUnit: normalizedProfile.geometry.baseUnit,
    authoringUnitsPerBaseUnit: normalizedProfile.geometry.authoringUnitsPerBaseUnit,
    wallSpan: normalizedProfile.geometry.wallSpan,
    wallHeight: normalizedProfile.geometry.wallHeight,
    wallThickness: normalizedProfile.geometry.wallThickness,
    floorThickness: normalizedProfile.geometry.floorThickness,
    door: deepClone(normalizedProfile.geometry.door),
    windowDefaults: deepClone(normalizedProfile.geometry.window),
    windowFamilies: deepClone(normalizedProfile.kitSpec.windowFamilies),
    catalogWindowSource: deepClone(normalizedProfile.kitSpec.catalogWindowSource),
    includeCorners: normalizedProfile.kitSpec.includeCorners !== false,
    includeEndCaps: normalizedProfile.kitSpec.includeEndCaps !== false,
    renderContract: deepClone(normalizedProfile.render),
    textureProfile: deepClone(normalizedProfile.textures?.authoring || {}),
    anchorPolicy: deepClone(normalizedProfile.anchors || {})
  });
}

function defaultTilesetKitSpec(layout) {
  return {
    name: `${layout.id}_kit`,
    includeCorners: true,
    includeEndCaps: false,
    catalogWindowSource: null,
    windowFamilies: []
  };
}

function normalizeTilesetKitSpec(input, { layout, geometry, render, anchors, textureProfile } = {}) {
  const base = mergeDeep(defaultTilesetKitSpec(layout), input || {});
  const normalized = normalizeWallKitSpec({
    name: base.name || `${layout.id}_kit`,
    baseUnit: geometry.baseUnit,
    authoringUnitsPerBaseUnit: geometry.authoringUnitsPerBaseUnit,
    wallSpan: geometry.wallSpan,
    wallHeight: geometry.wallHeight,
    wallThickness: geometry.wallThickness,
    floorThickness: geometry.floorThickness,
    door: deepClone(geometry.door),
    windowDefaults: deepClone(geometry.window),
    windowFamilies: deepClone(base.windowFamilies || []),
    catalogWindowSource: deepClone(base.catalogWindowSource || null),
    includeCorners: base.includeCorners !== false,
    includeEndCaps: base.includeEndCaps !== false,
    renderContract: deepClone(render || {}),
    textureProfile: deepClone(textureProfile || {}),
    anchorPolicy: deepClone(anchors || {})
  });

  return {
    name: normalized.name,
    includeCorners: normalized.includeCorners !== false,
    includeEndCaps: normalized.includeEndCaps !== false,
    catalogWindowSource: deepClone(normalized.catalogWindowSource || null),
    windowFamilies: deepClone(normalized.windowFamilies)
  };
}

function mergeDeep(base, overrides) {
  if (!isPlainObject(base)) {
    return deepClone(overrides);
  }
  const result = deepClone(base);
  if (!isPlainObject(overrides)) {
    return result;
  }

  Object.entries(overrides).forEach(([key, value]) => {
    if (Array.isArray(value)) {
      result[key] = deepClone(value);
      return;
    }
    if (isPlainObject(value) && isPlainObject(result[key])) {
      result[key] = mergeDeep(result[key], value);
      return;
    }
    result[key] = deepClone(value);
  });

  return result;
}

function positiveNumber(value, fallback) {
  return Number.isFinite(value) && value > 0 ? value : fallback;
}
