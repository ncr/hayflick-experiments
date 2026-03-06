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

  return img as GenerateImageResult;
}
