import * as THREE from "three";
import { PixelPerfectController } from "./pixel-perfect-controller";
import { PixelStage } from "./pixel-stage";
import { attachTouchGestures } from "./touch-gestures";

export type PixelPerfectIsoViewConfig = {
  mount: HTMLElement;
  width: number;
  height: number;
  scene: THREE.Scene;
  fixedRenderHeight: number;
  baseOrthoHeight: number;
  cameraDistance: number;
  cameraPitch: number;
  cameraYaw: number;
  basePixelZoom: number;
  zoomMin: number;
  zoomMax: number;
  zoomStep: number;
  zoomAnimationRate: number;
  zoomAnimationBurstRate: number;
  zoomAnimationEpsilon: number;
  rotationAnimationRate: number;
  rotationAnimationEpsilon: number;
  zoomBurstIdleMs: number;
  outputOverscanLowPixels: number;
  clearColor?: number;
  clearAlpha?: number;
  mountBackground?: string;
  canvasBackground?: string;
};

export type PixelPerfectIsoViewState = {
  cameraZoomCurrent: number;
  cameraZoomTarget: number;
  zoomAnimationActive: boolean;
  zoomBurstActive: boolean;
  controllerRenderScale: number;
  displayRenderScale: number;
  lowRenderWidth: number;
  lowRenderHeight: number;
  sceneOutputWidth: number;
  sceneOutputHeight: number;
  zoomMode: "free" | "safe-ladder";
  devicePixelRatio: number;
};

export type PixelSnapMode = "nearest" | "floor" | "ceil";

export class PixelPerfectIsoView {
  readonly stage: PixelStage;
  readonly renderer: THREE.WebGLRenderer;
  readonly camera: THREE.OrthographicCamera;
  readonly cameraTarget = new THREE.Vector3(0, 0, 0);

  private readonly config: PixelPerfectIsoViewConfig;
  private readonly scene: THREE.Scene;
  private readonly controller: PixelPerfectController;
  private readonly outputScene: THREE.Scene;
  private readonly outputCamera: THREE.OrthographicCamera;
  private readonly outputMaterial: THREE.ShaderMaterial;
  private readonly outputQuad: THREE.Mesh;
  private readonly lowTarget: THREE.WebGLRenderTarget;
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
  private readonly dragDelta = new THREE.Vector2();
  private readonly zoomScenePoint = new THREE.Vector2();
  private readonly previousZoomPivot = new THREE.Vector2();
  private readonly zoomBeforeWorld = new THREE.Vector3();
  private readonly zoomPivotScene = new THREE.Vector2(0.5, 0.5);
  private readonly resizeObserver: ResizeObserver;
  private readonly detachTouch: () => void;

  private viewportWidth: number;
  private viewportHeight: number;
  private dragActive = false;
  private lastClientX = 0;
  private lastClientY = 0;
  private pointerClientX = Number.NaN;
  private pointerClientY = Number.NaN;

  private animatedYawTurns = 0;
  private zoomAnimationActive = false;
  private zoomBurstActive = false;
  private zoomBurstExpiresAtMs = 0;
  private cameraZoomTarget = 1;
  private cameraZoomCurrent = 1;
  private cameraZoomStable = 1;

  private displayRenderScale = 1;
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

  constructor(config: PixelPerfectIsoViewConfig) {
    this.config = config;
    this.scene = config.scene;
    this.viewportWidth = Math.max(1, config.width);
    this.viewportHeight = Math.max(1, config.height);

    this.stage = new PixelStage({
      mount: config.mount,
      width: this.viewportWidth,
      height: this.viewportHeight,
      antialias: false,
      pixelRatio: 1,
      clearColor: config.clearColor ?? 0x0b0f14,
      clearAlpha: config.clearAlpha ?? 1,
      mountPosition: "relative",
      mountBackground: config.mountBackground ?? "#0b0f14",
      mountOverflow: "hidden",
      canvasPosition: "absolute",
      canvasLeft: "0px",
      canvasTop: "0px",
      canvasDisplay: "block",
      canvasBackground: config.canvasBackground ?? "#0b0f14",
      canvasImageRendering: "pixelated",
      canvasTransformOrigin: "0 0"
    });
    this.renderer = this.stage.renderer;

    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 200);

