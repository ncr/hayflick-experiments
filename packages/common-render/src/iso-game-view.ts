import * as THREE from "three";
import { PixelPerfectPane } from "./stage/pixel-perfect-pane";
import { SharedScissorStage } from "./stage/shared-scissor-stage";
import type { SetLowTargetOptions } from "./internals/low-resolution-target";
import {
  PixelPerfectDefaults,
  resolveLockedView,
  type IsoGameViewConfig as IsoGameViewConfigBase,
  type IsoGameViewPose,
  type IsoGameViewState,
  type PixelSnapMode
} from "./pixel-perfect-types";
import { type OutlinePipeline, type OutlineTuning } from "./outline/outline-pipeline";
import type { MaterialNameGroupMap } from "./presets/outline-groups";
import {
  addStandardGameLighting,
  type StandardGameLightingHandle,
  type StandardGameLightingOptions
} from "./presets/standard-lighting";
import { warnIfSceneHasNoLights } from "./presets/dev-warnings";

export type {
  IsoGameViewPose,
  IsoGameViewState,
  PixelSnapMode
} from "./pixel-perfect-types";
export type { OutlineTuning } from "./outline/outline-pipeline";

export type IsoGameViewConfig = IsoGameViewConfigBase & {
  /**
   * 4-pass outline pipeline. Default `true` (outlines ON, using
   * {@link OutlineDefaults}). Pass `false` to opt out — prop inspection or
   * unbroken-silhouette previews where edges hurt more than help. Pass a
   * partial tuning to override specific knobs. The pipeline handle lives on
   * {@link IsoGameView.outline} whenever outlines are enabled.
   */
  outlines?: boolean | Partial<OutlineTuning>;
  /**
   * Initial outline-group assignment applied once on the first frame.
   * See {@link MaterialNameGroupMap}. Use
   * {@link IsoGameView.setOutlineGroups} to replace the map after scene-graph
   * rebuilds.
   */
  outlineGroups?: MaterialNameGroupMap;
  /**
   * Extra camera layers to enable (layer 0 is always on). Matches
   * {@link PixelPerfectPaneConfig.layers}.
   */
  layers?: number[];
  /**
   * Auto-managed lighting. `true` adds {@link addStandardGameLighting} with
   * default options; an object passes through as options. The handle is
   * exposed as {@link IsoGameView.lighting}, and the lights are removed on
   * {@link IsoGameView.dispose}. Default `undefined` (consumer supplies
   * their own lighting).
   */
  lighting?: boolean | StandardGameLightingOptions;
};

const SINGLE_PANE_ID = "main";

export class IsoGameView {
  readonly stage: SharedScissorStage;
  readonly renderer: THREE.WebGLRenderer;
  readonly camera: THREE.OrthographicCamera;
  readonly cameraTarget: THREE.Vector3;

  /**
   * Set when the view was created with `outlines: true | {...}`. Gives access
   * to outline-group assignment, debug modes, and aux pixel readbacks. Null
   * when outlines are off.
   */
  readonly outline: OutlinePipeline | null;

  /**
   * Set when the view was created with `lighting: true | {...}`. Holds the
   * {@link StandardGameLightingHandle} returned by
   * {@link addStandardGameLighting}. Null when `lighting` was not passed.
   */
  readonly lighting: StandardGameLightingHandle | null;

  private readonly mount: HTMLElement;
  private readonly pane: PixelPerfectPane;
  private readonly projectLocal = new THREE.Vector2();
  private readonly zoomLadderValues: readonly number[];
  private disposed = false;

