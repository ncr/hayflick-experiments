import * as THREE from "three";
import type { ExperimentModule } from "../runtime/types";
import { PixelPerfectController, PixelStage } from "@common/render";
import {
  CAMERA_DISTANCE,
  CAMERA_PITCH,
  CAMERA_YAW,
  FIXED_RENDER_HEIGHT,
  GRID_SIZE,
  ORTHO_HEIGHT
} from "./config";

const ZOOM_MIN = 1;
const ZOOM_MAX = 20;
// 1 low-res pixel guard on each side of final upscale output.
const OUTPUT_OVERSCAN_LOW_PIXELS = 2;
const ZOOM_ANIMATION_RATE = 14;
const ZOOM_ANIMATION_BURST_RATE = 42;
const ROTATION_ANIMATION_RATE = 18;
const ROTATION_ANIMATION_EPSILON = 1e-3;
const ZOOM_ANIMATION_EPSILON = 0.02;
const ZOOM_BURST_IDLE_MS = 90;
const MAX_ANCHOR_CORRECTION_CSS = 96;
const MAX_ANCHOR_ERROR_CSS = 1400;

const experiment: ExperimentModule = {
  id: "pixel-perfect-2to1",
  title: "Pixel Perfect 2:1",
  tags: ["pixel", "isometric", "rendering"],
  init: ({ mount, width, height }) => {
    const stage = new PixelStage({
      mount,
      width,
      height,
      antialias: false,
      pixelRatio: 1,
      clearColor: 0x0b0f14,
      clearAlpha: 1,
      mountPosition: "relative",
      mountBackground: "#0b0f14",
      mountOverflow: "hidden",
      canvasPosition: "absolute",
      canvasLeft: "0px",
      canvasTop: "0px",
      canvasDisplay: "block",
      canvasBackground: "#0b0f14",
      canvasImageRendering: "pixelated",
      canvasTransformOrigin: "0 0"
    });
    const renderer = stage.renderer;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x0b0f14);

    const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 200);
    const cameraTarget = new THREE.Vector3(0, 0, 0);
    const screenRightWorld = new THREE.Vector3();
    const screenDownWorld = new THREE.Vector3();
    const cameraDirection = new THREE.Vector3();
    const raycaster = new THREE.Raycaster();
    const pointerNdc = new THREE.Vector2();
    const projectedNdc = new THREE.Vector3();
    const projectedClient = new THREE.Vector2();
    const groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
    const centerGround = new THREE.Vector3();
    const rightGround = new THREE.Vector3();
    const downGround = new THREE.Vector3();
    const zoomBeforeWorld = new THREE.Vector3();
    const dragDelta = new THREE.Vector2();

    const ambient = new THREE.AmbientLight(0xffffff, 0.65);
    scene.add(ambient);

    const keyLight = new THREE.DirectionalLight(0xffffff, 0.8);
    keyLight.position.set(4, 8, 4);
    scene.add(keyLight);

    const floorGroup = new THREE.Group();
    scene.add(floorGroup);

    const tileGeometry = new THREE.PlaneGeometry(1, 1);
    const tileWhite = new THREE.MeshLambertMaterial({ color: 0xf0f2f5 });
    const tileGray = new THREE.MeshLambertMaterial({ color: 0xc2c8cf });

    for (let x = 0; x < GRID_SIZE; x += 1) {
      for (let z = 0; z < GRID_SIZE; z += 1) {
        const material = (x + z) % 2 === 0 ? tileWhite : tileGray;
        const tile = new THREE.Mesh(tileGeometry, material);
        tile.rotation.x = -Math.PI * 0.5;
        tile.position.set(
          x - GRID_SIZE * 0.5 + 0.5,
          -0.001,
          z - GRID_SIZE * 0.5 + 0.5
        );
        floorGroup.add(tile);
      }
    }

    const boxGeometry = new THREE.BoxGeometry(1, 1, 1);
    const boxMaterials = [
      new THREE.MeshLambertMaterial({ color: 0x9bb7ff }),
      new THREE.MeshLambertMaterial({ color: 0xffb36a }),
      new THREE.MeshLambertMaterial({ color: 0x8be0a2 }),
      new THREE.MeshLambertMaterial({ color: 0xd8a7ff })
    ];

    const boxes: THREE.Mesh[] = [];
    const addBox = (x: number, y: number, z: number, colorIndex: number) => {
      const mesh = new THREE.Mesh(
        boxGeometry,
        boxMaterials[colorIndex % boxMaterials.length]
      );
      mesh.position.set(x, y, z);
      scene.add(mesh);
      boxes.push(mesh);
    };

    addBox(-3, 0.5, -2, 0);
    addBox(-1, 0.5, 2, 1);
    addBox(2, 0.5, -1, 2);
    addBox(3, 0.5, 3, 3);
    addBox(0, 1.5, 0, 0);

    const lowTarget = new THREE.WebGLRenderTarget(1, 1, {
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
      format: THREE.RGBAFormat,
      stencilBuffer: false
    });
    lowTarget.texture.generateMipmaps = false;

    const outputScene = new THREE.Scene();
    const outputCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    const outputMaterial = new THREE.ShaderMaterial({
      uniforms: {
        uSource: { value: lowTarget.texture },
        uContentScale: { value: new THREE.Vector2(1, 1) },
        uContentOffset: { value: new THREE.Vector2(0, 0) }
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
        varying vec2 vUv;
        void main() {
          vec2 sampleUv = (vUv - uContentOffset) / uContentScale;
          gl_FragColor = texture2D(uSource, sampleUv);
        }
      `
    });
    const outputQuad = new THREE.Mesh(
      new THREE.PlaneGeometry(2, 2),
      outputMaterial
    );
    outputQuad.frustumCulled = false;
    outputScene.add(outputQuad);

    const hud = document.createElement("div");
    hud.style.position = "absolute";
    hud.style.left = "8px";
    hud.style.top = "8px";
    hud.style.padding = "6px 8px";
    hud.style.background = "rgba(11, 15, 20, 0.8)";
    hud.style.color = "#d7dde6";
    hud.style.font = "12px/1.35 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";
    hud.style.whiteSpace = "pre-line";
    hud.style.pointerEvents = "none";
    hud.style.userSelect = "none";
    hud.style.zIndex = "3";
    mount.appendChild(hud);

    let dragActive = false;
    let lastClientX = 0;
    let lastClientY = 0;
    let viewportWidth = Math.max(1, width);
    let viewportHeight = Math.max(1, height);
    let screenUnitRight = 0;
    let screenUnitDown = 0;
    let snapAfterRotation = false;

    const maxBackingWidth = stage.maxBackingWidth;
    const maxBackingHeight = stage.maxBackingHeight;

    const controller = new PixelPerfectController({
      minZoom: ZOOM_MIN,
      maxZoom: ZOOM_MAX,
      initialZoom: 2,
      initialZoomMode: "free",
      overscanLowPixels: OUTPUT_OVERSCAN_LOW_PIXELS,
      baseOrthoHeight: ORTHO_HEIGHT,
      referenceLowHeight: FIXED_RENDER_HEIGHT,
      maxBackingWidth,
      maxBackingHeight,
      viewportCssWidth: viewportWidth,
      viewportCssHeight: viewportHeight,
      devicePixelRatio: Math.max(1, window.devicePixelRatio || 1)
    });

    const initialState = controller.getState();
    let animatedYawTurns = controller.getYawIndex();
    let animatedUserScale = initialState.userScale;
    let zoomAnimationActive = false;
    let displayRenderScale = initialState.renderScale;
    let displaySceneOutputWidth = initialState.sceneOutputWidth;
    let displaySceneOutputHeight = initialState.sceneOutputHeight;
    let displayOutputWidth = initialState.outputWidth;
    let displayOutputHeight = initialState.outputHeight;
    let displayOutputPadDeviceX = initialState.outputPadDeviceX;
    let displayOutputPadDeviceY = initialState.outputPadDeviceY;
    let displayRenderBaseX = initialState.renderBaseX;
    let displayRenderBaseY = initialState.renderBaseY;
    const zoomAnchorClient = new THREE.Vector2();
    const zoomAnchorWorld = new THREE.Vector3();
    let zoomAnchorActive = false;
    let zoomBurstActive = false;
    let zoomBurstExpiresAtMs = 0;

    const easeToward = (
      current: number,
      target: number,
      rate: number,
      deltaSeconds: number
    ): number => {
      if (deltaSeconds <= 0) {
        return current;
      }
      const blend = 1 - Math.exp(-rate * deltaSeconds);
      return current + (target - current) * blend;
    };

    const updateDisplayLayout = (scale: number) => {
      const state = controller.getState();
      const safeScale = Math.max(1, scale);
      displayRenderScale = safeScale;
      displaySceneOutputWidth = state.lowRenderWidth * safeScale;
      displaySceneOutputHeight = state.lowRenderHeight * safeScale;
      displayOutputWidth = (state.lowRenderWidth + OUTPUT_OVERSCAN_LOW_PIXELS) * safeScale;
      displayOutputHeight = (state.lowRenderHeight + OUTPUT_OVERSCAN_LOW_PIXELS) * safeScale;
      displayOutputPadDeviceX = (displayOutputWidth - displaySceneOutputWidth) * 0.5;
      displayOutputPadDeviceY = (displayOutputHeight - displaySceneOutputHeight) * 0.5;
      displayRenderBaseX = Math.floor((state.viewportDeviceWidth - displayOutputWidth) * 0.5);
      displayRenderBaseY = Math.floor((state.viewportDeviceHeight - displayOutputHeight) * 0.5);
    };

    const syncHud = () => {
      const state = controller.getState();
      const safeLevelsText =
        state.safeZoomLevels.length === 0
          ? "<none>"
          : state.safeZoomLevels.join(", ");
      hud.textContent = [
        `Zoom: ${animatedUserScale.toFixed(3)}x (target ${state.userScale}x, max ${state.maxUserScale}x)`,
        `Zoom mode: ${state.zoomMode}`,
        `DPR: ${state.devicePixelRatio.toFixed(3)}`,
        `Low-res: ${state.lowRenderWidth}x${state.lowRenderHeight}`,
        `Render viewport: ${Math.round(displaySceneOutputWidth)}x${Math.round(displaySceneOutputHeight)} (scale ${displayRenderScale.toFixed(3)}x, target ${state.renderScale}x)`,
        `GL cap: ${maxBackingWidth}x${maxBackingHeight}`,
        `Safe ladder: [${safeLevelsText}]`,
        "Keys: wheel zoom, Q/E rotate, middle-drag pan, WASD pan",
        "Modes: Z zoom-mode"
      ].join("\n");
    };

    const updateCameraProjection = (
      lowRenderWidth: number,
      lowRenderHeight: number,
      orthoHeight: number
    ) => {
      const aspect = lowRenderWidth / lowRenderHeight;
      const halfHeight = orthoHeight * 0.5;
      camera.left = -halfHeight * aspect;
      camera.right = halfHeight * aspect;
      camera.top = halfHeight;
      camera.bottom = -halfHeight;
      camera.updateProjectionMatrix();
    };

    const applyControllerState = () => {
      const state = controller.getState();
      lowTarget.setSize(state.lowRenderWidth, state.lowRenderHeight);
      (outputMaterial.uniforms.uContentScale.value as THREE.Vector2).set(
        state.contentScaleX,
        state.contentScaleY
      );
      (outputMaterial.uniforms.uContentOffset.value as THREE.Vector2).set(
        state.contentOffsetX,
        state.contentOffsetY
      );
      stage.applyLayout({
        deviceWidth: state.viewportDeviceWidth,
        deviceHeight: state.viewportDeviceHeight,
        cssWidth: state.viewportCssWidth,
        cssHeight: state.viewportCssHeight,
        left: 0,
        top: 0
      });
      updateCameraProjection(
        state.lowRenderWidth,
        state.lowRenderHeight,
        state.orthoHeight
      );
      if (!zoomAnimationActive) {
        displayRenderScale = state.renderScale;
      }
      updateDisplayLayout(displayRenderScale);
      syncHud();
    };

    const resize = (nextWidth: number, nextHeight: number) => {
      viewportWidth = Math.max(1, nextWidth);
      viewportHeight = Math.max(1, nextHeight);
      controller.resize(
        viewportWidth,
        viewportHeight,
        Math.max(1, window.devicePixelRatio || 1)
      );
      applyControllerState();
    };

    const getCanvasMetrics = () => stage.getCanvasMetrics();

    const setCameraPoseFromTarget = () => {
      const yaw = CAMERA_YAW + animatedYawTurns * (Math.PI * 0.5);
      const horizontal = Math.cos(CAMERA_PITCH);
      cameraDirection.set(
        Math.sin(yaw) * horizontal,
        Math.sin(CAMERA_PITCH),
        Math.cos(yaw) * horizontal
      );
      camera.position
        .copy(cameraTarget)
        .addScaledVector(cameraDirection, CAMERA_DISTANCE);
      camera.lookAt(cameraTarget);
      camera.updateProjectionMatrix();
      camera.updateMatrixWorld(true);
    };

    const worldAtClient = (
      clientX: number,
      clientY: number,
      out: THREE.Vector3
    ): boolean => {
      const metrics = getCanvasMetrics();
      if (!metrics) {
        return false;
      }
      const state = controller.getState();
      const deviceX = (clientX - metrics.rect.left) * metrics.cssToDeviceX;
      const deviceY = (clientY - metrics.rect.top) * metrics.cssToDeviceY;
      const renderStartX = displayRenderBaseX + state.panRemainderX;
      const renderStartY = displayRenderBaseY + state.panRemainderY;
      const localRenderX = deviceX - (renderStartX + displayOutputPadDeviceX);
      const localRenderY = deviceY - (renderStartY + displayOutputPadDeviceY);
      if (
        localRenderX < 0 ||
        localRenderY < 0 ||
        localRenderX > displaySceneOutputWidth ||
        localRenderY > displaySceneOutputHeight
      ) {
        return false;
      }
      const scenePoint = {
        x: localRenderX / displaySceneOutputWidth,
        y: localRenderY / displaySceneOutputHeight
      };
      pointerNdc.set(scenePoint.x * 2 - 1, -(scenePoint.y * 2 - 1));
      raycaster.setFromCamera(pointerNdc, camera);
      return raycaster.ray.intersectPlane(groundPlane, out) !== null;
    };

    const projectWorldToClient = (
      world: THREE.Vector3,
      out: THREE.Vector2
    ): boolean => {
      const metrics = getCanvasMetrics();
      if (!metrics) {
        return false;
      }
      const state = controller.getState();
      projectedNdc.copy(world).project(camera);
      const normalizedX = projectedNdc.x * 0.5 + 0.5;
      const normalizedY = 1 - (projectedNdc.y * 0.5 + 0.5);
      const deviceX =
        displayRenderBaseX +
        state.panRemainderX +
        displayOutputPadDeviceX +
        normalizedX * displaySceneOutputWidth;
      const deviceY =
        displayRenderBaseY +
        state.panRemainderY +
        displayOutputPadDeviceY +
        normalizedY * displaySceneOutputHeight;
      out.set(
        metrics.rect.left + deviceX / metrics.cssToDeviceX,
        metrics.rect.top + deviceY / metrics.cssToDeviceY
      );
      return true;
    };

    const updateScreenToWorld = () => {
      const state = controller.getState();
      const ndcStepX = 2 / state.lowRenderWidth;
      const ndcStepY = 2 / state.lowRenderHeight;

      pointerNdc.set(0, 0);
      raycaster.setFromCamera(pointerNdc, camera);
      const hasCenter = raycaster.ray.intersectPlane(groundPlane, centerGround) !== null;

      pointerNdc.set(ndcStepX, 0);
      raycaster.setFromCamera(pointerNdc, camera);
      const hasRight = raycaster.ray.intersectPlane(groundPlane, rightGround) !== null;

      pointerNdc.set(0, -ndcStepY);
      raycaster.setFromCamera(pointerNdc, camera);
      const hasDown = raycaster.ray.intersectPlane(groundPlane, downGround) !== null;

      if (hasCenter && hasRight && hasDown) {
        screenRightWorld.subVectors(rightGround, centerGround);
        screenDownWorld.subVectors(downGround, centerGround);
        screenUnitRight = screenRightWorld.length();
        screenUnitDown = screenDownWorld.length();
        return;
      }

      // Fallback for unexpected ray/plane intersection failures.
      const frustumWidth = camera.right - camera.left;
      const frustumHeight = camera.top - camera.bottom;
      const unitRight = frustumWidth / state.lowRenderWidth;
      const unitDown = frustumHeight / state.lowRenderHeight;
      const yaw = CAMERA_YAW + animatedYawTurns * (Math.PI * 0.5);
      screenRightWorld.set(Math.cos(yaw), 0, -Math.sin(yaw)).multiplyScalar(unitRight);
      screenDownWorld.set(Math.sin(yaw), 0, Math.cos(yaw)).multiplyScalar(unitDown);
      screenUnitRight = screenRightWorld.length();
      screenUnitDown = screenDownWorld.length();
    };

    const snapCameraTargetToGrid = () => {
      const det =
        screenRightWorld.x * screenDownWorld.z -
        screenRightWorld.z * screenDownWorld.x;
      if (Math.abs(det) <= 1e-12) {
        return;
      }

      const tx = cameraTarget.x;
      const tz = cameraTarget.z;
      const rightPixels = (tx * screenDownWorld.z - tz * screenDownWorld.x) / det;
      const downPixels = (screenRightWorld.x * tz - screenRightWorld.z * tx) / det;

      const snappedRightPixels = Math.round(rightPixels);
      const snappedDownPixels = Math.round(downPixels);
      const snappedX =
        snappedRightPixels * screenRightWorld.x +
        snappedDownPixels * screenDownWorld.x;
      const snappedZ =
        snappedRightPixels * screenRightWorld.z +
        snappedDownPixels * screenDownWorld.z;

      if (
        Math.abs(snappedX - cameraTarget.x) <= 1e-9 &&
        Math.abs(snappedZ - cameraTarget.z) <= 1e-9 &&
        Math.abs(cameraTarget.y) <= 1e-9
      ) {
        return;
      }
      cameraTarget.set(snappedX, 0, snappedZ);
      setCameraPoseFromTarget();
    };

    const ensureScreenBasis = () => {
      if (Math.abs(cameraTarget.y) > 1e-9) {
        cameraTarget.y = 0;
      }
      setCameraPoseFromTarget();
      updateScreenToWorld();
      const targetYawTurns = controller.getYawIndex();
      const rotationSettled =
        Math.abs(animatedYawTurns - targetYawTurns) <= ROTATION_ANIMATION_EPSILON;

      if (
        rotationSettled &&
        snapAfterRotation &&
        Math.abs(screenUnitRight) > 1e-9 &&
        Math.abs(screenUnitDown) > 1e-9
      ) {
        snapCameraTargetToGrid();
        snapAfterRotation = false;
      }
    };

    const updateAnimationState = (deltaSeconds: number) => {
      const state = controller.getState();
      const previousAnimatedUserScale = animatedUserScale;
      const previousDisplayRenderScale = displayRenderScale;

      const targetYawTurns = controller.getYawIndex();
      animatedYawTurns = easeToward(
        animatedYawTurns,
        targetYawTurns,
        ROTATION_ANIMATION_RATE,
        deltaSeconds
      );
      if (
        Math.abs(animatedYawTurns - targetYawTurns) <=
        ROTATION_ANIMATION_EPSILON
      ) {
        animatedYawTurns = targetYawTurns;
      }

      const targetUserScale = state.userScale;
      const targetRenderScale = state.renderScale;
      const zoomAnimationRate = zoomBurstActive
        ? ZOOM_ANIMATION_BURST_RATE
        : ZOOM_ANIMATION_RATE;
      animatedUserScale = easeToward(
        animatedUserScale,
        targetUserScale,
        zoomAnimationRate,
        deltaSeconds
      );
      displayRenderScale = easeToward(
        displayRenderScale,
        targetRenderScale,
        zoomAnimationRate,
        deltaSeconds
      );

      if (
        Math.abs(animatedUserScale - targetUserScale) <= ZOOM_ANIMATION_EPSILON &&
        Math.abs(displayRenderScale - targetRenderScale) <= ZOOM_ANIMATION_EPSILON
      ) {
        animatedUserScale = targetUserScale;
        displayRenderScale = targetRenderScale;
        zoomAnimationActive = false;
      } else {
        zoomAnimationActive = true;
      }

      updateDisplayLayout(displayRenderScale);
      if (
        Math.abs(previousAnimatedUserScale - animatedUserScale) > 1e-5 ||
        Math.abs(previousDisplayRenderScale - displayRenderScale) > 1e-5
      ) {
        syncHud();
      }
    };

    const applyPanDevice = (deltaDeviceX: number, deltaDeviceY: number) => {
      ensureScreenBasis();
      const step = controller.panByDevice(deltaDeviceX, deltaDeviceY);
      if (step.cameraStepX !== 0) {
        cameraTarget.addScaledVector(screenRightWorld, -step.cameraStepX);
      }
      if (step.cameraStepY !== 0) {
        cameraTarget.addScaledVector(screenDownWorld, -step.cameraStepY);
      }
    };

    const applyPan = (deltaCssX: number, deltaCssY: number) => {
      ensureScreenBasis();
      const metrics = getCanvasMetrics();
      const fallbackScale = controller.getState().devicePixelRatio;
      const cssToDeviceX = metrics?.cssToDeviceX ?? fallbackScale;
      const cssToDeviceY = metrics?.cssToDeviceY ?? fallbackScale;
      const step = controller.panByCss(
        deltaCssX,
        deltaCssY,
        cssToDeviceX,
        cssToDeviceY
      );
      if (step.cameraStepX !== 0) {
        cameraTarget.addScaledVector(screenRightWorld, -step.cameraStepX);
      }
      if (step.cameraStepY !== 0) {
        cameraTarget.addScaledVector(screenDownWorld, -step.cameraStepY);
      }
    };

    const resetPanCarry = () => {
      controller.resetPanCarry();
    };

    const applyZoomAnchorCorrection = (maxIterations: number) => {
      if (!zoomAnchorActive) {
        return;
      }
      for (let i = 0; i < maxIterations; i += 1) {
        if (!projectWorldToClient(zoomAnchorWorld, projectedClient)) {
          break;
        }
        const rawCorrectionX = zoomAnchorClient.x - projectedClient.x;
        const rawCorrectionY = zoomAnchorClient.y - projectedClient.y;
        if (
          Math.abs(rawCorrectionX) > MAX_ANCHOR_ERROR_CSS ||
          Math.abs(rawCorrectionY) > MAX_ANCHOR_ERROR_CSS
        ) {
          zoomAnchorActive = false;
          break;
        }
        if (
          !zoomAnimationActive &&
          !zoomBurstActive &&
          Math.abs(rawCorrectionX) < 1 &&
          Math.abs(rawCorrectionY) < 1
        ) {
          zoomAnchorActive = false;
          break;
        }
        if (Math.abs(rawCorrectionX) < 0.01 && Math.abs(rawCorrectionY) < 0.01) {
          break;
        }
        const correctionX = THREE.MathUtils.clamp(
          rawCorrectionX,
          -MAX_ANCHOR_CORRECTION_CSS,
          MAX_ANCHOR_CORRECTION_CSS
        );
        const correctionY = THREE.MathUtils.clamp(
          rawCorrectionY,
          -MAX_ANCHOR_CORRECTION_CSS,
          MAX_ANCHOR_CORRECTION_CSS
        );
        applyPan(correctionX, correctionY);
        ensureScreenBasis();
      }
    };

    resize(width, height);

    stage.observeResize((nextWidth, nextHeight) => {
      resize(nextWidth, nextHeight);
    });

    const handlePointerDown = (event: PointerEvent) => {
      if (event.button !== 1) {
        return;
      }
      resetPanCarry();
      dragActive = true;
      zoomAnchorActive = false;
      zoomBurstActive = false;
      lastClientX = event.clientX;
      lastClientY = event.clientY;
      stage.setCursor("grabbing");
      renderer.domElement.setPointerCapture(event.pointerId);
      event.preventDefault();
    };

    const handlePointerMove = (event: PointerEvent) => {
      if (!dragActive) {
        return;
      }
      dragDelta.set(event.clientX - lastClientX, event.clientY - lastClientY);
      lastClientX = event.clientX;
      lastClientY = event.clientY;
      applyPan(dragDelta.x, dragDelta.y);
      event.preventDefault();
    };

    const handlePointerUp = (event: PointerEvent) => {
      if (!dragActive) {
        return;
      }
      dragActive = false;
      resetPanCarry();
      stage.clearCursor();
      if (renderer.domElement.hasPointerCapture(event.pointerId)) {
        renderer.domElement.releasePointerCapture(event.pointerId);
      }
      event.preventDefault();
    };

    const handleWheel = (event: WheelEvent) => {
      const direction = (event.deltaY > 0 ? -1 : 1) as -1 | 1;
      const nowMs = performance.now();
      const burstContinues = zoomBurstActive && nowMs <= zoomBurstExpiresAtMs;
      if (!burstContinues) {
        resetPanCarry();
        ensureScreenBasis();
        const hasZoomAnchor = worldAtClient(
          event.clientX,
          event.clientY,
          zoomBeforeWorld
        );
        if (hasZoomAnchor) {
          zoomAnchorWorld.copy(zoomBeforeWorld);
          zoomAnchorActive = true;
        } else {
          zoomAnchorActive = false;
        }
      }
      zoomBurstActive = true;
      zoomBurstExpiresAtMs = nowMs + ZOOM_BURST_IDLE_MS;
      zoomAnchorClient.set(event.clientX, event.clientY);
      if (controller.stepZoom(direction)) {
        zoomAnimationActive = true;
        applyControllerState();
        applyZoomAnchorCorrection(2);
        syncHud();
      }
      event.preventDefault();
    };

    const handleAuxClick = (event: MouseEvent) => {
      if (event.button !== 1) {
        return;
      }
      event.preventDefault();
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.code === "KeyQ") {
        zoomAnchorActive = false;
        zoomBurstActive = false;
        snapAfterRotation = true;
        controller.rotateQuarterTurns(-1);
        event.preventDefault();
      } else if (event.code === "KeyE") {
        zoomAnchorActive = false;
        zoomBurstActive = false;
        snapAfterRotation = true;
        controller.rotateQuarterTurns(1);
        event.preventDefault();
      } else if (event.code === "KeyW") {
        event.preventDefault();
      } else if (event.code === "KeyS") {
        event.preventDefault();
      } else if (event.code === "KeyA") {
        event.preventDefault();
      } else if (event.code === "KeyD") {
        event.preventDefault();
      } else if (event.code === "KeyZ") {
        controller.toggleZoomMode();
        applyControllerState();
        event.preventDefault();
      }
    };

    renderer.domElement.addEventListener("pointerdown", handlePointerDown);
    renderer.domElement.addEventListener("pointermove", handlePointerMove);
    renderer.domElement.addEventListener("pointerup", handlePointerUp);
    renderer.domElement.addEventListener("pointercancel", handlePointerUp);
    renderer.domElement.addEventListener("auxclick", handleAuxClick);
    renderer.domElement.addEventListener("wheel", handleWheel, { passive: false });
    window.addEventListener("keydown", handleKeyDown);

    let raf = 0;
    let lastFrameTimeMs = performance.now();
    const render = (nowMs: number) => {
      const deltaSeconds = Math.min(
        0.05,
        Math.max(0, (nowMs - lastFrameTimeMs) / 1000)
      );
      lastFrameTimeMs = nowMs;
      updateAnimationState(deltaSeconds);
      ensureScreenBasis();
      if (zoomBurstActive && nowMs > zoomBurstExpiresAtMs) {
        zoomBurstActive = false;
      }

      if (zoomAnchorActive) {
        applyZoomAnchorCorrection(4);
      }

      renderer.setRenderTarget(lowTarget);
      renderer.clear();
      renderer.render(scene, camera);

      // no keyboard pan handling

      renderer.setRenderTarget(null);
      renderer.clear();
      const state = controller.getState();
      const viewportWidth = Math.max(1, Math.round(displayOutputWidth));
      const viewportHeight = Math.max(1, Math.round(displayOutputHeight));
      const renderLeft = Math.round(displayRenderBaseX + state.panRemainderX);
      const renderTop = Math.round(displayRenderBaseY + state.panRemainderY);
      const renderBottom = renderer.domElement.height - (renderTop + viewportHeight);
      renderer.setViewport(
        renderLeft,
        renderBottom,
        viewportWidth,
        viewportHeight
      );
      renderer.render(outputScene, outputCamera);
      renderer.setViewport(
        0,
        0,
        renderer.domElement.width,
        renderer.domElement.height
      );

      raf = requestAnimationFrame(render);
    };

    const debugWindow = window as Window & {
      __pixelPerfect2to1Debug?: {
        getState: () => {
          nativeDpr: number;
          activeDpr: number;
          maxUserScale: number;
          inputScaleX: number;
          inputScaleY: number;
          renderScale: number;
          userScale: number;
          animatedUserScale: number;
          zoomAnimationActive: boolean;
          lowRenderWidth: number;
          lowRenderHeight: number;
          sceneOutputWidth: number;
          sceneOutputHeight: number;
          outputWidth: number;
          outputHeight: number;
          outputPadDeviceX: number;
          outputPadDeviceY: number;
          viewportDeviceWidth: number;
          viewportDeviceHeight: number;
          renderBaseX: number;
          renderBaseY: number;
          panRemainderX: number;
          panRemainderY: number;
          cumulativePanDeviceX: number;
          cumulativePanDeviceY: number;
        };
        worldAtClient: (clientX: number, clientY: number) => {
          x: number;
          y: number;
          z: number;
        } | null;
        projectWorldToClient: (x: number, y: number, z: number) => {
          clientX: number;
          clientY: number;
        } | null;
      };
    };
    const debugApi = {
      getState: () => {
        const metrics = getCanvasMetrics();
        const state = controller.getState();
        return {
          nativeDpr: state.devicePixelRatio,
          activeDpr: state.devicePixelRatio,
          maxUserScale: state.maxUserScale,
          inputScaleX: metrics?.cssToDeviceX ?? state.devicePixelRatio,
          inputScaleY: metrics?.cssToDeviceY ?? state.devicePixelRatio,
          renderScale: displayRenderScale,
          userScale: state.userScale,
          animatedUserScale,
          zoomAnimationActive,
          lowRenderWidth: state.lowRenderWidth,
          lowRenderHeight: state.lowRenderHeight,
          sceneOutputWidth: displaySceneOutputWidth,
          sceneOutputHeight: displaySceneOutputHeight,
          outputWidth: displayOutputWidth,
          outputHeight: displayOutputHeight,
          outputPadDeviceX: displayOutputPadDeviceX,
          outputPadDeviceY: displayOutputPadDeviceY,
          viewportDeviceWidth: state.viewportDeviceWidth,
          viewportDeviceHeight: state.viewportDeviceHeight,
          renderBaseX: displayRenderBaseX,
          renderBaseY: displayRenderBaseY,
          panRemainderX: state.panRemainderX,
          panRemainderY: state.panRemainderY,
          cumulativePanDeviceX: state.cumulativePanDeviceX,
          cumulativePanDeviceY: state.cumulativePanDeviceY
        };
      },
      worldAtClient: (clientX: number, clientY: number) => {
        setCameraPoseFromTarget();
        if (!worldAtClient(clientX, clientY, zoomBeforeWorld)) {
          return null;
        }
        return {
          x: zoomBeforeWorld.x,
          y: zoomBeforeWorld.y,
          z: zoomBeforeWorld.z
        };
      },
      projectWorldToClient: (x: number, y: number, z: number) => {
        setCameraPoseFromTarget();
        if (!projectWorldToClient(zoomBeforeWorld.set(x, y, z), projectedClient)) {
          return null;
        }
        return {
          clientX: projectedClient.x,
          clientY: projectedClient.y
        };
      }
    };
    debugWindow.__pixelPerfect2to1Debug = debugApi;

    raf = requestAnimationFrame(render);

    return () => {
      cancelAnimationFrame(raf);
      renderer.domElement.removeEventListener("pointerdown", handlePointerDown);
      renderer.domElement.removeEventListener("pointermove", handlePointerMove);
      renderer.domElement.removeEventListener("pointerup", handlePointerUp);
      renderer.domElement.removeEventListener("pointercancel", handlePointerUp);
      renderer.domElement.removeEventListener("auxclick", handleAuxClick);
      renderer.domElement.removeEventListener("wheel", handleWheel);
      window.removeEventListener("keydown", handleKeyDown);

      hud.remove();
      if (debugWindow.__pixelPerfect2to1Debug === debugApi) {
        delete debugWindow.__pixelPerfect2to1Debug;
      }

      boxes.forEach((mesh) => scene.remove(mesh));
      scene.remove(floorGroup);
      scene.remove(ambient, keyLight);

      tileGeometry.dispose();
      tileWhite.dispose();
      tileGray.dispose();
      boxGeometry.dispose();
      boxMaterials.forEach((material) => material.dispose());
      lowTarget.dispose();
      outputQuad.geometry.dispose();
      outputMaterial.dispose();
      outputScene.remove(outputQuad);

      stage.dispose();
    };
  }
};

export default experiment;
