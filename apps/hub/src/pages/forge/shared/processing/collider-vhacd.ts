import * as THREE from "three";
import { ConvexGeometry } from "three/examples/jsm/geometries/ConvexGeometry.js";
import {
  disposeVhacdResult,
  extractVhacdSourceData,
  type VhacdOptions,
  type VhacdProgress,
  type VhacdResult,
  type VhacdWorkerRunner
} from "@common/collider-vhacd";
import * as fsApi from "../api/fs";
import type { ColliderParams } from "./colliders";

export type CompoundConvexHullPart = {
  position: [number, number, number];
  points: Array<[number, number, number]>;
};

export type ForgeColliderGenerationMetadata = {
  method: "vhacd-unity-v1";
  presetName: string;
  options: VhacdOptions;
  stats: VhacdResult["stats"];
  signature: string;
  generatedAt: string;
  hullCount: number;
};

export type ForgeVhacdPreset = {
  name: string;
  options: VhacdOptions;
};

export type ForgeVhacdPresetFile = {
  version: 1;
  defaultPreset: string;
  updatedAt: string;
  presets: ForgeVhacdPreset[];
};

const MIN_HULL_AXIS_SPAN = 1e-5;
const PRESET_FILE_PATH = "vhacd-presets.json";

export const DEFAULT_VHACD_OPTIONS: VhacdOptions = {
  resolution: 128,
  concavity: 0.002,
  alpha: 0.05,
  beta: 0.05,
  sliverPenalty: 0.35,
  planeDownsampling: 1,
  convexHullDownsampling: 1,
  maxConvexHulls: 24,
  minVoxelCountPerPart: 24,
  maxHullPointSamples: 1800,
  projectHullVertices: true,
  projectHullMaxDistance: 0.18,
  precomputeBothHullVariants: true,
  maxGridCells: 20_000_000,
  voxelizationTriangleSampleCount: 12_000
};

export const DEFAULT_VHACD_PRESET_FILE: ForgeVhacdPresetFile = {
  version: 1,
  defaultPreset: "Balanced",
  updatedAt: "2026-02-21T00:00:00.000Z",
  presets: [
    {
      name: "Balanced",
      options: { ...DEFAULT_VHACD_OPTIONS }
    },
    {
      name: "Fast",
      options: {
        ...DEFAULT_VHACD_OPTIONS,
        resolution: 96,
        concavity: 0.0035,
        alpha: 0.08,
        sliverPenalty: 0.45,
        planeDownsampling: 2,
        convexHullDownsampling: 2,
        maxConvexHulls: 16,
        minVoxelCountPerPart: 28,
        maxHullPointSamples: 1200,
        projectHullMaxDistance: 0.14,
        precomputeBothHullVariants: false,
        maxGridCells: 12_000_000,
        voxelizationTriangleSampleCount: 8_000
      }
    },
    {
      name: "High Detail",
      options: {
        ...DEFAULT_VHACD_OPTIONS,
        resolution: 256,
        concavity: 0.0015,
        alpha: 0.06,
        sliverPenalty: 0.5,
        maxConvexHulls: 32,
        minVoxelCountPerPart: 20,
        maxHullPointSamples: 3200,
        projectHullMaxDistance: 0.16,
        voxelizationTriangleSampleCount: 20_000
      }
    }
  ]
};

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function clampInt(value: number, min: number, max: number): number {
  return Math.floor(clamp(value, min, max));
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  return value as Record<string, unknown>;
}

function asTuple3(value: unknown): [number, number, number] | null {
  if (!Array.isArray(value) || value.length !== 3) {
    return null;
  }
  const x = Number(value[0]);
  const y = Number(value[1]);
  const z = Number(value[2]);
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
    return null;
  }
  return [x, y, z];
}

