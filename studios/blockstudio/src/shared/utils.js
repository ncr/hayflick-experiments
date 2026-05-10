import path from "node:path";

let idCounter = 0;

export function makeId(prefix = "id") {
  idCounter += 1;
  return `${prefix}_${Date.now().toString(36)}_${idCounter.toString(36)}`;
}

export function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function deepClone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

export function readString(value, fallback = "") {
  return typeof value === "string" ? value.trim() : fallback;
}

export function readNumber(value, fallback) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return fallback;
}

export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

export function slugify(value, fallback = "item") {
  const slug = String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return slug || fallback;
}

export function ensureArray(value) {
  if (Array.isArray(value)) {
    return value;
  }
  if (value === undefined || value === null) {
    return [];
  }
  return [value];
}

export function stableStringify(value) {
  return JSON.stringify(value, null, 2);
}

export function basenameLabel(input) {
  if (typeof input !== "string" || input.length === 0) {
    return "reference";
  }
  return path.basename(input).replace(/\.[a-z0-9]+$/i, "");
}

export function sortByName(items, field = "name") {
  return [...items].sort((left, right) => {
    return String(left?.[field] ?? "").localeCompare(String(right?.[field] ?? ""));
  });
}

export function asError(error, fallback = "Unknown error") {
  if (error instanceof Error) {
    return error;
  }
  return new Error(typeof error === "string" ? error : fallback);
}

export function summarizeList(items, max = 5) {
  const list = ensureArray(items).filter(Boolean);
  if (list.length <= max) {
    return list.join(", ");
  }
  return `${list.slice(0, max).join(", ")} (+${list.length - max} more)`;
}