  constructor(config: IsoGameViewConfig) {
    this.mount = config.mount;

    this.stage = new SharedScissorStage({
      mount: config.mount,
      width: config.width,
      height: config.height,
      pixelRatio: Math.max(1, window.devicePixelRatio || 1),
      antialias: false,
      clearColor: config.clearColor ?? 0x0b0f14,
      clearAlpha: config.clearAlpha ?? 1,
      shadows: config.shadows ?? false
    });
    this.renderer = this.stage.renderer;

    if (config.lighting) {
      const opts = config.lighting === true ? undefined : config.lighting;
      this.lighting = addStandardGameLighting(config.scene, opts);
    } else {
      this.lighting = null;
    }

    // Strip facade-only fields from the pane config. Keep clearColor /
    // clearAlpha flowing through: IsoViewport clears its own pane rect after
    // the stage-level full-canvas clear, so both layers need the same color.
    const {
      mount: _mount,
      scene: _scene,
      width: _w,
      height: _h,
      lighting: _lighting,
      yawIndex: _yawIndex,
      ...paneConfig
    } = config;

    // Lock-down: the cornerstone iso-2:1 contract is enforced here.
    // Resolve the locked (cameraPitch, yawIndex) pair into the underlying
    // (fixedRenderHeight, baseOrthoHeight, continuous cameraYaw) the pane
    // consumes. Tools that need a different scale must construct
    // PixelPerfectPane directly — IsoGameView is the locked surface.
    const cameraPitch = paneConfig.cameraPitch ?? PixelPerfectDefaults.cameraPitch;
    const lockedYawIndex = config.yawIndex ?? PixelPerfectDefaults.yawIndex;
    const lockedScale = resolveLockedView(cameraPitch, lockedYawIndex);

    this.pane = new PixelPerfectPane({
      stage: this.stage,
      id: SINGLE_PANE_ID,
      element: this.mount,
      scene: config.scene,
      width: config.width,
      height: config.height,
      ...paneConfig,
      cameraPitch,
      cameraYaw: lockedScale.cameraYaw,
      fixedRenderHeight: lockedScale.fixedRenderHeight,
      baseOrthoHeight: lockedScale.baseOrthoHeight,
      // IsoGameView keeps the historical default of outlines-ON. Raw
      // PixelPerfectPane defaults to OFF (explicit opt-in); the facade
      // flips that so `new IsoGameView({...})` ships with outlines.
      outlines: config.outlines ?? true
    });

    this.camera = this.pane.camera;
    this.cameraTarget = this.pane.cameraTarget;
    this.outline = this.pane.outline;

    const zMin = paneConfig.zoomMin ?? PixelPerfectDefaults.zoomMin;
    const zMax = paneConfig.zoomMax ?? PixelPerfectDefaults.zoomMax;
    const zStep = paneConfig.zoomStep ?? PixelPerfectDefaults.zoomStep;
    const levels: number[] = [];
    for (let z = zMin; z <= zMax + 1e-9; z += zStep) {
      levels.push(Number(z.toFixed(6)));
    }
    this.zoomLadderValues = Object.freeze(levels);

    warnIfSceneHasNoLights(config.scene, "IsoGameView");
  }

  /**
   * Replace the outline-group map and reapply to the scene. Use after
   * rebuilding a subtree so new meshes pick up their groups. Pass `null` to
   * clear the stored map (future rebuilds won't reapply).
   *
   * The optional `root` scopes the reapply to a subtree; omit it to reapply
   * to the whole scene.
   */
  setOutlineGroups(
    map: MaterialNameGroupMap | null,
    root?: THREE.Object3D
  ): void {
    this.pane.setOutlineGroups(map, root);
  }

  getState(): IsoGameViewState {
    return this.pane.getState();
  }

  getViewPose(): IsoGameViewPose {
    return this.pane.getViewPose();
  }

  setViewPose(pose: IsoGameViewPose): void {
    this.pane.setViewPose(pose);
  }

  /**
   * Discrete zoom levels resolved from the pane's `zoomMin/Max/Step` tuning.
   * These are the values the radio-style UI surfaces to the user; staying
   * on the ladder keeps the upscale on its quantized rail and avoids
   * sub-pixel shimmer.
   */
  getZoomLadder(): readonly number[] {
    return this.zoomLadderValues;
  }

  /** Set the target zoom. Thin wrapper over {@link setViewPose}. */
  setZoom(zoom: number): void {
    this.setViewPose({ ...this.getViewPose(), zoom });
  }

