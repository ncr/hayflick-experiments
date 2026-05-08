# Fallout Waystation Level Foundation

This is the smallest current foundation for authoring the `fallout-waystation`
Three.js scene without writing renderer calls in the level file.

The boundaries are intentionally narrow:

- Renderer code owns Three.js, `IsoGameView`, camera access, lighting, fog,
  resize, input binding, and frame rendering.
- ECS code owns entity lifetime, per-frame systems, and object attach/detach.
- Level authoring describes named placements of renderable assets.
- Asset code is the only place where a concept such as "building" becomes a
  concrete renderable object and optional behavior.

The example authored level is
`packages/experiments/src/fallout-waystation/example-level.ts`.

## Renderer API

Local renderer module:
`packages/experiments/src/fallout-waystation/renderer.ts`

Public surface:

- `new WaystationRenderer({ mount, width, height, config })`
  - Creates the Three.js scene and the existing `IsoGameView`.
  - Applies the current waystation lighting, fog, background, shadows, and
    outline defaults.
- `renderer.addObject(object: RenderableObject): void`
  - Adds an opaque renderable object to the scene.
- `renderer.removeObject(object: RenderableObject): void`
  - Removes an opaque renderable object from the scene.
- `renderer.faceCamera(aim: (camera) => void): void`
  - Narrow escape hatch for camera-facing effects such as light shafts. Level
    files do not call this.
- `renderer.bindInput(): () => void`
  - Binds the existing iso camera input and returns an unbind function.
- `renderer.resize(width, height): void`
- `renderer.frame(nowMs, deltaSeconds): void`
- `renderer.applyConfig(config): void`
  - Re-applies renderer-owned config: sun, ambient, hemisphere, fill, scene fog,
    and background.
- `renderer.dispose(): void`
- `createRenderableObject(threeObject): RenderableObject`
  - Adapter used by asset factories. It centralizes disposal of mesh/points
    geometry and materials.
- `RenderableObject`
  - Opaque object passed between assets, runtime, and renderer.

The lower-level `@common/render` API still exists, but the waystation level
does not import it directly.

## ECS API

Shared ECS package:
`packages/common-gameplay/src`

Public surface currently exported by `@common/gameplay`:

- `LevelRuntime<TNode>`
  - `addObject({ id, node, transform?, velocity?, persistent?, player? })`
  - `getObject(id)`
  - `removeObject(id)`
  - `addSystem(system)`
  - `step(dt)`
  - `dispose()`
- `World`
  - Entity lifecycle: `createEntity`, `destroyEntity`, `alive`, `entities`,
    `clear`
  - Component stores: `transforms`, `velocities`, `playerTags`, `persistents`,
    `sceneRefs`
  - Resources: `time`, `input`, `level`, `events`
  - Query helpers: `queryTransformVelocity`, `queryTransformPlayer`,
    `queryTransformSceneRef`
  - Save/load helpers: `serialize`, `deserialize`, `saveToLocalStorage`,
    `loadFromLocalStorage`
- Component/store primitives
  - `EID`, `ComponentStore<T>`, `DataStore<T>`, `TagStore`
- System primitives
  - `System`
  - `KeyboardTracker`
  - `createInputSystem`
  - `createPlayerInputSystem`
  - `createMovementSystem`
  - `createEventSystem`
  - `frame`
- Events and persistence
  - `EventBus`
  - `SAVE_SCHEMA_VERSION`
  - `createOpenLevel`
  - `resolveOpenLevel`
  - `serializeWorld`
  - `deserializeWorld`
  - `migrateSave`
  - `saveWorldToLocalStorage`
  - `loadWorldFromLocalStorage`
- Types exported from `ecs/types.ts`
  - `Transform`, `Velocity`, `Persistent`, `SceneRef`, `InputState`,
    `TimeResource`, `LevelSnapshot`, `LevelResource`, `LevelResolver`,
    `EcsEvent`, `PlayerTag`, `SaveEntityRecord`, `SaveGame`, `DebugMessage`,
    `DebugSink`, `WorldOptions`
