/**
 * PropRepository — abstracts prop I/O behind an injectable FsBackend.
 *
 * All filesystem paths are computed here; callers don't need to know the
 * on-disk layout. The batch creation method returns structured error results
 * instead of swallowing failures.
 */
import * as THREE from "three";
import type { Object3D } from "three";
import type { FsBackend } from "./types";
import { restFsBackend } from "./fs-backend";
import type { StyleGuide } from "../../forge-core/StyleGuidePanel";
import type {
  ForgeColliderPresetFile,
  ForgePhysicsKindPresetFile,
  ForgePropMeta,
} from "../types";
import {
  sanitizeForgePropMeta,
  sanitizeForgeColliderPresetFile,
  sanitizeForgePhysicsKindPresetFile,
  defaultForgeColliderPresetFile,
  defaultForgePhysicsKindPresetFile,
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

  async readMeta(propId: string): Promise<ForgePropMeta | null> {
    try {
      const raw = await this.fs.readJson<unknown>(`${makePropBaseDir(propId)}/meta.json`);
      return sanitizeForgePropMeta(raw);
    } catch {
      return null;
    }
  }

  async writeMeta(meta: ForgePropMeta): Promise<void> {
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

  async readColliderPresets(): Promise<ForgeColliderPresetFile> {
    try {
      const raw = await this.fs.readJson<unknown>(COLLIDER_PRESETS_FILE);
      const next = sanitizeForgeColliderPresetFile(raw);
      if (!raw) {
        await this.fs.writeJson(COLLIDER_PRESETS_FILE, next);
      }
      return next;
    } catch {
      const defaults = defaultForgeColliderPresetFile();
      await this.fs.writeJson(COLLIDER_PRESETS_FILE, defaults);
      return defaults;
    }
  }

  async readPhysicsKindPresets(): Promise<ForgePhysicsKindPresetFile> {
    try {
      const raw = await this.fs.readJson<unknown>(PHYSICS_KINDS_FILE);
      return sanitizeForgePhysicsKindPresetFile(raw);
    } catch {
      const defaults = defaultForgePhysicsKindPresetFile();
      await this.fs.writeJson(PHYSICS_KINDS_FILE, defaults);
      return defaults;
    }
  }

  async writeColliderPresets(file: ForgeColliderPresetFile): Promise<ForgeColliderPresetFile> {
    const sanitized = sanitizeForgeColliderPresetFile({
      ...file,
      updatedAt: new Date().toISOString(),
    });
    await this.fs.writeJson(COLLIDER_PRESETS_FILE, sanitized);
    return sanitized;
  }

  async writePhysicsKindPresets(
    file: ForgePhysicsKindPresetFile
  ): Promise<ForgePhysicsKindPresetFile> {
    const sanitized = sanitizeForgePhysicsKindPresetFile({
      ...file,
      updatedAt: new Date().toISOString(),
    });
    await this.fs.writeJson(PHYSICS_KINDS_FILE, sanitized);
    return sanitized;
  }

  async ensureSeedPresets(): Promise<void> {
    try { await this.fs.readJson<unknown>(COLLIDER_PRESETS_FILE); }
    catch { await this.fs.writeJson(COLLIDER_PRESETS_FILE, defaultForgeColliderPresetFile()); }
    try { await this.fs.readJson<unknown>(PHYSICS_KINDS_FILE); }
    catch { await this.fs.writeJson(PHYSICS_KINDS_FILE, defaultForgePhysicsKindPresetFile()); }
  }

  // ---- Batch creation (with error handling) ----

  async createPropBatch(
    items: { id: string; meta: ForgePropMeta }[]
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

export const forgeRepository = new PropRepository(restFsBackend);

export async function listForgePropIds(): Promise<string[]> {
  return forgeRepository.listPropIds();
}

export async function readForgePropMeta(propId: string): Promise<ForgePropMeta | null> {
  return forgeRepository.readMeta(propId);
}

export async function writeForgePropMeta(meta: ForgePropMeta): Promise<void> {
  await forgeRepository.writeMeta(meta);
}

export async function writePropConceptImage(
  propId: string,
  conceptImageDataUrl: string
): Promise<void> {
  await forgeRepository.writeConceptImage(propId, conceptImageDataUrl);
}

export async function writePropPrompt(propId: string, prompt: string): Promise<void> {
  await forgeRepository.writePrompt(propId, prompt);
}

export async function writePropRawGlb(propId: string, rawGlb: ArrayBuffer): Promise<void> {
  await forgeRepository.writeRawGlb(propId, rawGlb);
}

export async function writePropProcessedModelGlb(
  propId: string,
  glb: ArrayBuffer
): Promise<void> {
  await forgeRepository.writeProcessedGlb(propId, glb);
}

export async function writePropColliderGlb(
  propId: string,
  presetId: string,
  glb: ArrayBuffer
): Promise<string> {
  return forgeRepository.writeColliderGlb(propId, presetId, glb);
}

export async function readPropRawConceptImage(propId: string): Promise<string | null> {
  return forgeRepository.readConceptImage(propId);
}

export async function readPropRawGlb(propId: string): Promise<ArrayBuffer | null> {
  return forgeRepository.readRawGlb(propId);
}

export async function readPropProcessedModelGlb(propId: string): Promise<ArrayBuffer | null> {
  return forgeRepository.readProcessedGlb(propId);
}

export async function readColliderPresetFile(): Promise<ForgeColliderPresetFile> {
  return forgeRepository.readColliderPresets();
}

export async function writeColliderPresetFile(
  file: ForgeColliderPresetFile
): Promise<ForgeColliderPresetFile> {
  return forgeRepository.writeColliderPresets(file);
}

export async function readPhysicsKindPresetFile(): Promise<ForgePhysicsKindPresetFile> {
  return forgeRepository.readPhysicsKindPresets();
}

export async function writePhysicsKindPresetFile(
  file: ForgePhysicsKindPresetFile
): Promise<ForgePhysicsKindPresetFile> {
  return forgeRepository.writePhysicsKindPresets(file);
}

export async function ensureSeedPresetFiles(): Promise<void> {
  await forgeRepository.ensureSeedPresets();
}

export async function exportObjectToGlb(object: Object3D | Object3D[]): Promise<ArrayBuffer> {
  const { GLTFExporter } = await import("three/examples/jsm/exporters/GLTFExporter.js");
  const exporter = new GLTFExporter();

  const items = Array.isArray(object) ? object : [object];
  const baked: Object3D[] = items.map((item) => bakeWorldTransforms(item));
  const exportTarget = baked.length === 1 ? baked[0] : baked;

  return new Promise<ArrayBuffer>((resolve, reject) => {
    exporter.parse(
      exportTarget,
      (result) => resolve(result as ArrayBuffer),
      reject,
      { binary: true }
    );
  });
}

function bakeWorldTransforms(root: Object3D): Object3D {
  const clone = root.clone(true);
  clone.updateMatrixWorld(true);

  clone.traverse((node) => {
    if (
      (node instanceof THREE.Mesh ||
        node instanceof THREE.Line ||
        node instanceof THREE.LineSegments) &&
      node.geometry
    ) {
      const geometry = node.geometry.clone();
      geometry.applyMatrix4(node.matrixWorld);
      node.geometry = geometry;
    }
  });

  clone.traverse((node) => {
    node.position.set(0, 0, 0);
    node.rotation.set(0, 0, 0);
    node.scale.set(1, 1, 1);
    node.updateMatrix();
  });
  clone.updateMatrixWorld(true);

  return clone;
}
