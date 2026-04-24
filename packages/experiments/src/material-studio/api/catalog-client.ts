import type { LibraryEntry } from "../state/types";

const API = "/api/textured-mesh";

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text();
    let msg = text;
    try {
      msg = (JSON.parse(text) as { error?: string }).error ?? text;
    } catch {
      // ignore
    }
    throw new Error(msg || `${method} ${path} failed (${res.status})`);
  }
  return res.json() as Promise<T>;
}

type RawManifest = {
  name?: string;
  baseMeshId?: string;
  roles?: string[];
  prompts?: Record<string, string>;
  bakedAt?: string;
  updatedAt?: string;
  protected?: boolean;
};

function normaliseEntry(name: string, manifest: RawManifest | null): LibraryEntry {
  return {
    name,
    baseMeshId: manifest?.baseMeshId ?? null,
    roles: manifest?.roles ?? [],
    prompts: manifest?.prompts ?? {},
    bakedAt: manifest?.bakedAt ?? null,
    updatedAt: manifest?.updatedAt ?? null,
    protected: manifest?.protected ?? false,
  };
}

export async function listEntries(): Promise<LibraryEntry[]> {
  const json = await request<{ entries: Array<{ name: string; manifest: RawManifest | null }> }>("GET", "/list");
  return json.entries.map((e) => normaliseEntry(e.name, e.manifest));
}

export async function listBaseMeshes(): Promise<string[]> {
  const json = await request<{ meshes: string[] }>("GET", "/meshes");
  return json.meshes;
}

export type BaseMeshSidecar = {
  id: string;
  part?: {
    dimensions?: [number, number, number];
    kind?: string;
  };
};

export async function loadBaseMeshSidecar(id: string): Promise<BaseMeshSidecar | null> {
  try {
    const res = await fetch(`/api/assets/read?path=${encodeURIComponent(`meshes/${id}.manifest.json`)}`);
    if (!res.ok) return null;
    const json = await res.json();
    if (typeof json.content === "string") return JSON.parse(json.content) as BaseMeshSidecar;
    return json as BaseMeshSidecar;
  } catch {
    return null;
  }
}

export type LoadedEntry = {
  manifest: RawManifest;
  textures: Record<string, { baseColorB64: string; normalB64: string; armB64: string }>;
};

export async function loadEntry(name: string): Promise<LoadedEntry> {
  return request<LoadedEntry>("GET", `/entries/${encodeURIComponent(name)}`);
}

export async function deleteEntry(name: string): Promise<void> {
  await request("DELETE", `/entries/${encodeURIComponent(name)}`);
}

export async function patchEntry(
  name: string,
  patch: { rename?: string; protected?: boolean }
): Promise<{ name: string; manifest: RawManifest }> {
  return request("PATCH", `/entries/${encodeURIComponent(name)}`, patch);
}

export async function duplicateEntry(from: string, to: string): Promise<{ name: string }> {
  return request("POST", `/entries/${encodeURIComponent(from)}/duplicate`, { name: to });
}
