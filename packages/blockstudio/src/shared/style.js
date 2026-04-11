import fs from "node:fs";
import path from "node:path";

import { basenameLabel, ensureArray, makeId, readString, slugify, stableStringify } from "./utils.js";

const DEFAULT_PALETTE = ["#d7c7b1", "#a98663", "#735c47", "#42352d"];

const MATERIAL_HINTS = [
  "plaster",
  "stucco",
  "wood",
  "painted_wood",
  "stone",
  "brick",
  "metal",
  "glass",
  "fabric"
];

const TOKEN_TO_PALETTE = [
  { token: "monolith", palette: ["#d9d8d2", "#6d645d", "#12161b", "#4c453e"] },
  { token: "tecta", palette: ["#d9d8d2", "#6d645d", "#12161b", "#4c453e"] },
  { token: "tinted", palette: ["#d9d8d2", "#6d645d", "#12161b", "#4c453e"] },
  { token: "warm", palette: ["#ddc3a4", "#b68963", "#805740", "#473528"] },
  { token: "cool", palette: ["#cad4da", "#8e9fad", "#63727f", "#39434d"] },
  { token: "industrial", palette: ["#bfc3c5", "#8a8f93", "#5a6268", "#2f3438"] },
  { token: "cozy", palette: ["#dfcdb3", "#b58d62", "#7d5d3e", "#4f3928"] },
  { token: "victorian", palette: ["#d5c3b1", "#967057", "#5f4336", "#2b2020"] },
  { token: "mediterranean", palette: ["#e6d7b3", "#c39a5a", "#866146", "#4c4036"] }
];

export function normalizeReferenceImages(images) {
  return ensureArray(images).map((entry, index) => {
    if (typeof entry === "string") {
      return createReferenceRecord({ path: entry }, index);
    }
    return createReferenceRecord(entry, index);
  });
}

export function createStyleProfile(input = {}) {
  const references = normalizeReferenceImages(input.images);
  const styleNotes = readString(input.styleNotes);
  const assistantObservations = ensureArray(input.assistantObservations).map((value) => readString(value)).filter(Boolean);
  const userKeywords = ensureArray(input.keywords).map((value) => slugify(value)).filter(Boolean);
  const allText = [styleNotes, ...assistantObservations, ...references.map((reference) => reference.notes)].join(" ").toLowerCase();
  const tokens = uniqueTokens([...allText.split(/[^a-z0-9_]+/g), ...userKeywords]);
  const palette = normalizePalette(input.palette, tokens);
  const materials = normalizeMaterials(input.materials, allText);
  const styleProfile = {
    id: makeId("style"),
    name: readString(input.name, references[0]?.label || "reference_style"),
    references,
    notes: styleNotes,
    assistantObservations,
    keywords: tokens,
    palette,
    materials,
    textureStrategy: {
      mode: readString(input.textureStrategy?.mode, "procedural_tileable"),
      resolution: Number.isFinite(input.textureStrategy?.resolution)
        ? input.textureStrategy.resolution
        : 64
    },
    sourceSummary: buildSourceSummary({ references, styleNotes, assistantObservations })
  };
  return styleProfile;
}

export function serializeStyleProfile(styleProfile) {
  return stableStringify(styleProfile);
}

function createReferenceRecord(entry = {}, index = 0) {
  const filePath = readString(entry.path);
  const uri = readString(entry.uri);
  const label = readString(entry.label, basenameLabel(filePath || uri || `reference_${index + 1}`));
  const notes = readString(entry.notes);
  const metadata = filePath ? readFileMetadata(filePath) : null;
  return {
    id: makeId("ref"),
    label,
    path: filePath || undefined,
    uri: uri || undefined,
    notes,
    metadata
  };
}

function readFileMetadata(filePath) {
  try {
    const stat = fs.statSync(filePath);
    return {
      exists: true,
      size: stat.size,
      extension: path.extname(filePath).toLowerCase()
    };
  } catch {
    return {
      exists: false
    };
  }
}

function normalizePalette(palette, tokens) {
  const paletteList = ensureArray(palette).filter((entry) => typeof entry === "string" && /^#[0-9a-f]{6}$/i.test(entry));
  if (paletteList.length >= 3) {
    return paletteList.slice(0, 6);
  }
  for (const mapping of TOKEN_TO_PALETTE) {
    if (tokens.includes(mapping.token)) {
      return mapping.palette;
    }
  }
  return DEFAULT_PALETTE;
}

function normalizeMaterials(materials, text) {
  const explicit = ensureArray(materials).map((value) => slugify(value)).filter(Boolean);
  const inferred = MATERIAL_HINTS.filter((material) => text.includes(material.replace(/_/g, " ")));
  const merged = Array.from(new Set([...explicit, ...inferred]));
  return merged.length > 0 ? merged : ["plaster", "wood", "glass"];
}

function uniqueTokens(values) {
  return Array.from(new Set(values.map((value) => slugify(value)).filter(Boolean)));
}

function buildSourceSummary({ references, styleNotes, assistantObservations }) {
  const parts = [];
  if (references.length > 0) {
    parts.push(`references: ${references.map((reference) => reference.label).join(", ")}`);
  }
  if (styleNotes) {
    parts.push(`notes: ${styleNotes}`);
  }
  if (assistantObservations.length > 0) {
    parts.push(`observations: ${assistantObservations.join("; ")}`);
  }
  return parts.join(" | ");
}