- Small existing utility
  - `InventoryItem`
  - `mergeInventory`

The waystation foundation uses only `LevelRuntime`, `System`, and the runtime's
object attach/detach hooks. Level files do not import ECS types.

## Level Authoring API

Authoring module:
`packages/experiments/src/fallout-waystation/authoring.ts`

Public surface:

- `defineLevel({ id, title }, (level) => { ... }): AuthoredLevel`
- `level.place(id, asset, options?)`
  - `id` is the placement id inside the level.
  - `asset` is a string asset id, resolved by the asset registry.
  - `options` is a small record merged over the asset metadata defaults.
- `AuthoredLevel`
  - `{ id, title, placements }`
- `LevelPlacement`
  - `{ id, asset, options }`
- `LevelAssetOptions`
  - `Record<string, unknown>`

Runtime compiler:
`packages/experiments/src/fallout-waystation/level.ts`

Public surface:

- `createWaystationLevel({ renderer, config, definition?, assets? })`
  - Defaults to `exampleWaystationLevel` and `waystationAssets`.
  - Builds renderable assets in placement order.
  - Registers renderables with `LevelRuntime`.
  - Registers asset systems with the runtime.
  - Stores asset config callbacks.
- `WaystationLevel`
  - `id`
  - `title`
  - `applyConfig(config)`
  - `step(dt)`
  - `dispose()`

Example:

```ts
export const exampleWaystationLevel = defineLevel(
  { id: "fallout-waystation.example", title: "Roadside Cutaway Waystation" },
  (level) => {
    level.place("ground", "waystation.ground");
    level.place("building", "waystation.building");
    level.place("props", "waystation.props");
    level.place("light-shafts", "waystation.light-shafts", {
      building: "building"
    });
    level.place("dust", "waystation.dust");
    level.place("smoke", "waystation.smoke");
    level.place("steam", "waystation.steam");
  }
);
```

## Asset Contract

Contract module:
`packages/experiments/src/fallout-waystation/asset-contract.ts`

Renderable assets are referenced only by string id. The current concrete asset
registry lives in:
`packages/experiments/src/fallout-waystation/waystation-assets.ts`

Public surface:

- `RenderableAsset`
  - `{ metadata, create(context) }`
- `AssetMetadata`
  - `id: string`
  - `label: string`
  - `kind: "scenery" | "structure" | "prop-set" | "effect"`
  - `creates: "object3d"`
  - `defaults?: Record<string, unknown>`
  - `requires?: string[]`
- `AssetCreateContext`
  - `id`
  - `options`
  - `config`
  - `renderer`
  - `requireHandle<T>(placementId)`
- `AssetInstance`
  - `renderable: RenderableObject`
  - `handle?: unknown`
  - `systems?: System[]`
  - `configure?: (config) => void`
- `createAssetRegistry(assets)`
- `validateAssetMetadata(metadata)`
- `resolveAssetOptions(metadata, placementOptions)`

Defaults:

- Placement options default to `{}`.
- Asset metadata defaults default to `{}`.
- Placement options override asset metadata defaults.
- The current contract has no transform or ECS component fields.
- Assets have no systems, handle, or config callback unless the asset explicitly
  returns them.
- `requires` defaults to no dependencies.

Validation and errors:

- Missing or empty metadata `id`, `label`, `kind`, or `creates` throws.
- Unsupported `kind` throws.
- `creates` must be `"object3d"`.
- `defaults` must be an object when present.
- `requires` must be an array of non-empty strings when present.
- Duplicate asset ids throw.
- Unknown asset references throw `Unknown renderable asset: <id>`.
- A required option key must resolve to another placement id.
- Required handles must already exist, so dependency order stays explicit in the
  level file.

The current waystation assets are deliberately coarse: ground, building, props,
light shafts, dust, smoke, and steam. They preserve the existing visual style
while keeping the level file readable.

## Current Non-Goals

- No generic engine package.
- No editor schema.
- No asset loading pipeline.
- No transform grammar beyond what the current waystation scene needs.
- No broad game component catalog.
