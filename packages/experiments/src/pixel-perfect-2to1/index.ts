import * as THREE from "three";
import type { ExperimentModule } from "../runtime/types";
import {
  CAMERA_DISTANCE,
  CAMERA_PITCH,
  CAMERA_YAW,
  FIXED_RENDER_HEIGHT,
  FIXED_RENDER_WIDTH,
  GRID_SIZE,
  ORTHO_HEIGHT
} from "./config";
import {
  createPanPhaseState,
  rescalePanPhaseRemainder,
  stepPanPhase
} from "./pan-phase";
import {
  computeSafeZoomLevels,
  nearestZoomLevel,
  stepZoomLevel,
  type DprMode,
  type ZoomMode
} from "./zoom-modes";

const ZOOM_MIN = 1;
const ZOOM_MAX = 20;
const DPR_OVERRIDE_MIN = 1;
const DPR_OVERRIDE_MAX = 4;

const experiment: ExperimentModule = {
  id: "pixel-perfect-2to1",
  title: "Pixel Perfect 2:1",
  tags: ["pixel", "isometric", "rendering"],
  init: ({ mount, width, height }) => {
    const renderer = new THREE.WebGLRenderer({ antialias: false });
    renderer.setPixelRatio(1);
    renderer.setSize(width, height, true);
    renderer.setClearColor(0x0b0f14, 1);
    renderer.domElement.style.imageRendering = "pixelated";
    renderer.domElement.style.transformOrigin = "0 0";
    renderer.domElement.style.position = "absolute";
    renderer.domElement.style.left = "0px";
    renderer.domElement.style.top = "0px";
    renderer.domElement.style.display = "block";
    mount.appendChild(renderer.domElement);
    mount.style.position = "relative";
    mount.style.background = "#0b0f14";
    mount.style.overflow = "hidden";

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x0b0f14);

    const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 200);
    const cameraTarget = new THREE.Vector3(0, 0, 0);
    const screenRightWorld = new THREE.Vector3();
    const screenDownWorld = new THREE.Vector3();
    const cameraRight = new THREE.Vector3();
    const cameraUp = new THREE.Vector3();
    const cameraForward = new THREE.Vector3();
    const snappedCameraTarget = new THREE.Vector3();
    const raycaster = new THREE.Raycaster();
    const pointerNdc = new THREE.Vector2();
    const groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
    const beforeZoomWorld = new THREE.Vector3();
    const afterZoomWorld = new THREE.Vector3();
    const cameraShift = new THREE.Vector3();
    const dragDelta = new THREE.Vector2();

    const ambient = new THREE.AmbientLight(0xffffff, 0.65);
    scene.add(ambient);

    const keyLight = new THREE.DirectionalLight(0xffffff, 0.8);
    keyLight.position.set(4, 8, 4);
    scene.add(keyLight);

    const floorGroup = new THREE.Group();
    scene.add(floorGroup);

    const tileGeometry = new THREE.BoxGeometry(1, 0.04, 1);
    const tileWhite = new THREE.MeshLambertMaterial({ color: 0xf0f2f5 });
    const tileGray = new THREE.MeshLambertMaterial({ color: 0xc2c8cf });

    for (let x = 0; x < GRID_SIZE; x += 1) {
      for (let z = 0; z < GRID_SIZE; z += 1) {
        const material = (x + z) % 2 === 0 ? tileWhite : tileGray;
        const tile = new THREE.Mesh(tileGeometry, material);
        tile.position.set(
          x - GRID_SIZE * 0.5 + 0.5,
          -0.02,
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

    const lowTarget = new THREE.WebGLRenderTarget(
      FIXED_RENDER_WIDTH,
      FIXED_RENDER_HEIGHT,
      {
        minFilter: THREE.NearestFilter,
        magFilter: THREE.NearestFilter,
        format: THREE.RGBAFormat,
        stencilBuffer: false
      }
    );
    lowTarget.texture.generateMipmaps = false;

    const outputScene = new THREE.Scene();
    const outputCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    const outputMaterial = new THREE.ShaderMaterial({
      uniforms: {
        uSource: { value: lowTarget.texture }
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
        varying vec2 vUv;
        void main() {
          gl_FragColor = texture2D(uSource, vUv);
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

    let yawIndex = 0;
    let dragActive = false;
    let lastClientX = 0;
    let lastClientY = 0;
    let renderScale = 1;
    let zoomTarget = 4;
    let zoomCurrent = zoomTarget;
    let outputWidth = FIXED_RENDER_WIDTH;
    let outputHeight = FIXED_RENDER_HEIGHT;
    let viewportWidth = width;
    let viewportHeight = height;
    let devicePixelRatio = Math.max(1, window.devicePixelRatio || 1);
    let dprMode: DprMode = "native";
    let dprOverride = THREE.MathUtils.clamp(
      Math.round(devicePixelRatio),
      DPR_OVERRIDE_MIN,
      DPR_OVERRIDE_MAX
    );
    let zoomMode: ZoomMode = "free";
    let safeZoomLevels: number[] = [];
    let padSize = 0;
    let panPhase = createPanPhaseState();
    let screenUnitRight = 0;
    let screenUnitDown = 0;
    let keyPanX = 0;
    let keyPanY = 0;
    let keyPanActive = false;
    let lastYawIndex = Number.NaN;
    let zoomAnchorX = width * 0.5;
    let zoomAnchorY = height * 0.5;
    let zoomAnchorActive = false;

    const getActiveDpr = () =>
      dprMode === "override" ? dprOverride : devicePixelRatio;

    const updateSafeZoomLevels = () => {
      safeZoomLevels = computeSafeZoomLevels(getActiveDpr(), ZOOM_MIN, ZOOM_MAX);
      if (zoomMode === "safe-ladder") {
        if (safeZoomLevels.length === 0) {
          zoomMode = "free";
          zoomTarget = THREE.MathUtils.clamp(
            Math.round(zoomTarget),
            ZOOM_MIN,
            ZOOM_MAX
          );
        } else {
          zoomTarget = nearestZoomLevel(safeZoomLevels, zoomTarget);
        }
      }
    };

    const syncHud = () => {
      const activeDpr = getActiveDpr();
      const effectiveCssZoom =
        renderScale > 0 ? renderScale / devicePixelRatio : zoomCurrent;
      const safeLevelsText =
        safeZoomLevels.length === 0 ? "<none>" : safeZoomLevels.join(", ");
      hud.textContent = [
        `Zoom: ${effectiveCssZoom.toFixed(3)}x (target ${zoomTarget.toFixed(3)}x)`,
        `Zoom mode: ${zoomMode}`,
        `DPR mode: ${dprMode} (native=${devicePixelRatio.toFixed(3)}, active=${activeDpr.toFixed(3)})`,
        `Safe ladder: [${safeLevelsText}]`,
        "Keys: wheel zoom, Q/E rotate, WASD pan",
        "Modes: Z zoom-mode, V dpr-mode, [ ] dpr-override"
      ].join("\n");
    };

    const updateCameraProjection = (nextWidth: number, nextHeight: number) => {
      const aspect = nextWidth / nextHeight;
      const halfHeight = ORTHO_HEIGHT * 0.5;
      camera.left = -halfHeight * aspect;
      camera.right = halfHeight * aspect;
      camera.top = halfHeight;
      camera.bottom = -halfHeight;
      camera.updateProjectionMatrix();
    };

    const worldAtClient = (
      clientX: number,
      clientY: number,
      out: THREE.Vector3
    ): boolean => {
      const rect = renderer.domElement.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) {
        return false;
      }
      pointerNdc.x = ((clientX - rect.left) / rect.width) * 2 - 1;
      pointerNdc.y = -((clientY - rect.top) / rect.height) * 2 + 1;
      raycaster.setFromCamera(pointerNdc, camera);
      return !!raycaster.ray.intersectPlane(groundPlane, out);
    };

    const resize = (nextWidth: number, nextHeight: number) => {
      const safeWidth = Math.max(1, Math.floor(nextWidth));
      const safeHeight = Math.max(1, Math.floor(nextHeight));
      viewportWidth = safeWidth;
      viewportHeight = safeHeight;
      const previousActiveDpr = getActiveDpr();
      const nextDevicePixelRatio = Math.max(1, window.devicePixelRatio || 1);
      if (nextDevicePixelRatio !== devicePixelRatio) {
        devicePixelRatio = nextDevicePixelRatio;
      }
      const nextActiveDpr = getActiveDpr();
      if (Math.abs(nextActiveDpr - previousActiveDpr) > 1e-9) {
        const activeRatio = nextActiveDpr / previousActiveDpr;
        panPhase = {
          ...panPhase,
          carryX: panPhase.carryX * activeRatio,
          carryY: panPhase.carryY * activeRatio
        };
        updateSafeZoomLevels();
      }
      const fitScale = Math.max(
        1,
        Math.floor(
          Math.min(
            safeWidth / FIXED_RENDER_WIDTH,
            safeHeight / FIXED_RENDER_HEIGHT
          )
        )
      );
      const activeDpr = getActiveDpr();
      const nextScale = Math.max(
        1,
        Math.round(fitScale * zoomCurrent * activeDpr)
      );
      if (renderScale > 0 && nextScale !== renderScale) {
        panPhase = {
          ...panPhase,
          remainderX: rescalePanPhaseRemainder(
            panPhase.remainderX,
            renderScale,
            nextScale
          ),
          remainderY: rescalePanPhaseRemainder(
            panPhase.remainderY,
            renderScale,
            nextScale
          )
        };
      }
      renderScale = nextScale;
      const targetWidth = FIXED_RENDER_WIDTH * renderScale;
      const targetHeight = FIXED_RENDER_HEIGHT * renderScale;
      outputWidth = targetWidth;
      outputHeight = targetHeight;
      padSize = renderScale;
      const totalDeviceWidth = targetWidth + padSize * 2;
      const totalDeviceHeight = targetHeight + padSize * 2;
      renderer.setSize(totalDeviceWidth, totalDeviceHeight, true);
      renderer.domElement.style.width = `${totalDeviceWidth / devicePixelRatio}px`;
      renderer.domElement.style.height = `${totalDeviceHeight / devicePixelRatio}px`;
      const viewportDeviceWidth = Math.max(
        1,
        Math.floor(safeWidth * devicePixelRatio)
      );
      const viewportDeviceHeight = Math.max(
        1,
        Math.floor(safeHeight * devicePixelRatio)
      );
      const offsetDeviceX = Math.floor(
        (viewportDeviceWidth - totalDeviceWidth) * 0.5
      );
      const offsetDeviceY = Math.floor(
        (viewportDeviceHeight - totalDeviceHeight) * 0.5
      );
      renderer.domElement.style.left = `${offsetDeviceX / devicePixelRatio}px`;
      renderer.domElement.style.top = `${offsetDeviceY / devicePixelRatio}px`;
      updateCameraProjection(FIXED_RENDER_WIDTH, FIXED_RENDER_HEIGHT);
      lastYawIndex = Number.NaN;
      syncHud();
    };

    updateSafeZoomLevels();
    resize(width, height);

    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) {
        return;
      }
      resize(entry.contentRect.width, entry.contentRect.height);
    });
    observer.observe(mount);

    const applyPan = (deltaX: number, deltaY: number) => {
      const next = stepPanPhase(
        panPhase,
        deltaX * devicePixelRatio,
        deltaY * devicePixelRatio,
        renderScale
      );
      panPhase = next.state;
      if (next.cameraStepX !== 0) {
        cameraTarget.addScaledVector(screenRightWorld, -next.cameraStepX);
      }
      if (next.cameraStepY !== 0) {
        cameraTarget.addScaledVector(screenDownWorld, -next.cameraStepY);
      }
    };

    const handlePointerDown = (event: PointerEvent) => {
      if (event.button !== 0) {
        return;
      }
      dragActive = true;
      lastClientX = event.clientX;
      lastClientY = event.clientY;
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
      renderer.domElement.releasePointerCapture(event.pointerId);
      event.preventDefault();
    };

    const handleWheel = (event: WheelEvent) => {
      const deltaScale = event.deltaMode === WheelEvent.DOM_DELTA_LINE ? 16 : 1;
      const direction = (event.deltaY > 0 ? -1 : 1) as -1 | 1;
      let nextZoom = zoomTarget;
      if (zoomMode === "safe-ladder" && safeZoomLevels.length > 0) {
        nextZoom = stepZoomLevel(safeZoomLevels, zoomTarget, direction);
      } else {
        nextZoom = THREE.MathUtils.clamp(
          zoomTarget * Math.exp(-event.deltaY * deltaScale * 0.0015),
          ZOOM_MIN,
          ZOOM_MAX
        );
      }
      if (Math.abs(nextZoom - zoomTarget) > 1e-6) {
        zoomTarget = nextZoom;
        zoomAnchorX = event.clientX;
        zoomAnchorY = event.clientY;
        zoomAnchorActive = true;
        syncHud();
      }
      event.preventDefault();
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.code === "KeyQ") {
        yawIndex -= 1;
        event.preventDefault();
      } else if (event.code === "KeyE") {
        yawIndex += 1;
        event.preventDefault();
      } else if (event.code === "KeyW") {
        keyPanY = -1;
        keyPanActive = true;
        event.preventDefault();
      } else if (event.code === "KeyS") {
        keyPanY = 1;
        keyPanActive = true;
        event.preventDefault();
      } else if (event.code === "KeyA") {
        keyPanX = -1;
        keyPanActive = true;
        event.preventDefault();
      } else if (event.code === "KeyD") {
        keyPanX = 1;
        keyPanActive = true;
        event.preventDefault();
      } else if (event.code === "KeyZ") {
        zoomMode = zoomMode === "free" ? "safe-ladder" : "free";
        updateSafeZoomLevels();
        syncHud();
        event.preventDefault();
      } else if (event.code === "KeyV") {
        dprMode = dprMode === "native" ? "override" : "native";
        updateSafeZoomLevels();
        resize(viewportWidth, viewportHeight);
        event.preventDefault();
      } else if (event.code === "BracketLeft") {
        dprOverride = THREE.MathUtils.clamp(
          dprOverride - 1,
          DPR_OVERRIDE_MIN,
          DPR_OVERRIDE_MAX
        );
        updateSafeZoomLevels();
        if (dprMode === "override") {
          resize(viewportWidth, viewportHeight);
        } else {
          syncHud();
        }
        event.preventDefault();
      } else if (event.code === "BracketRight") {
        dprOverride = THREE.MathUtils.clamp(
          dprOverride + 1,
          DPR_OVERRIDE_MIN,
          DPR_OVERRIDE_MAX
        );
        updateSafeZoomLevels();
        if (dprMode === "override") {
          resize(viewportWidth, viewportHeight);
        } else {
          syncHud();
        }
        event.preventDefault();
      }
    };

    const handleKeyUp = (event: KeyboardEvent) => {
      if (event.code === "KeyW" || event.code === "KeyS") {
        keyPanY = 0;
      } else if (event.code === "KeyA" || event.code === "KeyD") {
        keyPanX = 0;
      }
      keyPanActive = keyPanX !== 0 || keyPanY !== 0;
    };

    renderer.domElement.addEventListener("pointerdown", handlePointerDown);
    renderer.domElement.addEventListener("pointermove", handlePointerMove);
    renderer.domElement.addEventListener("pointerup", handlePointerUp);
    renderer.domElement.addEventListener("pointercancel", handlePointerUp);
    renderer.domElement.addEventListener("wheel", handleWheel, { passive: false });
    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("keyup", handleKeyUp);

    const updateScreenToWorld = () => {
      const aspect = FIXED_RENDER_WIDTH / FIXED_RENDER_HEIGHT;
      const halfHeight = ORTHO_HEIGHT * 0.5;
      const halfWidth = halfHeight * aspect;
      const unitRight = (halfWidth * 2) / FIXED_RENDER_WIDTH;
      const unitDown = (halfHeight * 2) / FIXED_RENDER_HEIGHT;
      screenUnitRight = unitRight;
      screenUnitDown = unitDown;

      cameraRight.set(1, 0, 0).applyQuaternion(camera.quaternion);
      cameraUp.set(0, 1, 0).applyQuaternion(camera.quaternion);

      screenRightWorld.copy(cameraRight).multiplyScalar(unitRight);
      screenDownWorld.copy(cameraUp).multiplyScalar(-unitDown);
    };

    let raf = 0;
    const render = () => {
      const zoomDelta = zoomTarget - zoomCurrent;
      if (Math.abs(zoomDelta) > 0.0005) {
        const hadAnchor =
          zoomAnchorActive &&
          worldAtClient(zoomAnchorX, zoomAnchorY, beforeZoomWorld);
        zoomCurrent = THREE.MathUtils.lerp(zoomCurrent, zoomTarget, 0.22);
        if (Math.abs(zoomTarget - zoomCurrent) < 0.0005) {
          zoomCurrent = zoomTarget;
        }
        resize(viewportWidth, viewportHeight);
        if (hadAnchor && worldAtClient(zoomAnchorX, zoomAnchorY, afterZoomWorld)) {
          cameraShift.copy(beforeZoomWorld).sub(afterZoomWorld);
          cameraTarget.add(cameraShift);
        }
      } else if (zoomAnchorActive) {
        zoomAnchorActive = false;
      }

      const yaw = CAMERA_YAW + yawIndex * (Math.PI * 0.5);

      const horizontal = Math.cos(CAMERA_PITCH);
      const dir = new THREE.Vector3(
        Math.sin(yaw) * horizontal,
        Math.sin(CAMERA_PITCH),
        Math.cos(yaw) * horizontal
      );

      camera.position.copy(cameraTarget).addScaledVector(dir, CAMERA_DISTANCE);
      camera.lookAt(cameraTarget);
      camera.updateProjectionMatrix();
      camera.updateMatrixWorld(true);

      if (lastYawIndex !== yawIndex || screenUnitRight === 0 || screenUnitDown === 0) {
        updateScreenToWorld();
        lastYawIndex = yawIndex;
      }

      cameraForward.set(0, 0, -1).applyQuaternion(camera.quaternion);
      const depth = cameraTarget.dot(cameraForward);
      const rightPx = Math.round(cameraTarget.dot(cameraRight) / screenUnitRight);
      const upPx = Math.round(cameraTarget.dot(cameraUp) / screenUnitDown);
      snappedCameraTarget
        .copy(cameraForward)
        .multiplyScalar(depth)
        .addScaledVector(cameraRight, rightPx * screenUnitRight)
        .addScaledVector(cameraUp, upPx * screenUnitDown);
      cameraTarget.copy(snappedCameraTarget);
      camera.position.copy(cameraTarget).addScaledVector(dir, CAMERA_DISTANCE);
      camera.lookAt(cameraTarget);
      camera.updateMatrixWorld(true);

      renderer.setRenderTarget(lowTarget);
      renderer.clear();
      renderer.render(scene, camera);

      if (keyPanActive) {
        applyPan(
          keyPanX / devicePixelRatio,
          keyPanY / devicePixelRatio
        );
      }

      renderer.setRenderTarget(null);
      renderer.clear();
      renderer.setViewport(
        padSize + panPhase.remainderX,
        // WebGL viewport Y is bottom-origin; screen-space pan remainder is top-origin.
        // Invert Y remainder so subpixel pan and camera-step pan move in the same direction.
        padSize - panPhase.remainderY,
        outputWidth,
        outputHeight
      );
      renderer.render(outputScene, outputCamera);
      renderer.setViewport(0, 0, outputWidth + padSize * 2, outputHeight + padSize * 2);

      raf = requestAnimationFrame(render);
    };

    render();

    return () => {
      cancelAnimationFrame(raf);
      observer.disconnect();
      renderer.domElement.removeEventListener("pointerdown", handlePointerDown);
      renderer.domElement.removeEventListener("pointermove", handlePointerMove);
      renderer.domElement.removeEventListener("pointerup", handlePointerUp);
      renderer.domElement.removeEventListener("pointercancel", handlePointerUp);
      renderer.domElement.removeEventListener("wheel", handleWheel);
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("keyup", handleKeyUp);

      mount.style.position = "";
      mount.style.background = "";
      mount.style.overflow = "";
      hud.remove();

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

      renderer.dispose();
      renderer.domElement.remove();
    };
  }
};

export default experiment;
