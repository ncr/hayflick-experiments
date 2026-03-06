import type { Physics3dConvexHullPart } from "../settlement-builder-ecs/game-physics-3d";
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
