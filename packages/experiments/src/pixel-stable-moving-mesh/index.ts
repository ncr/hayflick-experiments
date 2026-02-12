import * as THREE from "three";
import { PixelPerfectIsoView } from "@common/render";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import type { ExperimentModule } from "../runtime/types";
import {
  CAMERA_DISTANCE,
  CAMERA_PITCH,
  CAMERA_YAW,
  FIXED_RENDER_HEIGHT,
  ORTHO_HEIGHT
} from "../pixel-perfect-camera-zoom/config";

const ZOOM_MIN = 1;
const ZOOM_MAX = 6;
const ZOOM_STEP = 1;
const BASE_PIXEL_ZOOM = 2;
const ZOOM_ANIMATION_RATE = 14;
const ZOOM_ANIMATION_BURST_RATE = 42;
const ROTATION_ANIMATION_RATE = 18;
const ROTATION_ANIMATION_EPSILON = 1e-3;
const ZOOM_ANIMATION_EPSILON = 0.02;
const ZOOM_BURST_IDLE_MS = 90;
const OUTPUT_OVERSCAN_LOW_PIXELS = 2;
const CHAIR_MODEL_URL = new URL(
  "../../../../assets/models/optimized/chair-optimized.glb",
  import.meta.url
).href;
const LAB_DEVICE_MODEL_URL = new URL(
  "../../../../assets/models/optimized/futuristic-lab-device-optimized.glb",
  import.meta.url
).href;
const PLANTER_MODEL_URL = new URL(
  "../../../../assets/models/optimized/compact-hydroponic-planter-optimized.glb",
  import.meta.url
).href;
const CHEST_MODEL_URL = new URL(
  "../../../../assets/models/optimized/futuristic-storage-chest-optimized.glb",
  import.meta.url
).href;

type MovementMode = "unstable-free" | "stable-snapped";

function makePixelDitherMaterial(color: number): THREE.ShaderMaterial {
  const rgb = new THREE.Color(color);
  const material = new THREE.ShaderMaterial({
    uniforms: {
      uColor: { value: new THREE.Vector3(rgb.r, rgb.g, rgb.b) },
      uLightDir: { value: new THREE.Vector3(0.45, 0.85, 0.25).normalize() },
      uBands: { value: 5.0 },
      uDitherStrength: { value: 0.0 },
      uMode: { value: 1 },
      uScreenPixelSize: { value: 4.0 },
      uLocalScale: { value: 12.0 }
    },
    vertexShader: `
      varying vec3 vLocalPos;
      varying vec3 vNormalWorld;

      void main() {
        vLocalPos = position;
        vNormalWorld = normalize(mat3(modelMatrix) * normal);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      precision highp float;

      uniform vec3 uColor;
      uniform vec3 uLightDir;
      uniform float uBands;
      uniform float uDitherStrength;
      uniform int uMode;
      uniform float uScreenPixelSize;
      uniform float uLocalScale;

      varying vec3 vLocalPos;
      varying vec3 vNormalWorld;

      float bayer4x4(vec2 p) {
        vec2 q = mod(floor(p), 4.0);
        float x = q.x;
        float y = q.y;
        if (y < 1.0) {
          if (x < 1.0) return 0.0;
          if (x < 2.0) return 8.0;
          if (x < 3.0) return 2.0;
          return 10.0;
        }
        if (y < 2.0) {
          if (x < 1.0) return 12.0;
          if (x < 2.0) return 4.0;
          if (x < 3.0) return 14.0;
          return 6.0;
        }
        if (y < 3.0) {
          if (x < 1.0) return 3.0;
          if (x < 2.0) return 11.0;
          if (x < 3.0) return 1.0;
          return 9.0;
        }
        if (x < 1.0) return 15.0;
        if (x < 2.0) return 7.0;
        if (x < 3.0) return 13.0;
        return 5.0;
      }

      void main() {
        vec3 normal = normalize(vNormalWorld);
        float ndl = max(dot(normal, normalize(uLightDir)), 0.0);
        float lit = mix(0.28, 1.0, ndl);

        vec2 ditherCoord = uMode == 0
          ? floor(gl_FragCoord.xy / max(1.0, uScreenPixelSize))
          : floor(vLocalPos.xz * uLocalScale);
        float bayer = (bayer4x4(ditherCoord) + 0.5) / 16.0 - 0.5;

        float levels = max(2.0, uBands);
        float dithered = clamp(lit + bayer * uDitherStrength, 0.0, 1.0);
        float quantized = floor(dithered * (levels - 1.0) + 0.5) / (levels - 1.0);
        gl_FragColor = vec4(uColor * quantized, 1.0);
      }
    `
  });
  return material;
}