export function normalizeVhacdOptions(
  input: Partial<VhacdOptions> | null | undefined
): VhacdOptions {
  return {
    resolution: clampInt(input?.resolution ?? DEFAULT_VHACD_OPTIONS.resolution, 10, 256),
    concavity: clamp(input?.concavity ?? DEFAULT_VHACD_OPTIONS.concavity, 0, 1),
    alpha: clamp(input?.alpha ?? DEFAULT_VHACD_OPTIONS.alpha, 0, 1),
    beta: clamp(input?.beta ?? DEFAULT_VHACD_OPTIONS.beta, 0, 1),
    sliverPenalty: clamp(input?.sliverPenalty ?? DEFAULT_VHACD_OPTIONS.sliverPenalty, 0, 3),
    planeDownsampling: clampInt(
      input?.planeDownsampling ?? DEFAULT_VHACD_OPTIONS.planeDownsampling,
      1,
      12
    ),
    convexHullDownsampling: clampInt(
      input?.convexHullDownsampling ?? DEFAULT_VHACD_OPTIONS.convexHullDownsampling,
      1,
      12
    ),
    maxConvexHulls: clampInt(
      input?.maxConvexHulls ?? DEFAULT_VHACD_OPTIONS.maxConvexHulls,
      1,
      64
    ),
    minVoxelCountPerPart: clampInt(
      input?.minVoxelCountPerPart ?? DEFAULT_VHACD_OPTIONS.minVoxelCountPerPart,
      4,
      200
    ),
    maxHullPointSamples: clampInt(
      input?.maxHullPointSamples ?? DEFAULT_VHACD_OPTIONS.maxHullPointSamples,
      64,
      9000
    ),
    projectHullVertices:
      input?.projectHullVertices ?? DEFAULT_VHACD_OPTIONS.projectHullVertices,
    projectHullMaxDistance: clamp(
      input?.projectHullMaxDistance ?? DEFAULT_VHACD_OPTIONS.projectHullMaxDistance,
      0,
      2
    ),
    precomputeBothHullVariants:
      input?.precomputeBothHullVariants ?? DEFAULT_VHACD_OPTIONS.precomputeBothHullVariants,
    maxGridCells: clampInt(
      input?.maxGridCells ?? DEFAULT_VHACD_OPTIONS.maxGridCells,
      250_000,
      20_000_000
    ),
    voxelizationTriangleSampleCount: clampInt(
      input?.voxelizationTriangleSampleCount ??
        DEFAULT_VHACD_OPTIONS.voxelizationTriangleSampleCount,
      1000,
      120_000
    )
  };
}

