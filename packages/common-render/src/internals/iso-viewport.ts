import * as THREE from "three";
import { IsoCamera } from "./iso-camera";
import { LowResolutionTarget } from "./low-resolution-target";
import type { SetLowTargetOptions } from "./low-resolution-target";
import { PixelPerfectController } from "./pixel-perfect-controller";
import {
  resolvePixelPerfectTuning,
  type IsoGameViewPose,
  type IsoGameViewState,
  type IsoViewportInput,
  type IsoViewportResolved,
  type PixelSnapMode
} from "../pixel-perfect-types";
import { RotationAnimation, ZoomAnimation } from "./viewport-animation";

export type PixelPerfectRenderViewport = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type IsoViewportVisualState = {
  targetX: number;
  targetY: number;
  targetZ: number;
  yawIndex: number;
  animatedYawTurns: number;
  zoomTarget: number;
  zoomCurrent: number;
  zoomPivotSceneX: number;
  zoomPivotSceneY: number;
  panDeviceCarryX: number;
  panDeviceCarryY: number;
  panDeviceRemainderX: number;
  panDeviceRemainderY: number;
};

/**
 * Thin composer that orchestrates the four collaborators that actually do the
 * work of a pixel-perfect iso viewport:
 * - {@link IsoCamera} — ortho camera + pose + screen↔world basis
 * - {@link LowResolutionTarget} — the low-res RT + the upscale quad
 * - {@link PixelPerfectController} — pan/zoom/pixel-scale quantization
 * - {@link RotationAnimation}/{@link ZoomAnimation} — easing state for the
 *   animated yaw/zoom transitions
 *
 * The core itself is responsible for: pan quantization (converting CSS deltas
 * into camera-target steps), zoom anchoring (keeping the world point under the
 * cursor fixed), and render orchestration.
 */
export class IsoViewport {
  readonly camera: THREE.OrthographicCamera;
  readonly cameraTarget: THREE.Vector3;

  private readonly config: IsoViewportResolved;
  private readonly scene: THREE.Scene;
  private readonly controller: PixelPerfectController;
  private readonly isoCamera: IsoCamera;
  private readonly lowRes: LowResolutionTarget;
  private readonly rotation: RotationAnimation;
  private readonly zoom: ZoomAnimation;

  private readonly projectedNdc = new THREE.Vector3();
  private readonly projectedClient = new THREE.Vector2();
  private readonly dragDelta = new THREE.Vector2();
  private readonly zoomScenePoint = new THREE.Vector2();
  private readonly previousZoomPivot = new THREE.Vector2();
  private readonly zoomBeforeWorld = new THREE.Vector3();
  private readonly zoomPivotScene = new THREE.Vector2(0.5, 0.5);

  private viewportWidth: number;
  private viewportHeight: number;
  private dragActive = false;
  private lastClientX = 0;
  private lastClientY = 0;
  private pointerClientX = Number.NaN;
  private pointerClientY = Number.NaN;

  private panDeviceCarryX = 0;
  private panDeviceCarryY = 0;
  private panDeviceRemainderX = 0;
  private panDeviceRemainderY = 0;
  private cssToDeviceX = 1;
  private cssToDeviceY = 1;

  private readonly baseDisplayRenderScale: number;

  /**
   * Optional callback invoked right before the scene is rendered to
   * lowTarget. Use this to flip per-pane renderer state — e.g. toggle
   * `toneMapping` / `toneMappingExposure` so one pane runs ACES while
   * another stays in `NoToneMapping`. Pair with `afterSceneRender` to
   * restore state and keep the stage renderer otherwise shared.
   */
  beforeSceneRender:
    | ((renderer: THREE.WebGLRenderer, lowTarget: THREE.WebGLRenderTarget) => void)
    | null = null;

  /**
   * Optional callback invoked after the scene is rendered to lowTarget
   * but before the output upscale quad is drawn. Use this to run
   * post-process AA passes (FXAA, SMAA) on the low-res image.
   */
  afterSceneRender:
    | ((renderer: THREE.WebGLRenderer, lowTarget: THREE.WebGLRenderTarget) => void)
    | null = null;

