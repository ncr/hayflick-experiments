import type { VhacdOptions } from "@common/collider-vhacd";
import { DEFAULT_VHACD_OPTIONS, normalizeVhacdOptions } from "../../forge/processing/collider-vhacd";
import {
  DEFAULT_FORGE_PHYSICS_SETTINGS,
  normalizeForgePhysicsSettings
} from "../../forge/processing/physics";
import type { PropPhysicsSettings } from "../../forge/types";
import type {
  ForgeV2BBoxJson,
  ForgeV2ColliderPresetFile,
  ForgeV2ColliderResultEntry,
  ForgeV2PhysicsKindPresetFile,
  ForgeV2SimulationCheckResult,
  ForgeV2PropMeta
} from "../types";

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function asFiniteNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function asBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function asTuple3(value: unknown, fallback: [number, number, number]): [number, number, number] {
  if (!Array.isArray(value) || value.length !== 3) {
    return fallback;
  }
  const x = Number(value[0]);
  const y = Number(value[1]);
  const z = Number(value[2]);
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
    return fallback;
  }
  return [x, y, z];
}

function normalizeBBox(value: unknown): ForgeV2BBoxJson | undefined {
  const record = asRecord(value);
  if (!record) {
    return undefined;
  }
  return {
    width: Math.max(0, asFiniteNumber(record.width, 0)),
    height: Math.max(0, asFiniteNumber(record.height, 0)),
    depth: Math.max(0, asFiniteNumber(record.depth, 0))
  };
}

function uniqueId(raw: string, index: number): string {
  const slug = raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  return slug.length > 0 ? slug : `preset-${index + 1}`;
}

export function defaultForgeV2ColliderPresetFile(): ForgeV2ColliderPresetFile {
  const presets = [
    {
      id: "fast-preview",
      name: "Fast Preview",
      enabledByDefault: true,
      options: normalizeVhacdOptions({
        ...DEFAULT_VHACD_OPTIONS,
        resolution: 96,
        concavity: 0.0035,
        planeDownsampling: 2,
        convexHullDownsampling: 2,
        maxConvexHulls: 16,
        precomputeBothHullVariants: false,
        maxGridCells: 12_000_000,
        voxelizationTriangleSampleCount: 8_000
      })
    },
    {
      id: "balanced",
      name: "Balanced",
      enabledByDefault: true,
      options: normalizeVhacdOptions({ ...DEFAULT_VHACD_OPTIONS })
    },
    {
      id: "high-detail",
      name: "High Detail",
      enabledByDefault: false,
      options: normalizeVhacdOptions({
        ...DEFAULT_VHACD_OPTIONS,
        resolution: 256,
        concavity: 0.0015,
        maxConvexHulls: 32,
        minVoxelCountPerPart: 20,
        maxHullPointSamples: 3200,
        voxelizationTriangleSampleCount: 20_000
      })
    }
  ];
  return {
    version: 1,
    defaultPresetId: "balanced",
    updatedAt: new Date().toISOString(),
    presets
  };
}

export function sanitizeForgeV2ColliderPresetFile(raw: unknown): ForgeV2ColliderPresetFile {
  const record = asRecord(raw);
  const sourcePresets = Array.isArray(record?.presets) ? record.presets : [];
  const seen = new Set<string>();
  const presets: ForgeV2ColliderPresetFile["presets"] = [];
  for (let i = 0; i < sourcePresets.length; i += 1) {
    const presetRecord = asRecord(sourcePresets[i]);
    if (!presetRecord) continue;
    const name = asString(presetRecord.name).trim();
    if (!name) continue;
    const id = uniqueId(asString(presetRecord.id, name), i);
    if (seen.has(id)) continue;
    seen.add(id);
    presets.push({
      id,
      name,
      enabledByDefault: asBoolean(presetRecord.enabledByDefault, i < 2),
      options: normalizeVhacdOptions(presetRecord.options as Partial<VhacdOptions>)
    });
  }
  if (presets.length <= 0) {
    return defaultForgeV2ColliderPresetFile();
  }
  const defaultIdRaw = asString(record?.defaultPresetId);
  const defaultPresetId =
    presets.some((preset) => preset.id === defaultIdRaw)
      ? defaultIdRaw
      : (presets.find((preset) => preset.enabledByDefault)?.id ?? presets[0].id);
  return {
    version: 1,
    defaultPresetId,
    updatedAt: asString(record?.updatedAt, new Date().toISOString()),
    presets
  };
}

