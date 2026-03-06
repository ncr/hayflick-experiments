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
  physicsHint?: SavedPropPhysicsHint;
  colliderVariants?: SavedPropColliderVariants;
  compoundCollider?: SavedPropCompoundCollider;
  compoundConvexHulls?: SavedPropCompoundConvexHulls;
};

export type SavedPropPhysicsHint = {
  mobility?: "fixed" | "dynamic";
  material?: SavedPropPhysicsMaterial;
  mass?: number;
  friction?: number;
  restitution?: number;
  linearDamping?: number;
  angularDamping?: number;
  activationDelayMs?: number;
};

export type SavedPropPhysicsMaterial =
  | "default"
  | "metal"
  | "rubber"
  | "glass"
  | "wood"
  | "concrete";

export type SavedPropCompoundColliderPart = {
  kind: "box";
  position: [number, number, number];
  halfExtents: [number, number, number];
};

export type SavedPropCompoundCollider = {
  type: "compound-boxes";
  source: string;
  parts: SavedPropCompoundColliderPart[];
};

export type SavedPropCompoundConvexHullPart = {
  kind: "convex-hull";
  position: [number, number, number];
  points: Array<[number, number, number]>;
};

export type SavedPropCompoundConvexHulls = {
  type: "compound-convex-hulls";
  source: string;
  rootOffset: [number, number, number];
  parts: SavedPropCompoundConvexHullPart[];
};

export type SavedPropBoxCollider = {
  type: "box";
  source: string;
  position: [number, number, number];
  halfExtents: [number, number, number];
};

export type SavedPropConvexHullCollider = {
  type: "convex-hull";
  source: string;
  points: Array<[number, number, number]>;
  rootOffset: [number, number, number];
};

export type SavedPropColliderVariants = {
  box?: SavedPropBoxCollider;
  convexHull?: SavedPropConvexHullCollider;
  compoundBoxes?: SavedPropCompoundCollider;
  compoundConvexHulls?: SavedPropCompoundConvexHulls;
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

function asPhysicsMaterial(
  value: unknown
): SavedPropPhysicsMaterial | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  switch (value) {
    case "default":
    case "metal":
    case "rubber":
    case "glass":
    case "wood":
    case "concrete":
      return value;
    default:
      return undefined;
  }
}

function firstFiniteNumber(...values: unknown[]): number | undefined {
  for (const value of values) {
    const parsed = asFiniteNumber(value);
    if (parsed !== null) {
      return parsed;
    }
  }
  return undefined;
}

function firstPhysicsMaterial(
  ...values: unknown[]
): SavedPropPhysicsMaterial | undefined {
  for (const value of values) {
    const parsed = asPhysicsMaterial(value);
    if (parsed) {
      return parsed;
    }
  }
  return undefined;
}

function negateSignedZeroSafe(value: number): number {
  return value === 0 ? 0 : -value;
}