  constructor(input: IsoViewportInput) {
    const resolved: IsoViewportResolved = {
      ...resolvePixelPerfectTuning(input),
      width: input.width,
      height: input.height,
      scene: input.scene,
      clearColor: input.clearColor,
      clearAlpha: input.clearAlpha,
      maxBackingWidth: input.maxBackingWidth,
      maxBackingHeight: input.maxBackingHeight,
      devicePixelRatio: input.devicePixelRatio
    };
    this.config = resolved;
    this.scene = resolved.scene;
    this.viewportWidth = Math.max(1, resolved.width);
    this.viewportHeight = Math.max(1, resolved.height);

    this.isoCamera = new IsoCamera({
      viewMode: resolved.cameraPitch,
      cameraYaw: resolved.cameraYaw,
      cameraDistance: resolved.cameraDistance
    });
    this.camera = this.isoCamera.camera;
    this.cameraTarget = this.isoCamera.cameraTarget;

    this.lowRes = new LowResolutionTarget({
      lowTargetSamples: resolved.lowTargetSamples,
      smoothPixelTransitions: resolved.smoothPixelTransitions,
      outputOverscanLowPixels: resolved.outputOverscanLowPixels
    });

    this.rotation = new RotationAnimation();
    this.zoom = new ZoomAnimation(
      {
        min: resolved.zoomMin,
        max: resolved.zoomMax,
        baseRate: resolved.zoomAnimationRate,
        burstRate: resolved.zoomAnimationBurstRate,
        epsilon: resolved.zoomAnimationEpsilon
      },
      1
    );

    this.controller = new PixelPerfectController({
      minZoom: resolved.zoomMin,
      maxZoom: resolved.zoomMax,
      initialZoom: resolved.basePixelZoom,
      initialZoomMode: "free",
      overscanLowPixels: resolved.outputOverscanLowPixels,
      baseOrthoHeight: resolved.baseOrthoHeight,
      referenceLowHeight: resolved.fixedRenderHeight,
      maxBackingWidth: Math.max(1, Math.floor(resolved.maxBackingWidth)),
      maxBackingHeight: Math.max(1, Math.floor(resolved.maxBackingHeight)),
      viewportCssWidth: this.viewportWidth,
      viewportCssHeight: this.viewportHeight,
      devicePixelRatio: Math.max(1, (resolved.devicePixelRatio ?? window.devicePixelRatio) || 1)
    });

    const initialState = this.controller.getState();
    this.baseDisplayRenderScale = initialState.renderScale;
    this.rotation.resetTo(this.controller.getYawIndex());
    this.lowRes.updateDisplayLayout(this.controller.getState(), this.baseDisplayRenderScale);
    this.applyControllerState();
    this.resize(this.viewportWidth, this.viewportHeight, resolved.devicePixelRatio);
  }

  getState(): IsoGameViewState {
    const state = this.controller.getState();
    return {
      cameraZoomCurrent: this.zoom.current,
      cameraZoomTarget: this.zoom.target,
      zoomAnimationActive: this.zoom.active,
      zoomBurstActive: this.zoom.burstActive,
      controllerRenderScale: state.renderScale,
      baseRenderScale: this.lowRes.baseRenderScale,
      lowRenderWidth: state.lowRenderWidth,
      lowRenderHeight: state.lowRenderHeight,
      sceneOutputWidth: this.lowRes.sceneOutputWidth,
      sceneOutputHeight: this.lowRes.sceneOutputHeight,
      zoomMode: state.zoomMode,
      devicePixelRatio: state.devicePixelRatio
    };
  }

  getViewPose(): IsoGameViewPose {
    return {
      targetX: this.cameraTarget.x,
      targetY: this.cameraTarget.y,
      targetZ: this.cameraTarget.z,
      yawIndex: this.controller.getYawIndex(),
      zoom: this.zoom.target
    };
  }

  getVisualState(): IsoViewportVisualState {
    return {
      targetX: this.cameraTarget.x,
      targetY: this.cameraTarget.y,
      targetZ: this.cameraTarget.z,
      yawIndex: this.controller.getYawIndex(),
      animatedYawTurns: this.rotation.animatedYawTurns,
      zoomTarget: this.zoom.target,
      zoomCurrent: this.zoom.current,
      zoomPivotSceneX: this.zoomPivotScene.x,
      zoomPivotSceneY: this.zoomPivotScene.y,
      panDeviceCarryX: this.panDeviceCarryX,
      panDeviceCarryY: this.panDeviceCarryY,
      panDeviceRemainderX: this.panDeviceRemainderX,
      panDeviceRemainderY: this.panDeviceRemainderY
    };
  }

