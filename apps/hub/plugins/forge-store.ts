import * as fs from "node:fs/promises";
import * as path from "node:path";

import {
  defaultForgeColliderPresetFile,
  defaultForgePhysicsKindPresetFile,
  sanitizeForgeColliderPresetFile,
  sanitizeForgePhysicsKindPresetFile,
  sanitizeForgePropMeta,
  type ForgeStoredColliderPresetFile,
  type ForgeStoredPhysicsKindPresetFile,
  type ForgeStoredPropMeta,
} from "./forge-store-schema";

type ForgeLifecycleStatus = "draft" | "image-ready" | "mesh-ready" | "physics-ready";

export interface ForgePropIndexItem {
  id: string;
  description: string;
  status: ForgeLifecycleStatus;
  createdAt: string;
  updatedAt: string;
  hasConceptImage: boolean;
}

interface ForgePropIndexFile {
  version: 1;
  updatedAt: string;
  props: ForgePropIndexItem[];
}

type SaveReferenceStageInput = {
  propId: string;
  meta: ForgeStoredPropMeta;
  conceptImageDataUrl?: string | null;
  prompt?: string | null;
};

type SaveMeshStageInput = {
  propId: string;
  meta: ForgeStoredPropMeta;
  rawGlbBase64?: string | null;
  processedGlbBase64?: string | null;
};

type SavePhysicsStageInput = {
  propId: string;
  meta: ForgeStoredPropMeta;
  colliderGlbs: Array<{
    presetId: string;
    glbBase64: string;
  }>;
};

const PROPS_DIR = "props";
const INDEX_FILE = "index.json";
const COLLIDER_PRESETS_FILE = "collider-presets.json";
const PHYSICS_KINDS_FILE = "physics-kinds.json";

async function exists(filePath: string): Promise<boolean> {
  try {
    await fs.stat(filePath);
    return true;
  } catch {
    return false;
  }
}

async function ensureDir(dirPath: string): Promise<void> {
  await fs.mkdir(dirPath, { recursive: true });
}

