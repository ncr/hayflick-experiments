import { imageDataToBase64Png } from "../api-client";
import { DEFAULT_PBR_TWEAK, type PbrTweakParams } from "../types";
import type { AuthoringSession } from "../state/types";
import type { LibraryEntry } from "../state/types";

export type BakeMaterialBody =
  | {
      baseColorPng: string;
      normalPng: string;
      armPng: string;
      /** New UV attribute as a plain number array (length = vertexCount*2). */
      newUv: number[];
      /** glTF material name in the base GLB, e.g. "blockstudio_wall". */
      materialName: string;
      roughnessFactor?: number;
      metallicFactor?: number;
      pbrTweak?: PbrTweakParams;
    }
  | { synthetic: string; materialName: string };

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
    pbrTweaks?: Record<string, PbrTweakParams>;
  };
};

export async function bakeFromAuthoring(session: AuthoringSession): Promise<BakeResult> {
  const materials: Record<string, BakeMaterialBody> = {};
  const prompts: Record<string, string> = {};
  for (const s of session.surfaces) {
    const state = session.surfaceStates[s.role];
    if (!state) continue;
    const materialName = `blockstudio_${s.role}`;
    if (s.kind === "synthetic") {
      materials[s.role] = { synthetic: s.synthetic ?? "glass", materialName };
    } else if (state.maps && state.islandLayout) {
      const [baseColorPng, normalPng, armPng] = await Promise.all([
        imageDataToBase64Png(state.maps.baseColor),
        imageDataToBase64Png(state.maps.normal),
        imageDataToBase64Png(state.maps.arm),
      ]);
      const pbrTweak = state.pbrTweak ?? DEFAULT_PBR_TWEAK;
      materials[s.role] = {
        baseColorPng,
        normalPng,
        armPng,
        newUv: Array.from(state.islandLayout.newUvBuffer),
        materialName,
        pbrTweak,
      };
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