    this.lowTarget = new THREE.WebGLRenderTarget(1, 1, {
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
      format: THREE.RGBAFormat,
      stencilBuffer: false
    });
    this.lowTarget.texture.generateMipmaps = false;

    this.outputScene = new THREE.Scene();
    this.outputCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this.outputMaterial = new THREE.ShaderMaterial({
      uniforms: {
        uSource: { value: this.lowTarget.texture },
        uContentScale: { value: new THREE.Vector2(1, 1) },
        uContentOffset: { value: new THREE.Vector2(0, 0) },
        uZoom: { value: 1 },
        uSourceSize: { value: new THREE.Vector2(1, 1) },
        uZoomPivot: { value: new THREE.Vector2(0.5, 0.5) }
      },
      vertexShader: `
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = vec4(position.xy, 0.0, 1.0);
        }
      `,
      fragmentShader: `
        precision highp float;
        uniform sampler2D uSource;
        uniform vec2 uContentScale;
        uniform vec2 uContentOffset;
        uniform float uZoom;
        uniform vec2 uSourceSize;
        uniform vec2 uZoomPivot;
        varying vec2 vUv;
        void main() {
          vec2 sampleUv = (vUv - uContentOffset) / uContentScale;
          sampleUv = (sampleUv - uZoomPivot) / max(0.0001, uZoom) + uZoomPivot;
          vec2 texel = vec2(1.0) / max(uSourceSize, vec2(1.0));
          sampleUv = clamp(sampleUv, vec2(0.0), vec2(1.0) - texel * 0.5);
          sampleUv = (floor(sampleUv * uSourceSize) + vec2(0.5)) * texel;
          gl_FragColor = texture2D(uSource, sampleUv);
        }
      `,
      depthTest: false
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
      maxBackingWidth: this.stage.maxBackingWidth,
      maxBackingHeight: this.stage.maxBackingHeight,
      viewportCssWidth: this.viewportWidth,
      viewportCssHeight: this.viewportHeight,
      devicePixelRatio: Math.max(1, window.devicePixelRatio || 1)
    });

    const initialState = this.controller.getState();
    this.baseDisplayRenderScale = initialState.renderScale;
    this.animatedYawTurns = this.controller.getYawIndex();
    this.updateDisplayLayout(this.baseDisplayRenderScale);
    this.applyControllerState();
    this.resize(this.viewportWidth, this.viewportHeight);

    this.stage.canvas.addEventListener("pointerdown", this.handlePointerDown);
    this.stage.canvas.addEventListener("pointermove", this.handlePointerMove);
    this.stage.canvas.addEventListener("pointerup", this.handlePointerUp);
    this.stage.canvas.addEventListener("pointercancel", this.handlePointerUp);
    this.stage.canvas.addEventListener("auxclick", this.handleAuxClick);
    this.stage.canvas.addEventListener("wheel", this.handleWheel, { passive: false });
    window.addEventListener("keydown", this.handleKeyDown);

    this.detachTouch = attachTouchGestures(this.stage.canvas, {
      onPan: (dx, dy) => {
        this.applyPan(dx, dy);
      },
      onPinch: (scaleDelta) => {
        if (Math.abs(scaleDelta - 1) < 0.02) {
          return;
        }
        this.stepCameraZoom(scaleDelta > 1 ? 1 : -1);
      },
      onRotate: (direction) => {
        this.rotateQuarterTurns(direction);
      }
    });