async function writeFileAtomic(filePath: string, data: Buffer | string): Promise<void> {
  await ensureDir(path.dirname(filePath));
  const tempFile = `${filePath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  await fs.writeFile(tempFile, data);
  await fs.rename(tempFile, filePath);
}

async function readJsonFile<T>(filePath: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8")) as T;
  } catch {
    return null;
  }
}

function decodeDataUrl(dataUrl: string): Buffer {
  const match = dataUrl.match(/^data:.*?;base64,(.+)$/);
  if (!match) {
    throw new Error("Invalid data URL");
  }
  return Buffer.from(match[1], "base64");
}

function decodeBase64(base64: string): Buffer {
  return Buffer.from(base64, "base64");
}

function conceptImagePath(root: string, propId: string): string {
  return path.join(root, PROPS_DIR, propId, "raw", "concept.png");
}

function promptPath(root: string, propId: string): string {
  return path.join(root, PROPS_DIR, propId, "raw", "prompt.txt");
}

function rawGlbPath(root: string, propId: string): string {
  return path.join(root, PROPS_DIR, propId, "raw", "tripo-output.glb");
}

function processedGlbPath(root: string, propId: string): string {
  return path.join(root, PROPS_DIR, propId, "processed", "model.glb");
}

function colliderGlbPath(root: string, propId: string, presetId: string): string {
  return path.join(root, PROPS_DIR, propId, "processed", "colliders", `${presetId}.glb`);
}

function metaPath(root: string, propId: string): string {
  return path.join(root, PROPS_DIR, propId, "meta.json");
}

export class ForgeStore {
  constructor(private readonly root: string) {}

  getConceptImagePath(propId: string): string {
    return conceptImagePath(this.root, propId);
  }

  getRawGlbPath(propId: string): string {
    return rawGlbPath(this.root, propId);
  }

  getProcessedGlbPath(propId: string): string {
    return processedGlbPath(this.root, propId);
  }

  async listProps(): Promise<ForgePropIndexItem[]> {
    const indexPath = path.join(this.root, INDEX_FILE);
    const cached = await readJsonFile<ForgePropIndexFile>(indexPath);
    if (cached?.version === 1 && Array.isArray(cached.props)) {
      return cached.props;
    }
    return this.rebuildIndex();
  }

  async getProp(propId: string): Promise<{ meta: ForgeStoredPropMeta; hasConceptImage: boolean } | null> {
    const meta = await this.readMeta(propId);
    if (!meta) return null;
    return {
      meta,
      hasConceptImage: await exists(conceptImagePath(this.root, propId)),
    };
  }

  async readMeta(propId: string): Promise<ForgeStoredPropMeta | null> {
    const raw = await readJsonFile<unknown>(metaPath(this.root, propId));
    return sanitizeForgePropMeta(raw);
  }

  async createProp(rawMeta: unknown): Promise<ForgeStoredPropMeta> {
    const meta = sanitizeForgePropMeta(rawMeta);
    if (!meta) {
      throw new Error("Invalid prop meta");
    }
    const filePath = metaPath(this.root, meta.id);
    if (await exists(filePath)) {
      throw new Error(`Prop already exists: ${meta.id}`);
    }
    await this.writeMeta(meta);
    return meta;
  }

  async saveReferenceStage(input: SaveReferenceStageInput): Promise<ForgeStoredPropMeta> {
    this.assertPropId(input.propId, input.meta);
    if (input.conceptImageDataUrl) {
      await writeFileAtomic(
        conceptImagePath(this.root, input.propId),
        decodeDataUrl(input.conceptImageDataUrl)
      );
    }
    if (input.prompt != null) {
      await writeFileAtomic(promptPath(this.root, input.propId), input.prompt);
    }
    return this.writeMeta(input.meta);
  }

  async saveMeshStage(input: SaveMeshStageInput): Promise<ForgeStoredPropMeta> {
    this.assertPropId(input.propId, input.meta);
    if (input.rawGlbBase64) {
      await writeFileAtomic(rawGlbPath(this.root, input.propId), decodeBase64(input.rawGlbBase64));
    }
    if (input.processedGlbBase64) {
      await writeFileAtomic(
        processedGlbPath(this.root, input.propId),
        decodeBase64(input.processedGlbBase64)
      );
    }
    return this.writeMeta(input.meta);
  }

  async savePhysicsStage(input: SavePhysicsStageInput): Promise<ForgeStoredPropMeta> {
    this.assertPropId(input.propId, input.meta);
    for (const entry of input.colliderGlbs) {
      await writeFileAtomic(
        colliderGlbPath(this.root, input.propId, entry.presetId),
        decodeBase64(entry.glbBase64)
      );
    }
    return this.writeMeta(input.meta);
  }

  async readColliderPresets(): Promise<ForgeStoredColliderPresetFile> {
    const filePath = path.join(this.root, COLLIDER_PRESETS_FILE);
    const raw = await readJsonFile<unknown>(filePath);
    if (!raw) {
      const defaults = defaultForgeColliderPresetFile();
      await writeFileAtomic(filePath, JSON.stringify(defaults, null, 2));
      return defaults;
    }
    return sanitizeForgeColliderPresetFile(raw);
  }

  async writeColliderPresets(file: unknown): Promise<ForgeStoredColliderPresetFile> {
    const next = {
      ...sanitizeForgeColliderPresetFile(file),
      updatedAt: new Date().toISOString(),
    };
    await writeFileAtomic(
      path.join(this.root, COLLIDER_PRESETS_FILE),
      JSON.stringify(next, null, 2)
    );
    return next;
  }

  async readPhysicsKinds(): Promise<ForgeStoredPhysicsKindPresetFile> {
    const filePath = path.join(this.root, PHYSICS_KINDS_FILE);
    const raw = await readJsonFile<unknown>(filePath);
    if (!raw) {
      const defaults = defaultForgePhysicsKindPresetFile();
      await writeFileAtomic(filePath, JSON.stringify(defaults, null, 2));
      return defaults;
    }
    return sanitizeForgePhysicsKindPresetFile(raw);
  }

  async writePhysicsKinds(file: unknown): Promise<ForgeStoredPhysicsKindPresetFile> {
    const next = {
      ...sanitizeForgePhysicsKindPresetFile(file),
      updatedAt: new Date().toISOString(),
    };
    await writeFileAtomic(
      path.join(this.root, PHYSICS_KINDS_FILE),
      JSON.stringify(next, null, 2)
    );
    return next;
  }

  private async writeMeta(meta: ForgeStoredPropMeta): Promise<ForgeStoredPropMeta> {
    const next: ForgeStoredPropMeta = {
      ...meta,
      updatedAt: new Date().toISOString(),
    };
    await writeFileAtomic(metaPath(this.root, meta.id), JSON.stringify(next, null, 2));
    await this.rebuildIndex();
    return next;
  }

  private async rebuildIndex(): Promise<ForgePropIndexItem[]> {
    const propsRoot = path.join(this.root, PROPS_DIR);
    await ensureDir(propsRoot);
    const entries = await fs.readdir(propsRoot, { withFileTypes: true });
    const props: ForgePropIndexItem[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const meta = await this.readMeta(entry.name);
      if (!meta) continue;
      props.push({
        id: meta.id,
        description: meta.description ?? meta.id,
        status: (meta.lifecycle?.status as ForgeLifecycleStatus) ?? "draft",
        createdAt: meta.createdAt ?? new Date().toISOString(),
        updatedAt: meta.updatedAt ?? meta.createdAt ?? new Date().toISOString(),
        hasConceptImage: await exists(conceptImagePath(this.root, meta.id)),
      });
    }
    props.sort((a, b) => a.id.localeCompare(b.id));
    const index: ForgePropIndexFile = {
      version: 1,
      updatedAt: new Date().toISOString(),
      props,
    };
    await writeFileAtomic(path.join(this.root, INDEX_FILE), JSON.stringify(index, null, 2));
    return props;
  }

  private assertPropId(propId: string, meta: ForgeStoredPropMeta): void {
    if (meta.id !== propId) {
      throw new Error(`Prop id mismatch: ${propId} !== ${meta.id}`);
    }
  }
}
