import {
  createDefaultState,
  serializeState,
  deserializeState,
  type MapEditorState,
  type SerializedState
} from "./editor-state";
import type { GreyboxDoorState } from "@common/level-editor";

const STORAGE_KEY = "map-editor:greybox-state:v1";

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
    const flipped = entry.flipped === true;
    const doorState: GreyboxDoorState | undefined =
      entry.doorState === "open" || entry.doorState === "closed" ? entry.doorState : undefined;
    edgeStructures.push({ tileName, ax, az, bx, bz, flipped, doorState });
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
    edgeStructures,
    cellStructures,
    vertexStructures
  };
}
