/**
 * PropRepository — abstracts prop I/O behind an injectable FsBackend.
 *
 * All filesystem paths are computed here; callers don't need to know the
 * on-disk layout. The batch creation method returns structured error results
 * instead of swallowing failures.
 */
import type { FsBackend } from "./types";
import type { StyleGuide } from "../../forge/StyleGuidePanel";
import type {
  ForgeV2ColliderPresetFile,
  ForgeV2PhysicsKindPresetFile,
  ForgeV2PropMeta,
} from "../types";
import {
  sanitizeForgeV2PropMeta,
  sanitizeForgeV2ColliderPresetFile,
  sanitizeForgeV2PhysicsKindPresetFile,
  defaultForgeV2ColliderPresetFile,
  defaultForgeV2PhysicsKindPresetFile,
} from "../state/schema";

// ---------------------------------------------------------------------------
// Path helpers (pure)
// ---------------------------------------------------------------------------

const PROPS_DIR = "props";
const COLLIDER_PRESETS_FILE = "collider-presets.json";
const PHYSICS_KINDS_FILE = "physics-kinds.json";

export function slugifyPropId(description: string): string {
  return description
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

export function makePropBaseDir(propId: string): string {
  return `${PROPS_DIR}/${propId}`;
}

export function buildComposedPrompt(styleGuide: StyleGuide, description: string): string {
  return [
    styleGuide.prompt,
    description,
    "3/4 view, product shot, centered object, plain mid-gray background."
  ]
    .filter(Boolean)
    .join(" ");
}

// ---------------------------------------------------------------------------
// Repository
// ---------------------------------------------------------------------------

export class PropRepository {
  constructor(private fs: FsBackend) {}

  // ---- Meta ----

  async readMeta(propId: string): Promise<ForgeV2PropMeta | null> {
    try {
      const raw = await this.fs.readJson<unknown>(`${makePropBaseDir(propId)}/meta.json`);
      return sanitizeForgeV2PropMeta(raw);
    } catch {
      return null;
    }
  }

  async writeMeta(meta: ForgeV2PropMeta): Promise<void> {
    await this.fs.writeJson(`${makePropBaseDir(meta.id)}/meta.json`, {
      ...meta,
      updatedAt: new Date().toISOString(),
    });
  }

  // ---- Concept image ----

  async readConceptImage(propId: string): Promise<string | null> {
    try {
      const res = await this.fs.readFile(`${makePropBaseDir(propId)}/raw/concept.png`);
      const blob = await res.blob();
      return await new Promise<string>((resolve) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result as string);
        reader.readAsDataURL(blob);
      });
    } catch {
      return null;
    }
  }

  async writeConceptImage(propId: string, dataUrl: string): Promise<void> {
    const blob = await fetch(dataUrl).then((res) => res.blob());
    await this.fs.writeBinary(`${makePropBaseDir(propId)}/raw/concept.png`, blob);
  }

  // ---- Prompt ----

  async writePrompt(propId: string, prompt: string): Promise<void> {
    await this.fs.writeText(`${makePropBaseDir(propId)}/raw/prompt.txt`, prompt);
  }

  // ---- Raw GLB ----

  async readRawGlb(propId: string): Promise<ArrayBuffer | null> {
    try {
      return await this.fs.readBinary(`${makePropBaseDir(propId)}/raw/tripo-output.glb`);
    } catch {
      return null;
    }
  }

  async writeRawGlb(propId: string, glb: ArrayBuffer): Promise<void> {
    await this.fs.writeBinary(`${makePropBaseDir(propId)}/raw/tripo-output.glb`, glb);
  }

  // ---- Processed GLB ----

  async readProcessedGlb(propId: string): Promise<ArrayBuffer | null> {
    try {
      return await this.fs.readBinary(`${makePropBaseDir(propId)}/processed/model.glb`);
    } catch {
      return null;
    }
  }

  async writeProcessedGlb(propId: string, glb: ArrayBuffer): Promise<void> {
    await this.fs.writeBinary(`${makePropBaseDir(propId)}/processed/model.glb`, glb);
  }

  // ---- Collider GLB ----

  async writeColliderGlb(propId: string, presetId: string, glb: ArrayBuffer): Promise<string> {
    const rel = `processed/colliders/${presetId}.glb`;
    await this.fs.writeBinary(`${makePropBaseDir(propId)}/${rel}`, glb);
    return rel;
  }

  // ---- Prop listing ----

  async listPropIds(): Promise<string[]> {
    const ids = await this.fs.listDirs(PROPS_DIR);
    return [...ids].sort((a, b) => a.localeCompare(b));
  }

  // ---- Presets ----

  async readColliderPresets(): Promise<ForgeV2ColliderPresetFile> {
    try {
      const raw = await this.fs.readJson<unknown>(COLLIDER_PRESETS_FILE);
      const next = sanitizeForgeV2ColliderPresetFile(raw);
      if (!raw) {
        await this.fs.writeJson(COLLIDER_PRESETS_FILE, next);
      }
      return next;
    } catch {
      const defaults = defaultForgeV2ColliderPresetFile();
      await this.fs.writeJson(COLLIDER_PRESETS_FILE, defaults);
      return defaults;
    }
  }

  async readPhysicsKindPresets(): Promise<ForgeV2PhysicsKindPresetFile> {
    try {
      const raw = await this.fs.readJson<unknown>(PHYSICS_KINDS_FILE);
      return sanitizeForgeV2PhysicsKindPresetFile(raw);
    } catch {
      const defaults = defaultForgeV2PhysicsKindPresetFile();
      await this.fs.writeJson(PHYSICS_KINDS_FILE, defaults);
      return defaults;
    }
  }

  async ensureSeedPresets(): Promise<void> {
    try { await this.fs.readJson<unknown>(COLLIDER_PRESETS_FILE); }
    catch { await this.fs.writeJson(COLLIDER_PRESETS_FILE, defaultForgeV2ColliderPresetFile()); }
    try { await this.fs.readJson<unknown>(PHYSICS_KINDS_FILE); }
    catch { await this.fs.writeJson(PHYSICS_KINDS_FILE, defaultForgeV2PhysicsKindPresetFile()); }
  }

  // ---- Batch creation (with error handling) ----

  async createPropBatch(
    items: { id: string; meta: ForgeV2PropMeta }[]
  ): Promise<{ created: string[]; errors: { id: string; error: string }[] }> {
    const created: string[] = [];
    const errors: { id: string; error: string }[] = [];

    for (const item of items) {
      try {
        await this.writeMeta(item.meta);
        created.push(item.id);
      } catch (err) {
        errors.push({
          id: item.id,
          error: err instanceof Error ? err.message : "Unknown error",
        });
      }
    }

    return { created, errors };
  }
}
