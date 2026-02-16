export type SavedPropDefinition = {
  id: string;
  description: string;
  conceptImagePath: string;
  bbox: {
    width: number;
    height: number;
    depth: number;
  };
  collider2d: {
    width: number;
    depth: number;
  } | null;
};

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

function readRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  return value as Record<string, unknown>;
}

function slugFromDescription(description: string): string {
  const value = description.trim().toLowerCase();
  if (!value) {
    return "prop";
  }
  return value
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "prop";
}

function decodeFsPayload(data: unknown): unknown {
  const record = readRecord(data);
  if (!record) {
    return data;
  }

  const content = record.content;
  if (typeof content === "string") {
    try {
      return JSON.parse(content);
    } catch {
      return data;
    }
  }

  return data;
}

async function listDirs(fetchImpl: FetchLike, dir: string): Promise<string[]> {
  const res = await fetchImpl(`/api/fs/list?dir=${encodeURIComponent(dir)}`);
  if (!res.ok) {
    throw new Error(`list failed: ${res.status}`);
  }
  const raw = await res.json();
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw.filter((entry): entry is string => typeof entry === "string");
}

async function readJson(fetchImpl: FetchLike, path: string): Promise<unknown> {
  const res = await fetchImpl(`/api/fs/read?path=${encodeURIComponent(path)}`);
  if (!res.ok) {
    throw new Error(`read failed: ${res.status}`);
  }
  const data = await res.json();
  return decodeFsPayload(data);
}

async function tryReadBinary(
  fetchImpl: FetchLike,
  path: string
): Promise<ArrayBuffer | null> {
  const res = await fetchImpl(`/api/fs/read?path=${encodeURIComponent(path)}`);
  if (!res.ok) {
    return null;
  }
  return res.arrayBuffer();
}

function asFiniteNumber(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return null;
  }
  return value;
}

function parseSavedPropMeta(id: string, raw: unknown): SavedPropDefinition {
  const record = readRecord(raw) ?? {};
  const description =
    typeof record.description === "string" && record.description.trim().length > 0
      ? record.description.trim()
      : id;

  const processing = readRecord(record.processing);
  const bboxRecord = processing ? readRecord(processing.bbox) : null;

  const width = Math.max(0, asFiniteNumber(bboxRecord?.width) ?? 0);
  const height = Math.max(0, asFiniteNumber(bboxRecord?.height) ?? 0);
  const depth = Math.max(0, asFiniteNumber(bboxRecord?.depth) ?? 0);

  const colliderWidth = width > 0 ? width : 0;
  const colliderDepth = depth > 0 ? depth : 0;

  return {
    id,
    description,
    conceptImagePath: `props/${id}/raw/concept.png`,
    bbox: {
      width,
      height,
      depth
    },
    collider2d:
      colliderWidth > 0 && colliderDepth > 0
        ? {
            width: colliderWidth,
            depth: colliderDepth
          }
        : null
  };
}

export async function listSavedPropDefinitions(
  fetchImpl: FetchLike = fetch
): Promise<SavedPropDefinition[]> {
  let ids: string[] = [];
  try {
    ids = await listDirs(fetchImpl, "props");
  } catch {
    return [];
  }

  const results = await Promise.all(
    ids.map(async (id) => {
      try {
        const raw = await readJson(fetchImpl, `props/${id}/meta.json`);
        return parseSavedPropMeta(id, raw);
      } catch {
        return {
          id,
          description: id,
          conceptImagePath: `props/${id}/raw/concept.png`,
          bbox: {
            width: 0,
            height: 0,
            depth: 0
          },
          collider2d: null
        } as SavedPropDefinition;
      }
    })
  );

  return results.sort((a, b) => a.description.localeCompare(b.description));
}

export function makePropPlacementId(
  sourcePropId: string,
  cellX: number,
  cellY: number,
  index: number
): string {
  return `${slugFromDescription(sourcePropId)}:${cellX},${cellY}:${index}`;
}

export async function loadSavedPropBinary(
  propId: string,
  fetchImpl: FetchLike = fetch
): Promise<ArrayBuffer | null> {
  const processed = await tryReadBinary(fetchImpl, `props/${propId}/processed/model.glb`);
  if (processed) {
    return processed;
  }
  return tryReadBinary(fetchImpl, `props/${propId}/raw/tripo-output.glb`);
}

export async function loadSavedPropColliderBinary(
  propId: string,
  fetchImpl: FetchLike = fetch
): Promise<ArrayBuffer | null> {
  const processedCollider = await tryReadBinary(
    fetchImpl,
    `props/${propId}/processed/collider.glb`
  );
  if (processedCollider) {
    return processedCollider;
  }

  const processedModel = await tryReadBinary(
    fetchImpl,
    `props/${propId}/processed/model.glb`
  );
  if (processedModel) {
    return processedModel;
  }

  return tryReadBinary(fetchImpl, `props/${propId}/raw/tripo-output.glb`);
}