  setVisualState(state: IsoViewportVisualState): void {
    this.setViewPose({
      targetX: state.targetX,
      targetY: state.targetY,
      targetZ: state.targetZ,
      yawIndex: state.yawIndex,
      zoom: state.zoomTarget
    });
    // Visual state is the full snapshot, so honor a non-finite targetY here as
    // an explicit "no change" rather than clamping. setViewPose() already
    // handles the side-mode pass-through; the non-side modes write 0.
    if (this.isoCamera.viewMode === "side" && Number.isFinite(state.targetY)) {
      this.cameraTarget.y = state.targetY;
    }

    this.rotation.resetTo(
      Number.isFinite(state.animatedYawTurns)
        ? state.animatedYawTurns
        : this.controller.getYawIndex()
    );

    const nextZoomTarget = this.quantizeZoom(
      THREE.MathUtils.clamp(
        Number.isFinite(state.zoomTarget) ? state.zoomTarget : this.zoom.target,
        this.config.zoomMin,
        this.config.zoomMax
      )
    );
    const nextZoomCurrent = THREE.MathUtils.clamp(
      Number.isFinite(state.zoomCurrent) ? state.zoomCurrent : nextZoomTarget,
      this.config.zoomMin,
      this.config.zoomMax
    );
    this.zoom.snapTo(nextZoomCurrent);
    this.zoom.setTarget(nextZoomTarget);

    this.zoomPivotScene.set(
      THREE.MathUtils.clamp(
        Number.isFinite(state.zoomPivotSceneX) ? state.zoomPivotSceneX : 0.5,
        0,
        1
      ),
      THREE.MathUtils.clamp(
        Number.isFinite(state.zoomPivotSceneY) ? state.zoomPivotSceneY : 0.5,
        0,
        1
      )
    );

    this.panDeviceCarryX = Number.isFinite(state.panDeviceCarryX) ? state.panDeviceCarryX : 0;
    this.panDeviceCarryY = Number.isFinite(state.panDeviceCarryY) ? state.panDeviceCarryY : 0;
    this.panDeviceRemainderX = Number.isFinite(state.panDeviceRemainderX)
      ? state.panDeviceRemainderX
      : 0;
    this.panDeviceRemainderY = Number.isFinite(state.panDeviceRemainderY)
      ? state.panDeviceRemainderY
      : 0;

    this.updateCameraProjection();
    this.lowRes.setZoomUniforms(this.zoom.stable, this.zoomPivotScene.x, 1 - this.zoomPivotScene.y);
    this.ensureScreenBasis();
  }

  /** The low-resolution render target the scene is drawn into. */
  getLowTarget(): THREE.WebGLRenderTarget {
    return this.lowRes.getLowTarget();
  }

  /** Replace the low-res render target (e.g. to change MSAA sample count). */
  setLowTarget(target: THREE.WebGLRenderTarget, options?: SetLowTargetOptions): void {
    const state = this.controller.getState();
    this.lowRes.setLowTarget(
      target,
      state.lowRenderWidth,
      state.lowRenderHeight,
      options
    );
  }

  /** Override the texture the output upscale quad reads from.
   *  Pass null to revert to the default lowTarget texture. */
  setOutputSourceTexture(texture: THREE.Texture | null): void {
    this.lowRes.setOutputSourceTexture(texture);
  }

  setViewPose(pose: IsoGameViewPose): void {
    if (Number.isFinite(pose.targetX)) {
      this.cameraTarget.x = pose.targetX;
    }
    if (Number.isFinite(pose.targetZ)) {
      this.cameraTarget.z = pose.targetZ;
    }
    // `side` view pans along world Y, so the target's Y component is part of
    // its state and must not be clamped. The other modes lock the target onto
    // the ground plane (Y=0) so the snap helpers stay coherent.
    if (this.isoCamera.viewMode === "side") {
      if (pose.targetY !== undefined && Number.isFinite(pose.targetY)) {
        this.cameraTarget.y = pose.targetY;
      }
    } else {
      this.cameraTarget.y = 0;
    }

    const targetYaw = Math.round(pose.yawIndex);
    this.controller.setYawIndex(targetYaw);
    this.rotation.resetTo(this.controller.getYawIndex());

    const nextZoom = this.quantizeZoom(
      THREE.MathUtils.clamp(
        Number.isFinite(pose.zoom) ? pose.zoom : this.zoom.target,
        this.config.zoomMin,
        this.config.zoomMax
      )
    );
    this.zoom.snapTo(nextZoom);

    this.updateCameraProjection();
    this.lowRes.setZoomUniforms(this.zoom.stable, this.zoomPivotScene.x, 1 - this.zoomPivotScene.y);
    this.ensureScreenBasis();
  }

