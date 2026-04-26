import type { Plugin, ViteDevServer } from "vite";
import { IncomingMessage, ServerResponse } from "node:http";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { ForgeStore } from "./forge-store";

const ASSETS_ROOT = path.resolve(process.cwd(), "../../assets");
const FORGE_ROOT = path.resolve(process.cwd(), "../../assets/forge");
const MESHES_ROOT = path.resolve(ASSETS_ROOT, "meshes");
const TEXTURED_MESHES_ROOT = path.resolve(ASSETS_ROOT, "textured-meshes");
const BAKE_DRIVER = path.resolve(process.cwd(), "../../scripts/blockstudio/bake-textured-mesh.py");
const BLENDER_BIN = process.env.BLENDER_BIN || "/opt/homebrew/bin/blender";
const forgeStore = new ForgeStore(FORGE_ROOT);

// Load .env files — Vite only exposes VITE_* to client; we need raw keys for server middleware
function loadEnvFile() {
  const candidates = [
    path.resolve(process.cwd(), ".env"),
    path.resolve(process.cwd(), "../../.env"),
  ];
  for (const envPath of candidates) {
    if (fs.existsSync(envPath)) {
      const content = fs.readFileSync(envPath, "utf-8");
      for (const line of content.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) continue;
        const eqIdx = trimmed.indexOf("=");
        if (eqIdx === -1) continue;
        const key = trimmed.slice(0, eqIdx).trim();
        const value = trimmed.slice(eqIdx + 1).trim();
        if (!process.env[key]) {
          process.env[key] = value;
        }
      }
    }
  }
}
loadEnvFile();

function jsonResponse(res: ServerResponse, status: number, data: unknown) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

function errorResponse(res: ServerResponse, status: number, message: string) {
  jsonResponse(res, status, { error: message });
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const body = await readBody(req);
  return JSON.parse(body.toString("utf-8"));
}

function getEnvKey(name: string): string | undefined {
  return process.env[name];
}

// --- OpenAI proxy ---
async function handleOpenAI(
  req: IncomingMessage,
  res: ServerResponse,
  subpath: string
) {
  const apiKey = getEnvKey("OPENAI_API_KEY");
  if (!apiKey) {
    return errorResponse(res, 500, "OPENAI_API_KEY not configured");
  }

  if (subpath === "/generate-image" && req.method === "POST") {
    const body = (await readJson(req)) as {
      prompt: string;
      size?: string;
      quality?: string;
      n?: number;
    };

    const n = Math.max(1, Math.min(8, body.n ?? 1));
    const response = await fetch(
      "https://api.openai.com/v1/images/generations",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "gpt-image-2",
          prompt: body.prompt,
          n,
          size: body.size || "1024x1024",
          quality: body.quality || "high",
          output_format: "png",
        }),
      }
    );

    if (!response.ok) {
      const err = await response.text();
      return errorResponse(res, response.status, err);
    }

    const result = await response.json();
    return jsonResponse(res, 200, result);
  }

  if (subpath === "/edit-image" && req.method === "POST") {
    const body = (await readJson(req)) as {
      prompt: string;
      imageBase64: string;
      size?: string;
      quality?: string;
      n?: number;
    };

    if (!body.imageBase64) {
      return errorResponse(res, 400, "imageBase64 is required");
    }

    // gpt-image-2's legacy /v1/images/edits endpoint is gated (returns 403
    // "organization must be verified" even for verified orgs as of late
    // April 2026 — see OpenAI community threads). The same model IS
    // accessible via the Responses API with `tools:[{type:"image_generation",
    // model:"gpt-image-2"}]`. We always go through Responses; both v1 and
    // v2 work that way and the token-based pricing is the same.
    const imageModel = process.env.OPENAI_IMAGE_MODEL || "gpt-image-2";
    const chatModel = process.env.OPENAI_RESPONSES_MODEL || "gpt-5.5";
    const responsesBody = {
      model: chatModel,
      input: [
        {
          role: "user",
          content: [
            { type: "input_text", text: body.prompt },
            {
              type: "input_image",
              image_url: `data:image/png;base64,${body.imageBase64}`,
            },
          ],
        },
      ],
      tools: [
        {
          type: "image_generation",
          model: imageModel,
          size: body.size || "1024x1024",
          quality: body.quality || "low",
        },
      ],
    };

    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(responsesBody),
    });

    if (!response.ok) {
      const err = await response.text();
      return errorResponse(res, response.status, err);
    }

    const result = (await response.json()) as {
      output?: Array<{ type: string; result?: string }>;
    };
    const igCall = result.output?.find(
      (o) => o.type === "image_generation_call"
    );
    if (!igCall?.result) {
      return errorResponse(
        res,
        500,
        `No image_generation_call.result in Responses output: ${JSON.stringify(result).slice(0, 500)}`
      );
    }
    // Adapt to the legacy /v1/images/* response shape so existing client
    // code (`data.data[0].b64_json`) keeps working unchanged.
    return jsonResponse(res, 200, {
      data: [{ b64_json: igCall.result }],
    });
  }

  errorResponse(res, 404, "Unknown OpenAI endpoint");
}

