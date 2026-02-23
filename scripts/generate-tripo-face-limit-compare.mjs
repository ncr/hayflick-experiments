import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, "..");

const TRIPO_PROXY_BASE =
  process.env.TRIPO_PROXY_BASE ?? "http://127.0.0.1:4173/api/tripo";
const MODEL_VERSION = "v3.0-20250812";
const FACE_LIMITS = [1000, 3000, 5000, 10000];

const PROPS = [
  {
    id: "chemical-flask",
    label: "Chemical Flask",
    sourceRawDir: path.join(
      REPO_ROOT,
      "assets/forge-v2/props/chemical-flask/raw"
    ),
  },
  {
    id: "commodore-pet-inspired-computer",
    label: "Commodore PET Inspired Computer",
    sourceRawDir: path.join(
      REPO_ROOT,
      "assets/forge-v2/props/commodore-pet-inspired-computer/raw"
    ),
  },
  {
    id: "professional-workbench-chair",
    label: "Professional Workbench Chair",
    sourceRawDir: path.join(
      REPO_ROOT,
      "assets/forge-v2/props/professional-workbench-chair/raw"
    ),
  },
];

const OUTPUT_ROOT = path.join(
  REPO_ROOT,
  "packages/experiments/src/tripo-face-limit-compare/generated"
);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function nowIso() {
  return new Date().toISOString();
}

function maybeParseQuotedPrompt(text) {
  const trimmed = text.trim();
  if (!trimmed) return "";
  if (trimmed.startsWith("\"") && trimmed.endsWith("\"")) {
    try {
      const parsed = JSON.parse(trimmed);
      if (typeof parsed === "string") return parsed;
    } catch {
      // Keep raw text if prompt.txt is not JSON-string encoded.
    }
  }
  return trimmed;
}

async function readPropInputs(prop) {
  const conceptPath = path.join(prop.sourceRawDir, "concept.png");
  const promptPath = path.join(prop.sourceRawDir, "prompt.txt");
  const [conceptBytes, promptRaw] = await Promise.all([
    fs.readFile(conceptPath),
    fs.readFile(promptPath, "utf8"),
  ]);
  return {
    conceptBytes,
    promptRaw,
    promptParsed: maybeParseQuotedPrompt(promptRaw),
    conceptPath,
    promptPath,
  };
}

async function postMultipartUpload(imageBytes) {
  const form = new FormData();
  form.append("file", new Blob([imageBytes]), "concept.png");
  const res = await fetch(`${TRIPO_PROXY_BASE}/upload`, {
    method: "POST",
    body: form,
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    // ignore
  }
  if (!res.ok) {
    throw new Error(
      `Tripo upload failed (${res.status}): ${json?.error ?? text.slice(0, 300)}`
    );
  }
  const token = json?.data?.image_token ?? json?.image_token;
  if (!token) {
    throw new Error(`Tripo upload missing image token: ${text.slice(0, 300)}`);
  }
  return { token, raw: json };
}

async function postCreateTask(body) {
  const res = await fetch(`${TRIPO_PROXY_BASE}/task`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    // ignore
  }
  if (!res.ok) {
    const err = new Error(
      `Tripo task creation failed (${res.status}): ${json?.error ?? text.slice(0, 500)}`
    );
    err.status = res.status;
    err.bodyText = text;
    throw err;
  }
  const taskId = json?.data?.task_id ?? json?.task_id;
  if (!taskId) {
    throw new Error(`Tripo task response missing task_id: ${text.slice(0, 300)}`);
  }
  return { taskId, raw: json };
}

async function createTaskWithOptionalPrompt({
  imageToken,
  faceLimit,
  prompt,
}) {
  const base = {
    type: "image_to_model",
    model_version: MODEL_VERSION,
    file: { type: "image", file_token: imageToken },
    face_limit: faceLimit,
    texture: true,
    pbr: true,
  };

  if (prompt) {
    try {
      const created = await postCreateTask({ ...base, prompt });
      return { ...created, promptIncluded: true };
    } catch (err) {
      const msg = String(err?.bodyText ?? err?.message ?? err);
      console.warn(
        `[createTask] prompt field rejected for face_limit=${faceLimit}, retrying without prompt: ${msg.slice(0, 160)}`
      );
    }
  }

  const created = await postCreateTask(base);
  return { ...created, promptIncluded: false };
}

async function pollTask(taskId) {
  const res = await fetch(`${TRIPO_PROXY_BASE}/task/${encodeURIComponent(taskId)}`);
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    // ignore
  }
  if (!res.ok) {
    throw new Error(
      `Tripo poll failed (${res.status}): ${json?.error ?? text.slice(0, 300)}`
    );
  }
  return json?.data ?? json;
}

function getModelUrl(task) {
  const out = task?.output ?? {};
  return out.model || out.pbr_model || out.base_model;
}