function normalizeSource(value: unknown, fallback = "unknown"): string {
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

function parseSavedPropPhysicsHint(raw: unknown): SavedPropPhysicsHint | undefined {
  const record = readRecord(raw);
  if (!record) {
    return undefined;
  }

  const resolved = readRecord(record.resolved);
  const overrides = readRecord(record.overrides);
  const mobilityRaw = record.mobility ?? resolved?.mobility ?? overrides?.mobility;
  const mobility =
    mobilityRaw === "fixed" || mobilityRaw === "dynamic" ? mobilityRaw : undefined;
  const material = firstPhysicsMaterial(
    record.material,
    resolved?.material,
    overrides?.material,
    record.kind
  );
  const mass = firstFiniteNumber(
    record.mass,
    resolved?.mass,
    resolved?.manualMass,
    overrides?.mass,
    overrides?.manualMass,
    record.manualMass
  );
  const friction = firstFiniteNumber(
    record.friction,
    resolved?.friction,
    overrides?.friction
  );
  const restitution = firstFiniteNumber(
    record.restitution,
    resolved?.restitution,
    overrides?.restitution
  );
  const linearDamping = firstFiniteNumber(
    record.linearDamping,
    resolved?.linearDamping,
    overrides?.linearDamping
  );
  const angularDamping = firstFiniteNumber(
    record.angularDamping,
    resolved?.angularDamping,
    overrides?.angularDamping
  );
  const activationDelayMs = firstFiniteNumber(
    record.activationDelayMs,
    resolved?.activationDelayMs,
    overrides?.activationDelayMs
  );

  if (
    mobility === undefined &&
    material === undefined &&
    mass === undefined &&
    friction === undefined &&
    restitution === undefined &&
    linearDamping === undefined &&
    angularDamping === undefined &&
    activationDelayMs === undefined
  ) {
    return undefined;
  }

  return {
    mobility,
    material,
    mass,
    friction,
    restitution,
    linearDamping,
    angularDamping,
    activationDelayMs
  };
}

function parseSavedCompoundCollider(raw: unknown): SavedPropCompoundCollider | undefined {
  const record = readRecord(raw);
  if (!record) {
    return undefined;
  }
  if (record.type !== "compound-boxes") {
    return undefined;
  }
  const partsRaw = record.parts;
  if (!Array.isArray(partsRaw)) {
    return undefined;
  }

  const parts: SavedPropCompoundColliderPart[] = [];
  for (const partRaw of partsRaw) {
    const partRecord = readRecord(partRaw);
    if (!partRecord || partRecord.kind !== "box") {
      continue;
    }
    const position = partRecord.position;
    const halfExtents = partRecord.halfExtents;
    if (!Array.isArray(position) || !Array.isArray(halfExtents)) {
      continue;
    }
    if (position.length !== 3 || halfExtents.length !== 3) {
      continue;
    }

    const px = asFiniteNumber(position[0]);
    const py = asFiniteNumber(position[1]);
    const pz = asFiniteNumber(position[2]);
    const hx = asFiniteNumber(halfExtents[0]);
    const hy = asFiniteNumber(halfExtents[1]);
    const hz = asFiniteNumber(halfExtents[2]);
    if (
      px === null ||
      py === null ||
      pz === null ||
      hx === null ||
      hy === null ||
      hz === null ||
      hx <= 0 ||
      hy <= 0 ||
      hz <= 0
    ) {
      continue;
    }

    parts.push({
      kind: "box",
      position: [px, py, pz],
      halfExtents: [hx, hy, hz]
    });
  }

  if (parts.length <= 0) {
    return undefined;
  }

  return {
    type: "compound-boxes",
    source:
      typeof record.source === "string" && record.source.length > 0
        ? record.source
        : "unknown",
    parts
  };
}

function parseVector3Tuple(
  raw: unknown
): [number, number, number] | undefined {
  if (!Array.isArray(raw) || raw.length !== 3) {
    return undefined;
  }
  const x = asFiniteNumber(raw[0]);
  const y = asFiniteNumber(raw[1]);
  const z = asFiniteNumber(raw[2]);
  if (x === null || y === null || z === null) {
    return undefined;
  }
  return [x, y, z];
}

function parseCompoundRootOffset(raw: unknown): [number, number, number] {
  const processing = readRecord(raw);
  const transform = readRecord(processing?.transform);
  const finalPivot = readRecord(transform?.finalPivot);
  const offset = parseVector3Tuple(finalPivot?.offset);
  if (!offset) {
    return [0, 0, 0];
  }
  return [
    negateSignedZeroSafe(offset[0]),
    negateSignedZeroSafe(offset[1]),
    negateSignedZeroSafe(offset[2])
  ];
}

function parseProcessedDimensions(raw: unknown): {
  width: number;
  height: number;
  depth: number;
} {
  const processing = readRecord(raw);
  const mesh = readRecord(processing?.mesh);
  const bboxRecord =
    readRecord(mesh?.bboxProcessed) ?? readRecord(processing?.bbox);

  return {
    width: Math.max(0, asFiniteNumber(bboxRecord?.width) ?? 0),
    height: Math.max(0, asFiniteNumber(bboxRecord?.height) ?? 0),
    depth: Math.max(0, asFiniteNumber(bboxRecord?.depth) ?? 0)
  };
}

function parseSavedCompoundConvexHulls(
  raw: unknown,
  options?: {
    fallbackSource?: string;
    rootOffset?: [number, number, number];
  }
): SavedPropCompoundConvexHulls | undefined {
  const record = readRecord(raw);
  if (!record || record.type !== "compound-convex-hulls") {
    return undefined;
  }

  const params = readRecord(record.params);
  const sourceRecord = params ?? record;
  const partsRaw = sourceRecord.parts;
  if (!Array.isArray(partsRaw)) {
    return undefined;
  }

  const parts: SavedPropCompoundConvexHullPart[] = [];
  for (const partRaw of partsRaw) {
    const partRecord = readRecord(partRaw);
    if (!partRecord) {
      continue;
    }
    const position = parseVector3Tuple(partRecord.position);
    const pointsRaw = Array.isArray(partRecord.points) ? partRecord.points : [];
    if (!position || pointsRaw.length < 4) {
      continue;
    }

    const points: Array<[number, number, number]> = [];
    for (const pointRaw of pointsRaw) {
      const point = parseVector3Tuple(pointRaw);
      if (!point) {
        continue;
      }
      points.push(point);
    }

    if (points.length < 4) {
      continue;
    }

    parts.push({
      kind: "convex-hull",
      position,
      points
    });
  }

  if (parts.length <= 0) {
    return undefined;
  }

  return {
    type: "compound-convex-hulls",
    source: normalizeSource(record.source, options?.fallbackSource ?? "unknown"),
    rootOffset: parseVector3Tuple(record.rootOffset) ?? options?.rootOffset ?? [0, 0, 0],
    parts
  };
}

function parseSelectedCompoundConvexHullPreset(
  raw: unknown,
  rootOffset: [number, number, number]
): SavedPropCompoundConvexHulls | undefined {
  const record = readRecord(raw);
  if (!record) {
    return undefined;
  }

  const presets = Array.isArray(record.presets) ? record.presets : [];
  const selectedPresetId =
    typeof record.selectedPresetId === "string" ? record.selectedPresetId : null;
  const candidates = presets
    .map((presetRaw) => {
      const preset = readRecord(presetRaw);
      if (!preset) {
        return null;
      }
      const presetId =
        typeof preset.presetId === "string" && preset.presetId.length > 0
          ? preset.presetId
          : null;
      const generation = readRecord(preset.generation);
      const collider = parseSavedCompoundConvexHulls(preset.collider, {
        fallbackSource:
          normalizeSource(generation?.method, presetId ?? "unknown"),
        rootOffset
      });
      if (!collider) {
        return null;
      }
      return {
        presetId,
        hullCount: asFiniteNumber(generation?.hullCount) ?? 0,
        collider
      };
    })
    .filter((candidate): candidate is NonNullable<typeof candidate> => candidate !== null);

  if (candidates.length <= 0) {
    return undefined;
  }

  if (selectedPresetId) {
    const selected = candidates.find((candidate) => candidate.presetId === selectedPresetId);
    if (selected) {
      return selected.collider;
    }
  }

  return candidates.reduce((best, candidate) =>
    candidate.hullCount > best.hullCount ? candidate : best
  ).collider;
}

function parseSavedBoxCollider(raw: unknown): SavedPropBoxCollider | undefined {
  const record = readRecord(raw);
  if (!record || record.type !== "box") {
    return undefined;
  }

  const position = parseVector3Tuple(record.position);
  const halfExtents = parseVector3Tuple(record.halfExtents);
  if (!position || !halfExtents) {
    return undefined;
  }
  if (halfExtents[0] <= 0 || halfExtents[1] <= 0 || halfExtents[2] <= 0) {
    return undefined;
  }

  return {
    type: "box",
    source:
      typeof record.source === "string" && record.source.length > 0
        ? record.source
        : "unknown",
    position,
    halfExtents
  };
}

function parseSavedConvexHullCollider(
  raw: unknown
): SavedPropConvexHullCollider | undefined {
  const record = readRecord(raw);
  if (!record || record.type !== "convex-hull") {
    return undefined;
  }

  const pointsRaw = record.points;
  const rootOffset = parseVector3Tuple(record.rootOffset);
  if (!Array.isArray(pointsRaw) || !rootOffset) {
    return undefined;
  }

  const points: Array<[number, number, number]> = [];
  for (const pointRaw of pointsRaw) {
    const point = parseVector3Tuple(pointRaw);
    if (!point) {
      continue;
    }
    points.push(point);
  }
  if (points.length < 4) {
    return undefined;
  }

  return {
    type: "convex-hull",
    source:
      typeof record.source === "string" && record.source.length > 0
        ? record.source
        : "unknown",
    points,
    rootOffset
  };
}

function parseSavedColliderVariants(
  raw: unknown,
  compoundRootOffset: [number, number, number]
): SavedPropColliderVariants | undefined {
  const record = readRecord(raw);
  if (!record) {
    return undefined;
  }

  const box = parseSavedBoxCollider(record.box);
  const convexHull = parseSavedConvexHullCollider(record.convexHull);
  const compoundBoxes = parseSavedCompoundCollider(record.compoundBoxes);
  const compoundConvexHulls = parseSavedCompoundConvexHulls(
    record.compoundConvexHulls,
    {
      rootOffset: compoundRootOffset
    }
  );

  if (!box && !convexHull && !compoundBoxes && !compoundConvexHulls) {
    return undefined;
  }

  return {
    box,
    convexHull,
    compoundBoxes,
    compoundConvexHulls
  };
}

function synthesizeFallbackBoxCollider(
  width: number,
  height: number,
  depth: number
): SavedPropBoxCollider | undefined {
  if (width <= 0 || height <= 0 || depth <= 0) {
    return undefined;
  }
  return {
    type: "box",
    source: "bbox-fallback",
    position: [0, height * 0.5, 0],
    halfExtents: [width * 0.5, height * 0.5, depth * 0.5]
  };
}

function synthesizeConvexHullFromBox(
  box: SavedPropBoxCollider
): SavedPropConvexHullCollider {
  const hx = box.halfExtents[0];
  const hy = box.halfExtents[1];
  const hz = box.halfExtents[2];
  return {
    type: "convex-hull",
    source: "box-fallback",
    points: [
      [-hx, -hy, -hz],
      [-hx, -hy, hz],
      [-hx, hy, -hz],
      [-hx, hy, hz],
      [hx, -hy, -hz],
      [hx, -hy, hz],
      [hx, hy, -hz],
      [hx, hy, hz]
    ],
    rootOffset: [
      negateSignedZeroSafe(box.position[0]),
      negateSignedZeroSafe(box.position[1]),
      negateSignedZeroSafe(box.position[2])
    ]
  };
}

function parseSavedPropMeta(id: string, raw: unknown): SavedPropDefinition {
  const record = readRecord(raw) ?? {};
  const description =
    typeof record.description === "string" && record.description.trim().length > 0
      ? record.description.trim()
      : id;

  const processing = readRecord(record.processing);
  const compoundRootOffset = parseCompoundRootOffset(processing);
  const { width, height, depth } = parseProcessedDimensions(processing);

  const colliderWidth = width > 0 ? width : 0;
  const colliderDepth = depth > 0 ? depth : 0;
  const physicsHint =
    parseSavedPropPhysicsHint(record.physics) ??
    parseSavedPropPhysicsHint(processing?.physics);
  const compoundColliderLegacy =
    parseSavedCompoundCollider(record.compoundCollider) ??
    parseSavedCompoundCollider(processing?.compoundCollider);
  const compoundConvexHullsLegacy =
    parseSavedCompoundConvexHulls(record.compoundConvexHulls, {
      rootOffset: compoundRootOffset
    }) ??
    parseSavedCompoundConvexHulls(processing?.compoundConvexHulls, {
      rootOffset: compoundRootOffset
    }) ??
    parseSavedCompoundConvexHulls(record.collider, {
      rootOffset: compoundRootOffset
    }) ??
    parseSavedCompoundConvexHulls(processing?.collider, {
      rootOffset: compoundRootOffset
    }) ??
    parseSelectedCompoundConvexHullPreset(record.colliders, compoundRootOffset);
  const parsedColliderVariants =
    parseSavedColliderVariants(record.colliderVariants, compoundRootOffset) ??
    parseSavedColliderVariants(processing?.colliderVariants, compoundRootOffset);
  const synthesizedBox =
    parsedColliderVariants?.box ??
    synthesizeFallbackBoxCollider(width, height, depth);
  const convexHull =
    parsedColliderVariants?.convexHull ??
    (synthesizedBox ? synthesizeConvexHullFromBox(synthesizedBox) : undefined);
  const compoundCollider =
    parsedColliderVariants?.compoundBoxes ?? compoundColliderLegacy;
  const compoundConvexHulls =
    parsedColliderVariants?.compoundConvexHulls ?? compoundConvexHullsLegacy;
  const colliderVariants: SavedPropColliderVariants | undefined =
    synthesizedBox || convexHull || compoundCollider || compoundConvexHulls
      ? {
          box: synthesizedBox,
          convexHull,
          compoundBoxes: compoundCollider,
          compoundConvexHulls
        }
      : undefined;

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
        : null,
    physicsHint,
    colliderVariants,
    compoundCollider,
    compoundConvexHulls
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
