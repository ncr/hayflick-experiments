import type { System } from "@common/gameplay";
import type { SceneConfig } from "./gui";
import type { RenderableObject, WaystationRenderer } from "./renderer";

export type AssetKind = "scenery" | "structure" | "prop-set" | "effect";

export type AssetMetadata = {
  id: string;
  label: string;
  kind: AssetKind;
  creates: "object3d";
  defaults?: Record<string, unknown>;
  requires?: string[];
};

export type AssetCreateContext = {
  id: string;
  options: Record<string, unknown>;
  config: SceneConfig;
  renderer: WaystationRenderer;
  requireHandle<T>(id: string): T;
};

export type AssetInstance = {
  renderable: RenderableObject;
  handle?: unknown;
  systems?: System[];
  configure?: (config: SceneConfig) => void;
};

export type RenderableAsset = {
  metadata: AssetMetadata;
  create(context: AssetCreateContext): AssetInstance;
};

export type AssetRegistry = {
  all(): readonly RenderableAsset[];
  get(id: string): RenderableAsset | undefined;
  require(id: string): RenderableAsset;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireNonEmpty(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`Asset metadata field "${field}" must be a non-empty string.`);
  }
  return value;
}

function requireStringArray(value: unknown, field: string): string[] | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || entry.trim().length === 0)) {
    throw new Error(`Asset metadata field "${field}" must be an array of non-empty strings.`);
  }

  return value.slice();
}

export function validateAssetMetadata(metadata: unknown): AssetMetadata {
  if (!isRecord(metadata)) {
    throw new Error("Asset metadata must be an object.");
  }

  const id = requireNonEmpty(metadata.id, "id");
  const label = requireNonEmpty(metadata.label, "label");
  const kind = requireNonEmpty(metadata.kind, "kind");
  const creates = requireNonEmpty(metadata.creates, "creates");

  if (!["scenery", "structure", "prop-set", "effect"].includes(kind)) {
    throw new Error(`Asset metadata field "kind" is not supported: ${kind}`);
  }

  if (creates !== "object3d") {
    throw new Error(`Asset metadata field "creates" is not supported: ${creates}`);
  }

  const defaults = metadata.defaults;
  if (defaults !== undefined && !isRecord(defaults)) {
    throw new Error('Asset metadata field "defaults" must be an object when present.');
  }

  return {
    id,
    label,
    kind: kind as AssetKind,
    creates,
    defaults: defaults ? { ...defaults } : undefined,
    requires: requireStringArray(metadata.requires, "requires")
  };
}

export function createAssetRegistry(assets: readonly RenderableAsset[]): AssetRegistry {
  const byId = new Map<string, RenderableAsset>();

  for (const asset of assets) {
    if (typeof asset.create !== "function") {
      throw new Error("Renderable asset is missing a create(context) function.");
    }

    const metadata = validateAssetMetadata(asset.metadata);
    if (byId.has(metadata.id)) {
      throw new Error(`Duplicate renderable asset id: ${metadata.id}`);
    }

    byId.set(metadata.id, {
      ...asset,
      metadata
    });
  }

  return {
    all() {
      return [...byId.values()];
    },
    get(id) {
      return byId.get(id);
    },
    require(id) {
      const asset = byId.get(id);
      if (!asset) {
        throw new Error(`Unknown renderable asset: ${id}`);
      }
      return asset;
    }
  };
}

export function resolveAssetOptions(
  metadata: AssetMetadata,
  placementOptions: Record<string, unknown>
): Record<string, unknown> {
  return {
    ...(metadata.defaults ?? {}),
    ...placementOptions
  };
}
