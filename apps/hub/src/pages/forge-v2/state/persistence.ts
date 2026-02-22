import type { Object3D } from "three";
import type { StyleGuide } from "../../forge/StyleGuidePanel";
import * as fsApi from "../api/fs";
import {
  defaultForgeV2ColliderPresetFile,
  defaultForgeV2PhysicsKindPresetFile,
  sanitizeForgeV2ColliderPresetFile,
  sanitizeForgeV2PhysicsKindPresetFile,
  sanitizeForgeV2PropMeta
} from "./schema";
import type {
  ForgeV2ColliderPresetFile,
  ForgeV2PhysicsKindPresetFile,
  ForgeV2PropMeta
} from "../types";

export const FORGE_V2_PROPS_DIR = "props";
const COLLIDER_PRESETS_FILE = "collider-presets.json";
const PHYSICS_KINDS_FILE = "physics-kinds.json";

export function slugifyPropId(description: string): string {
  return description
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

export function makePropBaseDir(propId: string): string {
  return `${FORGE_V2_PROPS_DIR}/${propId}`;
}

export async function listForgeV2PropIds(): Promise<string[]> {
  const ids = await fsApi.listDirs(FORGE_V2_PROPS_DIR);
  return [...ids].sort((a, b) => a.localeCompare(b));
}

export async function readForgeV2PropMeta(propId: string): Promise<ForgeV2PropMeta | null> {
  try {
    const raw = await fsApi.readJson<unknown>(`${makePropBaseDir(propId)}/meta.json`);
    return sanitizeForgeV2PropMeta(raw);
  } catch {
    return null;
  }
}

export async function writeForgeV2PropMeta(meta: ForgeV2PropMeta): Promise<void> {
  await fsApi.writeJson(`${makePropBaseDir(meta.id)}/meta.json`, {
    ...meta,
    updatedAt: new Date().toISOString()
  });
}

export async function writePropConceptImage(propId: string, conceptImageDataUrl: string): Promise<void> {
  const blob = await fetch(conceptImageDataUrl).then((res) => res.blob());
  await fsApi.writeBinary(`${makePropBaseDir(propId)}/raw/concept.png`, blob);
}

export async function writePropPrompt(propId: string, prompt: string): Promise<void> {
  await fsApi.writeText(`${makePropBaseDir(propId)}/raw/prompt.txt`, prompt);
}

export async function writePropRawGlb(propId: string, rawGlb: ArrayBuffer): Promise<void> {
  await fsApi.writeBinary(`${makePropBaseDir(propId)}/raw/tripo-output.glb`, rawGlb);
}

export async function writePropProcessedModelGlb(propId: string, glb: ArrayBuffer): Promise<void> {
  await fsApi.writeBinary(`${makePropBaseDir(propId)}/processed/model.glb`, glb);
}

export async function writePropColliderGlb(
  propId: string,
  presetId: string,
  glb: ArrayBuffer
): Promise<string> {
  const rel = `processed/colliders/${presetId}.glb`;
  await fsApi.writeBinary(`${makePropBaseDir(propId)}/${rel}`, glb);
  return rel;
}

export async function readPropRawConceptImage(propId: string): Promise<string | null> {
  try {
    const res = await fsApi.readFile(`${makePropBaseDir(propId)}/raw/concept.png`);
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

export async function readPropRawGlb(propId: string): Promise<ArrayBuffer | null> {
  try {
    return await fsApi.readBinary(`${makePropBaseDir(propId)}/raw/tripo-output.glb`);
  } catch {
    return null;
  }
}

export async function readPropProcessedModelGlb(propId: string): Promise<ArrayBuffer | null> {
  try {
    return await fsApi.readBinary(`${makePropBaseDir(propId)}/processed/model.glb`);
  } catch {
    return null;
  }
}

export async function readColliderPresetFile(): Promise<ForgeV2ColliderPresetFile> {
  try {
    const raw = await fsApi.readJson<unknown>(COLLIDER_PRESETS_FILE);
    const next = sanitizeForgeV2ColliderPresetFile(raw);
    if (!raw) {
      await fsApi.writeJson(COLLIDER_PRESETS_FILE, next);
    }
    return next;
  } catch {
    const defaults = defaultForgeV2ColliderPresetFile();
    await fsApi.writeJson(COLLIDER_PRESETS_FILE, defaults);
    return defaults;
  }
}

export async function writeColliderPresetFile(
  file: ForgeV2ColliderPresetFile
): Promise<ForgeV2ColliderPresetFile> {
  const sanitized = sanitizeForgeV2ColliderPresetFile({
    ...file,
    updatedAt: new Date().toISOString()
  });
  await fsApi.writeJson(COLLIDER_PRESETS_FILE, sanitized);
  return sanitized;
}

export async function readPhysicsKindPresetFile(): Promise<ForgeV2PhysicsKindPresetFile> {
  try {
    const raw = await fsApi.readJson<unknown>(PHYSICS_KINDS_FILE);
    const next = sanitizeForgeV2PhysicsKindPresetFile(raw);
    return next;
  } catch {
    const defaults = defaultForgeV2PhysicsKindPresetFile();
    await fsApi.writeJson(PHYSICS_KINDS_FILE, defaults);
    return defaults;
  }
}

export async function writePhysicsKindPresetFile(
  file: ForgeV2PhysicsKindPresetFile
): Promise<ForgeV2PhysicsKindPresetFile> {
  const sanitized = sanitizeForgeV2PhysicsKindPresetFile({
    ...file,
    updatedAt: new Date().toISOString()
  });
  await fsApi.writeJson(PHYSICS_KINDS_FILE, sanitized);
  return sanitized;
}

export async function exportObjectToGlb(object: Object3D | Object3D[]): Promise<ArrayBuffer> {
  const { GLTFExporter } = await import("three/examples/jsm/exporters/GLTFExporter.js");
  const exporter = new GLTFExporter();
  return new Promise<ArrayBuffer>((resolve, reject) => {
    exporter.parse(
      object,
      (result) => resolve(result as ArrayBuffer),
      reject,
      { binary: true }
    );
  });
}

export async function ensureSeedPresetFiles(): Promise<void> {
  try {
    await fsApi.readJson<unknown>(COLLIDER_PRESETS_FILE);
  } catch {
    await fsApi.writeJson(COLLIDER_PRESETS_FILE, defaultForgeV2ColliderPresetFile());
  }
  try {
    await fsApi.readJson<unknown>(PHYSICS_KINDS_FILE);
  } catch {
    await fsApi.writeJson(PHYSICS_KINDS_FILE, defaultForgeV2PhysicsKindPresetFile());
  }
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
