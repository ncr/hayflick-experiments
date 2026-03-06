import type { Plugin, ViteDevServer } from "vite";
import { IncomingMessage, ServerResponse } from "node:http";
import * as fs from "node:fs";
import * as path from "node:path";
import { ForgeStore } from "./forge-store";

const ASSETS_ROOT = path.resolve(process.cwd(), "../../assets");
const FORGE_ROOT = path.resolve(process.cwd(), "../../assets/forge");
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
    };

    const response = await fetch(
      "https://api.openai.com/v1/images/generations",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "gpt-image-1",
          prompt: body.prompt,
          n: 1,
          size: body.size || "1024x1024",
          quality: body.quality || "high",
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
