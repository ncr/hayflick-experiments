import { isLevelBuilderGroundBase } from "@common/level-editor";
import {
  createDefaultState,
  serializeState,
  deserializeState,
  type MapEditorState,
  type SerializedState
} from "./editor-state";

const STORAGE_KEY = "map-editor-2d:state:v3";

export function saveEditorState(state: MapEditorState): void {
  try {
    const data = serializeState(state);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
  } catch {
    // localStorage may be full or unavailable
  }
}

export function loadEditorState(): MapEditorState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return createDefaultState();

    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed)) return createDefaultState();

    const validated = validateSerialized(parsed);
    if (!validated) return createDefaultState();

    return deserializeState(validated);
  } catch {
    return createDefaultState();
  }
}

let saveTimer: ReturnType<typeof setTimeout> | null = null;

export function debouncedSave(state: MapEditorState): void {
  if (saveTimer !== null) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    saveEditorState(state);
  }, 500);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function asNumber(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return value;
}

function validateSerialized(raw: Record<string, unknown>): SerializedState | null {
  const grid = isRecord(raw.grid) ? raw.grid : null;
  if (!grid) return null;

  const tiles = asNumber(grid.tiles);
  const tileSize = asNumber(grid.tileSize);
  const origin = asNumber(grid.origin);
  if (!tiles || !tileSize || origin === null) return null;

  const defaultGround = raw.defaultGround;
  if (typeof defaultGround !== "string" || !isLevelBuilderGroundBase(defaultGround)) return null;

  const overridesRaw = Array.isArray(raw.terrainOverrides) ? raw.terrainOverrides : [];
  const terrainOverrides = [];
  for (const entry of overridesRaw) {
    if (!isRecord(entry)) continue;
    const x = asNumber(entry.x);
    const z = asNumber(entry.z);
    const base = entry.base;
    if (x === null || z === null || typeof base !== "string") continue;
    if (!isLevelBuilderGroundBase(base)) continue;
    terrainOverrides.push({ x, z, base });
  }

  const edgesRaw = Array.isArray(raw.edgeStructures) ? raw.edgeStructures : [];
  const edgeStructures = [];
  for (const entry of edgesRaw) {
    if (!isRecord(entry)) continue;
    const tileName = entry.tileName;
    const ax = asNumber(entry.ax);
    const az = asNumber(entry.az);
    const bx = asNumber(entry.bx);
    const bz = asNumber(entry.bz);
    if (typeof tileName !== "string" || ax === null || az === null || bx === null || bz === null) continue;
    edgeStructures.push({ tileName, ax, az, bx, bz });
  }

  const cellsRaw = Array.isArray(raw.cellStructures) ? raw.cellStructures : [];
  const cellStructures = [];
  for (const entry of cellsRaw) {
    if (!isRecord(entry)) continue;
    const tileName = entry.tileName;
    const x = asNumber(entry.x);
    const z = asNumber(entry.z);
    if (typeof tileName !== "string" || x === null || z === null) continue;
    cellStructures.push({ tileName, x, z });
  }

  const vertexRaw = Array.isArray(raw.vertexStructures) ? raw.vertexStructures : [];
  const vertexStructures = [];
  for (const entry of vertexRaw) {
    if (!isRecord(entry)) continue;
    const tileName = entry.tileName;
    const x = asNumber(entry.x);
    const z = asNumber(entry.z);
    const rotation = asNumber(entry.rotation) ?? 0;
    if (typeof tileName !== "string" || x === null || z === null) continue;
    vertexStructures.push({ tileName, x, z, rotation });
  }

  return {
    grid: { tiles, tileSize, origin },
    defaultGround,
    terrainOverrides,
    edgeStructures,
    cellStructures,
    vertexStructures
  };
}
