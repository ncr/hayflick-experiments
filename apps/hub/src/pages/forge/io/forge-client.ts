import type {
  ForgeColliderPresetFile,
  ForgeLifecycleStatus,
  ForgePhysicsKindPresetFile,
  ForgePropMeta,
} from "../types";

const FORGE_API_BASE = "/api/forge";

export interface ForgePropIndexItem {
  id: string;
  description: string;
  status: ForgeLifecycleStatus;
  createdAt: string;
  updatedAt: string;
  hasConceptImage: boolean;
}

export interface ForgePropRecord {
  meta: ForgePropMeta;
  hasConceptImage: boolean;
}

type SaveMeshStageInput = {
  propId: string;
  meta: ForgePropMeta;
  rawGlb?: ArrayBuffer | null;
  processedGlb?: ArrayBuffer | null;
};

type SavePhysicsStageInput = {
  propId: string;
  meta: ForgePropMeta;
  colliderGlbs: Array<{
    presetId: string;
    glb: ArrayBuffer;
  }>;
};

async function readJson<T>(path: string): Promise<T> {
  const res = await fetch(`${FORGE_API_BASE}${path}`);
  if (!res.ok) {
    if (res.status === 404) {
      throw new Error("Not found");
    }
    throw new Error(`Forge API read failed: ${res.statusText}`);
  }
  return res.json() as Promise<T>;
}

async function sendJson<T>(method: "POST" | "PUT", path: string, body: unknown): Promise<T> {
  const res = await fetch(`${FORGE_API_BASE}${path}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`Forge API write failed: ${res.statusText}`);
  }
  return res.json() as Promise<T>;
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  let binary = "";
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

export function getPropConceptImageUrl(propId: string): string {
  return `${FORGE_API_BASE}/props/${encodeURIComponent(propId)}/concept-image`;
}

export async function listForgeProps(): Promise<ForgePropIndexItem[]> {
  return readJson<ForgePropIndexItem[]>("/props");
}

export async function getForgeProp(propId: string): Promise<ForgePropRecord | null> {
  try {
    return await readJson<ForgePropRecord>(`/props/${encodeURIComponent(propId)}`);
  } catch {
    return null;
  }
}

export async function createForgeProp(meta: ForgePropMeta): Promise<ForgePropMeta> {
  return sendJson<ForgePropMeta>("POST", "/props", { meta });
}

export async function saveReferenceStage(input: {
  propId: string;
  meta: ForgePropMeta;
  conceptImageDataUrl?: string | null;
  prompt?: string | null;
}): Promise<ForgePropMeta> {
  return sendJson<ForgePropMeta>("POST", `/props/${encodeURIComponent(input.propId)}/reference`, {
    meta: input.meta,
    conceptImageDataUrl: input.conceptImageDataUrl ?? null,
    prompt: input.prompt ?? null,
  });
}

export async function saveMeshStage(input: SaveMeshStageInput): Promise<ForgePropMeta> {
  return sendJson<ForgePropMeta>("POST", `/props/${encodeURIComponent(input.propId)}/mesh`, {
    meta: input.meta,
    rawGlbBase64: input.rawGlb ? arrayBufferToBase64(input.rawGlb) : null,
    processedGlbBase64: input.processedGlb ? arrayBufferToBase64(input.processedGlb) : null,
  });
}

export async function savePhysicsStage(input: SavePhysicsStageInput): Promise<ForgePropMeta> {
  return sendJson<ForgePropMeta>("POST", `/props/${encodeURIComponent(input.propId)}/physics`, {
    meta: input.meta,
    colliderGlbs: input.colliderGlbs.map((entry) => ({
      presetId: entry.presetId,
      glbBase64: arrayBufferToBase64(entry.glb),
    })),
  });
}

export async function readPropRawGlb(propId: string): Promise<ArrayBuffer | null> {
  const res = await fetch(`${FORGE_API_BASE}/props/${encodeURIComponent(propId)}/raw-glb`);
  if (!res.ok) {
    if (res.status === 404) return null;
    throw new Error(`Forge API read failed: ${res.statusText}`);
  }
  return res.arrayBuffer();
}

export async function readPropProcessedModelGlb(propId: string): Promise<ArrayBuffer | null> {
  const res = await fetch(`${FORGE_API_BASE}/props/${encodeURIComponent(propId)}/processed-glb`);
  if (!res.ok) {
    if (res.status === 404) return null;
    throw new Error(`Forge API read failed: ${res.statusText}`);
  }
  return res.arrayBuffer();
}

export async function readColliderPresetFile(): Promise<ForgeColliderPresetFile> {
  return readJson<ForgeColliderPresetFile>("/collider-presets");
}

export async function writeColliderPresetFile(
  file: ForgeColliderPresetFile
): Promise<ForgeColliderPresetFile> {
  return sendJson<ForgeColliderPresetFile>("PUT", "/collider-presets", { file });
}

export async function readPhysicsKindPresetFile(): Promise<ForgePhysicsKindPresetFile> {
  return readJson<ForgePhysicsKindPresetFile>("/physics-kinds");
}

export async function writePhysicsKindPresetFile(
  file: ForgePhysicsKindPresetFile
): Promise<ForgePhysicsKindPresetFile> {
  return sendJson<ForgePhysicsKindPresetFile>("PUT", "/physics-kinds", { file });
}
