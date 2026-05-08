import { LevelRuntime } from "@common/gameplay";
import type { AuthoredLevel, LevelPlacement } from "./authoring";
import {
  createAssetRegistry,
  resolveAssetOptions,
  type RenderableAsset
} from "./asset-contract";
import { exampleWaystationLevel } from "./example-level";
import type { SceneConfig } from "./gui";
import type { RenderableObject, WaystationRenderer } from "./renderer";
import { waystationAssets } from "./waystation-assets";
import { fogHeightUniforms } from "./fog";
import {
  aoBoxEdgeUniforms,
  aoFloorUniforms,
  aoGroundUniforms
} from "./ao-patch";

export type WaystationLevelOptions = {
  renderer: WaystationRenderer;
  config: SceneConfig;
  definition?: AuthoredLevel;
  assets?: readonly RenderableAsset[];
};

export type WaystationLevel = {
  id: string;
  title: string;
  applyConfig(config: SceneConfig): void;
  step(dt: number): void;
  dispose(): void;
};

function requirePlacementHandle(
  handles: Map<string, unknown>,
  owner: LevelPlacement,
  id: string
): unknown {
  if (!handles.has(id)) {
    throw new Error(
      `Placement "${owner.id}" requires placement "${id}" to be created first.`
    );
  }

  return handles.get(id);
}

function assertRequiredHandles(
  handles: Map<string, unknown>,
  placement: LevelPlacement,
  options: Record<string, unknown>,
  requiredOptionKeys: readonly string[] | undefined
): void {
  for (const key of requiredOptionKeys ?? []) {
    const value = options[key];
    if (typeof value !== "string" || value.trim().length === 0) {
      throw new Error(
        `Placement "${placement.id}" asset option "${key}" must name another placement.`
      );
    }
    requirePlacementHandle(handles, placement, value);
  }
}

function applyGlobalConfig(config: SceneConfig): void {
  fogHeightUniforms.fogHeightFloor.value = config.fog.heightFloor;
  fogHeightUniforms.fogHeightScale.value = config.fog.heightScale;

  aoFloorUniforms.aoStrength.value = config.ao.floorStrength;
  aoFloorUniforms.aoRadius.value = config.ao.floorRadius;
  aoGroundUniforms.aoStrength.value = config.ao.groundStrength;
  aoGroundUniforms.aoRadius.value = config.ao.groundRadius;
  aoBoxEdgeUniforms.boxEdgeStrength.value = config.ao.edgeStrength;
  aoBoxEdgeUniforms.boxEdgeFraction.value = config.ao.edgeFraction;
}

export function createWaystationLevel(options: WaystationLevelOptions): WaystationLevel {
  const definition = options.definition ?? exampleWaystationLevel;
  const registry = createAssetRegistry(options.assets ?? waystationAssets);
  const runtime = new LevelRuntime<RenderableObject>({
    attach(object) {
      options.renderer.addObject(object);
    },
    detach(object) {
      options.renderer.removeObject(object);
    },
    disposeNode(object) {
      object.dispose();
    }
  });

  const handles = new Map<string, unknown>();
  const configure: Array<(config: SceneConfig) => void> = [];

  for (const placement of definition.placements) {
    const asset = registry.require(placement.asset);
    const assetOptions = resolveAssetOptions(asset.metadata, placement.options);

    assertRequiredHandles(handles, placement, assetOptions, asset.metadata.requires);

    const instance = asset.create({
      id: placement.id,
      options: assetOptions,
      config: options.config,
      renderer: options.renderer,
      requireHandle<T>(id: string): T {
        return requirePlacementHandle(handles, placement, id) as T;
      }
    });

    runtime.addObject({
      id: placement.id,
      node: instance.renderable
    });

    if (instance.handle !== undefined) {
      handles.set(placement.id, instance.handle);
    }

    if (instance.configure) {
      configure.push(instance.configure);
    }

    for (const system of instance.systems ?? []) {
      runtime.addSystem(system);
    }
  }

  const applyConfig = (config: SceneConfig): void => {
    applyGlobalConfig(config);
    for (const apply of configure) {
      apply(config);
    }
  };
  applyConfig(options.config);

  return {
    id: definition.id,
    title: definition.title,
    applyConfig,
    step(dt) {
      runtime.step(dt);
    },
    dispose() {
      runtime.dispose();
    }
  };
}