  getYawIndex(): number {
    return this.controller.getYawIndex();
  }

  rotateQuarterTurns(delta: -1 | 1): void {
    this.zoom.cancelBurst();
    this.rotation.cancelSnap();
    this.recenterCameraTargetToScreenCenterIfNeeded();
    this.controller.rotateQuarterTurns(delta);
  }

  panByCss(dx: number, dy: number): void {
    this.applyPan(dx, dy);
  }

  stepCameraZoom(direction: -1 | 1): void {
    const raw = THREE.MathUtils.clamp(
      this.zoom.target + direction * this.config.zoomStep,
      this.config.zoomMin,
      this.config.zoomMax
    );
    const nextZoom = this.quantizeZoom(raw);
    if (Math.abs(nextZoom - this.zoom.target) <= 1e-6) {
      return;
    }
    this.zoom.setTarget(nextZoom);
  }

  reset(): void {
    this.controller.resetView(this.config.basePixelZoom, "free");
    this.rotation.resetTo(this.controller.getYawIndex());
    this.cameraTarget.set(0, 0, 0);
    this.zoom.snapTo(1);
    this.zoomPivotScene.set(0.5, 0.5);
    this.panDeviceCarryX = 0;
    this.panDeviceCarryY = 0;
    this.panDeviceRemainderX = 0;
    this.panDeviceRemainderY = 0;
    this.applyControllerState();
  }

  resize(
    nextWidth: number,
    nextHeight: number,
    nextDevicePixelRatio?: number,
    exactDeviceWidth?: number,
    exactDeviceHeight?: number
  ): void {
    const previousDpr = this.controller.getState().devicePixelRatio;
    this.viewportWidth = Math.max(1, nextWidth);
    this.viewportHeight = Math.max(1, nextHeight);
    this.controller.resize(
      this.viewportWidth,
      this.viewportHeight,
      Math.max(1, (nextDevicePixelRatio ?? window.devicePixelRatio) || 1),
      exactDeviceWidth,
      exactDeviceHeight
    );
    const nextDpr = this.controller.getState().devicePixelRatio;
    if (Math.abs(nextDpr - previousDpr) > 1e-9) {
      const ratio = nextDpr / previousDpr;
      this.panDeviceCarryX *= ratio;
      this.panDeviceCarryY *= ratio;
      this.panDeviceRemainderX = Math.trunc(this.panDeviceRemainderX * ratio);
      this.panDeviceRemainderY = Math.trunc(this.panDeviceRemainderY * ratio);
    }
    const state = this.controller.getState();
    this.cssToDeviceX = state.viewportCssWidth > 0 ? state.viewportDeviceWidth / state.viewportCssWidth : 1;
    this.cssToDeviceY = state.viewportCssHeight > 0 ? state.viewportDeviceHeight / state.viewportCssHeight : 1;
    this.applyControllerState();
  }

