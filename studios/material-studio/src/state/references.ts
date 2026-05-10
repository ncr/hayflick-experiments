const STORAGE_KEY = "map-editor-2d:state:v3";

type TileRefArray = Array<{ tileName: string }>;

export type ReferenceSnapshot = {
  count: number;
};

function readRaw(): Record<string, unknown> | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

function writeRaw(data: Record<string, unknown>): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
}

function structureArrays(state: Record<string, unknown>): TileRefArray[] {
  const out: TileRefArray[] = [];
  for (const key of ["edgeStructures", "cellStructures", "vertexStructures"]) {
    const arr = state[key];
    if (Array.isArray(arr)) out.push(arr as TileRefArray);
  }
  return out;
}

/** Count references to a given tile name across the map-editor's persisted state. */
export function countReferences(tileName: string): number {
  const state = readRaw();
  if (!state) return 0;
  let count = 0;
  for (const arr of structureArrays(state)) {
    for (const entry of arr) {
      if (entry && entry.tileName === tileName) count++;
    }
  }
  return count;
}

/** Rewrite every reference to `from` → `to` in the persisted map. Returns number rewritten. */
export function rewriteReferences(from: string, to: string): number {
  const state = readRaw();
  if (!state) return 0;
  let count = 0;
  for (const arr of structureArrays(state)) {
    for (const entry of arr) {
      if (entry && entry.tileName === from) {
        entry.tileName = to;
        count++;
      }
    }
  }
  if (count > 0) writeRaw(state);
  return count;
}
