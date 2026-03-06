type RecordLike = Record<string, unknown>;

export interface ForgeStoredColliderPreset {
  id: string;
  name: string;
  enabledByDefault?: boolean;
  options: Record<string, unknown>;
}

export interface ForgeStoredColliderPresetFile {
  version: 1;
  defaultPresetId: string;
  updatedAt: string;
  presets: ForgeStoredColliderPreset[];
}

export interface ForgeStoredPhysicsKindPreset {
  id: string;
  name: string;
  mobility: string;
  material: string;
  massMode: string;
  massScale: number;
  manualMass: number;
  friction: number;
  restitution: number;
  linearDamping: number;
  angularDamping: number;
  activationDelayMs: number;
}

export interface ForgeStoredPhysicsKindPresetFile {
  version: 1;
  defaultKindId: string;
  updatedAt: string;
  kinds: ForgeStoredPhysicsKindPreset[];
}

export interface ForgeStoredPropMeta extends Record<string, unknown> {
  version?: number;
  id: string;
  description?: string;
  createdAt?: string;
  updatedAt?: string;
  lifecycle?: {
    status?: string;
  };
}

function asRecord(value: unknown): RecordLike | null {
  return typeof value === "object" && value !== null ? (value as RecordLike) : null;
}

function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function asNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function asBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function normalizeLifecycleStatus(raw: unknown): string {
  switch (raw) {
    case "draft":
    case "image-ready":
    case "mesh-ready":
    case "physics-ready":
      return raw;
    case "generation-approved":
      return "mesh-ready";
    case "physics-approved":
      return "physics-ready";
    default:
      return "draft";
  }
}

export function defaultForgeColliderPresetFile(): ForgeStoredColliderPresetFile {
  return {
    version: 1,
    defaultPresetId: "balanced",
    updatedAt: new Date().toISOString(),
    presets: [
      {
        id: "fast-preview",
        name: "Fast Preview",
        enabledByDefault: true,
        options: {
          resolution: 96,
          concavity: 0.0035,
          alpha: 0.05,
          beta: 0.05,
          sliverPenalty: 0.35,
          planeDownsampling: 2,
          convexHullDownsampling: 2,
          maxConvexHulls: 16,
          minVoxelCountPerPart: 24,
          maxHullPointSamples: 1800,
          projectHullVertices: true,
          projectHullMaxDistance: 0.18,
          precomputeBothHullVariants: false,
          maxGridCells: 12000000,
          voxelizationTriangleSampleCount: 8000,
        },
      },
      {
        id: "balanced",
        name: "Balanced",
        enabledByDefault: true,
        options: {
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
          maxGridCells: 20000000,
          voxelizationTriangleSampleCount: 12000,
        },
      },
      {
        id: "high-detail",
        name: "High Detail",
        enabledByDefault: false,
        options: {
          resolution: 192,
          concavity: 0.0018,
          alpha: 0.055,
          beta: 0.05,
          sliverPenalty: 0.45,
          planeDownsampling: 1,
          convexHullDownsampling: 1,
          maxConvexHulls: 28,
          minVoxelCountPerPart: 22,
          maxHullPointSamples: 2400,
          projectHullVertices: true,
          projectHullMaxDistance: 0.17,
          precomputeBothHullVariants: true,
          maxGridCells: 16000000,
          voxelizationTriangleSampleCount: 16000,
        },
      },
    ],
  };
}

export function defaultForgePhysicsKindPresetFile(): ForgeStoredPhysicsKindPresetFile {
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
        activationDelayMs: 500,
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
        activationDelayMs: 350,
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
        activationDelayMs: 450,
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
        activationDelayMs: 500,
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
        activationDelayMs: 600,
      },
    ],
  };
}

export function sanitizeForgeColliderPresetFile(raw: unknown): ForgeStoredColliderPresetFile {
  const record = asRecord(raw);
  const presetsRaw = Array.isArray(record?.presets) ? record.presets : [];
  const presets = presetsRaw
    .map((entry) => {
      const preset = asRecord(entry);
      if (!preset) return null;
      const id = asString(preset.id).trim();
      const name = asString(preset.name).trim();
      if (!id || !name) return null;
      return {
        id,
        name,
        enabledByDefault: asBoolean(preset.enabledByDefault, false),
        options: asRecord(preset.options) ?? {},
      };
    })
    .filter((entry): entry is NonNullable<typeof entry> => entry !== null);
  if (presets.length === 0) return defaultForgeColliderPresetFile();
  const defaultPresetId = asString(record?.defaultPresetId, presets[0].id);
  return {
    version: 1,
    defaultPresetId: presets.some((preset) => preset.id === defaultPresetId)
      ? defaultPresetId
      : presets[0].id,
    updatedAt: asString(record?.updatedAt, new Date().toISOString()),
    presets,
  };
}

export function sanitizeForgePhysicsKindPresetFile(raw: unknown): ForgeStoredPhysicsKindPresetFile {
  const record = asRecord(raw);
  const kindsRaw = Array.isArray(record?.kinds) ? record.kinds : [];
  const kinds = kindsRaw
    .map((entry) => {
      const kind = asRecord(entry);
      if (!kind) return null;
      const id = asString(kind.id).trim();
      const name = asString(kind.name).trim();
      if (!id || !name) return null;
      return {
        id,
        name,
        mobility: asString(kind.mobility, "auto"),
        material: asString(kind.material, "wood"),
        massMode: asString(kind.massMode, "auto"),
        massScale: asNumber(kind.massScale, 1),
        manualMass: asNumber(kind.manualMass, 1.8),
        friction: asNumber(kind.friction, 0.72),
        restitution: asNumber(kind.restitution, 0.04),
        linearDamping: asNumber(kind.linearDamping, 0.26),
        angularDamping: asNumber(kind.angularDamping, 0.36),
        activationDelayMs: asNumber(kind.activationDelayMs, 500),
      };
    })
    .filter((entry): entry is NonNullable<typeof entry> => entry !== null);
  if (kinds.length === 0) return defaultForgePhysicsKindPresetFile();
  const defaultKindId = asString(record?.defaultKindId, kinds[0].id);
  return {
    version: 1,
    defaultKindId: kinds.some((kind) => kind.id === defaultKindId)
      ? defaultKindId
      : kinds[0].id,
    updatedAt: asString(record?.updatedAt, new Date().toISOString()),
    kinds,
  };
}

export function sanitizeForgePropMeta(raw: unknown): ForgeStoredPropMeta | null {
  const record = asRecord(raw);
  if (!record) return null;
  const id = asString(record.id).trim();
  if (!id) return null;
  const createdAt = asString(record.createdAt || record.created, new Date().toISOString());
  const updatedAt = asString(record.updatedAt, createdAt);
  const lifecycle = asRecord(record.lifecycle);
  return {
    ...(record as ForgeStoredPropMeta),
    version: typeof record.version === "number" ? record.version : 1,
    id,
    description: asString(record.description, id),
    createdAt,
    updatedAt,
    lifecycle: {
      ...(lifecycle ?? {}),
      status: normalizeLifecycleStatus(lifecycle?.status),
    },
  };
}
