import * as THREE from "three";
import { OutputUpscaleMaterial } from "./output-upscale-material";
import { PixelPerfectController } from "./pixel-perfect-controller";
import {
  pitchForPixelView,
  resolvePixelPerfectTuning,
  type PixelPerfectViewPose,
  type PixelPerfectViewState,
  type PixelPerfectViewportCoreInput,
  type PixelPerfectViewportCoreResolved,
  type PixelSnapMode,
  type PixelView
} from "./pixel-perfect-types";

/** @deprecated Use {@link PixelPerfectViewportCoreInput} instead. */
export type PixelPerfectViewportCoreConfig = PixelPerfectViewportCoreInput;

export type PixelPerfectRenderViewport = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type PixelPerfectViewportCoreVisualState = {
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

export class PixelPerfectViewportCore {
  private static readonly ROTATION_SNAP_SETTLE_SECONDS = 0.08;

  readonly camera: THREE.OrthographicCamera;
  readonly cameraTarget = new THREE.Vector3(0, 0, 0);

  private readonly config: PixelPerfectViewportCoreResolved;
  private readonly viewMode: PixelView;
  private readonly cameraPitchRadians: number;
  private readonly scene: THREE.Scene;
  private readonly controller: PixelPerfectController;
  private readonly outputScene: THREE.Scene;
  private readonly outputCamera: THREE.OrthographicCamera;
  private readonly outputMaterial: OutputUpscaleMaterial;
  private readonly outputQuad: THREE.Mesh;
  private lowTarget: THREE.WebGLRenderTarget;
  private customOutputSource: THREE.Texture | null = null;
  private readonly raycaster = new THREE.Raycaster();
  private readonly pointerNdc = new THREE.Vector2();
  private readonly projectedNdc = new THREE.Vector3();
  private readonly projectedClient = new THREE.Vector2();
  private readonly centerGround = new THREE.Vector3();
  private readonly rightGround = new THREE.Vector3();
  private readonly downGround = new THREE.Vector3();
  private readonly groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  private readonly screenRightWorld = new THREE.Vector3();
  private readonly screenDownWorld = new THREE.Vector3();
  private readonly cameraDirection = new THREE.Vector3();
  // Scratch space for extracting the camera's local axes when computing the
  // screen-to-world basis without raycasting (used by `side` view mode).
  private readonly cameraBasisRight = new THREE.Vector3();
  private readonly cameraBasisUp = new THREE.Vector3();
  private readonly cameraBasisBack = new THREE.Vector3();
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

  private animatedYawTurns = 0;
  private rotationSnapActive = false;
  private rotationSnapFromTurns = 0;
  private rotationSnapToTurns = 0;
  private rotationSnapElapsedSeconds = 0;
  private zoomAnimationActive = false;
  private zoomBurstActive = false;
  private zoomBurstExpiresAtMs = 0;
  private cameraZoomTarget = 1;
  private cameraZoomCurrent = 1;
  private cameraZoomStable = 1;

  private baseRenderScale = 1;
  private displaySceneOutputWidth = 1;
  private displaySceneOutputHeight = 1;
  private displayOutputWidth = 1;
  private displayOutputHeight = 1;
  private displayOutputPadDeviceX = 0;
  private displayOutputPadDeviceY = 0;
  private displayRenderBaseX = 0;
  private displayRenderBaseY = 0;
  private readonly baseDisplayRenderScale: number;
  private panDeviceCarryX = 0;
  private panDeviceCarryY = 0;
  private panDeviceRemainderX = 0;
  private panDeviceRemainderY = 0;
  private cssToDeviceX = 1;
  private cssToDeviceY = 1;

  constructor(input: PixelPerfectViewportCoreInput) {
    const resolved: PixelPerfectViewportCoreResolved = {
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
    const config = resolved;
    this.config = resolved;
    this.viewMode = config.cameraPitch;
    this.cameraPitchRadians = pitchForPixelView(config.cameraPitch);
    this.scene = config.scene;
    this.viewportWidth = Math.max(1, config.width);
    this.viewportHeight = Math.max(1, config.height);

    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 200);

    this.lowTarget = new THREE.WebGLRenderTarget(1, 1, {
      minFilter: THREE.NearestFilter,
      magFilter: THREE.LinearFilter,
      format: THREE.RGBAFormat,
      stencilBuffer: false,
      samples: config.lowTargetSamples
    });
    this.lowTarget.texture.generateMipmaps = false;

    this.outputScene = new THREE.Scene();
    this.outputCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this.outputMaterial = new OutputUpscaleMaterial({
      source: this.lowTarget.texture,
      smoothPixelTransitions: config.smoothPixelTransitions
    });
    this.outputQuad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.outputMaterial);
    this.outputQuad.frustumCulled = false;
    this.outputScene.add(this.outputQuad);

    this.controller = new PixelPerfectController({
      minZoom: 1,
      maxZoom: 20,
      initialZoom: config.basePixelZoom,
      initialZoomMode: "free",
      overscanLowPixels: config.outputOverscanLowPixels,
      baseOrthoHeight: config.baseOrthoHeight,
      referenceLowHeight: config.fixedRenderHeight,
      maxBackingWidth: Math.max(1, Math.floor(config.maxBackingWidth)),
      maxBackingHeight: Math.max(1, Math.floor(config.maxBackingHeight)),
      viewportCssWidth: this.viewportWidth,
      viewportCssHeight: this.viewportHeight,
      devicePixelRatio: Math.max(1, (config.devicePixelRatio ?? window.devicePixelRatio) || 1)
    });

    const initialState = this.controller.getState();
    this.baseDisplayRenderScale = initialState.renderScale;
    this.animatedYawTurns = this.controller.getYawIndex();
    this.updateDisplayLayout(this.baseDisplayRenderScale);
    this.applyControllerState();
    this.resize(this.viewportWidth, this.viewportHeight, config.devicePixelRatio);
  }

  getState(): PixelPerfectViewState {
    const state = this.controller.getState();
    return {
      cameraZoomCurrent: this.cameraZoomCurrent,
      cameraZoomTarget: this.cameraZoomTarget,
      zoomAnimationActive: this.zoomAnimationActive,
      zoomBurstActive: this.zoomBurstActive,
      controllerRenderScale: state.renderScale,
      baseRenderScale: this.baseRenderScale,
      lowRenderWidth: state.lowRenderWidth,
      lowRenderHeight: state.lowRenderHeight,
      sceneOutputWidth: this.displaySceneOutputWidth,
      sceneOutputHeight: this.displaySceneOutputHeight,
      zoomMode: state.zoomMode,
      devicePixelRatio: state.devicePixelRatio
    };
  }

  getViewPose(): PixelPerfectViewPose {
    return {
      targetX: this.cameraTarget.x,
      targetY: this.cameraTarget.y,
      targetZ: this.cameraTarget.z,
      yawIndex: this.controller.getYawIndex(),
      zoom: this.cameraZoomTarget
    };
  }

  getVisualState(): PixelPerfectViewportCoreVisualState {
    return {
      targetX: this.cameraTarget.x,
      targetY: this.cameraTarget.y,
      targetZ: this.cameraTarget.z,
      yawIndex: this.controller.getYawIndex(),
      animatedYawTurns: this.animatedYawTurns,
      zoomTarget: this.cameraZoomTarget,
      zoomCurrent: this.cameraZoomCurrent,
      zoomPivotSceneX: this.zoomPivotScene.x,
      zoomPivotSceneY: this.zoomPivotScene.y,
      panDeviceCarryX: this.panDeviceCarryX,
      panDeviceCarryY: this.panDeviceCarryY,
      panDeviceRemainderX: this.panDeviceRemainderX,
      panDeviceRemainderY: this.panDeviceRemainderY
    };
  }

  setVisualState(state: PixelPerfectViewportCoreVisualState): void {
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
    if (this.viewMode === "side" && Number.isFinite(state.targetY)) {
      this.cameraTarget.y = state.targetY;
    }

    this.animatedYawTurns = Number.isFinite(state.animatedYawTurns)
      ? state.animatedYawTurns
      : this.controller.getYawIndex();
    this.rotationSnapActive = false;
    this.rotationSnapFromTurns = this.animatedYawTurns;
    this.rotationSnapToTurns = this.animatedYawTurns;
    this.rotationSnapElapsedSeconds = 0;

    const nextZoomTarget = THREE.MathUtils.clamp(
      Number.isFinite(state.zoomTarget) ? state.zoomTarget : this.cameraZoomTarget,
      this.config.zoomMin,
      this.config.zoomMax
    );
    const nextZoomCurrent = THREE.MathUtils.clamp(
      Number.isFinite(state.zoomCurrent) ? state.zoomCurrent : nextZoomTarget,
      this.config.zoomMin,
      this.config.zoomMax
    );
    this.cameraZoomTarget = this.quantizeZoom(nextZoomTarget);
    this.cameraZoomCurrent = nextZoomCurrent;
    this.cameraZoomStable = nextZoomCurrent;
    this.zoomAnimationActive =
      Math.abs(this.cameraZoomTarget - this.cameraZoomCurrent) > this.config.zoomAnimationEpsilon;
    this.zoomBurstActive = false;

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
    this.outputMaterial.uniforms.uZoom.value = Math.max(1, this.cameraZoomStable);
    this.outputMaterial.uniforms.uEffectiveScale.value =
      this.baseRenderScale * Math.max(1, this.cameraZoomStable);
    (this.outputMaterial.uniforms.uZoomPivot.value as THREE.Vector2).set(
      this.zoomPivotScene.x,
      1 - this.zoomPivotScene.y
    );
    this.ensureScreenBasis();
  }

  /* ---- AA extension points ---- */

  /** The low-resolution render target the scene is drawn into. */
  getLowTarget(): THREE.WebGLRenderTarget {
    return this.lowTarget;
  }

  /** Replace the low-res render target (e.g. to change MSAA sample count). */
  setLowTarget(target: THREE.WebGLRenderTarget): void {
    const old = this.lowTarget;
    this.lowTarget = target;
    // Keep size in sync with controller
    const state = this.controller.getState();
    this.lowTarget.setSize(state.lowRenderWidth, state.lowRenderHeight);
    // Update output source unless a custom source overrides it
    if (!this.customOutputSource) {
      this.outputMaterial.uniforms.uSource.value = this.lowTarget.texture;
    }
    old.dispose();
  }

  /** Override the texture the output upscale quad reads from.
   *  Pass null to revert to the default lowTarget texture. */
  setOutputSourceTexture(texture: THREE.Texture | null): void {
    this.customOutputSource = texture;
    this.outputMaterial.uniforms.uSource.value = texture ?? this.lowTarget.texture;
  }

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

  setViewPose(pose: PixelPerfectViewPose): void {
    if (Number.isFinite(pose.targetX)) {
      this.cameraTarget.x = pose.targetX;
    }
    if (Number.isFinite(pose.targetZ)) {
      this.cameraTarget.z = pose.targetZ;
    }
    // `side` view pans along world Y, so the target's Y component is part of
    // its state and must not be clamped. The other modes lock the target onto
    // the ground plane (Y=0) so the snap helpers stay coherent.
    if (this.viewMode === "side") {
      if (pose.targetY !== undefined && Number.isFinite(pose.targetY)) {
        this.cameraTarget.y = pose.targetY;
      }
    } else {
      this.cameraTarget.y = 0;
    }

    const targetYaw = Math.round(pose.yawIndex);
    this.controller.setYawIndex(targetYaw);

    this.animatedYawTurns = this.controller.getYawIndex();
    this.rotationSnapActive = false;
    this.rotationSnapFromTurns = this.animatedYawTurns;
    this.rotationSnapToTurns = this.animatedYawTurns;
    this.rotationSnapElapsedSeconds = 0;

    const nextZoom = THREE.MathUtils.clamp(
      Number.isFinite(pose.zoom) ? pose.zoom : this.cameraZoomTarget,
      this.config.zoomMin,
      this.config.zoomMax
    );
    this.cameraZoomTarget = this.quantizeZoom(nextZoom);
    this.cameraZoomCurrent = this.cameraZoomTarget;
    this.cameraZoomStable = this.cameraZoomTarget;
    this.zoomAnimationActive = false;
    this.zoomBurstActive = false;

    this.updateCameraProjection();
    this.outputMaterial.uniforms.uZoom.value = Math.max(1, this.cameraZoomStable);
    this.outputMaterial.uniforms.uEffectiveScale.value =
      this.baseRenderScale * Math.max(1, this.cameraZoomStable);
    this.ensureScreenBasis();
  }

  getYawIndex(): number {
    return this.controller.getYawIndex();
  }

  rotateQuarterTurns(delta: -1 | 1): void {
    this.zoomBurstActive = false;
    this.rotationSnapActive = false;
    this.recenterCameraTargetToScreenCenterIfNeeded();
    this.controller.rotateQuarterTurns(delta);
  }

  panByCss(dx: number, dy: number): void {
    this.applyPan(dx, dy);
  }

  stepCameraZoom(direction: -1 | 1): void {
    const raw = THREE.MathUtils.clamp(
      this.cameraZoomTarget + direction * this.config.zoomStep,
      this.config.zoomMin,
      this.config.zoomMax
    );
    const nextZoom = this.quantizeZoom(raw);
    if (Math.abs(nextZoom - this.cameraZoomTarget) <= 1e-6) {
      return;
    }
    this.cameraZoomTarget = nextZoom;
    this.zoomAnimationActive = true;
  }

  reset(): void {
    this.controller.resetView(this.config.basePixelZoom, "free");
    this.animatedYawTurns = this.controller.getYawIndex();
    this.rotationSnapActive = false;
    this.rotationSnapFromTurns = this.animatedYawTurns;
    this.rotationSnapToTurns = this.animatedYawTurns;
    this.rotationSnapElapsedSeconds = 0;
    this.cameraTarget.set(0, 0, 0);
    this.cameraZoomTarget = 1;
    this.cameraZoomCurrent = 1;
    this.cameraZoomStable = 1;
    this.zoomAnimationActive = false;
    this.zoomBurstActive = false;
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
    if (this.zoomBurstActive && nowMs > this.zoomBurstExpiresAtMs) {
      this.zoomBurstActive = false;
    }
    this.ensureScreenBasis();
    const previousScissorTest = renderer.getScissorTest();
    renderer.setRenderTarget(this.lowTarget);
    renderer.setScissorTest(false);
    renderer.setViewport(0, 0, this.lowTarget.width, this.lowTarget.height);
    renderer.setScissor(0, 0, this.lowTarget.width, this.lowTarget.height);
    renderer.clear();

    if (this.beforeSceneRender) {
      this.beforeSceneRender(renderer, this.lowTarget);
    }

    renderer.render(this.scene, this.camera);

    if (this.afterSceneRender) {
      this.afterSceneRender(renderer, this.lowTarget);
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

    const viewportWidth = Math.max(1, Math.round(this.displayOutputWidth));
    const viewportHeight = Math.max(1, Math.round(this.displayOutputHeight));
    const renderLeft = paneViewport.x + this.getRenderStartX();
    const renderTop = this.getRenderStartY();
    // Allow negative local viewport offsets so subpixel pan remainders can move the
    // overscanned output smoothly inside the scissor rect (matches PixelPerfectView).
    const renderBottom = paneViewport.y + (paneViewport.height - (renderTop + viewportHeight));
    renderer.setViewport(renderLeft, renderBottom, viewportWidth, viewportHeight);
    renderer.render(this.outputScene, this.outputCamera);
    renderer.setViewport(paneViewport.x, paneViewport.y, paneViewport.width, paneViewport.height);
  }

  worldAtLocalCss(localCssX: number, localCssY: number, out: THREE.Vector3): boolean {
    const deviceX = localCssX * this.cssToDeviceX;
    const deviceY = localCssY * this.cssToDeviceY;
    const renderStartX = this.getRenderStartX();
    const renderStartY = this.getRenderStartY();
    const localRenderX = deviceX - (renderStartX + this.displayOutputPadDeviceX);
    const localRenderY = deviceY - (renderStartY + this.displayOutputPadDeviceY);
    if (
      localRenderX < 0 ||
      localRenderY < 0 ||
      localRenderX > this.displaySceneOutputWidth ||
      localRenderY > this.displaySceneOutputHeight
    ) {
      return false;
    }
    const scenePointX = localRenderX / this.displaySceneOutputWidth;
    const scenePointY = localRenderY / this.displaySceneOutputHeight;
    const shaderZoom = Math.max(1, this.cameraZoomStable);
    const sourceX =
      (scenePointX - this.zoomPivotScene.x) / shaderZoom + this.zoomPivotScene.x;
    const sourceY =
      (scenePointY - this.zoomPivotScene.y) / shaderZoom + this.zoomPivotScene.y;
    if (sourceX < 0 || sourceY < 0 || sourceX > 1 || sourceY > 1) {
      return false;
    }
    this.pointerNdc.set(sourceX * 2 - 1, -(sourceY * 2 - 1));
    this.raycaster.setFromCamera(this.pointerNdc, this.camera);
    return this.raycaster.ray.intersectPlane(this.groundPlane, out) !== null;
  }

  projectWorldToLocalCss(world: THREE.Vector3, out: THREE.Vector2): boolean {
    this.projectedNdc.copy(world).project(this.camera);
    const sourceX = this.projectedNdc.x * 0.5 + 0.5;
    const sourceY = 1 - (this.projectedNdc.y * 0.5 + 0.5);
    const shaderZoom = Math.max(1, this.cameraZoomStable);
    const normalizedX =
      (sourceX - this.zoomPivotScene.x) * shaderZoom + this.zoomPivotScene.x;
    const normalizedY =
      (sourceY - this.zoomPivotScene.y) * shaderZoom + this.zoomPivotScene.y;
    const deviceX =
      this.getRenderStartX() +
      this.displayOutputPadDeviceX +
      normalizedX * this.displaySceneOutputWidth;
    const deviceY =
      this.getRenderStartY() +
      this.displayOutputPadDeviceY +
      normalizedY * this.displaySceneOutputHeight;
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
    // Snap-on-ground has no meaning for a horizontal camera (the ground plane
    // is parallel to the view direction).
    if (this.viewMode === "side") {
      return false;
    }
    this.ensureScreenBasis();

    const ux = this.screenRightWorld.x;
    const uz = this.screenRightWorld.z;
    const vx = this.screenDownWorld.x;
    const vz = this.screenDownWorld.z;
    const wx = world.x - this.centerGround.x;
    const wz = world.z - this.centerGround.z;
    const det = ux * vz - uz * vx;
    if (Math.abs(det) < 1e-8) {
      return false;
    }

    const a = (wx * vz - wz * vx) / det;
    const b = (wz * ux - wx * uz) / det;
    const qa = this.quantizeSnap(a, mode);
    const qb = this.quantizeSnap(b, mode);

    out.set(
      this.centerGround.x + ux * qa + vx * qb,
      world.y,
      this.centerGround.z + uz * qa + vz * qb
    );
    return true;
  }

  dispose(): void {
    this.lowTarget.dispose();
    this.outputQuad.geometry.dispose();
    this.outputMaterial.dispose();
    this.outputScene.remove(this.outputQuad);
  }

  private applyControllerState(): void {
    const state = this.controller.getState();
    this.lowTarget.setSize(state.lowRenderWidth, state.lowRenderHeight);
    (this.outputMaterial.uniforms.uSourceSize.value as THREE.Vector2).set(
      state.lowRenderWidth,
      state.lowRenderHeight
    );
    (this.outputMaterial.uniforms.uContentScale.value as THREE.Vector2).set(
      state.contentScaleX,
      state.contentScaleY
    );
    (this.outputMaterial.uniforms.uContentOffset.value as THREE.Vector2).set(
      state.contentOffsetX,
      state.contentOffsetY
    );
    this.updateDisplayLayout(this.baseDisplayRenderScale);
  }

  private updateDisplayLayout(scale: number): void {
    const state = this.controller.getState();
    const safeScale = Math.max(1, scale);
    this.baseRenderScale = safeScale;
    this.displaySceneOutputWidth = state.lowRenderWidth * safeScale;
    this.displaySceneOutputHeight = state.lowRenderHeight * safeScale;
    this.displayOutputWidth =
      (state.lowRenderWidth + this.config.outputOverscanLowPixels) * safeScale;
    this.displayOutputHeight =
      (state.lowRenderHeight + this.config.outputOverscanLowPixels) * safeScale;
    this.displayOutputPadDeviceX =
      (this.displayOutputWidth - this.displaySceneOutputWidth) * 0.5;
    this.displayOutputPadDeviceY =
      (this.displayOutputHeight - this.displaySceneOutputHeight) * 0.5;
    this.displayRenderBaseX = Math.floor(
      (state.viewportDeviceWidth - this.displayOutputWidth) * 0.5
    );
    this.displayRenderBaseY = Math.floor(
      (state.viewportDeviceHeight - this.displayOutputHeight) * 0.5
    );
  }

  private updateCameraProjection(): void {
    const state = this.controller.getState();
    const aspect = state.lowRenderWidth / state.lowRenderHeight;
    // When zoom < 1, expand the frustum so the camera captures more world.
    // Shader zoom only handles magnification (zoom >= 1).
    const zoomOutFactor = Math.min(1, this.cameraZoomStable);
    const h = state.orthoHeight / zoomOutFactor;
    const bias = this.config.verticalBias ?? 0.5;
    this.camera.left = -h * 0.5 * aspect;
    this.camera.right = h * 0.5 * aspect;
    this.camera.top = h * (1 - bias);
    this.camera.bottom = -h * bias;
    this.camera.updateProjectionMatrix();
  }

  private setCameraPoseFromTarget(): void {
    const yaw = this.config.cameraYaw + this.animatedYawTurns * (Math.PI * 0.5);
    const horizontal = Math.cos(this.cameraPitchRadians);
    this.cameraDirection.set(
      Math.sin(yaw) * horizontal,
      Math.sin(this.cameraPitchRadians),
      Math.cos(yaw) * horizontal
    );
    this.camera.position.copy(this.cameraTarget).addScaledVector(
      this.cameraDirection,
      this.config.cameraDistance
    );
    this.camera.lookAt(this.cameraTarget);
    this.camera.updateMatrixWorld(true);
  }

  private updateScreenToWorld(): void {
    const state = this.controller.getState();

    if (this.viewMode === "side") {
      // The side view's camera looks horizontally, so the Y=0 ground plane is
      // parallel to the view direction and the raycast approach used by the
      // iso/top-down modes never produces a finite intersection. Derive the
      // screen-to-world basis directly from the camera's local axes — see
      // computeCameraBasisScreenToWorld() for the math.
      this.computeCameraBasisScreenToWorld();
      // Snap helpers reference centerGround as their origin; for side mode the
      // most coherent value is the camera target itself (snap onto ground only
      // makes sense for top-down/iso anyway).
      this.centerGround.copy(this.cameraTarget);
      return;
    }

    const ndcStepX = 2 / state.lowRenderWidth;
    const ndcStepY = 2 / state.lowRenderHeight;

    this.pointerNdc.set(0, 0);
    this.raycaster.setFromCamera(this.pointerNdc, this.camera);
    const hasCenter = this.raycaster.ray.intersectPlane(this.groundPlane, this.centerGround) !== null;
    this.pointerNdc.set(ndcStepX, 0);
    this.raycaster.setFromCamera(this.pointerNdc, this.camera);
    const hasRight = this.raycaster.ray.intersectPlane(this.groundPlane, this.rightGround) !== null;
    this.pointerNdc.set(0, -ndcStepY);
    this.raycaster.setFromCamera(this.pointerNdc, this.camera);
    const hasDown = this.raycaster.ray.intersectPlane(this.groundPlane, this.downGround) !== null;

    if (hasCenter && hasRight && hasDown) {
      this.screenRightWorld.subVectors(this.rightGround, this.centerGround);
      this.screenDownWorld.subVectors(this.downGround, this.centerGround);
      return;
    }

    // Fallback: ground-plane raycast didn't produce a finite basis (e.g. the
    // camera is parallel to the plane). Use the camera-basis derivation, which
    // is universally correct for any orthographic camera.
    this.computeCameraBasisScreenToWorld();
  }

  /**
   * Derive `screenRightWorld` / `screenDownWorld` from the camera's local axes
   * scaled by world units per low-res pixel. Works for any orthographic camera
   * regardless of pitch — used by `side` mode (where the ground-plane raycast
   * is degenerate) and as a universal fallback for the other modes.
   */
  private computeCameraBasisScreenToWorld(): void {
    const state = this.controller.getState();
    this.camera.matrixWorld.extractBasis(
      this.cameraBasisRight,
      this.cameraBasisUp,
      this.cameraBasisBack
    );
    const worldUnitsPerPixelX =
      (this.camera.right - this.camera.left) / Math.max(1, state.lowRenderWidth);
    const worldUnitsPerPixelY =
      (this.camera.top - this.camera.bottom) / Math.max(1, state.lowRenderHeight);
    this.screenRightWorld.copy(this.cameraBasisRight).multiplyScalar(worldUnitsPerPixelX);
    this.screenDownWorld.copy(this.cameraBasisUp).multiplyScalar(-worldUnitsPerPixelY);
  }

  private ensureScreenBasis(): void {
    if (this.viewMode !== "side" && Math.abs(this.cameraTarget.y) > 1e-9) {
      this.cameraTarget.y = 0;
    }
    this.setCameraPoseFromTarget();
    this.updateScreenToWorld();
  }

  private updateAnimationState(deltaSeconds: number): void {
    const targetYawTurns = this.controller.getYawIndex();
    if (this.rotationSnapActive && this.rotationSnapToTurns !== targetYawTurns) {
      this.rotationSnapActive = false;
    }

    if (this.rotationSnapActive) {
      this.rotationSnapElapsedSeconds += Math.max(0, deltaSeconds);
      const duration = PixelPerfectViewportCore.ROTATION_SNAP_SETTLE_SECONDS;
      const tRaw = duration > 0 ? this.rotationSnapElapsedSeconds / duration : 1;
      const t = THREE.MathUtils.clamp(tRaw, 0, 1);
      const easedT = t * t * (3 - 2 * t);
      this.animatedYawTurns = THREE.MathUtils.lerp(
        this.rotationSnapFromTurns,
        this.rotationSnapToTurns,
        easedT
      );
      if (t >= 1) {
        this.animatedYawTurns = this.rotationSnapToTurns;
        this.rotationSnapActive = false;
      }
    } else {
      this.animatedYawTurns = this.easeToward(
        this.animatedYawTurns,
        targetYawTurns,
        this.config.rotationAnimationRate,
        deltaSeconds
      );
      const yawSnapEpsilon = Math.min(this.config.rotationAnimationEpsilon, 1e-5);
      if (Math.abs(this.animatedYawTurns - targetYawTurns) <= yawSnapEpsilon) {
        this.rotationSnapActive = true;
        this.rotationSnapFromTurns = this.animatedYawTurns;
        this.rotationSnapToTurns = targetYawTurns;
        this.rotationSnapElapsedSeconds = 0;
      }
    }

    const zoomRate = this.zoomBurstActive
      ? this.config.zoomAnimationBurstRate
      : this.config.zoomAnimationRate;
    this.cameraZoomCurrent = this.easeToward(
      this.cameraZoomCurrent,
      this.cameraZoomTarget,
      zoomRate,
      deltaSeconds
    );
    if (
      Math.abs(this.cameraZoomCurrent - this.cameraZoomTarget) <=
      this.config.zoomAnimationEpsilon
    ) {
      this.cameraZoomCurrent = this.cameraZoomTarget;
      this.zoomAnimationActive = false;
    } else {
      this.zoomAnimationActive = true;
    }
    this.cameraZoomStable = THREE.MathUtils.clamp(
      this.cameraZoomCurrent,
      this.config.zoomMin,
      this.config.zoomMax
    );
    this.updateCameraProjection();
    this.outputMaterial.uniforms.uZoom.value = Math.max(1, this.cameraZoomStable);
    (this.outputMaterial.uniforms.uZoomPivot.value as THREE.Vector2).set(
      this.zoomPivotScene.x,
      1 - this.zoomPivotScene.y
    );
    this.outputMaterial.uniforms.uEffectiveScale.value =
      this.baseRenderScale * Math.max(1, this.cameraZoomStable);
    this.updateDisplayLayout(this.baseDisplayRenderScale);
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
      this.controller.getState().renderScale * Math.max(1, this.cameraZoomStable)
    );
    const cameraStepX = Math.trunc(this.panDeviceRemainderX / cameraStepQuantum);
    const cameraStepY = Math.trunc(this.panDeviceRemainderY / cameraStepQuantum);
    this.panDeviceRemainderX -= cameraStepX * cameraStepQuantum;
    this.panDeviceRemainderY -= cameraStepY * cameraStepQuantum;

    if (cameraStepX !== 0) {
      this.cameraTarget.addScaledVector(this.screenRightWorld, -cameraStepX);
    }
    if (cameraStepY !== 0) {
      this.cameraTarget.addScaledVector(this.screenDownWorld, -cameraStepY);
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
    const localRenderX = deviceX - (renderStartX + this.displayOutputPadDeviceX);
    const localRenderY = deviceY - (renderStartY + this.displayOutputPadDeviceY);
    if (
      localRenderX < 0 ||
      localRenderY < 0 ||
      localRenderX > this.displaySceneOutputWidth ||
      localRenderY > this.displaySceneOutputHeight
    ) {
      return false;
    }
    out.set(
      localRenderX / this.displaySceneOutputWidth,
      localRenderY / this.displaySceneOutputHeight
    );
    return true;
  }

  private easeToward(current: number, target: number, rate: number, deltaSeconds: number): number {
    if (deltaSeconds <= 0) {
      return current;
    }
    const blend = 1 - Math.exp(-rate * deltaSeconds);
    return current + (target - current) * blend;
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
    const quantum = 1 / Math.max(1, this.baseRenderScale);
    return Math.max(1, Math.round(zoom / quantum) * quantum);
  }

  private quantizeSnap(value: number, mode: PixelSnapMode): number {
    switch (mode) {
      case "floor":
        return Math.floor(value);
      case "ceil":
        return Math.ceil(value);
      case "nearest":
      default:
        return Math.round(value);
    }
  }

  beginPanDrag(localCssX: number, localCssY: number): void {
    this.pointerClientX = localCssX;
    this.pointerClientY = localCssY;
    this.dragActive = true;
    this.lastClientX = localCssX;
    this.lastClientY = localCssY;
    this.zoomBurstActive = false;
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
      this.cameraZoomTarget + direction * this.config.zoomStep,
      this.config.zoomMin,
      this.config.zoomMax
    );
    const nextZoom = this.quantizeZoom(raw);
    if (Math.abs(nextZoom - this.cameraZoomTarget) <= 1e-6) {
      return false;
    }

    this.zoomBurstActive = true;
    this.zoomBurstExpiresAtMs = nowMs + this.config.zoomBurstIdleMs;
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

    this.cameraZoomTarget = nextZoom;
    this.zoomAnimationActive =
      Math.abs(this.cameraZoomTarget - this.cameraZoomCurrent) >
      this.config.zoomAnimationEpsilon;
    return true;
  }

  isDragging(): boolean {
    return this.dragActive;
  }

  private getRenderStartX(): number {
    const state = this.controller.getState();
    return Math.round(
      this.displayRenderBaseX + state.panRemainderX + this.panDeviceRemainderX
    );
  }

  private getRenderStartY(): number {
    const state = this.controller.getState();
    return Math.round(
      this.displayRenderBaseY + state.panRemainderY + this.panDeviceRemainderY
    );
  }
}
