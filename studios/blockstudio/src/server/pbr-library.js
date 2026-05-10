import fs from "node:fs";
import path from "node:path";
import https from "node:https";

const MATERIALS_DIR = path.resolve(
  new URL(".", import.meta.url).pathname,
  "../../../../assets/materials"
);
const REGISTRY_PATH = path.join(MATERIALS_DIR, "registry.json");

const POLYHAVEN_FILES_API = "https://api.polyhaven.com/files";
const POLYHAVEN_DOWNLOAD_BASE = "https://dl.polyhaven.org/file/ph-assets/Textures";

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

export function loadRegistry() {
  if (!fs.existsSync(REGISTRY_PATH)) {
    return { materials: {} };
  }
  return JSON.parse(fs.readFileSync(REGISTRY_PATH, "utf-8"));
}

export function saveRegistry(registry) {
  fs.writeFileSync(REGISTRY_PATH, JSON.stringify(registry, null, 2) + "\n");
}

export function listMaterials() {
  const registry = loadRegistry();
  return Object.entries(registry.materials || {}).map(([id, mat]) => ({
    id,
    source: mat.source,
    category: mat.category,
    resolution: mat.resolution || "1k",
    hasBaseColor: Boolean(mat.maps?.baseColor),
    hasNormal: Boolean(mat.maps?.normal),
    hasArm: Boolean(mat.maps?.arm)
  }));
}

// ---------------------------------------------------------------------------
// Material resolution
// ---------------------------------------------------------------------------

export function resolveMaterial(materialId) {
  const registry = loadRegistry();
  const mat = registry.materials?.[materialId];
  if (!mat) {
    return null;
  }

  const sourceDir = path.join(MATERIALS_DIR, mat.source || "polyhaven", materialId);
  const resolved = {
    id: materialId,
    ...mat,
    paths: {}
  };

  for (const [mapType, filename] of Object.entries(mat.maps || {})) {
    if (filename) {
      const filePath = path.join(sourceDir, filename);
      resolved.paths[mapType] = fs.existsSync(filePath) ? filePath : null;
    }
  }

  return resolved;
}

export function resolveMaterialPaths(materialId) {
  const resolved = resolveMaterial(materialId);
  return resolved?.paths || null;
}

// ---------------------------------------------------------------------------
// Build material map for Blender (role → PBR file paths)
// ---------------------------------------------------------------------------

// Synthetic material IDs that don't live in the registry — the Blender side
// builds them procedurally. Useful for things like glass where a photographic
// PBR source would be actively wrong.
const SYNTHETIC_MATERIALS = new Set(["glass"]);

export function buildBlenderMaterialMap(textureProfile) {
  // Wall kits use three named roles. Ground kits use one role per tile name,
  // supplied via `tileMaterials: { asphalt: "asphalt_04", ... }`. Roles with
  // no material id are skipped — the Blender side leaves those meshes
  // materialless, which downstream consumers replace.
  const roleMap = {
    wall: textureProfile?.wallMaterial || null,
    trim: textureProfile?.trimMaterial || null,
    accent: textureProfile?.accentMaterial || null,
    ...(textureProfile?.tileMaterials || {})
  };

  const result = {};
  for (const [role, materialId] of Object.entries(roleMap)) {
    if (!materialId) {
      continue;
    }
    if (SYNTHETIC_MATERIALS.has(materialId)) {
      // Emit a synthetic marker so the Blender side can build a procedural
      // material (transmissive glass, flat color, etc.) instead of looking
      // up a PBR map set in the registry.
      result[role] = { synthetic: materialId };
      continue;
    }
    const resolved = resolveMaterial(materialId);
    if (!resolved || !resolved.paths) {
      continue;
    }
    result[role] = {
      baseColor: resolved.paths.baseColor || null,
      normal: resolved.paths.normal || null,
      arm: resolved.paths.arm || null,
      roughnessFactor: resolved.defaults?.roughnessFactor ?? 0.5,
      metallicFactor: resolved.defaults?.metallicFactor ?? 0.0
    };
  }
  return result;
}

// ---------------------------------------------------------------------------
// Polyhaven download
// ---------------------------------------------------------------------------

export async function downloadFromPolyhaven(materialId, resolution = "1k") {
  const filesUrl = `${POLYHAVEN_FILES_API}/${materialId}`;
  const filesData = await fetchJson(filesUrl);

  const targetDir = path.join(MATERIALS_DIR, "polyhaven", materialId);
  fs.mkdirSync(targetDir, { recursive: true });

  const mapTypes = {
    Diffuse: { key: "baseColor", suffix: "diff" },
    nor_gl: { key: "normal", suffix: "nor_gl" },
    arm: { key: "arm", suffix: "arm" }
  };

  const maps = {};
  const downloaded = [];

  for (const [apiKey, { key, suffix }] of Object.entries(mapTypes)) {
    const mapData = filesData?.[apiKey]?.[resolution]?.jpg;
    if (!mapData?.url) {
      continue;
    }

    const filename = `${materialId}_${suffix}_${resolution}.jpg`;
    const filePath = path.join(targetDir, filename);

    if (!fs.existsSync(filePath)) {
      await downloadFile(mapData.url, filePath);
      downloaded.push(filename);
    }

    maps[key] = filename;
  }

  // Update registry
  const registry = loadRegistry();
  registry.materials = registry.materials || {};
  registry.materials[materialId] = {
    source: "polyhaven",
    sourceId: materialId,
    category: filesData?.categories?.[0] || "unknown",
    maps,
    defaults: {
      roughnessFactor: 0.5,
      metallicFactor: 0.0
    },
    physicalScaleM: 1.0,
    resolution
  };
  saveRegistry(registry);

  return {
    id: materialId,
    directory: targetDir,
    maps,
    downloaded,
    resolution
  };
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetchJson(res.headers.location).then(resolve, reject);
      }
      let data = "";
      res.on("data", (chunk) => { data += chunk; });
      res.on("end", () => {
        try {
          resolve(JSON.parse(data));
        } catch (error) {
          reject(new Error(`Failed to parse JSON from ${url}: ${error.message}`));
        }
      });
      res.on("error", reject);
    }).on("error", reject);
  });
}

function downloadFile(url, filePath) {
  return new Promise((resolve, reject) => {
    const makeRequest = (requestUrl) => {
      const mod = requestUrl.startsWith("https") ? https : (require("node:http"));
      mod.get(requestUrl, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          return makeRequest(res.headers.location);
        }
        if (res.statusCode !== 200) {
          reject(new Error(`Download failed: HTTP ${res.statusCode} for ${requestUrl}`));
          return;
        }
        const stream = fs.createWriteStream(filePath);
        res.pipe(stream);
        stream.on("finish", () => {
          stream.close();
          resolve();
        });
        stream.on("error", reject);
      }).on("error", reject);
    };
    makeRequest(url);
  });
}