export function defaultForgeV2PhysicsKindPresetFile(): ForgeV2PhysicsKindPresetFile {
  return {
    version: 1,
    defaultKindId: "wood",
    updatedAt: new Date().toISOString(),
    kinds: [
      {
        id: "heavy-metal",
        name: "Heavy Metal",
        mobility: "auto",
        material: "metal",
        massMode: "auto",
        massScale: 1.35,
        manualMass: 4,
        friction: 0.6,
        restitution: 0.03,
        linearDamping: 0.18,
        angularDamping: 0.24,
        activationDelayMs: 500
      },
      {
        id: "glass",
        name: "Glass",
        mobility: "auto",
        material: "glass",
        massMode: "auto",
        massScale: 0.8,
        manualMass: 1.2,
        friction: 0.48,
        restitution: 0.05,
        linearDamping: 0.16,
        angularDamping: 0.2,
        activationDelayMs: 350
      },
      {
        id: "rubber",
        name: "Rubber",
        mobility: "auto",
        material: "rubber",
        massMode: "auto",
        massScale: 1,
        manualMass: 1.5,
        friction: 1.15,
        restitution: 0.18,
        linearDamping: 0.42,
        angularDamping: 0.52,
        activationDelayMs: 450
      },
      {
        id: "wood",
        name: "Wood",
        mobility: "auto",
        material: "wood",
        massMode: "auto",
        massScale: 1,
        manualMass: 1.8,
        friction: 0.72,
        restitution: 0.04,
        linearDamping: 0.26,
        angularDamping: 0.36,
        activationDelayMs: 500
      },
      {
        id: "concrete",
        name: "Concrete",
        mobility: "auto",
        material: "concrete",
        massMode: "auto",
        massScale: 1,
        manualMass: 10,
        friction: 0.9,
        restitution: 0.01,
        linearDamping: 0.18,
        angularDamping: 0.24,
        activationDelayMs: 600
      }
    ]
  };
}

export function sanitizeForgeV2PhysicsKindPresetFile(raw: unknown): ForgeV2PhysicsKindPresetFile {
  const record = asRecord(raw);
  const sourceKinds = Array.isArray(record?.kinds) ? record.kinds : [];
  const kinds: ForgeV2PhysicsKindPresetFile["kinds"] = [];
  const seen = new Set<string>();
  for (let i = 0; i < sourceKinds.length; i += 1) {
    const kindRecord = asRecord(sourceKinds[i]);
    if (!kindRecord) continue;
    const name = asString(kindRecord.name).trim();
    if (!name) continue;
    const id = uniqueId(asString(kindRecord.id, name), i);
    if (seen.has(id)) continue;
    seen.add(id);
    const normalized = normalizeForgePhysicsSettings(
      {
        mobility: kindRecord.mobility as PropPhysicsSettings["mobility"],
        material: kindRecord.material as PropPhysicsSettings["material"],
        massMode: kindRecord.massMode as PropPhysicsSettings["massMode"],
        massScale: asFiniteNumber(kindRecord.massScale, DEFAULT_FORGE_PHYSICS_SETTINGS.massScale),
        manualMass: asFiniteNumber(kindRecord.manualMass, DEFAULT_FORGE_PHYSICS_SETTINGS.manualMass),
        friction: asFiniteNumber(kindRecord.friction, DEFAULT_FORGE_PHYSICS_SETTINGS.friction),
        restitution: asFiniteNumber(
          kindRecord.restitution,
          DEFAULT_FORGE_PHYSICS_SETTINGS.restitution
        ),
        linearDamping: asFiniteNumber(
          kindRecord.linearDamping,
          DEFAULT_FORGE_PHYSICS_SETTINGS.linearDamping
        ),
        angularDamping: asFiniteNumber(
          kindRecord.angularDamping,
          DEFAULT_FORGE_PHYSICS_SETTINGS.angularDamping
        ),
        activationDelayMs: asFiniteNumber(
          kindRecord.activationDelayMs,
          DEFAULT_FORGE_PHYSICS_SETTINGS.activationDelayMs
        )
      },
      null
    );
    kinds.push({
      id,
      name,
      mobility: normalized.mobility,
      material: normalized.material,
      massMode: normalized.massMode,
      massScale: normalized.massScale,
      manualMass: normalized.manualMass,
      friction: normalized.friction,
      restitution: normalized.restitution,
      linearDamping: normalized.linearDamping,
      angularDamping: normalized.angularDamping,
      activationDelayMs: normalized.activationDelayMs
    });
  }
  if (kinds.length <= 0) {
    return defaultForgeV2PhysicsKindPresetFile();
  }
  const defaultKindIdRaw = asString(record?.defaultKindId);
  const defaultKindId = kinds.some((k) => k.id === defaultKindIdRaw)
    ? defaultKindIdRaw
    : kinds[0].id;
  return {
    version: 1,
    defaultKindId,
    updatedAt: asString(record?.updatedAt, new Date().toISOString()),
    kinds
  };
}

