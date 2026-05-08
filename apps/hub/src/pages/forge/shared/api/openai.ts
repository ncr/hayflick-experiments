import { saveEntry } from "@common/core/imagegen-cache";

export const FORGE_CONCEPT_CACHE_SOURCE = "forge.concept-image";

export interface GenerateImageResult {
  url?: string;
  b64_json?: string;
}

export async function generateImage(
  prompt: string,
  size = "1024x1024"
): Promise<GenerateImageResult> {
  const res = await fetch("/api/openai/generate-image", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt, size }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(
      `Image generation failed: ${(err as { error: string }).error}`
    );
  }

  const data = await res.json();
  const img = data.data?.[0];
  if (!img) throw new Error("No image returned");

  if (img.b64_json) {
    saveEntry({
      source: FORGE_CONCEPT_CACHE_SOURCE,
      prompt,
      tags: { size },
      inputImageB64: null,
      outputB64: img.b64_json,
      outputMimeType: "image/png",
    }).catch((err) => console.warn("[imagegen-cache] save failed:", err));
  }

  return img as GenerateImageResult;
}
