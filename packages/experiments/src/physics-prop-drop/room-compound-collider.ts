import type {
  Physics3dBoxPart,
  Physics3dConvexHullPart
} from "../prop-physics-3d/game-physics-3d";
import { parseCompoundConvexHullParts } from "./compound-hull-collider";

type RecordLike = Record<string, unknown>;

function asRecord(raw: unknown): RecordLike | null {
  return raw !== null && typeof raw === "object" && !Array.isArray(raw)
    ? (raw as RecordLike)
    : null;
}

export function parseRoomCompoundColliderAsset(raw: unknown): Physics3dConvexHullPart[] {
  const record = asRecord(raw);
  return parseCompoundConvexHullParts(record?.collider);
}

export function scaleCompoundConvexHullParts(
  parts: Physics3dConvexHullPart[],
  scale: { x: number; y: number; z: number }
): Physics3dConvexHullPart[] {
  return parts.map((part) => {
    const vertices = new Float32Array(part.vertices.length);
    for (let i = 0; i < part.vertices.length; i += 3) {
      vertices[i] = part.vertices[i] * scale.x;
      vertices[i + 1] = part.vertices[i + 1] * scale.y;
      vertices[i + 2] = part.vertices[i + 2] * scale.z;
    }
    return {
      translation: {
        x: part.translation.x * scale.x,
        y: part.translation.y * scale.y,
        z: part.translation.z * scale.z
      },
      vertices
    };
  });
}

type PartBounds = {
  index: number;
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  minZ: number;
  maxZ: number;
};

function computePartBounds(
  part: Physics3dConvexHullPart,
  index: number
): PartBounds | null {
  if (part.vertices.length < 3) {
    return null;
  }

  let minX = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  let minZ = Number.POSITIVE_INFINITY;
  let maxZ = Number.NEGATIVE_INFINITY;

  for (let i = 0; i < part.vertices.length; i += 3) {
    const x = part.translation.x + part.vertices[i];
    const y = part.translation.y + part.vertices[i + 1];
    const z = part.translation.z + part.vertices[i + 2];
    minX = Math.min(minX, x);
    maxX = Math.max(maxX, x);
    minY = Math.min(minY, y);
    maxY = Math.max(maxY, y);
    minZ = Math.min(minZ, z);
    maxZ = Math.max(maxZ, z);
  }

  return { index, minX, maxX, minY, maxY, minZ, maxZ };
}

function partHorizontalArea(part: PartBounds): number {
  return Math.max(0, part.maxX - part.minX) * Math.max(0, part.maxZ - part.minZ);
}

function partHeight(part: PartBounds): number {
  return Math.max(0, part.maxY - part.minY);
}

function findSupportFloorSource(parts: Physics3dConvexHullPart[]): PartBounds | null {
  const bounds = parts
    .map((part, index) => computePartBounds(part, index))
    .filter((part): part is PartBounds => part !== null);
  if (bounds.length <= 0) {
    return null;
  }

  const globalMinY = bounds.reduce((minY, part) => Math.min(minY, part.minY), Infinity);
  const globalMaxY = bounds.reduce((maxY, part) => Math.max(maxY, part.maxY), -Infinity);
  const roomHeight = Math.max(globalMaxY - globalMinY, 0.001);
  const maxArea = bounds.reduce((max, part) => Math.max(max, partHorizontalArea(part)), 0);
  const broadThinLowerCandidates = bounds.filter((part) => {
    const area = partHorizontalArea(part);
    const height = partHeight(part);
    return (
      area >= maxArea * 0.7 &&
      height <= Math.max(0.2, roomHeight * 0.08) &&
      part.maxY <= globalMinY + roomHeight * 0.45
    );
  });
  if (broadThinLowerCandidates.length > 0) {
    return broadThinLowerCandidates.reduce((best, part) =>
      part.maxY > best.maxY ? part : best
    );
  }

  const floorCandidates = bounds.filter((part) => part.minY <= globalMinY + 0.05);
  return floorCandidates.reduce<PartBounds | null>((best, part) => {
    const area = partHorizontalArea(part);
    if (area <= 0) {
      return best;
    }
    if (!best) {
      return part;
    }
    return area > partHorizontalArea(best) ? part : best;
  }, null);
}

export function deriveRoomSupportFloorPart(
  parts: Physics3dConvexHullPart[]
): Physics3dBoxPart | null {
  const supportSource = findSupportFloorSource(parts);
  if (!supportSource) {
    return null;
  }

  const supportThickness = 0.02;
  const supportLift = 0.002;
  const centerX = (supportSource.minX + supportSource.maxX) * 0.5;
  const centerZ = (supportSource.minZ + supportSource.maxZ) * 0.5;
  const width = supportSource.maxX - supportSource.minX;
  const depth = supportSource.maxZ - supportSource.minZ;

  if (width <= 0 || depth <= 0) {
    return null;
  }

  return {
    translation: {
      x: centerX,
      y: supportSource.maxY + supportLift - supportThickness * 0.5,
      z: centerZ
    },
    halfExtents: {
      x: width * 0.5,
      y: supportThickness * 0.5,
      z: depth * 0.5
    }
  };
}

export function omitRoomSupportSurfaceParts(
  parts: Physics3dConvexHullPart[]
): Physics3dConvexHullPart[] {
  const supportSource = findSupportFloorSource(parts);
  if (!supportSource) {
    return [...parts];
  }
  const supportArea =
    (supportSource.maxX - supportSource.minX) * (supportSource.maxZ - supportSource.minZ);
  const supportHeight = supportSource.maxY - supportSource.minY;
  const supportMaxY = supportSource.maxY;

  return parts.filter((part, index) => {
    const bounds = computePartBounds(part, index);
    if (!bounds) {
      return false;
    }
    const area = partHorizontalArea(bounds);
    const height = partHeight(bounds);
    const isBroadLowSupportSurface =
      area >= supportArea * 0.6 &&
      height <= Math.max(0.2, supportHeight + 0.05) &&
      bounds.maxY <= supportMaxY + 0.05;
    return !isBroadLowSupportSurface;
  });
}