  /**
   * Physical mm one low-res texel occupies on screen at `zoom`, using the
   * W3C convention that 1 CSS px ≈ 1/96 inch. The OS doesn't expose real
   * mm so this varies by display — treat as a sensible default. Depends on
   * `baseRenderScale`, which depends on canvas size, so values shift on
   * resize.
   */
  getTexelMmForZoom(zoom: number, devicePixelRatioOverride?: number): number {
    const dpr =
      devicePixelRatioOverride ??
      (typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1);
    const cssPxPerMm = 96 / 25.4;
    const baseRenderScale = Math.max(1, this.getState().baseRenderScale);
    return (baseRenderScale * zoom) / dpr / cssPxPerMm;
  }

  /**
   * Pick the ladder entry whose on-screen texel size is closest to
   * `targetMm`. Use to choose a sensible default that lives on the
   * quantized zoom rail.
   */
  pickClosestZoomForTexelMm(
    targetMm: number,
    devicePixelRatioOverride?: number
  ): number {
    let best = this.zoomLadderValues[0] ?? 1;
    let bestDiff = Infinity;
    for (const z of this.zoomLadderValues) {
      const diff = Math.abs(this.getTexelMmForZoom(z, devicePixelRatioOverride) - targetMm);
      if (diff < bestDiff) {
        bestDiff = diff;
        best = z;
      }
    }
    return best;
  }

  getYawIndex(): number {
    return this.pane.getYawIndex();
  }

  rotateQuarterTurns(delta: -1 | 1): void {
    this.pane.rotateQuarterTurns(delta);
  }

  panByCss(dx: number, dy: number): void {
    this.pane.panByCss(dx, dy);
  }

  stepCameraZoom(direction: -1 | 1): void {
    this.pane.stepCameraZoom(direction);
  }

  toggleZoomMode(): void {
    this.pane.toggleZoomMode();
  }

  beginPanDrag(clientX: number, clientY: number): boolean {
    const local = this.toLocalCss(clientX, clientY);
    if (!local) {
      return false;
    }
    this.pane.beginPanDrag(local.x, local.y);
    return true;
  }

  updatePanDrag(clientX: number, clientY: number): boolean {
    const local = this.toLocalCss(clientX, clientY);
    if (!local) {
      return false;
    }
    return this.pane.updatePanDrag(local.x, local.y);
  }

  endPanDrag(): boolean {
    return this.pane.endPanDrag();
  }

  zoomStepAtClient(
    direction: -1 | 1,
    clientX: number,
    clientY: number,
    nowMs?: number
  ): boolean {
    const local = this.toLocalCss(clientX, clientY);
    if (!local) {
      return false;
    }
    return this.pane.stepCameraZoomAtLocalCss(direction, local.x, local.y, nowMs);
  }

  /* ---- AA extension points (advanced) ----
   *
   * Prefer `toneMapping` / `outlines` / `shadows` config on construction.
   * These escape hatches exist for cases the declarative API can't cover —
   * primarily custom antialiasing (FXAA / SMAA / MSAA). See
   * `PixelPerfectPane` for the full rationale.
   */

  /** @advanced See PixelPerfectPane.getLowTarget. */
  getLowTarget(): THREE.WebGLRenderTarget {
    return this.pane.getLowTarget();
  }

  /** @advanced See PixelPerfectPane.setLowTarget. */
  setLowTarget(target: THREE.WebGLRenderTarget, options?: SetLowTargetOptions): void {
    this.pane.setLowTarget(target, options);
  }

  /** @advanced See PixelPerfectPane.setOutputSourceTexture. */
  setOutputSourceTexture(texture: THREE.Texture | null): void {
    this.pane.setOutputSourceTexture(texture);
  }

  /** @advanced See PixelPerfectPane.beforeSceneRender. */
  get beforeSceneRender():
    | ((renderer: THREE.WebGLRenderer, lowTarget: THREE.WebGLRenderTarget) => void)
    | null {
    return this.pane.beforeSceneRender;
  }

  /** @advanced See PixelPerfectPane.beforeSceneRender. */
  set beforeSceneRender(
    cb: ((renderer: THREE.WebGLRenderer, lowTarget: THREE.WebGLRenderTarget) => void) | null
  ) {
    this.pane.beforeSceneRender = cb;
  }

  /** @advanced See PixelPerfectPane.afterSceneRender. */
  get afterSceneRender():
    | ((renderer: THREE.WebGLRenderer, lowTarget: THREE.WebGLRenderTarget) => void)
    | null {
    return this.pane.afterSceneRender;
  }

