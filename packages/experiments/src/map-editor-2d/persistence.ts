import type { LevelBuilderBakeInput } from "@common/level-editor";
import {
  isLevelBuilderGroundBase,
  isLevelBuilderStructureKind,
  isLevelBuilderDoorState,
  LEVEL_BUILDER_STRUCTURE_KIND,
  LEVEL_EDITOR_WORLD_UNIT
} from "@common/level-editor";
import { createDefaultState, fromBakeInput, toBakeInput, type MapEditorState } from "./editor-state";

const STORAGE_KEY = "map-editor-2d:state";

export function saveEditorState(state: MapEditorState): void {
  try {
    const input = toBakeInput(state);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(input));
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

    const input = parseBakeInput(parsed);
    if (!input) return createDefaultState();

    return fromBakeInput(input);
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

function parseBakeInput(raw: Record<string, unknown>): LevelBuilderBakeInput | null {
  const level = isRecord(raw.level) ? raw.level : null;
  const grid = isRecord(raw.grid) ? raw.grid : null;
  const terrain = isRecord(raw.terrain) ? raw.terrain : null;
  const structures = Array.isArray(raw.structures) ? raw.structures : null;

  if (!level || !grid || !terrain || !structures) return null;

  const levelId = typeof level.id === "string" ? level.id : null;
  const levelVersion = asNumber(level.version);
  const tiles = asNumber(grid.tiles);
  const tileSize = asNumber(grid.tileSize);
  const origin = asNumber(grid.origin);

  if (!levelId || levelVersion === null || !tiles || !tileSize || origin === null) return null;

  const defaultGround = terrain.defaultGround;
  if (!isLevelBuilderGroundBase(defaultGround)) return null;

  const overridesRaw = Array.isArray(terrain.overrides) ? terrain.overrides : [];
  const overrides = [];
  for (const entry of overridesRaw) {
    if (!isRecord(entry)) continue;
    const x = asNumber(entry.x);
    const z = asNumber(entry.z);
    const base = entry.base;
    if (x === null || z === null || !isLevelBuilderGroundBase(base)) continue;
    overrides.push({ x, z, base });
  }

  const parsedStructures = [];
  for (const entry of structures) {
    if (!isRecord(entry)) continue;
    const ax = asNumber(entry.ax);
    const az = asNumber(entry.az);
    const bx = asNumber(entry.bx);
    const bz = asNumber(entry.bz);
    const kind = entry.kind;
    if (ax === null || az === null || bx === null || bz === null) continue;
    if (!isLevelBuilderStructureKind(kind)) continue;

    if (kind === LEVEL_BUILDER_STRUCTURE_KIND.DOOR) {
      const doorState = entry.doorState;
      if (!isLevelBuilderDoorState(doorState)) continue;
      parsedStructures.push({ kind, doorState, ax, az, bx, bz });
    } else {
      parsedStructures.push({ kind, ax, az, bx, bz });
    }
  }

  return {
    level: { id: levelId, version: levelVersion },
    grid: { tiles, tileSize, origin },
    terrain: { defaultGround, overrides },
    structures: parsedStructures
  };
}