export function createDefaultForgeV2Meta(input: {
  id: string;
  description: string;
  styleGuide: { name: string; prompt: string; negativePrompt: string; imageSize: string };
  composedPrompt: string;
  faceLimit: number;
  pbr: boolean;
}): ForgeV2PropMeta {
  const now = new Date().toISOString();
  return {
    version: 1,
    id: input.id,
    description: input.description,
    createdAt: now,
    updatedAt: now,
    lifecycle: { status: "draft" },
    styleGuide: {
      name: input.styleGuide.name,
      prompt: input.styleGuide.prompt,
      negativePrompt: input.styleGuide.negativePrompt,
      imageSize: input.styleGuide.imageSize
    },
    generation: {
      image: {
        provider: "openai",
        model: "gpt-image-1",
        prompt: input.composedPrompt,
        size: input.styleGuide.imageSize || "1024x1024",
        revision: 0
      },
      mesh: {
        provider: "tripo",
        faceLimit: input.faceLimit,
        pbr: input.pbr,
        revision: 0
      }
    },
    processing: {
      mesh: {
        originalFaces: 0,
        processedFaces: 0,
        simplificationRatio: 1,
        textureResolution: 0
      },
      transform: {
        unitScaleMetersPerUnit: 1.28,
        targetDimension: { method: "max", value: 1 },
        scale: [1, 1, 1],
        provisionalPivot: {
          preset: "bottom-center",
          offset: [0, 0, 0],
          basis: "mesh"
        }
      }
    },
    pixelPreview: {
      testEnvironmentVersion: 1,
      cameraSyncState: {
        target: [0, 0, 0],
        yawTurns: 0,
        zoomLevel: 1
      },
      views: [
        { angle: "north", visible: true },
        { angle: "east", visible: true },
        { angle: "south", visible: true },
        { angle: "west", visible: true }
      ]
    }
  };
}