  /** @advanced See PixelPerfectPane.afterSceneRender. */
  set afterSceneRender(
    cb: ((renderer: THREE.WebGLRenderer, lowTarget: THREE.WebGLRenderTarget) => void) | null
  ) {
    this.pane.afterSceneRender = cb;
  }

  get canvas(): HTMLCanvasElement {
    return this.stage.canvas;
  }

  reset(): void {
    this.pane.reset();
  }

  resize(nextWidth: number, nextHeight: number): void {
    this.stage.resize(nextWidth, nextHeight, Math.max(1, window.devicePixelRatio || 1));
  }

  /**
   * Begin the render loop. Equivalent to a requestAnimationFrame loop that
   * calls {@link frame} each tick. Safe to call when already running.
   */
  start(): void {
    this.stage.start();
  }

  /** Stop the render loop started by {@link start}. Safe to call when idle. */
  stop(): void {
    this.stage.stop();
  }

  /**
   * Render a single frame. Use when integrating with a caller-owned tick loop
   * or for deterministic test frames. For normal runtime, prefer
   * {@link start} / {@link stop}.
   */
  frame(nowMs: number, deltaSeconds: number): void {
    this.stage.drawFrame(nowMs, deltaSeconds);
  }

  worldAtClient(clientX: number, clientY: number, out: THREE.Vector3): boolean {
    const local = this.toLocalCss(clientX, clientY);
    if (!local) {
      return false;
    }
    return this.pane.worldAtLocalCss(local.x, local.y, out);
  }

  /** Project a world point to mount-local CSS pixel coords (origin at top-left of the viewport mount). */
  projectWorldToLocalCss(world: THREE.Vector3, out: THREE.Vector2): boolean {
    return this.pane.projectWorldToLocalCss(world, out);
  }

  projectWorldToClient(world: THREE.Vector3, out: THREE.Vector2): boolean {
    const local = this.projectLocal;
    if (!this.pane.projectWorldToLocalCss(world, local)) {
      return false;
    }
    const rect = this.mount.getBoundingClientRect();
    out.set(rect.left + local.x, rect.top + local.y);
    return true;
  }

  /**
   * Snap a world point to the screen-pixel lattice on the ground plane.
   * The default {a:1, b:1} quantizes to every screen pixel — under
   * orthographic projection, translating by integer screen pixels is
   * rasterization-identical (the cornerstone), so the rendered outline
   * is pixel-stable across all snap cells regardless of granularity.
   *
   * The staircase *trajectory* of a moving box (the iso 2:1 walk you
   * see when moving diagonally) is shaped by how the input system feeds
   * deltas into the (a, b) basis, NOT by snap granularity: see
   * `createPlayerInputSystem` for the iso 2:1 input mapping.
   *
   * `granularity` is retained as an escape hatch for tools that want to
   * pin objects to coarser cells; the game render path should keep the
   * default.
   */
  snapWorldPointOnGround(
    world: THREE.Vector3,
    out: THREE.Vector3,
    mode: PixelSnapMode = "nearest",
    granularity: { a: number; b: number } = { a: 1, b: 1 }
  ): boolean {
    return this.pane.snapWorldPointOnGround(world, out, mode, granularity);
  }

  /**
   * Returns the current screen-pixel basis on the ground plane (center +
   * u (one screen-pixel right in world XZ) + v (one screen-pixel down in
   * world XZ)) — the basis used by {@link snapWorldPointOnGround}. Null
   * in side mode. Diagnostic / test surface; the game render path uses
   * `snapWorldPointOnGround` instead.
   */
  getSnapBasis(): {
    centerX: number;
    centerZ: number;
    ux: number;
    uz: number;
    vx: number;
    vz: number;
  } | null {
    return this.pane.getSnapBasis();
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.stage.stop();
    this.lighting?.remove();
    // The outline pipeline is owned by the pane; stage.dispose() disposes panes.
    this.stage.dispose();
  }

  private toLocalCss(clientX: number, clientY: number): { x: number; y: number } | null {
    const rect = this.mount.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) {
      return null;
    }
    return {
      x: clientX - rect.left,
      y: clientY - rect.top
    };
  }
}