const experiment: ExperimentModule = {
  id: "pixel-stable-moving-mesh",
  title: "Pixel Stable Moving Mesh",
  tags: ["pixel", "isometric", "rendering", "prototype"],
  init: async ({ mount, width, height }) => {
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x0b0f14);

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

    const ambient = new THREE.AmbientLight(0xf6fbff, 0.95);
    const keyLight = new THREE.DirectionalLight(0xfff5e8, 1.3);
    keyLight.position.set(7, 10, 6);
    const fillLight = new THREE.DirectionalLight(0xbfd7ff, 0.7);
    fillLight.position.set(-6, 7, -5);
    const rimLight = new THREE.DirectionalLight(0xffffff, 0.45);
    rimLight.position.set(-3, 5, 8);
    scene.add(ambient, keyLight, fillLight, rimLight);

    const boardGroup = new THREE.Group();
    scene.add(boardGroup);
    const boardSize = 20;
    const tileGeometry = new THREE.PlaneGeometry(1, 1);
    const tileDark = new THREE.MeshBasicMaterial({ color: 0x7d8590 });
    const tileLight = new THREE.MeshBasicMaterial({ color: 0xaab2bd });

    for (let x = 0; x < boardSize; x += 1) {
      for (let z = 0; z < boardSize; z += 1) {
        const tile = new THREE.Mesh(
          tileGeometry,
          (x + z) % 2 === 0 ? tileLight : tileDark
        );
        tile.rotation.x = -Math.PI * 0.5;
        tile.position.set(x - boardSize * 0.5 + 0.5, -0.001, z - boardSize * 0.5 + 0.5);
        boardGroup.add(tile);
      }
    }

    let movementMode: MovementMode = "stable-snapped";

    const dynamicMaterials: THREE.ShaderMaterial[] = [];
    const boxMaterial = makePixelDitherMaterial(0xff7f3f);
    dynamicMaterials.push(boxMaterial);

    const boxGeometry = new THREE.BoxGeometry(1, 1, 1);
    const box = new THREE.Mesh(boxGeometry, boxMaterial);
    box.position.set(2, 0.5, 0);
    scene.add(box);

    const chairLoader = new GLTFLoader();
    let chairRoot: THREE.Group | null = null;
    let labDeviceRoot: THREE.Group | null = null;
    let planterRoot: THREE.Group | null = null;
    let chestRoot: THREE.Group | null = null;
    try {
      const chairGltf = await chairLoader.loadAsync(CHAIR_MODEL_URL);
      chairRoot = chairGltf.scene;
      chairRoot.position.set(-2.5, 0.5, 0);
      chairRoot.traverse((object) => {
        if (object instanceof THREE.Mesh) {
          object.castShadow = false;
          object.receiveShadow = false;
        }
      });
      scene.add(chairRoot);
    } catch (error) {
      console.error("[pixel-stable-moving-mesh] failed to load chair model", error);
    }

    try {
      const labDeviceGltf = await chairLoader.loadAsync(LAB_DEVICE_MODEL_URL);
      labDeviceRoot = labDeviceGltf.scene;
      labDeviceRoot.position.set(4.5, 0, -1.5);
      labDeviceRoot.traverse((object) => {
        if (object instanceof THREE.Mesh) {
          object.castShadow = false;
          object.receiveShadow = false;
        }
      });
      scene.add(labDeviceRoot);
    } catch (error) {
      console.error(
        "[pixel-stable-moving-mesh] failed to load lab device model",
        error
      );
    }

    try {
      const planterGltf = await chairLoader.loadAsync(PLANTER_MODEL_URL);
      planterRoot = planterGltf.scene;
      planterRoot.position.set(0.5, 0, 3.5);
      planterRoot.traverse((object) => {
        if (object instanceof THREE.Mesh) {
          object.castShadow = false;
          object.receiveShadow = false;
        }
      });
      scene.add(planterRoot);
    } catch (error) {
      console.error(
        "[pixel-stable-moving-mesh] failed to load planter model",
        error
      );
    }

    try {
      const chestGltf = await chairLoader.loadAsync(CHEST_MODEL_URL);
      chestRoot = chestGltf.scene;
      chestRoot.position.set(-4.5, 0, 2.2);
      chestRoot.traverse((object) => {
        if (object instanceof THREE.Mesh) {
          object.castShadow = false;
          object.receiveShadow = false;
        }
      });
      scene.add(chestRoot);
    } catch (error) {
      console.error(
        "[pixel-stable-moving-mesh] failed to load chest model",
        error
      );
    }

    const player = new THREE.Group();
    const playerBodyGeometry = new THREE.CylinderGeometry(0.18, 0.25, 0.8, 14, 1);
    const playerHeadGeometry = new THREE.SphereGeometry(0.2, 14, 12);
    const playerBodyMaterial = makePixelDitherMaterial(0x72c2ff);
    const playerHeadMaterial = makePixelDitherMaterial(0xffd8a8);
    dynamicMaterials.push(playerBodyMaterial, playerHeadMaterial);

    const playerBody = new THREE.Mesh(playerBodyGeometry, playerBodyMaterial);
    playerBody.position.y = 0.4;
    const playerHead = new THREE.Mesh(playerHeadGeometry, playerHeadMaterial);
    playerHead.position.y = 0.92;
    player.add(playerBody, playerHead);
    player.position.set(0, 0, 0);
    scene.add(player);

    const view = new PixelPerfectIsoView({
      mount,
      width,
      height,
      scene,
      fixedRenderHeight: FIXED_RENDER_HEIGHT,
      baseOrthoHeight: ORTHO_HEIGHT,
      cameraDistance: CAMERA_DISTANCE,
      cameraPitch: CAMERA_PITCH,
      cameraYaw: CAMERA_YAW,
      basePixelZoom: BASE_PIXEL_ZOOM,
      zoomMin: ZOOM_MIN,
      zoomMax: ZOOM_MAX,
      zoomStep: ZOOM_STEP,
      zoomAnimationRate: ZOOM_ANIMATION_RATE,
      zoomAnimationBurstRate: ZOOM_ANIMATION_BURST_RATE,
      zoomAnimationEpsilon: ZOOM_ANIMATION_EPSILON,
      rotationAnimationRate: ROTATION_ANIMATION_RATE,
      rotationAnimationEpsilon: ROTATION_ANIMATION_EPSILON,
      zoomBurstIdleMs: ZOOM_BURST_IDLE_MS,
      outputOverscanLowPixels: OUTPUT_OVERSCAN_LOW_PIXELS,
      clearColor: 0x0b0f14,
      clearAlpha: 1,
      mountBackground: "#0b0f14",
      canvasBackground: "#0b0f14"
    });
    view.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    view.renderer.toneMappingExposure = 1.22;

    const pressedKeys = new Set<string>();
    const playerSpeed = 3.2;
    const inputRight = new THREE.Vector3();
    const inputForward = new THREE.Vector3();
    const playerLogical = new THREE.Vector2(0, 0);
    const snappedGround = new THREE.Vector3();

    const syncHud = () => {
      const state = view.getState();
      hud.textContent = [
        "Shading: no dithering",
        `Movement mode: ${movementMode === "stable-snapped" ? "stable-snapped" : "unstable-free"} (M toggle)`,
        `Player: WASD / arrows`,
        `Camera: middle-drag pan, wheel zoom, Q/E rotate`,
        `Zoom: ${state.cameraZoomCurrent.toFixed(2)}x target ${state.cameraZoomTarget.toFixed(2)}x`
      ].join("\n");
    };

    const setMovementMode = (nextMode: MovementMode): void => {
      movementMode = nextMode;
      dynamicMaterials.forEach((material) => {
        material.uniforms.uMode.value = 1;
        material.uniforms.uDitherStrength.value = 0.0;
      });
      syncHud();
    };

    const onKeyDown = (event: KeyboardEvent) => {
      pressedKeys.add(event.code);
      if (event.code === "KeyM") {
        const nextMode: MovementMode =
          movementMode === "stable-snapped" ? "unstable-free" : "stable-snapped";
        setMovementMode(nextMode);
        event.preventDefault();
      }
    };

    const onKeyUp = (event: KeyboardEvent) => {
      pressedKeys.delete(event.code);
    };

    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);

    let raf = 0;
    let lastFrameTimeMs = performance.now();
    const render = (nowMs: number) => {
      const deltaSeconds = Math.min(0.05, Math.max(0, (nowMs - lastFrameTimeMs) / 1000));
      lastFrameTimeMs = nowMs;

      const inputX =
        (pressedKeys.has("KeyD") || pressedKeys.has("ArrowRight") ? 1 : 0) -
        (pressedKeys.has("KeyA") || pressedKeys.has("ArrowLeft") ? 1 : 0);
      const inputY =
        (pressedKeys.has("KeyW") || pressedKeys.has("ArrowUp") ? 1 : 0) -
        (pressedKeys.has("KeyS") || pressedKeys.has("ArrowDown") ? 1 : 0);
      if (inputX !== 0 || inputY !== 0) {
        inputRight.set(1, 0, 0).applyQuaternion(view.camera.quaternion);
        inputRight.y = 0;
        if (inputRight.lengthSq() > 0.000001) {
          inputRight.normalize();
        }

        inputForward.set(0, 0, -1).applyQuaternion(view.camera.quaternion);
        inputForward.y = 0;
        if (inputForward.lengthSq() > 0.000001) {
          inputForward.normalize();
        }

        let moveX = inputRight.x * inputX + inputForward.x * inputY;
        let moveZ = inputRight.z * inputX + inputForward.z * inputY;
        const length = Math.hypot(moveX, moveZ);
        moveX /= length;
        moveZ /= length;
        const step = playerSpeed * deltaSeconds;
        playerLogical.x += moveX * step;
        playerLogical.y += moveZ * step;
      }

      if (movementMode === "stable-snapped") {
        snappedGround.set(playerLogical.x, 0, playerLogical.y);
        if (view.snapWorldPointOnGround(snappedGround, snappedGround)) {
          player.position.copy(snappedGround);
        } else {
          player.position.set(playerLogical.x, 0, playerLogical.y);
        }
      } else {
        player.position.set(playerLogical.x, 0, playerLogical.y);
      }
      view.frame(nowMs, deltaSeconds);
      raf = requestAnimationFrame(render);
    };

    syncHud();
    raf = requestAnimationFrame(render);

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      hud.remove();

      scene.remove(ambient, keyLight, fillLight, rimLight, boardGroup, box, player);
      if (chairRoot) {
        scene.remove(chairRoot);
      }
      if (labDeviceRoot) {
        scene.remove(labDeviceRoot);
      }
      if (planterRoot) {
        scene.remove(planterRoot);
      }
      if (chestRoot) {
        scene.remove(chestRoot);
      }
      tileGeometry.dispose();
      tileDark.dispose();
      tileLight.dispose();
      boxGeometry.dispose();
      playerBodyGeometry.dispose();
      playerHeadGeometry.dispose();
      dynamicMaterials.forEach((material) => material.dispose());
      view.dispose();
    };
  }
};

export default experiment;