function sanitizePresetName(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function uniquePresetName(name: string): string {
  return name.toLowerCase();
}

export function sanitizeVhacdPresetFile(raw: unknown): ForgeVhacdPresetFile {
  const record = asRecord(raw);
  const presetsRaw = Array.isArray(record?.presets) ? record.presets : [];

  const presets: ForgeVhacdPreset[] = [];
  const seen = new Set<string>();

  for (const presetRaw of presetsRaw) {
    const presetRecord = asRecord(presetRaw);
    if (!presetRecord) {
      continue;
    }
    const name = sanitizePresetName(presetRecord.name);
    if (!name) {
      continue;
    }
    const key = uniquePresetName(name);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    presets.push({
      name,
      options: normalizeVhacdOptions(asRecord(presetRecord.options) as Partial<VhacdOptions>)
    });
  }

  if (presets.length <= 0) {
    return {
      ...DEFAULT_VHACD_PRESET_FILE,
      presets: DEFAULT_VHACD_PRESET_FILE.presets.map((preset) => ({
        name: preset.name,
        options: { ...preset.options }
      })),
      updatedAt: new Date().toISOString()
    };
  }

  const defaultPresetRaw = sanitizePresetName(record?.defaultPreset);
  const defaultPreset =
    defaultPresetRaw &&
    presets.some((preset) => uniquePresetName(preset.name) === uniquePresetName(defaultPresetRaw))
      ? presets.find(
          (preset) => uniquePresetName(preset.name) === uniquePresetName(defaultPresetRaw)
        )?.name ?? presets[0]?.name ?? "Balanced"
      : presets[0]?.name ?? "Balanced";

  return {
    version: 1,
    defaultPreset,
    updatedAt:
      typeof record?.updatedAt === "string" && record.updatedAt.trim().length > 0
        ? record.updatedAt
        : new Date().toISOString(),
    presets
  };
}

export async function readVhacdPresetFile(): Promise<ForgeVhacdPresetFile> {
  try {
    const raw = await fsApi.readJson<unknown>(PRESET_FILE_PATH);
    return sanitizeVhacdPresetFile(raw);
  } catch {
    const defaults = sanitizeVhacdPresetFile(DEFAULT_VHACD_PRESET_FILE);
    await fsApi.writeJson(PRESET_FILE_PATH, defaults);
    return defaults;
  }
}

export async function writeVhacdPresetFile(
  input: ForgeVhacdPresetFile
): Promise<ForgeVhacdPresetFile> {
  const next = sanitizeVhacdPresetFile({
    ...input,
    updatedAt: new Date().toISOString()
  });
  await fsApi.writeJson(PRESET_FILE_PATH, next);
  return next;
}

function dedupeGeometryPoints(geometry: THREE.BufferGeometry): Array<[number, number, number]> {
  const position = geometry.getAttribute("position");
  if (!(position instanceof THREE.BufferAttribute) || position.count <= 0) {
    return [];
  }

  const points: Array<[number, number, number]> = [];
  const seen = new Set<string>();
  for (let i = 0; i < position.count; i += 1) {
    const x = position.getX(i);
    const y = position.getY(i);
    const z = position.getZ(i);
    const key = `${x.toFixed(6)}|${y.toFixed(6)}|${z.toFixed(6)}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    points.push([x, y, z]);
  }
  return points;
}

function spansForPoints(points: Array<[number, number, number]>): [number, number, number] {
  if (points.length <= 0) {
    return [0, 0, 0];
  }
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let minZ = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  let maxZ = Number.NEGATIVE_INFINITY;

  for (const point of points) {
    if (point[0] < minX) minX = point[0];
    if (point[1] < minY) minY = point[1];
    if (point[2] < minZ) minZ = point[2];
    if (point[0] > maxX) maxX = point[0];
    if (point[1] > maxY) maxY = point[1];
    if (point[2] > maxZ) maxZ = point[2];
  }

  return [maxX - minX, maxY - minY, maxZ - minZ];
}

function boxHullPartFromBounds(bounds: THREE.Box3): CompoundConvexHullPart {
  const min = bounds.min;
  const max = bounds.max;
  const center = bounds.getCenter(new THREE.Vector3());
  const corners: Array<[number, number, number]> = [
    [min.x, min.y, min.z],
    [min.x, min.y, max.z],
    [min.x, max.y, min.z],
    [min.x, max.y, max.z],
    [max.x, min.y, min.z],
    [max.x, min.y, max.z],
    [max.x, max.y, min.z],
    [max.x, max.y, max.z]
  ];

  return {
    position: [center.x, center.y, center.z],
    points: corners.map((corner) => [
      corner[0] - center.x,
      corner[1] - center.y,
      corner[2] - center.z
    ])
  };
}

function convertHullsToCompoundParts(
  result: VhacdResult,
  sourceModel: THREE.Object3D
): CompoundConvexHullPart[] {
  const parts: CompoundConvexHullPart[] = [];
  for (const hull of result.hulls) {
    const worldPoints = dedupeGeometryPoints(hull.geometry);
    if (worldPoints.length < 4) {
      continue;
    }
    const [spanX, spanY, spanZ] = spansForPoints(worldPoints);
    if (
      spanX < MIN_HULL_AXIS_SPAN ||
      spanY < MIN_HULL_AXIS_SPAN ||
      spanZ < MIN_HULL_AXIS_SPAN
    ) {
      continue;
    }

    const center: [number, number, number] = [
      hull.centroid[0],
      hull.centroid[1],
      hull.centroid[2]
    ];
    const points = worldPoints.map((point) => [
      point[0] - center[0],
      point[1] - center[1],
      point[2] - center[2]
    ]) as Array<[number, number, number]>;
    parts.push({
      position: center,
      points
    });
  }

  if (parts.length > 0) {
    return parts;
  }

  const fallbackBounds = new THREE.Box3().setFromObject(sourceModel);
  if (fallbackBounds.isEmpty()) {
    fallbackBounds.set(
      new THREE.Vector3(-0.1, -0.1, -0.1),
      new THREE.Vector3(0.1, 0.1, 0.1)
    );
  }
  return [boxHullPartFromBounds(fallbackBounds)];
}

function asCompoundConvexHullPart(value: unknown): CompoundConvexHullPart | null {
  const record = asRecord(value);
  if (!record) {
    return null;
  }

  const position = asTuple3(record.position);
  const pointsRaw = Array.isArray(record.points) ? record.points : [];
  const points: Array<[number, number, number]> = [];
  for (const pointRaw of pointsRaw) {
    const point = asTuple3(pointRaw);
    if (!point) {
      continue;
    }
    points.push(point);
  }

  if (!position || points.length < 4) {
    return null;
  }

  const [spanX, spanY, spanZ] = spansForPoints(points);
  if (
    spanX < MIN_HULL_AXIS_SPAN ||
    spanY < MIN_HULL_AXIS_SPAN ||
    spanZ < MIN_HULL_AXIS_SPAN
  ) {
    return null;
  }

  return {
    position,
    points
  };
}

export function getCompoundConvexHullPartsFromCollider(
  collider: ColliderParams | null | undefined
): CompoundConvexHullPart[] {
  if (!collider || collider.type !== "compound-convex-hulls") {
    return [];
  }
  const params = asRecord(collider.params);
  if (!params || !Array.isArray(params.parts)) {
    return [];
  }

  const parts: CompoundConvexHullPart[] = [];
  for (const partRaw of params.parts) {
    const part = asCompoundConvexHullPart(partRaw);
    if (!part) {
      continue;
    }
    parts.push(part);
  }
  return parts;
}

export function buildColliderExportSceneFromParams(
  collider: ColliderParams | null | undefined
): THREE.Group {
  const group = new THREE.Group();
  const parts = getCompoundConvexHullPartsFromCollider(collider);
  const material = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    roughness: 0.85,
    metalness: 0.02
  });

  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index];
    const vectors = part.points.map((point) => new THREE.Vector3(point[0], point[1], point[2]));
    if (vectors.length < 4) {
      continue;
    }
    const geometry = new ConvexGeometry(vectors);
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.set(part.position[0], part.position[1], part.position[2]);
    mesh.name = `compound-convex-hull-${index + 1}`;
    group.add(mesh);
  }

  return group;
}

export type ForgeVhacdBuildResult = {
  collider: ColliderParams;
  metadata: ForgeColliderGenerationMetadata;
};

export async function buildVhacdColliderForObject(options: {
  sourceModel: THREE.Object3D;
  presetName: string;
  inputOptions: Partial<VhacdOptions> | VhacdOptions;
  runner: VhacdWorkerRunner;
  onProgress?: (progress: VhacdProgress) => void;
}): Promise<ForgeVhacdBuildResult> {
  const sourceData = extractVhacdSourceData(options.sourceModel);
  if (!sourceData || sourceData.positions.length < 9) {
    const fallbackBounds = new THREE.Box3().setFromObject(options.sourceModel);
    if (fallbackBounds.isEmpty()) {
      fallbackBounds.set(
        new THREE.Vector3(-0.1, -0.1, -0.1),
        new THREE.Vector3(0.1, 0.1, 0.1)
      );
    }
    const fallbackPart = boxHullPartFromBounds(fallbackBounds);
    return {
      collider: {
        type: "compound-convex-hulls",
        position: [0, 0, 0],
        params: {
          parts: [fallbackPart]
        }
      },
      metadata: {
        method: "vhacd-unity-v1",
        presetName: options.presetName,
        options: normalizeVhacdOptions(options.inputOptions),
        stats: {
          sourceTriangleCount: 0,
          voxelCount: 0,
          voxelPreviewCount: 0,
          voxelSize: 0,
          rootVolume: 0,
          rootHullVolume: 0,
          rootConcavity: 0,
          splitCount: 0,
          mergeCount: 0,
          candidatePlaneCount: 0,
          iterationCount: 0,
          generatedBeforeMerge: 0,
          splitEvaluationMode: "sequential",
          splitWorkerCount: 1
        },
        signature: "fallback",
        generatedAt: new Date().toISOString(),
        hullCount: 1
      }
    };
  }

  const normalizedOptions = normalizeVhacdOptions(options.inputOptions);
  let result: VhacdResult | null = null;
  try {
    result = await options.runner.run(sourceData, normalizedOptions, (progress) => {
      options.onProgress?.(progress);
    });
    const parts = convertHullsToCompoundParts(result, options.sourceModel);
    const collider: ColliderParams = {
      type: "compound-convex-hulls",
      position: [0, 0, 0],
      params: {
        parts
      }
    };

    return {
      collider,
      metadata: {
        method: "vhacd-unity-v1",
        presetName: options.presetName,
        options: normalizedOptions,
        stats: { ...result.stats },
        signature: result.signature,
        generatedAt: new Date().toISOString(),
        hullCount: parts.length
      }
    };
  } finally {
    if (result) {
      disposeVhacdResult(result);
    }
  }
}