  renderToRenderer(
    renderer: THREE.WebGLRenderer,
    viewport: PixelPerfectRenderViewport,
    nowMs: number,
    deltaSeconds: number,
    clipViewport?: PixelPerfectRenderViewport
  ): void {
    const paneViewport = viewport;
    const scissorViewport = clipViewport ?? paneViewport;
    this.updateAnimationState(deltaSeconds);
    this.zoom.tickBurstExpiry(nowMs);
    this.ensureScreenBasis();

    const lowTarget = this.lowRes.getLowTarget();
    const previousScissorTest = renderer.getScissorTest();
    renderer.setRenderTarget(lowTarget);
    renderer.setScissorTest(false);
    renderer.setViewport(0, 0, lowTarget.width, lowTarget.height);
    renderer.setScissor(0, 0, lowTarget.width, lowTarget.height);
    renderer.clear();

    if (this.beforeSceneRender) {
      this.beforeSceneRender(renderer, lowTarget);
    }

    renderer.render(this.scene, this.camera);

    if (this.afterSceneRender) {
      this.afterSceneRender(renderer, lowTarget);
    }

    renderer.setRenderTarget(null);
    renderer.setScissorTest(previousScissorTest);

    renderer.setScissor(
      scissorViewport.x,
      scissorViewport.y,
      scissorViewport.width,
      scissorViewport.height
    );
    renderer.setViewport(paneViewport.x, paneViewport.y, paneViewport.width, paneViewport.height);
    renderer.setClearColor(this.config.clearColor ?? 0x0b0f14, this.config.clearAlpha ?? 1);
    renderer.clear(true, true, true);

    const viewportWidth = Math.max(1, Math.round(this.lowRes.outputWidth));
    const viewportHeight = Math.max(1, Math.round(this.lowRes.outputHeight));
    const renderLeft = paneViewport.x + this.getRenderStartX();
    const renderTop = this.getRenderStartY();
    // Allow negative local viewport offsets so subpixel pan remainders can move the
    // overscanned output smoothly inside the scissor rect (matches IsoGameView).
    const renderBottom = paneViewport.y + (paneViewport.height - (renderTop + viewportHeight));
    this.lowRes.renderUpscaleQuad(renderer, renderLeft, renderBottom, viewportWidth, viewportHeight);
    renderer.setViewport(paneViewport.x, paneViewport.y, paneViewport.width, paneViewport.height);
  }

  worldAtLocalCss(localCssX: number, localCssY: number, out: THREE.Vector3): boolean {
    const deviceX = localCssX * this.cssToDeviceX;
    const deviceY = localCssY * this.cssToDeviceY;
    const renderStartX = this.getRenderStartX();
    const renderStartY = this.getRenderStartY();
    const localRenderX = deviceX - (renderStartX + this.lowRes.outputPadDeviceX);
    const localRenderY = deviceY - (renderStartY + this.lowRes.outputPadDeviceY);
    if (
      localRenderX < 0 ||
      localRenderY < 0 ||
      localRenderX > this.lowRes.sceneOutputWidth ||
      localRenderY > this.lowRes.sceneOutputHeight
    ) {
      return false;
    }
    const scenePointX = localRenderX / this.lowRes.sceneOutputWidth;
    const scenePointY = localRenderY / this.lowRes.sceneOutputHeight;
    const shaderZoom = Math.max(1, this.zoom.stable);
    const sourceX =
      (scenePointX - this.zoomPivotScene.x) / shaderZoom + this.zoomPivotScene.x;
    const sourceY =
      (scenePointY - this.zoomPivotScene.y) / shaderZoom + this.zoomPivotScene.y;
    if (sourceX < 0 || sourceY < 0 || sourceX > 1 || sourceY > 1) {
      return false;
    }
    return this.isoCamera.worldAtNdc(sourceX * 2 - 1, -(sourceY * 2 - 1), out);
  }

  projectWorldToLocalCss(world: THREE.Vector3, out: THREE.Vector2): boolean {
    this.projectedNdc.copy(world).project(this.camera);
    const sourceX = this.projectedNdc.x * 0.5 + 0.5;
    const sourceY = 1 - (this.projectedNdc.y * 0.5 + 0.5);
    const shaderZoom = Math.max(1, this.zoom.stable);
    const normalizedX =
      (sourceX - this.zoomPivotScene.x) * shaderZoom + this.zoomPivotScene.x;
    const normalizedY =
      (sourceY - this.zoomPivotScene.y) * shaderZoom + this.zoomPivotScene.y;
    const deviceX =
      this.getRenderStartX() +
      this.lowRes.outputPadDeviceX +
      normalizedX * this.lowRes.sceneOutputWidth;
    const deviceY =
      this.getRenderStartY() +
      this.lowRes.outputPadDeviceY +
      normalizedY * this.lowRes.sceneOutputHeight;
    out.set(
      deviceX / this.cssToDeviceX,
      deviceY / this.cssToDeviceY
    );
    return true;
  }

  snapWorldPointOnGround(
    world: THREE.Vector3,
    out: THREE.Vector3,
    mode: PixelSnapMode = "nearest"
  ): boolean {
    this.ensureScreenBasis();
    return this.isoCamera.snapWorldPointOnGround(world, out, mode);
  }

  dispose(): void {
    this.lowRes.dispose();
  }

  private applyControllerState(): void {
    const state = this.controller.getState();
    this.lowRes.applyControllerState(state, this.baseDisplayRenderScale);
  }

