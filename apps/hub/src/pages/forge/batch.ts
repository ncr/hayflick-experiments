import type { PropItem } from "./types";
import type { StyleGuide } from "./StyleGuidePanel";
import { generateImage } from "./api/openai";
import { generateModel } from "./api/tripo";

let nextId = 1;

export function createPropItem(description: string): PropItem {
  return {
    id: `prop-${nextId++}-${Date.now()}`,
    description,
    status: "draft",
    conceptImage: null,
    imageError: null,
    rawGlb: null,
    modelProgress: 0,
    modelError: null,
    originalFaces: 0,
    simplifiedFaces: 0,
    simplificationRatio: 1,
    scale: 1,
    scaleMode: "height",
    targetDimension: 0.85,
    pivot: "bottom-center",
    pivotOffset: [0, 0, 0],
    collider: null,
    textureResolution: 0,
    bbox: null,
  };
}

export function composePrompt(
  styleGuide: StyleGuide,
  description: string
): string {
  return [
    styleGuide.prompt,
    description,
    "3/4 view, product shot, centered object, plain mid-gray background.",
  ]
    .filter(Boolean)
    .join(" ");
}

async function semaphore<T>(
  tasks: (() => Promise<T>)[],
  concurrency: number
): Promise<T[]> {
  const results: T[] = [];
  let idx = 0;

  async function worker() {
    while (idx < tasks.length) {
      const i = idx++;
      results[i] = await tasks[i]();
    }
  }

  const workers = Array.from(
    { length: Math.min(concurrency, tasks.length) },
    () => worker()
  );
  await Promise.all(workers);
  return results;
}

export async function generateImagesParallel(
  items: PropItem[],
  styleGuide: StyleGuide,
  updateProp: (id: string, patch: Partial<PropItem>) => void,
  concurrency = 3
): Promise<void> {
  const tasks = items.map((item) => async () => {
    updateProp(item.id, { status: "generating-image", imageError: null });
    try {
      const prompt = composePrompt(styleGuide, item.description);
      const result = await generateImage(prompt, styleGuide.imageSize);
      let dataUrl: string;
      if (result.b64_json) {
        dataUrl = `data:image/png;base64,${result.b64_json}`;
      } else if (result.url) {
        const resp = await fetch(result.url);
        const blob = await resp.blob();
        dataUrl = await new Promise<string>((resolve) => {
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result as string);
          reader.readAsDataURL(blob);
        });
      } else {
        throw new Error("No image returned");
      }
      updateProp(item.id, { status: "image-ready", conceptImage: dataUrl });
    } catch (err) {
      updateProp(item.id, {
        status: "draft",
        imageError: err instanceof Error ? err.message : "Image gen failed",
      });
    }
  });

  await semaphore(tasks, concurrency);
}

export async function generate3DParallel(
  items: PropItem[],
  updateProp: (id: string, patch: Partial<PropItem>) => void,
  concurrency = 3
): Promise<void> {
  const tasks = items.map((item) => async () => {
    if (!item.conceptImage) return;
    updateProp(item.id, {
      status: "generating-3d",
      modelProgress: 0,
      modelError: null,
    });
    try {
      const resp = await fetch(item.conceptImage);
      const blob = await resp.blob();
      const glb = await generateModel(blob, {}, (p) => {
        updateProp(item.id, { modelProgress: Math.round(p) });
      });
      updateProp(item.id, { status: "3d-ready", rawGlb: glb });
    } catch (err) {
      updateProp(item.id, {
        status: "image-ready",
        modelError: err instanceof Error ? err.message : "3D gen failed",
      });
    }
  });

  await semaphore(tasks, concurrency);
}
