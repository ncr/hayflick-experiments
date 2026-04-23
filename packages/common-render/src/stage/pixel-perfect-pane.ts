import * as THREE from "three";
import type {
  IsoGameViewPose,
  IsoGameViewState,
  IsoGameViewTuning,
  PixelSnapMode
} from "../pixel-perfect-types";
import { IsoViewport } from "../internals/iso-viewport";
import type {
  SharedScissorFrameContext,
  SharedScissorPane,
  SharedScissorPaneRect
} from "./shared-scissor-stage";
import { SharedScissorStage } from "./shared-scissor-stage";
import {
  OutlinePipeline,
  type OutlineTuning
} from "../outline/outline-pipeline";
import {
  assignOutlineGroupsByMaterialName,
  type MaterialNameGroupMap
} from "../presets/outline-groups";

export type PixelPerfectPaneConfig = {
  /** Stage to host this pane. The pane auto-registers on construction. */
  stage: SharedScissorStage;
  /** Stage-unique pane id. */
  id: string;
  /** DOM element whose layout rect the pane renders into. */
  element: HTMLElement;
  /** The three.js scene to render into this pane. */
  scene: THREE.Scene;
  /** CSS width override. Defaults to `element.clientWidth`. */
  width?: number;
  /** CSS height override. Defaults to `element.clientHeight`. */
  height?: number;
  clearColor?: number;
  clearAlpha?: number;
  /**
   * Enable the 4-pass outline pipeline. `true` uses {@link OutlineDefaults};
   * an object overrides individual tuning fields. `false` (or omitted)
   * disables outlines. When enabled, the pane also defaults
   * {@link PixelPerfectPaneConfig.toneMapping} to `"aces"`.
   *
   * The pipeline handle is exposed as {@link PixelPerfectPane.outline}.
   */
  outlines?: boolean | Partial<OutlineTuning>;
  /**
   * Initial outline-group assignment to run once on the first `render()`
   * call. See {@link assignOutlineGroupsByMaterialName}. Use
   * {@link PixelPerfectPane.reapplyOutlineGroups} to re-run when the
   * scene graph is rebuilt.
   */
  outlineGroups?: MaterialNameGroupMap;
  /**
   * Extra camera layers to enable (layer 0 is always on). Used when
   * different panes on a shared stage filter lighting or geometry per
   * camera via `.layers.set(...)`.
   */
  layers?: number[];
} & Partial<IsoGameViewTuning>;

/**
 * A pane attached to a {@link SharedScissorStage} that renders a scene through
 * the pixel-perfect iso-2:1 pipeline. Replaces the older pattern of manually
 * constructing a `IsoViewport` + pane adapter + calling
 * `stage.registerPane` — this class collapses that into one construction.
 *
 * The pane auto-reads `devicePixelRatio` and max backing size from the stage,
 * and auto-registers itself. `dispose()` is invoked by the stage when the
 * stage is disposed.
 */
export class PixelPerfectPane implements SharedScissorPane {
  readonly id: string;
  readonly element: HTMLElement;
  /**
   * The 4-pass outline pipeline attached to this pane, or null when
   * `outlines: false`/unset. Use this handle for outline-group assignment,
   * debug-mode toggling, and aux pixel readbacks.
   */
  readonly outline: OutlinePipeline | null;

  private readonly core: IsoViewport;
  private readonly stage: SharedScissorStage;
  private readonly fixedDevicePixelRatio: number;
  private readonly scene: THREE.Scene;
  private readonly outlineGroupsMap: MaterialNameGroupMap | null;
  private warnedMissingStageShadows = false;
  private initialOutlineGroupsApplied = false;

