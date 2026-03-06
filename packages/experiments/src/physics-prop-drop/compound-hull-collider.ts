import type { Physics3dConvexHullPart } from "../settlement-builder-ecs/game-physics-3d";

type RecordLike = Record<string, unknown>;

function asRecord(raw: unknown): RecordLike | null {
  return raw !== null && typeof raw === "object" && !Array.isArray(raw)
    ? (raw as RecordLike)
    : null;
}

function asFiniteNumber(raw: unknown): number | null {
  return typeof raw === "number" && Number.isFinite(raw) ? raw : null;
}

function parseVector3Tuple(raw: unknown): [number, number, number] | null {
  if (!Array.isArray(raw) || raw.length !== 3) {
    return null;
  }
  const x = asFiniteNumber(raw[0]);
  const y = asFiniteNumber(raw[1]);
  const z = asFiniteNumber(raw[2]);
  if (x === null || y === null || z === null) {
    return null;
  }
  return [x, y, z];
}

export function parseCompoundConvexHullParts(raw: unknown): Physics3dConvexHullPart[] {
  const collider = asRecord(raw);
  if (!collider || collider.type !== "compound-convex-hulls") {
    return [];
  }
  const params = asRecord(collider.params);
  const partsRaw = params?.parts;
  if (!Array.isArray(partsRaw)) {
    return [];
  }

  const parts: Physics3dConvexHullPart[] = [];
  for (const partRaw of partsRaw) {
    const part = asRecord(partRaw);
    const translationTuple = parseVector3Tuple(part?.position);
    const pointsRaw = Array.isArray(part?.points) ? part.points : [];
    if (!translationTuple || pointsRaw.length < 4) {
      continue;
    }

    const points: Array<[number, number, number]> = [];
    for (const pointRaw of pointsRaw) {
      const point = parseVector3Tuple(pointRaw);
      if (point) {
        points.push(point);
      }
    }
    if (points.length < 4) {
      continue;
    }

    const vertices = new Float32Array(points.length * 3);
    for (let i = 0; i < points.length; i += 1) {
      vertices[i * 3] = points[i][0];
      vertices[i * 3 + 1] = points[i][1];
      vertices[i * 3 + 2] = points[i][2];
    }

    parts.push({
      translation: {
        x: translationTuple[0],
        y: translationTuple[1],
        z: translationTuple[2]
      },
      vertices
    });
  }

  return parts;
}

export function computeCompoundHullDimensions(
  parts: Physics3dConvexHullPart[]
): { width: number; height: number; depth: number } {
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let minZ = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  let maxZ = Number.NEGATIVE_INFINITY;

  for (const part of parts) {
    const { x: tx, y: ty, z: tz } = part.translation;
    for (let i = 0; i < part.vertices.length; i += 3) {
      const x = tx + part.vertices[i];
      const y = ty + part.vertices[i + 1];
      const z = tz + part.vertices[i + 2];
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (z < minZ) minZ = z;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
      if (z > maxZ) maxZ = z;
    }
  }

  if (!Number.isFinite(minX) || !Number.isFinite(maxX)) {
    return { width: 0, height: 0, depth: 0 };
  }
  return {
    width: Math.max(0, maxX - minX),
    height: Math.max(0, maxY - minY),
    depth: Math.max(0, maxZ - minZ)
  };
}
