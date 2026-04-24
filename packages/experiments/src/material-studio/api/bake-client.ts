import { imageDataToBase64Png } from "../api-client";
import type { AuthoringSession } from "../state/types";
import type { LibraryEntry } from "../state/types";

export type BakeMaterialBody =
  | { baseColorPng: string; normalPng: string; armPng: string; roughnessFactor?: number; metallicFactor?: number }
  | { synthetic: string };

export type BakeResult = {
  ok: true;
  name: string;
  artifactPath: string;
  manifest: {
    baseMeshId: string;
    roles: string[];
    prompts: Record<string, string>;
    bakedAt: string;
    updatedAt: string;
    protected: boolean;
  };
};

export async function bakeFromAuthoring(session: AuthoringSession): Promise<BakeResult> {
  const materials: Record<string, BakeMaterialBody> = {};
  const prompts: Record<string, string> = {};
  for (const s of session.surfaces) {
    const state = session.surfaceStates[s.role];
    if (!state) continue;
    if (s.kind === "synthetic") {
      materials[s.role] = { synthetic: s.synthetic ?? "glass" };
    } else if (state.maps) {
      const [baseColorPng, normalPng, armPng] = await Promise.all([
        imageDataToBase64Png(state.maps.baseColor),
        imageDataToBase64Png(state.maps.normal),
        imageDataToBase64Png(state.maps.arm),
      ]);
      materials[s.role] = { baseColorPng, normalPng, armPng };
      prompts[s.role] = state.prompt;
    }
  }

  const res = await fetch("/api/textured-mesh/bake", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: session.entryName,
      baseMeshId: session.baseMeshId,
      materials,
      prompts,
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    let msg = text;
    try {
      msg = (JSON.parse(text) as { error?: string }).error ?? text;
    } catch {
      // ignore
    }
    throw new Error(msg || `Bake failed (${res.status})`);
  }

  return (await res.json()) as BakeResult;
}

export function bakeResultToLibraryEntry(result: BakeResult): LibraryEntry {
  return {
    name: result.name,
    baseMeshId: result.manifest.baseMeshId,
    roles: result.manifest.roles,
    prompts: result.manifest.prompts,
    bakedAt: result.manifest.bakedAt,
    updatedAt: result.manifest.updatedAt,
    protected: result.manifest.protected,
  };
}