  constructor(config: PixelPerfectPaneConfig) {
    this.id = config.id;
    this.element = config.element;
    this.stage = config.stage;
    this.scene = config.scene;
    this.outlineGroupsMap = config.outlineGroups ?? null;
    this.fixedDevicePixelRatio = config.stage.getDevicePixelRatio();

    const measuredWidth = config.width ?? Math.max(1, Math.floor(config.element.clientWidth));
    const measuredHeight = config.height ?? Math.max(1, Math.floor(config.element.clientHeight));

    const {
      stage: _stage,
      id: _id,
      element: _element,
      width: _w,
      height: _h,
      outlines: _outlines,
      outlineGroups: _outlineGroups,
      layers: _layers,
      toneMapping: _toneMapping,
      shadows: _shadows,
      ...tuning
    } = config;
    this.core = new IsoViewport({
      ...tuning,
      width: measuredWidth,
      height: measuredHeight,
      scene: config.scene,
      maxBackingWidth: config.stage.maxBackingWidth,
      maxBackingHeight: config.stage.maxBackingHeight,
      devicePixelRatio: this.fixedDevicePixelRatio
    });

    config.stage.registerPane(this);

    if (config.layers) {
      for (const layer of config.layers) {
        this.core.camera.layers.enable(layer);
      }
    }

    // Tone mapping defaults to "aces" when outlines are on, to match the
    // PBR lighting the outline pipeline already drives through the ACES
    // scene render. Explicit toneMapping wins over the derived default.
    const outlinesOn = config.outlines !== undefined && config.outlines !== false;
    const toneMappingExplicit = config.toneMapping !== undefined;
    const toneMappingMode =
      config.toneMapping ?? (outlinesOn ? "aces" : undefined);
    this.installToneMappingHooksForMode(toneMappingMode);

    if (config.shadows) {
      this.warnIfStageShadowsMissing();
    }

    // Outlines wrap the pane's tone-mapping hooks (installed above), so
    // the outline pipeline's state save/restore correctly nests the pane's
    // tone-mapping scope. Construction also swaps the pane's low-res render
    // target, so any color-space tagging must happen after this line.
    this.outline = outlinesOn ? this.createOutline(config.outlines) : null;

    // Tag the (possibly-swapped) low target as sRGB so the ACES tone map +
    // gamma encoding apply correctly when the scene is drawn through it.
    // Only apply when toneMapping was set *explicitly* — when it's derived
    // from `outlines: true`, we stay backward-compatible with consumers
    // (e.g. outline-walls) that never tagged the target themselves.
    if (toneMappingExplicit && toneMappingMode === "aces") {
      this.core.getLowTarget().texture.colorSpace = THREE.SRGBColorSpace;
    }
  }

  private createOutline(
    outlinesConfig: boolean | Partial<OutlineTuning> | undefined
  ): OutlinePipeline {
    const tuning =
      typeof outlinesConfig === "object" ? outlinesConfig : undefined;
    return new OutlinePipeline({
      view: this,
      scene: this.scene,
      clearColor: this.stage.clearColor,
      clearAlpha: this.stage.clearAlpha,
      tuning
    });
  }

  /**
   * Re-apply the configured outline-group assignment. Call after rebuilding
   * a subtree of the scene so newly-added meshes pick up their outline group.
   *
   * - `reapplyOutlineGroups()` — re-apply to the whole pane scene with the
   *   map supplied at construction.
   * - `reapplyOutlineGroups(root)` — re-apply to a subtree with the config map.
   * - `reapplyOutlineGroups(root, map)` — explicit root and map.
   */
  reapplyOutlineGroups(
    root?: THREE.Object3D,
    map?: MaterialNameGroupMap
  ): void {
    if (!this.outline) return;
    const resolvedMap = map ?? this.outlineGroupsMap;
    if (!resolvedMap) return;
    const resolvedRoot = root ?? this.scene;
    assignOutlineGroupsByMaterialName(resolvedRoot, this.outline, resolvedMap);
  }

  private installToneMappingHooksForMode(
    mode: PixelPerfectPaneConfig["toneMapping"]
  ): void {
    if (mode === "aces") {
      this.installToneMappingHooks(THREE.ACESFilmicToneMapping);
    } else if (mode === "none") {
      this.installToneMappingHooks(THREE.NoToneMapping);
    }
  }