    this.resizeObserver = new ResizeObserver(() => {
      const rect = config.mount.getBoundingClientRect();
      this.resize(rect.width, rect.height);
    });
    this.resizeObserver.observe(config.mount);
  }

  getState(): PixelPerfectIsoViewState {
    const state = this.controller.getState();
    return {
      cameraZoomCurrent: this.cameraZoomCurrent,
      cameraZoomTarget: this.cameraZoomTarget,
      zoomAnimationActive: this.zoomAnimationActive,
      zoomBurstActive: this.zoomBurstActive,
      controllerRenderScale: state.renderScale,
      displayRenderScale: this.displayRenderScale,
      lowRenderWidth: state.lowRenderWidth,
      lowRenderHeight: state.lowRenderHeight,
      sceneOutputWidth: this.displaySceneOutputWidth,
      sceneOutputHeight: this.displaySceneOutputHeight,
      zoomMode: state.zoomMode,
      devicePixelRatio: state.devicePixelRatio
    };
  }

  getYawIndex(): number {
    return this.controller.getYawIndex();
  }

  rotateQuarterTurns(delta: -1 | 1): void {
    this.zoomBurstActive = false;
    this.recenterCameraTargetToScreenCenter();
    this.controller.rotateQuarterTurns(delta);
  }

  panByCss(dx: number, dy: number): void {
    this.applyPan(dx, dy);
  }

  stepCameraZoom(direction: -1 | 1): void {
    const nextZoom = THREE.MathUtils.clamp(
      this.cameraZoomTarget + direction * this.config.zoomStep,
      this.config.zoomMin,
      this.config.zoomMax
    );
    if (Math.abs(nextZoom - this.cameraZoomTarget) <= 1e-6) {
      return;
    }
    this.cameraZoomTarget = nextZoom;
    this.zoomAnimationActive = true;
  }

  get canvas(): HTMLCanvasElement {
    return this.stage.canvas;
  }

  reset(): void {
    this.controller.resetView(this.config.basePixelZoom, "free");
    this.animatedYawTurns = this.controller.getYawIndex();
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

  resize(nextWidth: number, nextHeight: number): void {
    const previousDpr = this.controller.getState().devicePixelRatio;
    this.viewportWidth = Math.max(1, nextWidth);
    this.viewportHeight = Math.max(1, nextHeight);
    this.controller.resize(
      this.viewportWidth,
      this.viewportHeight,
      Math.max(1, window.devicePixelRatio || 1)
    );
    const nextDpr = this.controller.getState().devicePixelRatio;
    if (Math.abs(nextDpr - previousDpr) > 1e-9) {
      const ratio = nextDpr / previousDpr;
      this.panDeviceCarryX *= ratio;
      this.panDeviceCarryY *= ratio;
      this.panDeviceRemainderX = Math.trunc(this.panDeviceRemainderX * ratio);
      this.panDeviceRemainderY = Math.trunc(this.panDeviceRemainderY * ratio);
    }
    this.applyControllerState();
  }

  frame(nowMs: number, deltaSeconds: number): void {
    this.updateAnimationState(deltaSeconds);
    if (this.zoomBurstActive && nowMs > this.zoomBurstExpiresAtMs) {
      this.zoomBurstActive = false;
    }
    this.ensureScreenBasis();
    this.renderer.setRenderTarget(this.lowTarget);
    this.renderer.clear();
    this.renderer.render(this.scene, this.camera);
    this.renderer.setRenderTarget(null);
    this.renderer.clear();

    const viewportWidth = Math.max(1, Math.round(this.displayOutputWidth));
    const viewportHeight = Math.max(1, Math.round(this.displayOutputHeight));
    const state = this.controller.getState();
    const renderLeft = Math.round(
      this.displayRenderBaseX + state.panRemainderX + this.panDeviceRemainderX
    );
    const renderTop = Math.round(
      this.displayRenderBaseY + state.panRemainderY + this.panDeviceRemainderY
    );
    const renderBottom = this.renderer.domElement.height - (renderTop + viewportHeight);
    this.renderer.setViewport(renderLeft, renderBottom, viewportWidth, viewportHeight);
    this.renderer.render(this.outputScene, this.outputCamera);
    this.renderer.setViewport(0, 0, this.renderer.domElement.width, this.renderer.domElement.height);
  }

  worldAtClient(clientX: number, clientY: number, out: THREE.Vector3): boolean {
    const metrics = this.stage.getCanvasMetrics();
    if (!metrics) {
      return false;
    }
    const state = this.controller.getState();
    const deviceX = (clientX - metrics.rect.left) * metrics.cssToDeviceX;
    const deviceY = (clientY - metrics.rect.top) * metrics.cssToDeviceY;
    const renderStartX =
      this.displayRenderBaseX + state.panRemainderX + this.panDeviceRemainderX;
    const renderStartY =
      this.displayRenderBaseY + state.panRemainderY + this.panDeviceRemainderY;
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
    const sourceX =
      (scenePointX - this.zoomPivotScene.x) / this.cameraZoomStable + this.zoomPivotScene.x;
    const sourceY =
      (scenePointY - this.zoomPivotScene.y) / this.cameraZoomStable + this.zoomPivotScene.y;
    if (sourceX < 0 || sourceY < 0 || sourceX > 1 || sourceY > 1) {
      return false;
    }
    this.pointerNdc.set(sourceX * 2 - 1, -(sourceY * 2 - 1));
    this.raycaster.setFromCamera(this.pointerNdc, this.camera);
    return this.raycaster.ray.intersectPlane(this.groundPlane, out) !== null;
  }

  projectWorldToClient(world: THREE.Vector3, out: THREE.Vector2): boolean {
    const metrics = this.stage.getCanvasMetrics();
    if (!metrics) {
      return false;
    }
    const state = this.controller.getState();
    this.projectedNdc.copy(world).project(this.camera);
    const sourceX = this.projectedNdc.x * 0.5 + 0.5;
    const sourceY = 1 - (this.projectedNdc.y * 0.5 + 0.5);
    const normalizedX =
      (sourceX - this.zoomPivotScene.x) * this.cameraZoomStable + this.zoomPivotScene.x;
    const normalizedY =
      (sourceY - this.zoomPivotScene.y) * this.cameraZoomStable + this.zoomPivotScene.y;
    const deviceX =
      this.displayRenderBaseX +
      state.panRemainderX +
      this.panDeviceRemainderX +
      this.displayOutputPadDeviceX +
      normalizedX * this.displaySceneOutputWidth;
    const deviceY =
      this.displayRenderBaseY +
      state.panRemainderY +
      this.panDeviceRemainderY +
      this.displayOutputPadDeviceY +
      normalizedY * this.displaySceneOutputHeight;
    out.set(
      metrics.rect.left + deviceX / metrics.cssToDeviceX,
      metrics.rect.top + deviceY / metrics.cssToDeviceY
    );
    return true;
  }

  snapWorldPointOnGround(
    world: THREE.Vector3,
    out: THREE.Vector3,
    mode: PixelSnapMode = "nearest"
  ): boolean {
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
    this.detachTouch();
    this.resizeObserver.disconnect();
    this.stage.canvas.removeEventListener("pointerdown", this.handlePointerDown);
    this.stage.canvas.removeEventListener("pointermove", this.handlePointerMove);
    this.stage.canvas.removeEventListener("pointerup", this.handlePointerUp);
    this.stage.canvas.removeEventListener("pointercancel", this.handlePointerUp);
    this.stage.canvas.removeEventListener("auxclick", this.handleAuxClick);
    this.stage.canvas.removeEventListener("wheel", this.handleWheel);
    window.removeEventListener("keydown", this.handleKeyDown);
    this.lowTarget.dispose();
    this.outputQuad.geometry.dispose();
    this.outputMaterial.dispose();
    this.outputScene.remove(this.outputQuad);
    this.stage.dispose();
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
    this.stage.applyLayout({
      deviceWidth: state.viewportDeviceWidth,
      deviceHeight: state.viewportDeviceHeight,
      cssWidth: state.viewportCssWidth,
      cssHeight: state.viewportCssHeight,
      left: 0,
      top: 0
    });
    this.updateDisplayLayout(this.baseDisplayRenderScale);
  }

  private updateDisplayLayout(scale: number): void {
    const state = this.controller.getState();
    const safeScale = Math.max(1, scale);
    this.displayRenderScale = safeScale;
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
    const halfHeight = state.orthoHeight * 0.5;
    this.camera.left = -halfHeight * aspect;
    this.camera.right = halfHeight * aspect;
    this.camera.top = halfHeight;
    this.camera.bottom = -halfHeight;
    this.camera.updateProjectionMatrix();
  }

  private setCameraPoseFromTarget(): void {
    const yaw = this.config.cameraYaw + this.animatedYawTurns * (Math.PI * 0.5);
    const horizontal = Math.cos(this.config.cameraPitch);
    this.cameraDirection.set(
      Math.sin(yaw) * horizontal,
      Math.sin(this.config.cameraPitch),
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

    const frustumWidth = this.camera.right - this.camera.left;
    const frustumHeight = this.camera.top - this.camera.bottom;
    this.screenRightWorld
      .set(Math.cos(this.config.cameraYaw), 0, -Math.sin(this.config.cameraYaw))
      .multiplyScalar(frustumWidth);
    this.screenDownWorld
      .set(Math.sin(this.config.cameraYaw), 0, Math.cos(this.config.cameraYaw))
      .multiplyScalar(frustumHeight);
  }

  private ensureScreenBasis(): void {
    if (Math.abs(this.cameraTarget.y) > 1e-9) {
      this.cameraTarget.y = 0;
    }
    this.setCameraPoseFromTarget();
    this.updateScreenToWorld();
  }

  private updateAnimationState(deltaSeconds: number): void {
    const targetYawTurns = this.controller.getYawIndex();
    this.animatedYawTurns = this.easeToward(
      this.animatedYawTurns,
      targetYawTurns,
      this.config.rotationAnimationRate,
      deltaSeconds
    );
    if (
      Math.abs(this.animatedYawTurns - targetYawTurns) <=
      this.config.rotationAnimationEpsilon
    ) {
      this.animatedYawTurns = targetYawTurns;
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
    this.outputMaterial.uniforms.uZoom.value = this.cameraZoomStable;
    (this.outputMaterial.uniforms.uZoomPivot.value as THREE.Vector2).set(
      this.zoomPivotScene.x,
      1 - this.zoomPivotScene.y
    );
    this.updateDisplayLayout(this.baseDisplayRenderScale);
  }

  private applyPanRawCss(deltaCssX: number, deltaCssY: number): void {
    this.ensureScreenBasis();
    const metrics = this.stage.getCanvasMetrics();
    const fallbackScale = this.controller.getState().devicePixelRatio;
    const cssToDeviceX = metrics?.cssToDeviceX ?? fallbackScale;
    const cssToDeviceY = metrics?.cssToDeviceY ?? fallbackScale;
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

  private recenterCameraTargetToScreenCenter(): void {
    const metrics = this.stage.getCanvasMetrics();
    if (!metrics) {
      return;
    }
    const centerClientX = metrics.rect.left + metrics.rect.width * 0.5;
    const centerClientY = metrics.rect.top + metrics.rect.height * 0.5;
    if (this.worldAtClient(centerClientX, centerClientY, this.zoomBeforeWorld)) {
      this.zoomPivotScene.set(0.5, 0.5);
      this.cameraTarget.x = this.zoomBeforeWorld.x;
      this.cameraTarget.z = this.zoomBeforeWorld.z;
      this.cameraTarget.y = 0;
      this.ensureScreenBasis();
    }
  }

  private scenePointAtClient(clientX: number, clientY: number, out: THREE.Vector2): boolean {
    const metrics = this.stage.getCanvasMetrics();
    if (!metrics) {
      return false;
    }
    const state = this.controller.getState();
    const deviceX = (clientX - metrics.rect.left) * metrics.cssToDeviceX;
    const deviceY = (clientY - metrics.rect.top) * metrics.cssToDeviceY;
    const renderStartX =
      this.displayRenderBaseX + state.panRemainderX + this.panDeviceRemainderX;
    const renderStartY =
      this.displayRenderBaseY + state.panRemainderY + this.panDeviceRemainderY;
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

  private handlePointerDown = (event: PointerEvent) => {
    if (event.button !== 1) {
      return;
    }
    this.pointerClientX = event.clientX;
    this.pointerClientY = event.clientY;
    this.dragActive = true;
    this.lastClientX = event.clientX;
    this.lastClientY = event.clientY;
    this.zoomBurstActive = false;
    this.stage.setCursor("grabbing");
    this.stage.canvas.setPointerCapture(event.pointerId);
    event.preventDefault();
  };

  private handlePointerMove = (event: PointerEvent) => {
    this.pointerClientX = event.clientX;
    this.pointerClientY = event.clientY;
    if (!this.dragActive) {
      return;
    }
    this.dragDelta.set(event.clientX - this.lastClientX, event.clientY - this.lastClientY);
    this.lastClientX = event.clientX;
    this.lastClientY = event.clientY;
    this.applyPan(this.dragDelta.x, this.dragDelta.y);
    event.preventDefault();
  };

  private handlePointerUp = (event: PointerEvent) => {
    if (!this.dragActive) {
      return;
    }
    this.dragActive = false;
    this.stage.clearCursor();
    if (this.stage.canvas.hasPointerCapture(event.pointerId)) {
      this.stage.canvas.releasePointerCapture(event.pointerId);
    }
    event.preventDefault();
  };

  private handleAuxClick = (event: MouseEvent) => {
    if (event.button !== 1) {
      return;
    }
    event.preventDefault();
  };

  private handleWheel = (event: WheelEvent) => {
    const direction = (event.deltaY > 0 ? -1 : 1) as -1 | 1;
    const nextZoom = THREE.MathUtils.clamp(
      this.cameraZoomTarget + direction * this.config.zoomStep,
      this.config.zoomMin,
      this.config.zoomMax
    );
    if (Math.abs(nextZoom - this.cameraZoomTarget) <= 1e-6) {
      event.preventDefault();
      return;
    }

    const nowMs = performance.now();
    this.zoomBurstActive = true;
    this.zoomBurstExpiresAtMs = nowMs + this.config.zoomBurstIdleMs;
    this.pointerClientX = event.clientX;
    this.pointerClientY = event.clientY;
    const hadAnchorWorld = this.worldAtClient(
      this.pointerClientX,
      this.pointerClientY,
      this.zoomBeforeWorld
    );
    if (this.scenePointAtClient(this.pointerClientX, this.pointerClientY, this.zoomScenePoint)) {
      this.previousZoomPivot.copy(this.zoomPivotScene);
      this.zoomPivotScene.copy(this.zoomScenePoint);
      if (
        hadAnchorWorld &&
        (Math.abs(this.zoomPivotScene.x - this.previousZoomPivot.x) > 1e-6 ||
          Math.abs(this.zoomPivotScene.y - this.previousZoomPivot.y) > 1e-6)
      ) {
        this.ensureScreenBasis();
        if (this.projectWorldToClient(this.zoomBeforeWorld, this.projectedClient)) {
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

    event.preventDefault();
  };

  private handleKeyDown = (event: KeyboardEvent) => {
    if (event.code === "KeyQ") {
      this.zoomBurstActive = false;
      this.recenterCameraTargetToScreenCenter();
      this.controller.rotateQuarterTurns(-1);
      event.preventDefault();
      return;
    }
    if (event.code === "KeyE") {
      this.zoomBurstActive = false;
      this.recenterCameraTargetToScreenCenter();
      this.controller.rotateQuarterTurns(1);
      event.preventDefault();
      return;
    }
    if (event.code === "KeyZ") {
      this.controller.toggleZoomMode();
      this.applyControllerState();
      event.preventDefault();
    }
  };
}