// --- Tripo proxy ---
async function handleTripo(
  req: IncomingMessage,
  res: ServerResponse,
  subpath: string
) {
  const apiKey = getEnvKey("TRIPO_API_KEY");
  if (!apiKey) {
    return errorResponse(res, 500, "TRIPO_API_KEY not configured");
  }

  const tripoBase = "https://api.tripo3d.ai/v2/openapi";

  if (subpath === "/upload" && req.method === "POST") {
    const body = await readBody(req);
    // Forward multipart body as-is
    const contentType = req.headers["content-type"] || "application/octet-stream";
    const response = await fetch(`${tripoBase}/upload`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": contentType,
      },
      body: new Uint8Array(body),
    });
    const result = await response.json();
    return jsonResponse(res, response.status, result);
  }

  if (subpath === "/task" && req.method === "POST") {
    const body = await readBody(req);
    const response = await fetch(`${tripoBase}/task`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: new Uint8Array(body),
    });
    const result = await response.json();
    return jsonResponse(res, response.status, result);
  }

  if (subpath.startsWith("/task/") && req.method === "GET") {
    const taskId = subpath.replace("/task/", "");
    const response = await fetch(`${tripoBase}/task/${taskId}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    const result = await response.json();
    return jsonResponse(res, response.status, result);
  }

  if (subpath === "/download" && req.method === "GET") {
    const url = new URL(req.url!, "http://localhost");
    const downloadUrl = url.searchParams.get("url");
    if (!downloadUrl) {
      return errorResponse(res, 400, "Missing url param");
    }
    const response = await fetch(downloadUrl, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!response.ok) {
      return errorResponse(res, response.status, "Download failed");
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    res.writeHead(200, {
      "Content-Type": "model/gltf-binary",
      "Content-Length": buffer.length,
    });
    res.end(buffer);
    return;
  }

  errorResponse(res, 404, "Unknown Tripo endpoint");
}

// --- File system ---
function ensureDir(dirPath: string) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

function safePath(base: string, ...segments: string[]): string | null {
  const resolved = path.resolve(base, ...segments);
  if (!resolved.startsWith(base)) return null;
  return resolved;
}

async function handleFs(
  req: IncomingMessage,
  res: ServerResponse,
  subpath: string,
  root: string
) {
  // Read a file or directory listing
  if (subpath === "/read" && req.method === "GET") {
    const url = new URL(req.url!, "http://localhost");
    const filePath = url.searchParams.get("path");
    if (!filePath) return errorResponse(res, 400, "Missing path param");

    const resolved = safePath(root, filePath);
    if (!resolved) return errorResponse(res, 403, "Path traversal denied");

    if (!fs.existsSync(resolved)) {
      return errorResponse(res, 404, "Not found");
    }

    const stat = fs.statSync(resolved);
    if (stat.isDirectory()) {
      const entries = fs.readdirSync(resolved, { withFileTypes: true });
      return jsonResponse(
        res,
        200,
        entries.map((e) => ({ name: e.name, isDirectory: e.isDirectory() }))
      );
    }

    // Return file content
    if (resolved.endsWith(".json") || resolved.endsWith(".txt")) {
      const content = fs.readFileSync(resolved, "utf-8");
      return jsonResponse(res, 200, { content });
    }

    // Binary file — return as-is
    const buffer = fs.readFileSync(resolved);
    const ext = path.extname(resolved).toLowerCase();
    const mimeMap: Record<string, string> = {
      ".png": "image/png",
      ".jpg": "image/jpeg",
      ".jpeg": "image/jpeg",
      ".glb": "model/gltf-binary",
    };
    res.writeHead(200, {
      "Content-Type": mimeMap[ext] || "application/octet-stream",
      "Content-Length": buffer.length,
    });
    res.end(buffer);
    return;
  }

  // Write a file
  if (subpath === "/write" && req.method === "POST") {
    const url = new URL(req.url!, "http://localhost");
    const filePath = url.searchParams.get("path");
    if (!filePath) return errorResponse(res, 400, "Missing path param");

    const resolved = safePath(root, filePath);
    if (!resolved) return errorResponse(res, 403, "Path traversal denied");

    ensureDir(path.dirname(resolved));
    const body = await readBody(req);

    const contentType = req.headers["content-type"] || "";
    if (contentType.includes("application/json")) {
      fs.writeFileSync(resolved, body.toString("utf-8"));
    } else {
      fs.writeFileSync(resolved, body);
    }
    return jsonResponse(res, 200, { ok: true, path: filePath });
  }

  // List style guides or props
  if (subpath === "/list" && req.method === "GET") {
    const url = new URL(req.url!, "http://localhost");
    const dir = url.searchParams.get("dir") || "";
    const resolved = safePath(root, dir);
    if (!resolved) return errorResponse(res, 403, "Path traversal denied");

    if (!fs.existsSync(resolved)) {
      return jsonResponse(res, 200, []);
    }

    const entries = fs.readdirSync(resolved, { withFileTypes: true });
    return jsonResponse(
      res,
      200,
      entries
        .filter((e) => e.isDirectory())
        .map((e) => e.name)
    );
  }

  errorResponse(res, 404, "Unknown FS endpoint");
}

// --- Textured mesh authoring ---

/**
 * Per-role material definition as sent from the client.
 *
 * - PBR: base64 PNG for baseColor, normal, arm (+ optional scalar factors).
 * - Synthetic: a preset name like "glass" — the bake script builds a
 *   procedural shader instead of sampling textures.
 */
type TexturedMeshRoleBody =
  | {
      baseColorPng: string;
      normalPng: string;
      armPng: string;
      roughnessFactor?: number;
      metallicFactor?: number;
    }
  | { synthetic: string };

type BakeRequestBody = {
  name: string;
  baseMeshId: string;
  materials: Record<string, TexturedMeshRoleBody>;
  /** Optional metadata: prompts that produced each role — saved alongside the artifact for provenance. */
  prompts?: Record<string, string>;
};

function safeEntryName(name: string): string | null {
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(name)) return null;
  return name;
}

function writePngFromBase64(filePath: string, b64: string): void {
  const buf = Buffer.from(b64, "base64");
  fs.writeFileSync(filePath, buf);
}

type StoredManifest = {
  name?: string;
  baseMeshId?: string;
  roles?: string[];
  prompts?: Record<string, string>;
  bakedAt?: string;
  updatedAt?: string;
  protected?: boolean;
};

function readManifest(entryDir: string): StoredManifest | null {
  const manifestPath = path.join(entryDir, "manifest.json");
  if (!fs.existsSync(manifestPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(manifestPath, "utf-8")) as StoredManifest;
  } catch {
    return null;
  }
}

function writeManifest(entryDir: string, manifest: StoredManifest): void {
  fs.writeFileSync(path.join(entryDir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
}

function copyDirRecursive(src: string, dst: string): void {
  fs.mkdirSync(dst, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dst, entry.name);
    if (entry.isDirectory()) copyDirRecursive(s, d);
    else fs.copyFileSync(s, d);
  }
}

function rmDirRecursive(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}

function readRoleTexture(entryDir: string, role: string, file: string): string | null {
  const p = path.join(entryDir, "textures", role, file);
  if (!fs.existsSync(p)) return null;
  return fs.readFileSync(p).toString("base64");
}

async function handleTexturedMesh(
  req: IncomingMessage,
  res: ServerResponse,
  subpath: string
) {
  // GET /list — enumerate existing textured-mesh entries (manifest inlined, unchanged shape)
  if (subpath === "/list" && req.method === "GET") {
    if (!fs.existsSync(TEXTURED_MESHES_ROOT)) {
      return jsonResponse(res, 200, { entries: [] });
    }
    const entries = fs
      .readdirSync(TEXTURED_MESHES_ROOT, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith("_"))
      .map((e) => ({ name: e.name, manifest: readManifest(path.join(TEXTURED_MESHES_ROOT, e.name)) }));
    return jsonResponse(res, 200, { entries });
  }

  // GET /meshes — list available base meshes
  if (subpath === "/meshes" && req.method === "GET") {
    if (!fs.existsSync(MESHES_ROOT)) {
      return jsonResponse(res, 200, { meshes: [] });
    }
    const meshes = fs
      .readdirSync(MESHES_ROOT)
      .filter((f) => f.endsWith(".glb"))
      .map((f) => f.replace(/\.glb$/, ""));
    return jsonResponse(res, 200, { meshes });
  }

  // /entries/:name (+ optional /duplicate) — single-entry management
  if (subpath.startsWith("/entries/")) {
    const rest = subpath.slice("/entries/".length);
    const [rawName, op] = rest.split("/");
    const entryName = rawName ? safeEntryName(rawName) : null;
    if (!entryName) return errorResponse(res, 400, "Invalid entry name");
    const entryDir = path.join(TEXTURED_MESHES_ROOT, entryName);
    const manifest = readManifest(entryDir);

    // POST /entries/:name/duplicate — server-side copy
    if (op === "duplicate" && req.method === "POST") {
      if (!fs.existsSync(entryDir)) return errorResponse(res, 404, "Entry not found");
      const body = (await readJson(req)) as { name: string };
      const newName = body.name && safeEntryName(body.name);
      if (!newName) return errorResponse(res, 400, "Invalid target name");
      const newDir = path.join(TEXTURED_MESHES_ROOT, newName);
      if (fs.existsSync(newDir)) return errorResponse(res, 409, "Target already exists");
      copyDirRecursive(entryDir, newDir);
      const copied = readManifest(newDir);
      if (copied) {
        const now = new Date().toISOString();
        writeManifest(newDir, { ...copied, name: newName, protected: false, bakedAt: now, updatedAt: now });
      }
      return jsonResponse(res, 200, { ok: true, name: newName });
    }

    // GET /entries/:name — full entry including texture base64s
    if (!op && req.method === "GET") {
      if (!fs.existsSync(entryDir)) return errorResponse(res, 404, "Entry not found");
      const roles = manifest?.roles ?? [];
      const textures: Record<string, { baseColorB64: string; normalB64: string; armB64: string }> = {};
      for (const role of roles) {
        const bc = readRoleTexture(entryDir, role, "baseColor.png");
        const nr = readRoleTexture(entryDir, role, "normal.png");
        const ar = readRoleTexture(entryDir, role, "arm.png");
        if (bc && nr && ar) textures[role] = { baseColorB64: bc, normalB64: nr, armB64: ar };
      }
      return jsonResponse(res, 200, { manifest, textures });
    }

    // DELETE /entries/:name — refuse if protected
    if (!op && req.method === "DELETE") {
      if (!fs.existsSync(entryDir)) return errorResponse(res, 404, "Entry not found");
      if (manifest?.protected) return errorResponse(res, 409, "Entry is protected — unlock before deleting");
      rmDirRecursive(entryDir);
      return jsonResponse(res, 200, { ok: true });
    }

    // PATCH /entries/:name — rename and/or protected
    if (!op && req.method === "PATCH") {
      if (!fs.existsSync(entryDir)) return errorResponse(res, 404, "Entry not found");
      const body = (await readJson(req)) as { rename?: string; protected?: boolean };
      if (manifest?.protected && body.rename !== undefined) {
        return errorResponse(res, 409, "Entry is protected — unlock before renaming");
      }
      let finalName = entryName;
      let finalDir = entryDir;
      if (body.rename !== undefined) {
        const newName = safeEntryName(body.rename);
        if (!newName) return errorResponse(res, 400, "Invalid target name");
        if (newName !== entryName) {
          const newDir = path.join(TEXTURED_MESHES_ROOT, newName);
          if (fs.existsSync(newDir)) return errorResponse(res, 409, "Target already exists");
          fs.renameSync(entryDir, newDir);
          finalName = newName;
          finalDir = newDir;
        }
      }
      const cur = readManifest(finalDir) ?? {};
      const next: StoredManifest = {
        ...cur,
        name: finalName,
        ...(body.protected !== undefined ? { protected: body.protected } : {}),
      };
      writeManifest(finalDir, next);
      return jsonResponse(res, 200, { ok: true, name: finalName, manifest: next });
    }

    return errorResponse(res, 404, "Unknown entry endpoint");
  }

  // POST /bake — write textures, invoke Blender, produce artifact.glb
  if (subpath === "/bake" && req.method === "POST") {
    const body = (await readJson(req)) as BakeRequestBody;

    const entryName = body.name && safeEntryName(body.name);
    if (!entryName) {
      return errorResponse(res, 400, "Invalid entry name (alphanumeric/underscore/dash, ≤64 chars)");
    }
    if (!body.baseMeshId || typeof body.baseMeshId !== "string") {
      return errorResponse(res, 400, "Missing baseMeshId");
    }

    const baseMeshPath = path.join(MESHES_ROOT, `${body.baseMeshId}.glb`);
    if (!fs.existsSync(baseMeshPath)) {
      return errorResponse(res, 404, `Base mesh not found: ${body.baseMeshId}`);
    }

    const entryDir = path.join(TEXTURED_MESHES_ROOT, entryName);
    const existingManifest = fs.existsSync(entryDir) ? readManifest(entryDir) : null;
    if (existingManifest?.protected) {
      return errorResponse(res, 409, "Entry is protected — unlock before re-baking");
    }
    const texturesDir = path.join(entryDir, "textures");
    ensureDir(texturesDir);

    // Write each role's PNGs to disk, build the job materials dict.
    const jobMaterials: Record<string, unknown> = {};
    for (const [role, matBody] of Object.entries(body.materials || {})) {
      if ("synthetic" in matBody) {
        jobMaterials[role] = { synthetic: matBody.synthetic };
        continue;
      }
      const roleDir = path.join(texturesDir, role);
      ensureDir(roleDir);
      const bc = path.join(roleDir, "baseColor.png");
      const nr = path.join(roleDir, "normal.png");
      const ar = path.join(roleDir, "arm.png");
      writePngFromBase64(bc, matBody.baseColorPng);
      writePngFromBase64(nr, matBody.normalPng);
      writePngFromBase64(ar, matBody.armPng);
      jobMaterials[role] = {
        baseColor: bc,
        normal: nr,
        arm: ar,
        roughnessFactor: matBody.roughnessFactor ?? 0.85,
        metallicFactor: matBody.metallicFactor ?? 0.0,
      };
    }

    const artifactPath = path.join(entryDir, "artifact.glb");
    const jobPath = path.join(os.tmpdir(), `bake-${entryName}-${Date.now()}.json`);
    fs.writeFileSync(
      jobPath,
      JSON.stringify({
        baseMeshPath,
        materials: jobMaterials,
        outputPath: artifactPath,
      })
    );

    try {
      if (!fs.existsSync(BLENDER_BIN)) {
        return errorResponse(res, 500, `Blender not found at ${BLENDER_BIN}`);
      }
      execFileSync(
        BLENDER_BIN,
        ["--background", "--python", BAKE_DRIVER, "--", "--job", jobPath],
        { stdio: "inherit" }
      );
    } catch (err) {
      return errorResponse(res, 500, `Bake failed: ${(err as Error).message}`);
    } finally {
      try {
        fs.unlinkSync(jobPath);
      } catch {
        // ignore
      }
    }

    const now = new Date().toISOString();
    const manifest: StoredManifest = {
      name: entryName,
      baseMeshId: body.baseMeshId,
      roles: Object.keys(body.materials || {}),
      prompts: body.prompts ?? {},
      bakedAt: existingManifest?.bakedAt ?? now,
      updatedAt: now,
      protected: existingManifest?.protected ?? false,
    };
    writeManifest(entryDir, manifest);

    return jsonResponse(res, 200, {
      ok: true,
      name: entryName,
      artifactPath: `textured-meshes/${entryName}/artifact.glb`,
      manifest,
    });
  }

  errorResponse(res, 404, "Unknown textured-mesh endpoint");
}

function serveBinaryFile(res: ServerResponse, filePath: string) {
  if (!fs.existsSync(filePath)) {
    return errorResponse(res, 404, "Not found");
  }
  const buffer = fs.readFileSync(filePath);
  const ext = path.extname(filePath).toLowerCase();
  const mimeMap: Record<string, string> = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".glb": "model/gltf-binary",
  };
  res.writeHead(200, {
    "Content-Type": mimeMap[ext] || "application/octet-stream",
    "Content-Length": buffer.length,
  });
  res.end(buffer);
}

async function handleForge(
  req: IncomingMessage,
  res: ServerResponse,
  subpath: string
) {
  const parts = subpath.split("/").filter(Boolean);

  if (parts.length === 1 && parts[0] === "props" && req.method === "GET") {
    return jsonResponse(res, 200, await forgeStore.listProps());
  }

  if (parts.length === 1 && parts[0] === "props" && req.method === "POST") {
    const body = (await readJson(req)) as { meta?: unknown };
    try {
      const meta = await forgeStore.createProp(body.meta);
      return jsonResponse(res, 200, meta);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to create prop";
      return errorResponse(res, message.includes("already exists") ? 409 : 400, message);
    }
  }

  if (parts.length === 1 && parts[0] === "collider-presets" && req.method === "GET") {
    return jsonResponse(res, 200, await forgeStore.readColliderPresets());
  }

  if (parts.length === 1 && parts[0] === "collider-presets" && req.method === "PUT") {
    const body = (await readJson(req)) as { file?: unknown };
    return jsonResponse(res, 200, await forgeStore.writeColliderPresets(body.file));
  }

  if (parts.length === 1 && parts[0] === "physics-kinds" && req.method === "GET") {
    return jsonResponse(res, 200, await forgeStore.readPhysicsKinds());
  }

  if (parts.length === 1 && parts[0] === "physics-kinds" && req.method === "PUT") {
    const body = (await readJson(req)) as { file?: unknown };
    return jsonResponse(res, 200, await forgeStore.writePhysicsKinds(body.file));
  }

  if (parts.length >= 2 && parts[0] === "props") {
    const propId = decodeURIComponent(parts[1]);

    if (parts.length === 2 && req.method === "GET") {
      const record = await forgeStore.getProp(propId);
      if (!record) {
        return errorResponse(res, 404, "Not found");
      }
      return jsonResponse(res, 200, record);
    }

    if (parts.length === 3 && parts[2] === "concept-image" && req.method === "GET") {
      return serveBinaryFile(res, forgeStore.getConceptImagePath(propId));
    }

    if (parts.length === 3 && parts[2] === "raw-glb" && req.method === "GET") {
      return serveBinaryFile(res, forgeStore.getRawGlbPath(propId));
    }

    if (parts.length === 3 && parts[2] === "processed-glb" && req.method === "GET") {
      return serveBinaryFile(res, forgeStore.getProcessedGlbPath(propId));
    }

    if (parts.length === 3 && parts[2] === "reference" && req.method === "POST") {
      const body = (await readJson(req)) as {
        meta?: unknown;
        conceptImageDataUrl?: string | null;
        prompt?: string | null;
      };
      return jsonResponse(
        res,
        200,
        await forgeStore.saveReferenceStage({
          propId,
          meta: body.meta as never,
          conceptImageDataUrl: body.conceptImageDataUrl,
          prompt: body.prompt,
        })
      );
    }

    if (parts.length === 3 && parts[2] === "mesh" && req.method === "POST") {
      const body = (await readJson(req)) as {
        meta?: unknown;
        rawGlbBase64?: string | null;
        processedGlbBase64?: string | null;
      };
      return jsonResponse(
        res,
        200,
        await forgeStore.saveMeshStage({
          propId,
          meta: body.meta as never,
          rawGlbBase64: body.rawGlbBase64,
          processedGlbBase64: body.processedGlbBase64,
        })
      );
    }

    if (parts.length === 3 && parts[2] === "physics" && req.method === "POST") {
      const body = (await readJson(req)) as {
        meta?: unknown;
        colliderGlbs?: Array<{ presetId: string; glbBase64: string }>;
      };
      return jsonResponse(
        res,
        200,
        await forgeStore.savePhysicsStage({
          propId,
          meta: body.meta as never,
          colliderGlbs: Array.isArray(body.colliderGlbs) ? body.colliderGlbs : [],
        })
      );
    }
  }

  errorResponse(res, 404, "Unknown Forge endpoint");
}

export function apiProxyPlugin(): Plugin {
  return {
    name: "forge-api-proxy",
    configureServer(server: ViteDevServer) {
      server.middlewares.use(async (req, res, next) => {
        const url = req.url || "";

        if (!url.startsWith("/api/")) {
          return next();
        }

        try {
          if (url.startsWith("/api/openai/")) {
            const subpath = url.replace("/api/openai", "").split("?")[0];
            return await handleOpenAI(req, res, subpath);
          }

          if (url.startsWith("/api/tripo/")) {
            const subpath = url.replace("/api/tripo", "").split("?")[0];
            return await handleTripo(req, res, subpath);
          }

          if (url.startsWith("/api/assets/")) {
            const subpath = url.replace("/api/assets", "").split("?")[0];
            return await handleFs(req, res, subpath, ASSETS_ROOT);
          }

          if (url.startsWith("/api/forge/")) {
            const subpath = url.replace("/api/forge", "").split("?")[0];
            return await handleForge(req, res, subpath);
          }

          if (url.startsWith("/api/fs/")) {
            const subpath = url.replace("/api/fs", "").split("?")[0];
            return await handleFs(req, res, subpath, FORGE_ROOT);
          }

          if (url.startsWith("/api/textured-mesh/")) {
            const subpath = url.replace("/api/textured-mesh", "").split("?")[0];
            return await handleTexturedMesh(req, res, subpath);
          }

          errorResponse(res, 404, "Unknown API route");
        } catch (err) {
          console.error("[forge-api-proxy]", err);
          errorResponse(
            res,
            500,
            err instanceof Error ? err.message : "Internal error"
          );
        }
      });
    },
  };
}