  // Only `toneMapping` mode is managed per-pane. `toneMappingExposure` stays
  // a renderer-wide knob the consumer can set directly on `view.renderer`
  // (e.g. 1.25 for a brighter PBR scene); the hook leaves it untouched so
  // the value is visible during the scene render pass.
  private installToneMappingHooks(targetMode: THREE.ToneMapping): void {
    let savedMode: THREE.ToneMapping = THREE.NoToneMapping;
    this.core.beforeSceneRender = (renderer) => {
      savedMode = renderer.toneMapping;
      renderer.toneMapping = targetMode;
    };
    this.core.afterSceneRender = (renderer) => {
      renderer.toneMapping = savedMode;
    };
  }

  private warnIfStageShadowsMissing(): void {
    if (this.warnedMissingStageShadows) return;
    if (this.stage.renderer.shadowMap.enabled) return;
    this.warnedMissingStageShadows = true;
    console.warn(
      `[PixelPerfectPane] Pane "${this.id}" requested shadows: true but the ` +
        `hosting SharedScissorStage was not constructed with shadows: true. ` +
        `Shadow casting requires the shared renderer to enable shadowMap.enabled, ` +
        `so this pane will render without shadows.`
    );
  }

  render(frame: SharedScissorFrameContext, rect: SharedScissorPaneRect): void {
    if (
      !this.initialOutlineGroupsApplied &&
      this.outline &&
      this.outlineGroupsMap
    ) {
      assignOutlineGroupsByMaterialName(this.scene, this.outline, this.outlineGroupsMap);
      this.initialOutlineGroupsApplied = true;
    }
    this.core.renderToRenderer(
      frame.renderer,
      {
        x: rect.deviceViewportLeft,
        y: rect.deviceViewportBottom,
        width: rect.deviceWidthUnclipped,
        height: rect.deviceHeightUnclipped
      },
      frame.nowMs,
      frame.deltaSeconds,
      {
        x: rect.deviceLeft,
        y: rect.deviceBottom,
        width: rect.deviceWidth,
        height: rect.deviceHeight
      }
    );
  }

  onResize(rect: SharedScissorPaneRect): void {
    const dpr =
      this.fixedDevicePixelRatio ||
      (rect.cssWidth > 0 ? rect.deviceWidthUnclipped / rect.cssWidth : 1);
    const logicalDeviceWidth = Math.max(
      1,
      rect.deviceWidthUnclipped || Math.round(rect.cssWidth * dpr)
    );
    const logicalDeviceHeight = Math.max(
      1,
      rect.deviceHeightUnclipped || Math.round(rect.cssHeight * dpr)
    );
    this.core.resize(rect.cssWidth, rect.cssHeight, dpr, logicalDeviceWidth, logicalDeviceHeight);
  }

  dispose(): void {
    this.outline?.dispose();
    this.core.dispose();
  }

  /* ---------- Pose / state ---------- */

  getViewPose(): IsoGameViewPose {
    return this.core.getViewPose();
  }

  setViewPose(pose: IsoGameViewPose): void {
    this.core.setViewPose(pose);
  }

  getState(): IsoGameViewState {
    return this.core.getState();
  }

  /* ---------- Camera / scene ---------- */

  get camera(): THREE.OrthographicCamera {
    return this.core.camera;
  }

  get cameraTarget(): THREE.Vector3 {
    return this.core.cameraTarget;
  }

  /** The shared renderer this pane draws into. Useful for outline / post-process hooks. */
  get renderer(): THREE.WebGLRenderer {
    return this.stage.renderer;
  }

  /* ---------- Input / pan / zoom / rotate ---------- */

  panByCss(dx: number, dy: number): void {
    this.core.panByCss(dx, dy);
  }

  getYawIndex(): number {
    return this.core.getYawIndex();
  }

  rotateQuarterTurns(delta: -1 | 1): void {
    this.core.rotateQuarterTurns(delta);
  }

  stepCameraZoom(direction: -1 | 1): void {
    this.core.stepCameraZoom(direction);
  }

