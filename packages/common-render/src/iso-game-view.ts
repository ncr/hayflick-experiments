import * as THREE from "three";
import { PixelPerfectPane } from "./stage/pixel-perfect-pane";
import { SharedScissorStage } from "./stage/shared-scissor-stage";
import {
  type IsoGameViewConfig as IsoGameViewConfigBase,
  type IsoGameViewPose,
  type IsoGameViewState,
  type PixelSnapMode
} from "./pixel-perfect-types";
import { type OutlinePipeline, type OutlineTuning } from "./outline/outline-pipeline";
import type { MaterialNameGroupMap } from "./presets/outline-groups";

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
   * {@link IsoGameView.reapplyOutlineGroups} for scene-graph rebuilds.
   */
  outlineGroups?: MaterialNameGroupMap;
  /**
   * Extra camera layers to enable (layer 0 is always on). Matches
   * {@link PixelPerfectPaneConfig.layers}.
   */
  layers?: number[];
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

  private readonly mount: HTMLElement;
  private readonly pane: PixelPerfectPane;
  private readonly savedMountBackground: string;
  private readonly savedCanvasBackground: string;
  private readonly projectLocal = new THREE.Vector2();
  private disposed = false;

  constructor(config: IsoGameViewConfig) {
    this.mount = config.mount;
    this.savedMountBackground = this.mount.style.background;

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
    this.savedCanvasBackground = this.stage.canvas.style.background;

    if (config.mountBackground !== undefined) {
      this.mount.style.background = config.mountBackground;
    }
    if (config.canvasBackground !== undefined) {
      this.stage.canvas.style.background = config.canvasBackground;
    }

    // Strip facade-only fields from the pane config so the pane's stage-facing
    // clear path doesn't double-clear with the stage's own clear.
    const {
      mount: _mount,
      scene: _scene,
      width: _w,
      height: _h,
      clearColor: _cc,
      clearAlpha: _ca,
      mountBackground: _mb,
      canvasBackground: _cb,
      ...paneConfig
    } = config;
    this.pane = new PixelPerfectPane({
      stage: this.stage,
      id: SINGLE_PANE_ID,
      element: this.mount,
      scene: config.scene,
      width: config.width,
      height: config.height,
      ...paneConfig,
      // IsoGameView keeps the historical default of outlines-ON. Raw
      // PixelPerfectPane defaults to OFF (explicit opt-in); the facade
      // flips that so `new IsoGameView({...})` ships with outlines.
      outlines: config.outlines ?? true
    });

    this.camera = this.pane.camera;
    this.cameraTarget = this.pane.cameraTarget;
    this.outline = this.pane.outline;
  }

  /**
   * Re-apply the configured outline-group assignment. Call after rebuilding
   * a subtree of the scene so newly-added meshes pick up their outline group.
   * See {@link PixelPerfectPane.reapplyOutlineGroups}.
   */
  reapplyOutlineGroups(
    root?: THREE.Object3D,
    map?: MaterialNameGroupMap
  ): void {
    this.pane.reapplyOutlineGroups(root, map);
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
   * primarily custom antialiasing. See `PixelPerfectPane` for the full
   * rationale; `packages/experiments/src/prop-test-scene/` is the
   * canonical FXAA / SMAA reference.
   */

  /** @advanced See PixelPerfectPane.getLowTarget. */
  getLowTarget(): THREE.WebGLRenderTarget {
    return this.pane.getLowTarget();
  }

  /** @advanced See PixelPerfectPane.setLowTarget. */
  setLowTarget(target: THREE.WebGLRenderTarget): void {
    this.pane.setLowTarget(target);
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

  projectWorldToClient(world: THREE.Vector3, out: THREE.Vector2): boolean {
    const local = this.projectLocal;
    if (!this.pane.projectWorldToLocalCss(world, local)) {
      return false;
    }
    const rect = this.mount.getBoundingClientRect();
    out.set(rect.left + local.x, rect.top + local.y);
    return true;
  }

  snapWorldPointOnGround(
    world: THREE.Vector3,
    out: THREE.Vector3,
    mode: PixelSnapMode = "nearest"
  ): boolean {
    return this.pane.snapWorldPointOnGround(world, out, mode);
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    // The outline pipeline is owned by the pane; stage.dispose() disposes panes.
    this.stage.canvas.style.background = this.savedCanvasBackground;
    this.stage.dispose();
    this.mount.style.background = this.savedMountBackground;
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