export function sanitizeForgeV2PropMeta(raw: unknown): ForgeV2PropMeta | null {
  const record = asRecord(raw);
  if (!record) {
    return null;
  }
  const id = asString(record.id).trim();
  if (!id) {
    return null;
  }
  const description = asString(record.description, id);
  const lifecycleRecord = asRecord(record.lifecycle);
  const lifecycleStatus = asString(lifecycleRecord?.status, "draft");
  const allowedStatuses = new Set([
    "draft",
    "image-ready",
    "mesh-ready",
    "generation-approved",
    "physics-approved"
  ]);
  const status = allowedStatuses.has(lifecycleStatus)
    ? (lifecycleStatus as ForgeV2PropMeta["lifecycle"]["status"])
    : "draft";

  const styleGuideRecord = asRecord(record.styleGuide);
  const generationRecord = asRecord(record.generation);
  const imageRecord = asRecord(generationRecord?.image);
  const meshRecord = asRecord(generationRecord?.mesh);
  const processingRecord = asRecord(record.processing);
  const meshProcRecord = asRecord(processingRecord?.mesh);
  const transformRecord = asRecord(processingRecord?.transform);
  const provisionalPivotRecord = asRecord(transformRecord?.provisionalPivot);
  const finalPivotRecord = asRecord(transformRecord?.finalPivot);
  const pixelPreviewRecord = asRecord(record.pixelPreview);
  const cameraSyncRecord = asRecord(pixelPreviewRecord?.cameraSyncState);
  const collidersRecord = asRecord(record.colliders);
  const physicsRecord = asRecord(record.physics);

  return {
    version: 1,
    id,
    description,
    createdAt: asString(record.createdAt, new Date().toISOString()),
    updatedAt: asString(record.updatedAt, new Date().toISOString()),
    lifecycle: {
      status,
      generationApprovedAt: asString(lifecycleRecord?.generationApprovedAt) || undefined,
      physicsApprovedAt: asString(lifecycleRecord?.physicsApprovedAt) || undefined
    },
    styleGuide: {
      name: asString(styleGuideRecord?.name),
      prompt: asString(styleGuideRecord?.prompt),
      negativePrompt: asString(styleGuideRecord?.negativePrompt),
      imageSize: asString(styleGuideRecord?.imageSize, "1024x1024")
    },
    generation: {
      image: {
        provider: "openai",
        model: asString(imageRecord?.model, "gpt-image-1"),
        prompt: asString(imageRecord?.prompt),
        size: asString(imageRecord?.size, "1024x1024"),
        generatedAt: asString(imageRecord?.generatedAt) || undefined,
        revision: Math.max(0, Math.floor(asFiniteNumber(imageRecord?.revision, 0)))
      },
      mesh: {
        provider: "tripo",
        faceLimit: Math.max(500, Math.floor(asFiniteNumber(meshRecord?.faceLimit, 5000))),
        pbr: asBoolean(meshRecord?.pbr, true),
        tripoTaskId: asString(meshRecord?.tripoTaskId) || undefined,
        generatedAt: asString(meshRecord?.generatedAt) || undefined,
        revision: Math.max(0, Math.floor(asFiniteNumber(meshRecord?.revision, 0)))
      }
    },
    processing: {
      mesh: {
        originalFaces: Math.max(0, Math.floor(asFiniteNumber(meshProcRecord?.originalFaces, 0))),
        processedFaces: Math.max(0, Math.floor(asFiniteNumber(meshProcRecord?.processedFaces, 0))),
        simplificationRatio: Math.max(0.0001, asFiniteNumber(meshProcRecord?.simplificationRatio, 1)),
        textureResolution: Math.max(0, Math.floor(asFiniteNumber(meshProcRecord?.textureResolution, 0))),
        bboxRaw: normalizeBBox(meshProcRecord?.bboxRaw),
        bboxProcessed: normalizeBBox(meshProcRecord?.bboxProcessed)
      },
      transform: {
        unitScaleMetersPerUnit: asFiniteNumber(transformRecord?.unitScaleMetersPerUnit, 1.28),
        targetDimension: {
          method: (() => {
            const method = asString(asRecord(transformRecord?.targetDimension)?.method, "max");
            if (method === "width" || method === "height" || method === "max" || method === "manual" || method === "depth") {
              return method;
            }
            return "max";
          })(),
          value: Math.max(0.01, asFiniteNumber(asRecord(transformRecord?.targetDimension)?.value, 1))
        },
        scale: asTuple3(transformRecord?.scale, [1, 1, 1]),
        provisionalPivot: {
          preset: (() => {
            const p = asString(provisionalPivotRecord?.preset, "bottom-center");
            return p === "center" || p === "bottom-front-center" ? p : "bottom-center";
          })(),
          offset: asTuple3(provisionalPivotRecord?.offset, [0, 0, 0]),
          basis: "mesh"
        },
        finalPivot: finalPivotRecord
          ? {
              preset: (() => {
                const p = asString(finalPivotRecord.preset, "bottom-center");
                return p === "center" || p === "bottom-front-center" ? p : "bottom-center";
              })(),
              offset: asTuple3(finalPivotRecord.offset, [0, 0, 0]),
              basis: "collider" as const,
              colliderPresetId: asString(finalPivotRecord.colliderPresetId)
            }
          : undefined
      }
    },
    pixelPreview: {
      testEnvironmentVersion: 1,
      cameraSyncState: {
        target: asTuple3(cameraSyncRecord?.target, [0, 0, 0]),
        yawTurns: Math.round(asFiniteNumber(cameraSyncRecord?.yawTurns, 0)),
        zoomLevel: Math.max(1, Math.round(asFiniteNumber(cameraSyncRecord?.zoomLevel, 1)))
      },
      views: [
        { angle: "north", visible: true },
        { angle: "east", visible: true },
        { angle: "south", visible: true },
        { angle: "west", visible: true }
      ]
    },
    colliders: collidersRecord
      ? {
          selectedPresetId: asString(collidersRecord.selectedPresetId) || undefined,
          presets: Array.isArray(collidersRecord.presets)
            ? (collidersRecord.presets as ForgeV2ColliderResultEntry[])
            : []
        }
      : undefined,
    physics: physicsRecord
      ? {
          kind: asString(physicsRecord.kind, "wood"),
          overrides: (asRecord(physicsRecord.overrides) ?? {}) as Partial<PropPhysicsSettings>,
          resolved: normalizeForgePhysicsSettings(
            (asRecord(physicsRecord.resolved) ?? {}) as Partial<PropPhysicsSettings>,
            null
          ),
          simulationChecks: (asRecord(physicsRecord.simulationChecks) ?? undefined) as
            | Record<string, ForgeV2SimulationCheckResult>
            | undefined
        }
      : undefined
  };
}