async function downloadModel(url) {
  const res = await fetch(
    `${TRIPO_PROXY_BASE}/download?url=${encodeURIComponent(url)}`
  );
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Tripo download failed (${res.status}): ${text.slice(0, 300)}`);
  }
  return Buffer.from(await res.arrayBuffer());
}

async function writeJson(filePath, data) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

async function fileExists(filePath) {
  try {
    await fs.stat(filePath);
    return true;
  } catch {
    return false;
  }
}

async function generateVariant(prop, inputs, faceLimit) {
  const outDir = path.join(OUTPUT_ROOT, prop.id);
  const glbPath = path.join(outDir, `${faceLimit}.glb`);
  const metaPath = path.join(outDir, `${faceLimit}.json`);

  if (await fileExists(glbPath)) {
    console.log(`[skip] ${prop.id} ${faceLimit} (already exists)`);
    return {
      propId: prop.id,
      faceLimit,
      glbRelPath: path.relative(OUTPUT_ROOT, glbPath).replaceAll(path.sep, "/"),
      metaRelPath: path.relative(OUTPUT_ROOT, metaPath).replaceAll(path.sep, "/"),
      skipped: true,
    };
  }

  console.log(`[start] ${prop.id} face_limit=${faceLimit}`);
  const upload = await postMultipartUpload(inputs.conceptBytes);
  console.log(`[upload] ${prop.id} face_limit=${faceLimit} token ok`);

  const created = await createTaskWithOptionalPrompt({
    imageToken: upload.token,
    faceLimit,
    prompt: inputs.promptParsed,
  });
  console.log(
    `[task] ${prop.id} face_limit=${faceLimit} task=${created.taskId} promptIncluded=${created.promptIncluded}`
  );

  let task = null;
  let pollCount = 0;
  do {
    await sleep(2000);
    task = await pollTask(created.taskId);
    pollCount += 1;
    console.log(
      `[poll] ${prop.id} ${faceLimit} status=${task.status} progress=${task.progress ?? "?"} (#${pollCount})`
    );
  } while (task.status === "queued" || task.status === "running");

  const modelUrl = getModelUrl(task);
  if (task.status !== "success" || !modelUrl) {
    await writeJson(metaPath, {
      propId: prop.id,
      faceLimit,
      failedAt: nowIso(),
      status: task.status,
      taskId: created.taskId,
      task,
      promptRaw: inputs.promptRaw,
      promptParsed: inputs.promptParsed,
      promptIncludedInTaskRequest: created.promptIncluded,
    });
    throw new Error(
      `Tripo task failed for ${prop.id} face_limit=${faceLimit}: ${task.status}`
    );
  }

  const glbBytes = await downloadModel(modelUrl);
  await fs.mkdir(outDir, { recursive: true });
  await fs.writeFile(glbPath, glbBytes);

  const variantMeta = {
    propId: prop.id,
    propLabel: prop.label,
    faceLimit,
    generatedAt: nowIso(),
    source: {
      promptPath: path.relative(REPO_ROOT, inputs.promptPath).replaceAll(path.sep, "/"),
      conceptPath: path.relative(REPO_ROOT, inputs.conceptPath).replaceAll(path.sep, "/"),
    },
    promptRaw: inputs.promptRaw,
    promptParsed: inputs.promptParsed,
    taskId: created.taskId,
    tripoTaskStatus: task.status,
    tripoTaskProgress: task.progress ?? null,
    tripoModelUrl: modelUrl,
    promptIncludedInTaskRequest: created.promptIncluded,
    task,
    file: {
      glb: path.relative(OUTPUT_ROOT, glbPath).replaceAll(path.sep, "/"),
      bytes: glbBytes.length,
    },
  };
  await writeJson(metaPath, variantMeta);
  console.log(
    `[done] ${prop.id} face_limit=${faceLimit} bytes=${glbBytes.length}`
  );
  return {
    propId: prop.id,
    faceLimit,
    glbRelPath: variantMeta.file.glb,
    metaRelPath: path.relative(OUTPUT_ROOT, metaPath).replaceAll(path.sep, "/"),
    skipped: false,
  };
}

async function main() {
  const startedAt = nowIso();
  console.log(`[info] Tripo face-limit generation starting via ${TRIPO_PROXY_BASE}`);
  await fs.mkdir(OUTPUT_ROOT, { recursive: true });

  const allResults = [];
  for (const prop of PROPS) {
    const inputs = await readPropInputs(prop);
    for (const faceLimit of FACE_LIMITS) {
      const result = await generateVariant(prop, inputs, faceLimit);
      allResults.push(result);
    }
  }

  const manifest = {
    id: "tripo-face-limit-compare",
    generatedAt: nowIso(),
    startedAt,
    tripoProxyBase: TRIPO_PROXY_BASE,
    modelVersion: MODEL_VERSION,
    faceLimits: FACE_LIMITS,
    props: PROPS.map((p) => ({ id: p.id, label: p.label })),
    variants: allResults,
  };
  await writeJson(path.join(OUTPUT_ROOT, "manifest.json"), manifest);
  console.log(`[info] Wrote manifest with ${allResults.length} variants`);
}

main().catch((err) => {
  console.error(err?.stack ?? String(err));
  process.exitCode = 1;
});