  private updateCameraProjection(): void {
    const state = this.controller.getState();
    const aspect = state.lowRenderWidth / state.lowRenderHeight;
    // When zoom < 1, expand the frustum so the camera captures more world.
    // Shader zoom only handles magnification (zoom >= 1).
    this.isoCamera.applyProjection({
      orthoHeight: state.orthoHeight,
      aspect,
      zoomOutFactor: Math.min(1, this.zoom.stable),
      verticalBias: this.config.verticalBias
    });
  }

  private ensureScreenBasis(): void {
    this.isoCamera.applyPoseFromTarget(this.rotation.animatedYawTurns);
    const state = this.controller.getState();
    this.isoCamera.updateScreenToWorld(state.lowRenderWidth, state.lowRenderHeight);
  }

  private updateAnimationState(deltaSeconds: number): void {
    this.rotation.advance(
      this.controller.getYawIndex(),
      deltaSeconds,
      this.config.rotationAnimationRate,
      this.config.rotationAnimationEpsilon
    );
    this.zoom.advance(deltaSeconds);

    this.updateCameraProjection();
    this.lowRes.setZoomUniforms(this.zoom.stable, this.zoomPivotScene.x, 1 - this.zoomPivotScene.y);
    this.lowRes.updateDisplayLayout(this.controller.getState(), this.baseDisplayRenderScale);
  }

  private applyPanRawCss(deltaCssX: number, deltaCssY: number): void {
    this.ensureScreenBasis();
    const fallbackScale = this.controller.getState().devicePixelRatio;
    const cssToDeviceX = this.cssToDeviceX || fallbackScale;
    const cssToDeviceY = this.cssToDeviceY || fallbackScale;
    const deltaDeviceX = deltaCssX * cssToDeviceX + this.panDeviceCarryX;
    const deltaDeviceY = deltaCssY * cssToDeviceY + this.panDeviceCarryY;
    const wholeDeviceX = Math.trunc(deltaDeviceX);
    const wholeDeviceY = Math.trunc(deltaDeviceY);
    this.panDeviceCarryX = deltaDeviceX - wholeDeviceX;
    this.panDeviceCarryY = deltaDeviceY - wholeDeviceY;

    this.panDeviceRemainderX += wholeDeviceX;
    this.panDeviceRemainderY += wholeDeviceY;

    const cameraStepQuantum = Math.max(
      1,
      this.controller.getState().renderScale * Math.max(1, this.zoom.stable)
    );
    const cameraStepX = Math.trunc(this.panDeviceRemainderX / cameraStepQuantum);
    const cameraStepY = Math.trunc(this.panDeviceRemainderY / cameraStepQuantum);
    this.panDeviceRemainderX -= cameraStepX * cameraStepQuantum;
    this.panDeviceRemainderY -= cameraStepY * cameraStepQuantum;

    if (cameraStepX !== 0) {
      this.cameraTarget.addScaledVector(this.isoCamera.screenRightWorld, -cameraStepX);
    }
    if (cameraStepY !== 0) {
      this.cameraTarget.addScaledVector(this.isoCamera.screenDownWorld, -cameraStepY);
    }
  }

  private applyPan(deltaCssX: number, deltaCssY: number): void {
    this.applyPanRawCss(deltaCssX, deltaCssY);
  }

  private recenterCameraTargetToScreenCenterIfNeeded(): void {
    if (
      Math.abs(this.zoomPivotScene.x - 0.5) <= 1e-6 &&
      Math.abs(this.zoomPivotScene.y - 0.5) <= 1e-6
    ) {
      return;
    }
    const centerLocalX = this.viewportWidth * 0.5;
    const centerLocalY = this.viewportHeight * 0.5;
    if (this.worldAtLocalCss(centerLocalX, centerLocalY, this.zoomBeforeWorld)) {
      this.zoomPivotScene.set(0.5, 0.5);
      this.cameraTarget.x = this.zoomBeforeWorld.x;
      this.cameraTarget.z = this.zoomBeforeWorld.z;
      this.cameraTarget.y = 0;
      this.ensureScreenBasis();
    }
  }

