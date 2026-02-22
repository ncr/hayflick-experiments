import * as THREE from "three";
import { PixelPerfectIsoView } from "@common/render";
import { bindPixelPerfectIsoViewInput } from "@common/input";
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
const ORBIT_LIGHT_RADIUS = 10;
const ORBIT_LIGHT_BASE_Y = 10.8;
const ORBIT_LIGHT_Y_SWING = 0.45;
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
    scene.background = new THREE.Color(0xcfe9ff);

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

    const skyLight = new THREE.HemisphereLight(0xe2f2ff, 0xbbc89c, 0.95);
    const keyLight = new THREE.DirectionalLight(0xffffff, 1.6);
    keyLight.position.set(ORBIT_LIGHT_RADIUS, ORBIT_LIGHT_BASE_Y, 0);
    keyLight.castShadow = true;
    keyLight.shadow.mapSize.set(2048, 2048);
    keyLight.shadow.bias = -0.0002;
    keyLight.shadow.normalBias = 0.01;
    keyLight.shadow.camera.left = -12;
    keyLight.shadow.camera.right = 12;
    keyLight.shadow.camera.top = 12;
    keyLight.shadow.camera.bottom = -12;
    keyLight.shadow.camera.near = 0.1;
    keyLight.shadow.camera.far = 40;
    const keyTarget = new THREE.Object3D();
    keyTarget.position.set(0, 0, 0);
    keyLight.target = keyTarget;
    scene.add(skyLight, keyLight, keyTarget);

    const boardGroup = new THREE.Group();
    scene.add(boardGroup);
    const boardSize = 20;
    const tileGeometry = new THREE.PlaneGeometry(1, 1);
    const tileDark = new THREE.MeshStandardMaterial({
      color: 0x7d8590,
      roughness: 0.95,
      metalness: 0.02
    });
    const tileLight = new THREE.MeshStandardMaterial({
      color: 0xaab2bd,
      roughness: 0.93,
      metalness: 0.02
    });

    for (let x = 0; x < boardSize; x += 1) {
      for (let z = 0; z < boardSize; z += 1) {
        const tile = new THREE.Mesh(
          tileGeometry,
          (x + z) % 2 === 0 ? tileLight : tileDark
        );
        tile.rotation.x = -Math.PI * 0.5;
        tile.position.set(x - boardSize * 0.5 + 0.5, -0.001, z - boardSize * 0.5 + 0.5);
        tile.receiveShadow = true;
        boardGroup.add(tile);
      }
    }

    let movementMode: MovementMode = "stable-snapped";
    const placementBounds = new THREE.Box3();
    const placeOnGround = (
      object: THREE.Object3D,
      x: number,
      z: number,
      scale: number
    ): void => {
      object.scale.setScalar(scale);
      object.position.set(x, 0, z);
      object.updateMatrixWorld(true);
      placementBounds.setFromObject(object);
      object.position.y -= placementBounds.min.y;
      object.updateMatrixWorld(true);
    };

    const toShadowReceivingMaterial = (material: THREE.Material): THREE.Material => {
      if (material instanceof THREE.MeshBasicMaterial) {
        const converted = new THREE.MeshStandardMaterial({
          color: material.color.clone(),
          map: material.map,
          alphaMap: material.alphaMap,
          transparent: material.transparent,
          opacity: material.opacity,
          side: material.side,
          alphaTest: material.alphaTest,
          roughness: 0.9,
          metalness: 0.05
        });
        converted.name = material.name;
        converted.vertexColors = material.vertexColors;
        converted.wireframe = material.wireframe;
        converted.depthTest = material.depthTest;
        converted.depthWrite = material.depthWrite;
        converted.toneMapped = material.toneMapped;
        converted.shadowSide = converted.side;
        converted.needsUpdate = true;
        return converted;
      }

      material.shadowSide = material.side;
      material.needsUpdate = true;
      return material;
    };

    const enablePropMeshShadows = (root: THREE.Object3D): void => {
      root.traverse((object) => {
        if (!(object instanceof THREE.Mesh)) {
          return;
        }
        const geometry = object.geometry;
        if (geometry) {
          if (!geometry.getAttribute("normal")) {
            geometry.computeVertexNormals();
          } else {
            geometry.normalizeNormals();
          }
          geometry.computeBoundingSphere();
        }
        object.castShadow = true;
        object.receiveShadow = true;
        if (Array.isArray(object.material)) {
          object.material = object.material.map((entry) =>
            toShadowReceivingMaterial(entry)
          );
        } else {
          object.material = toShadowReceivingMaterial(object.material);
        }
      });
    };

    const dynamicMaterials: THREE.ShaderMaterial[] = [];
    const boxMaterial = new THREE.MeshStandardMaterial({
      color: 0xff7f3f,
      roughness: 0.72,
      metalness: 0.08
    });

    const boxGeometry = new THREE.BoxGeometry(1, 1, 1);
    const box = new THREE.Mesh(boxGeometry, boxMaterial);
    placeOnGround(box, 2, 0, 2);
    box.castShadow = true;
    box.receiveShadow = true;
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
      enablePropMeshShadows(chairRoot);
      scene.add(chairRoot);
    } catch (error) {
      console.error("[pixel-stable-moving-mesh] failed to load chair model", error);
    }

    try {
      const labDeviceGltf = await chairLoader.loadAsync(LAB_DEVICE_MODEL_URL);
      labDeviceRoot = labDeviceGltf.scene;
      placeOnGround(labDeviceRoot, 4.5, -1.5, 2);
      enablePropMeshShadows(labDeviceRoot);
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
      planterRoot.scale.setScalar(3);
      enablePropMeshShadows(planterRoot);
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
      placeOnGround(chestRoot, -4.5, 2.2, 2);
      enablePropMeshShadows(chestRoot);
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
    const playerBodyMaterial = new THREE.MeshStandardMaterial({
      color: 0x72c2ff,
      roughness: 0.62,
      metalness: 0.06
    });
    const playerHeadMaterial = new THREE.MeshStandardMaterial({
      color: 0xffd8a8,
      roughness: 0.58,
      metalness: 0.03
    });

    const playerBody = new THREE.Mesh(playerBodyGeometry, playerBodyMaterial);
    playerBody.position.y = 0.4;
    playerBody.castShadow = true;
    playerBody.receiveShadow = true;
    const playerHead = new THREE.Mesh(playerHeadGeometry, playerHeadMaterial);
    playerHead.position.y = 0.92;
    playerHead.castShadow = true;
    playerHead.receiveShadow = true;
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
      clearColor: 0xcfe9ff,
      clearAlpha: 1,
      mountBackground: "#cfe9ff",
      canvasBackground: "#cfe9ff"
    });
    const detachCameraInput = bindPixelPerfectIsoViewInput({ view });
    view.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    view.renderer.toneMappingExposure = 1.15;
    view.renderer.shadowMap.enabled = true;
    view.renderer.shadowMap.type = THREE.PCFSoftShadowMap;

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
        "Light: orbiting key light + shadows",
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
      const orbitAngle = nowMs * 0.00025;
      keyLight.position.set(
        Math.cos(orbitAngle) * ORBIT_LIGHT_RADIUS,
        ORBIT_LIGHT_BASE_Y + Math.sin(orbitAngle * 0.37) * ORBIT_LIGHT_Y_SWING,
        Math.sin(orbitAngle) * ORBIT_LIGHT_RADIUS
      );
      keyTarget.position.set(0, 0, 0);
      keyTarget.updateMatrixWorld();

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

      scene.remove(
        skyLight,
        keyLight,
        keyTarget,
        boardGroup,
        box,
        player
      );
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
      boxMaterial.dispose();
      playerBodyGeometry.dispose();
      playerHeadGeometry.dispose();
      dynamicMaterials.forEach((material) => material.dispose());
      detachCameraInput();
      view.dispose();
    };
  }
};

export default experiment;
