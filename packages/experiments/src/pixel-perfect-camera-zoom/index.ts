import * as THREE from "three";
import type { ExperimentModule } from "../runtime/types";
import { PixelPerfectIsoView } from "@common/render";
import {
  CAMERA_DISTANCE,
  CAMERA_PITCH,
  CAMERA_YAW,
  FIXED_RENDER_HEIGHT,
  GRID_SIZE,
  ORTHO_HEIGHT
} from "../pixel-perfect-2to1/config";

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

type CameraZoomDebugApi = {
  getState: () => {
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
  };
  worldAtClient: (clientX: number, clientY: number) => {
    x: number;
    y: number;
    z: number;
  } | null;
  projectWorldToClient: (
    x: number,
    y: number,
    z: number
  ) => {
    clientX: number;
    clientY: number;
  } | null;
};

const experiment: ExperimentModule = {
  id: "pixel-perfect-camera-zoom",
  title: "Pixel Perfect (Camera Zoom)",
  tags: ["pixel", "isometric", "rendering"],
  init: ({ mount, width, height }) => {
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
        tile.position.set(x - GRID_SIZE * 0.5 + 0.5, -0.001, z - GRID_SIZE * 0.5 + 0.5);
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
      const mesh = new THREE.Mesh(boxGeometry, boxMaterials[colorIndex % boxMaterials.length]);
      mesh.position.set(x, y, z);
      scene.add(mesh);
      boxes.push(mesh);
    };
    addBox(-3, 0.5, -2, 0);
    addBox(-1, 0.5, 2, 1);
    addBox(2, 0.5, -1, 2);
    addBox(3, 0.5, 3, 3);
    addBox(0, 1.5, 0, 0);

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

    const projectedWorld = new THREE.Vector3();
    const projectedClient = new THREE.Vector2();

    const syncHud = () => {
      const state = view.getState();
      hud.textContent = [
        `Camera zoom: ${state.cameraZoomCurrent.toFixed(3)}x (target ${state.cameraZoomTarget.toFixed(3)}x)`,
        `Zoom mode: fixed render`,
        `DPR: ${state.devicePixelRatio.toFixed(3)}`,
        `Low-res: ${state.lowRenderWidth}x${state.lowRenderHeight}`,
        `Render viewport: ${Math.round(state.sceneOutputWidth)}x${Math.round(state.sceneOutputHeight)} (scale ${state.displayRenderScale.toFixed(3)}x)`,
        `Keys: Q/E rotate, wheel zoom, middle-drag pan, Z toggle zoom mode`,
        `Note: render target size stays constant; orthographic frustum changes`
      ].join("\n");
    };

    const debugWindow = window as Window & {
      __pixelPerfectCameraZoomDebug?: CameraZoomDebugApi;
    };

    const debugApi: CameraZoomDebugApi = {
      getState: () => {
        const state = view.getState();
        return {
          cameraZoomCurrent: state.cameraZoomCurrent,
          cameraZoomTarget: state.cameraZoomTarget,
          zoomAnimationActive: state.zoomAnimationActive,
          zoomBurstActive: state.zoomBurstActive,
          controllerRenderScale: state.controllerRenderScale,
          displayRenderScale: state.displayRenderScale,
          lowRenderWidth: state.lowRenderWidth,
          lowRenderHeight: state.lowRenderHeight,
          sceneOutputWidth: state.sceneOutputWidth,
          sceneOutputHeight: state.sceneOutputHeight
        };
      },
      worldAtClient: (clientX: number, clientY: number) => {
        if (!view.worldAtClient(clientX, clientY, projectedWorld)) {
          return null;
        }
        return {
          x: projectedWorld.x,
          y: projectedWorld.y,
          z: projectedWorld.z
        };
      },
      projectWorldToClient: (x: number, y: number, z: number) => {
        projectedWorld.set(x, y, z);
        if (!view.projectWorldToClient(projectedWorld, projectedClient)) {
          return null;
        }
        return {
          clientX: projectedClient.x,
          clientY: projectedClient.y
        };
      }
    };

    debugWindow.__pixelPerfectCameraZoomDebug = debugApi;

    let raf = 0;
    let lastFrameTimeMs = performance.now();
    const render = (nowMs: number) => {
      const deltaSeconds = Math.min(0.05, Math.max(0, (nowMs - lastFrameTimeMs) / 1000));
      lastFrameTimeMs = nowMs;
      view.frame(nowMs, deltaSeconds);
      syncHud();
      raf = requestAnimationFrame(render);
    };

    syncHud();
    raf = requestAnimationFrame(render);

    return () => {
      cancelAnimationFrame(raf);
      hud.remove();
      if (debugWindow.__pixelPerfectCameraZoomDebug === debugApi) {
        delete debugWindow.__pixelPerfectCameraZoomDebug;
      }
      boxes.forEach((mesh) => scene.remove(mesh));
      scene.remove(floorGroup);
      scene.remove(ambient, keyLight);
      tileGeometry.dispose();
      tileWhite.dispose();
      tileGray.dispose();
      boxGeometry.dispose();
      boxMaterials.forEach((material) => material.dispose());
      view.dispose();
    };
  }
};

export default experiment;