  stepCameraZoomAtLocalCss(
    direction: -1 | 1,
    localX: number,
    localY: number,
    nowMs?: number
  ): boolean {
    return this.core.zoomStepAtLocalCss(direction, localX, localY, nowMs);
  }

  toggleZoomMode(): void {
    this.core.toggleZoomMode();
  }

  beginPanDrag(localX: number, localY: number): void {
    this.core.beginPanDrag(localX, localY);
  }

  updatePanDrag(localX: number, localY: number): boolean {
    return this.core.updatePanDrag(localX, localY);
  }

  endPanDrag(): boolean {
    return this.core.endPanDrag();
  }

  isDragging(): boolean {
    return this.core.isDragging();
  }

  /* ---------- Projection helpers ---------- */

  worldAtLocalCss(localX: number, localY: number, out: THREE.Vector3): boolean {
    return this.core.worldAtLocalCss(localX, localY, out);
  }

  projectWorldToLocalCss(world: THREE.Vector3, out: THREE.Vector2): boolean {
    return this.core.projectWorldToLocalCss(world, out);
  }

  snapWorldPointOnGround(
    world: THREE.Vector3,
    out: THREE.Vector3,
    mode?: PixelSnapMode
  ): boolean {
    return this.core.snapWorldPointOnGround(world, out, mode);
  }

  /* ---------- AA extension hooks (advanced) ---------- *
   *
   * These expose the low-res render target and the scene-render hook pair
   * that the library normally drives from declarative config. Reach for
   * the declarative alternatives first:
   *
   *   - `toneMapping: "none" | "aces"` instead of flipping `renderer.toneMapping`
   *     in a `beforeSceneRender` hook
   *   - `outlines: true | {...}` + `outlineGroups:` instead of hand-rolling
   *     an outline pipeline on `afterSceneRender`
   *   - `shadows: true` (on the stage) instead of touching `renderer.shadowMap`
   *
   * The remaining legitimate use case is custom antialiasing (FXAA, SMAA,
   * MSAA sample-count swaps) — see `packages/experiments/src/prop-test-scene/`.
   */

  /** @advanced Prefer `toneMapping` / `outlines` / `shadows` declarative config. */
  getLowTarget(): THREE.WebGLRenderTarget {
    return this.core.getLowTarget();
  }

  /** @advanced Prefer `lowTargetSamples` in pane config over swapping the RT. */
  setLowTarget(target: THREE.WebGLRenderTarget): void {
    this.core.setLowTarget(target);
  }

  /** @advanced For custom-AA output; the library drives this when `outlines: true`. */
  setOutputSourceTexture(texture: THREE.Texture | null): void {
    this.core.setOutputSourceTexture(texture);
  }

  /** @advanced Read the pane's before-scene hook; assignment overwrites any library-owned chain. */
  get beforeSceneRender():
    | ((renderer: THREE.WebGLRenderer, lowTarget: THREE.WebGLRenderTarget) => void)
    | null {
    return this.core.beforeSceneRender;
  }

  /** @advanced Setting this clobbers the pane's tone-mapping / outline setup. Use `toneMapping` / `outlines` config. */
  set beforeSceneRender(
    cb: ((renderer: THREE.WebGLRenderer, lowTarget: THREE.WebGLRenderTarget) => void) | null
  ) {
    this.core.beforeSceneRender = cb;
  }

  /** @advanced Read the pane's after-scene hook; assignment overwrites any library-owned chain. */
  get afterSceneRender():
    | ((renderer: THREE.WebGLRenderer, lowTarget: THREE.WebGLRenderTarget) => void)
    | null {
    return this.core.afterSceneRender;
  }

  /** @advanced Setting this clobbers the pane's outline / tone-mapping restore. Use `outlines` config for outlines. */
  set afterSceneRender(
    cb: ((renderer: THREE.WebGLRenderer, lowTarget: THREE.WebGLRenderTarget) => void) | null
  ) {
    this.core.afterSceneRender = cb;
  }

  reset(): void {
    this.core.reset();
  }
}