  private scenePointAtLocalCss(localX: number, localY: number, out: THREE.Vector2): boolean {
    const deviceX = localX * this.cssToDeviceX;
    const deviceY = localY * this.cssToDeviceY;
    const renderStartX = this.getRenderStartX();
    const renderStartY = this.getRenderStartY();
    const localRenderX = deviceX - (renderStartX + this.lowRes.outputPadDeviceX);
    const localRenderY = deviceY - (renderStartY + this.lowRes.outputPadDeviceY);
    if (
      localRenderX < 0 ||
      localRenderY < 0 ||
      localRenderX > this.lowRes.sceneOutputWidth ||
      localRenderY > this.lowRes.sceneOutputHeight
    ) {
      return false;
    }
    out.set(
      localRenderX / this.lowRes.sceneOutputWidth,
      localRenderY / this.lowRes.sceneOutputHeight
    );
    return true;
  }

  /**
   * Snap a zoom level so that `baseRenderScale * zoom` is an integer,
   * guaranteeing every texel maps to the same number of device pixels.
   * Below zoom 1 the shader doesn't magnify, so no snap is needed.
   */
  private quantizeZoom(zoom: number): number {
    if (zoom < 1) {
      return zoom;
    }
    const quantum = 1 / Math.max(1, this.lowRes.baseRenderScale);
    return Math.max(1, Math.round(zoom / quantum) * quantum);
  }

  beginPanDrag(localCssX: number, localCssY: number): void {
    this.pointerClientX = localCssX;
    this.pointerClientY = localCssY;
    this.dragActive = true;
    this.lastClientX = localCssX;
    this.lastClientY = localCssY;
    this.zoom.cancelBurst();
  }

  updatePanDrag(localCssX: number, localCssY: number): boolean {
    this.pointerClientX = localCssX;
    this.pointerClientY = localCssY;
    if (!this.dragActive) {
      return false;
    }
    this.dragDelta.set(localCssX - this.lastClientX, localCssY - this.lastClientY);
    this.lastClientX = localCssX;
    this.lastClientY = localCssY;
    this.applyPan(this.dragDelta.x, this.dragDelta.y);
    return true;
  }

  endPanDrag(): boolean {
    if (!this.dragActive) {
      return false;
    }
    this.dragActive = false;
    return true;
  }

  toggleZoomMode(): void {
    this.controller.toggleZoomMode();
    this.applyControllerState();
  }

  zoomStepAtLocalCss(
    direction: -1 | 1,
    localCssX: number,
    localCssY: number,
    nowMs: number = performance.now()
  ): boolean {
    const raw = THREE.MathUtils.clamp(
      this.zoom.target + direction * this.config.zoomStep,
      this.config.zoomMin,
      this.config.zoomMax
    );
    const nextZoom = this.quantizeZoom(raw);
    if (Math.abs(nextZoom - this.zoom.target) <= 1e-6) {
      return false;
    }

    this.zoom.startBurst(nowMs + this.config.zoomBurstIdleMs);
    this.pointerClientX = localCssX;
    this.pointerClientY = localCssY;
    const hadAnchorWorld = this.worldAtLocalCss(
      this.pointerClientX,
      this.pointerClientY,
      this.zoomBeforeWorld
    );
    if (this.scenePointAtLocalCss(this.pointerClientX, this.pointerClientY, this.zoomScenePoint)) {
      this.previousZoomPivot.copy(this.zoomPivotScene);
      this.zoomPivotScene.copy(this.zoomScenePoint);
      if (
        hadAnchorWorld &&
        (Math.abs(this.zoomPivotScene.x - this.previousZoomPivot.x) > 1e-6 ||
          Math.abs(this.zoomPivotScene.y - this.previousZoomPivot.y) > 1e-6)
      ) {
        this.ensureScreenBasis();
        if (this.projectWorldToLocalCss(this.zoomBeforeWorld, this.projectedClient)) {
          const correctionX = this.pointerClientX - this.projectedClient.x;
          const correctionY = this.pointerClientY - this.projectedClient.y;
          if (Math.abs(correctionX) > 0.01 || Math.abs(correctionY) > 0.01) {
            this.applyPan(correctionX, correctionY);
            this.ensureScreenBasis();
          }
        }
      }
    }

    this.zoom.setTarget(nextZoom);
    return true;
  }

  isDragging(): boolean {
    return this.dragActive;
  }

  private getRenderStartX(): number {
    const state = this.controller.getState();
    return Math.round(
      this.lowRes.renderBaseX + state.panRemainderX + this.panDeviceRemainderX
    );
  }

  private getRenderStartY(): number {
    const state = this.controller.getState();
    return Math.round(
      this.lowRes.renderBaseY + state.panRemainderY + this.panDeviceRemainderY
    );
  }
}
