export interface TripoTask {
  task_id: string;
  type: string;
  status: "queued" | "running" | "success" | "failed";
  progress: number;
  output?: {
    model?: string;
    pbr_model?: string;
    base_model?: string;
    rendered_image?: string;
  };
}

function getModelUrl(task: TripoTask): string | undefined {
  const out = task.output;
  if (!out) return undefined;
  return out.model || out.pbr_model || out.base_model;
}

export async function uploadImage(imageBlob: Blob): Promise<string> {
  const form = new FormData();
  form.append("file", imageBlob, "concept.png");

  const res = await fetch("/api/tripo/upload", {
    method: "POST",
    body: form,
  });

  if (!res.ok) throw new Error("Tripo upload failed");
  const data = await res.json();
  return data.data?.image_token ?? data.image_token;
}

export async function createTask(params: {
  type: string;
  file?: { type: string; file_token: string };
  model_version?: string;
  face_limit?: number;
  texture?: boolean;
  pbr?: boolean;
}): Promise<string> {
  const res = await fetch("/api/tripo/task", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(params),
  });

  if (!res.ok) throw new Error("Tripo task creation failed");
  const data = await res.json();
  return data.data?.task_id ?? data.task_id;
}

export async function pollTask(taskId: string): Promise<TripoTask> {
  const res = await fetch(`/api/tripo/task/${taskId}`);
  if (!res.ok) throw new Error("Tripo poll failed");
  const data = await res.json();
  return (data.data ?? data) as TripoTask;
}

export async function downloadModel(url: string): Promise<ArrayBuffer> {
  const res = await fetch(
    `/api/tripo/download?url=${encodeURIComponent(url)}`
  );
  if (!res.ok) throw new Error("Tripo download failed");
  return res.arrayBuffer();
}

export async function generateModel(
  imageBlob: Blob,
  opts: { faceLimit?: number; pbr?: boolean } = {},
  onProgress?: (progress: number, status: string) => void
): Promise<ArrayBuffer> {
  onProgress?.(0, "Uploading image...");
  const token = await uploadImage(imageBlob);

  onProgress?.(5, "Creating 3D task...");
  const taskId = await createTask({
    type: "image_to_model",
    model_version: "v3.0-20250812",
    file: { type: "image", file_token: token },
    face_limit: opts.faceLimit ?? 20000,
    texture: opts.pbr !== false,
    pbr: opts.pbr !== false,
  });

  // Poll until done
  let task: TripoTask;
  do {
    await new Promise((r) => setTimeout(r, 2000));
    task = await pollTask(taskId);
    onProgress?.(5 + task.progress * 0.9, task.status);
  } while (task.status === "queued" || task.status === "running");

  const modelUrl = getModelUrl(task);
  if (task.status !== "success" || !modelUrl) {
    throw new Error(`Tripo task failed: ${task.status} (keys: ${Object.keys(task.output ?? {}).join(", ")})`);
  }

  onProgress?.(95, "Downloading model...");
  const glb = await downloadModel(modelUrl);
  onProgress?.(100, "Done");
  return glb;
}
