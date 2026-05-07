import * as THREE from "three";
import {
  PixelPerfectPane,
  SharedScissorStage,
  addStandardGameLighting,
  type StandardGameLightingHandle
} from "@common/render";
import type { ExperimentModule } from "../runtime/types";
import {
  buildGui,
  loadConfig,
  type GuiHandle,
  type ProbeConfig
} from "./gui";

// World scale in this project: 1 three.js scene unit = 1 "world unit" = 1.28 m.
// Box dimensions below are spec'd directly in world units (= tile-multiples)
// so their edges land on integer tile boundaries, giving clean staircases at
// integer-V presets.
//
// This experiment uses PixelPerfectPane (the lower-level configurable path)
// directly because the whole point is to compare different (FRH, BOH) pairs.
// IsoGameView locks the iso scale to ISO_VIEW_CONTRACT and is the right
// path for game render — but a calibration probe needs to break that lock.

const FLOOR_HALF_TILES = 4; // 8 wu x 8 wu = 10.24 m square floor

function buildScene(config: ProbeConfig): {
  scene: THREE.Scene;
  grid: THREE.LineSegments;
  meshes: THREE.Mesh[];
} {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x222428);

  const floorGeo = new THREE.PlaneGeometry(FLOOR_HALF_TILES * 2, FLOOR_HALF_TILES * 2);
  const floorMat = new THREE.MeshStandardMaterial({
    color: 0x4a4e54,
    roughness: 0.95,
    metalness: 0.0
  });
  const floor = new THREE.Mesh(floorGeo, floorMat);
  floor.rotation.x = -Math.PI / 2;
  floor.receiveShadow = true;
  scene.add(floor);

  // Tile grid on the floor (1 wu = 1.28 m intervals). Boxes are
  // tile-multiples so their edges align to these lines.
  const gridSegs: number[] = [];
  for (let i = -FLOOR_HALF_TILES; i <= FLOOR_HALF_TILES; i++) {
    gridSegs.push(i, 0.001, -FLOOR_HALF_TILES, i, 0.001, FLOOR_HALF_TILES);
    gridSegs.push(-FLOOR_HALF_TILES, 0.001, i, FLOOR_HALF_TILES, 0.001, i);
  }
  const gridGeo = new THREE.BufferGeometry();
  gridGeo.setAttribute(
    "position",
    new THREE.Float32BufferAttribute(gridSegs, 3)
  );
  const grid = new THREE.LineSegments(
    gridGeo,
    new THREE.LineBasicMaterial({ color: 0x6a7078, transparent: true, opacity: 0.55 })
  );
  grid.visible = config.showGrid;
  scene.add(grid);

  // Box A: 128 cm cube (1 tile x 1 tile x 1 tile).
  const boxAGeo = new THREE.BoxGeometry(1, 1, 1);
  const boxAMat = new THREE.MeshStandardMaterial({
    color: 0xb8c5d0,
    roughness: 0.7,
    metalness: 0.0
  });
  const boxA = new THREE.Mesh(boxAGeo, boxAMat);
  boxA.position.set(-1, 0.5, 0);
  boxA.castShadow = true;
  boxA.receiveShadow = true;
  scene.add(boxA);

  // Box B: 128 cm wide x 256 cm tall x 64 cm deep
  // (1 tile x 2 tile x 0.5 tile).
  const boxBGeo = new THREE.BoxGeometry(1, 2, 0.5);
  const boxBMat = new THREE.MeshStandardMaterial({
    color: 0xc89a6a,
    roughness: 0.7,
    metalness: 0.0
  });
  const boxB = new THREE.Mesh(boxBGeo, boxBMat);
  boxB.position.set(1, 1, 0);
  boxB.castShadow = true;
  boxB.receiveShadow = true;
  scene.add(boxB);

  return { scene, grid, meshes: [boxA, boxB] };
}

type Setup = {
  stage: SharedScissorStage;
  pane: PixelPerfectPane;
  lighting: StandardGameLightingHandle;
};

function buildSetup(
  mount: HTMLElement,
  width: number,
  height: number,
  scene: THREE.Scene,
  config: ProbeConfig
): Setup {
  const stage = new SharedScissorStage({
    mount,
    width,
    height,
    pixelRatio: Math.max(1, window.devicePixelRatio || 1),
    antialias: false,
    clearColor: 0x222428,
    clearAlpha: 1,
    shadows: config.shadows
  });

  const lighting = addStandardGameLighting(scene, {
    ambient: 0.55,
    keyColor: 0xfff2d6,
    keyIntensity: 1.4,
    keyDirection: [1, 2, 1.4],
    fillColor: 0xa6b5cc,
    fillIntensity: 0.32,
    shadows: config.shadows
  });

  const pane = new PixelPerfectPane({
    stage,
    id: "main",
    element: mount,
    scene,
    width,
    height,
    fixedRenderHeight: config.fixedRenderHeight,
    baseOrthoHeight: config.baseOrthoHeight,
    basePixelZoom: config.basePixelZoom,
    cameraPitch: "iso-2to1",
    cameraYaw: Math.PI / 4,
    shadows: config.shadows,
    outlines: config.outlines
      ? { outlineBrightness: 1.18, outlineMix: 0.85 }
      : false
  });

  if (config.shadows) {
    stage.renderer.shadowMap.type = THREE.BasicShadowMap;
    const sun = lighting.key;
    sun.castShadow = true;
    sun.shadow.mapSize.set(1024, 1024);
    sun.shadow.camera.left = -6;
    sun.shadow.camera.right = 6;
    sun.shadow.camera.top = 6;
    sun.shadow.camera.bottom = -6;
    sun.shadow.camera.near = 0.1;
    sun.shadow.camera.far = 30;
    sun.shadow.bias = -0.0005;
    sun.shadow.normalBias = 0.04;
    sun.shadow.camera.updateProjectionMatrix();
  }

  return { stage, pane, lighting };
}

const experiment: ExperimentModule = {
  id: "iso-scale-probe",
  title: "Iso Scale Probe",
  tags: ["threejs", "pixel-perfect", "iso", "calibration"],
  init: ({ mount, width, height }) => {
    const config = loadConfig();
    const { scene, grid } = buildScene(config);

    let setup = buildSetup(mount, width, height, scene, config);
    let mountWidth = width;
    let mountHeight = height;

    const rebuild = (): void => {
      setup.lighting.remove();
      setup.stage.dispose();
      setup = buildSetup(mount, mountWidth, mountHeight, scene, config);
    };

    const applyTogglesNoRebuild = (): void => {
      grid.visible = config.showGrid;
    };
    applyTogglesNoRebuild();

    const observer = new ResizeObserver((entries) => {
      for (const e of entries) {
        if (e.contentRect.width > 0 && e.contentRect.height > 0) {
          mountWidth = e.contentRect.width;
          mountHeight = e.contentRect.height;
          setup.stage.resize(
            mountWidth,
            mountHeight,
            Math.max(1, window.devicePixelRatio || 1)
          );
        }
      }
    });
    observer.observe(mount);

    let gui: GuiHandle | null = null;
    gui = buildGui(config, {
      onScaleChange: () => rebuild(),
      onZoomChange: () => rebuild(),
      onTogglesChange: () => {
        applyTogglesNoRebuild();
        rebuild();
      }
    });

    let raf = 0;
    let prev = performance.now();
    const tick = (): void => {
      raf = requestAnimationFrame(tick);
      const now = performance.now();
      const dt = Math.min((now - prev) / 1000, 0.1);
      prev = now;
      setup.stage.drawFrame(now, dt);
    };
    tick();

    return () => {
      cancelAnimationFrame(raf);
      observer.disconnect();
      gui?.destroy();
      setup.lighting.remove();
      setup.stage.dispose();
      // Scene meshes / materials cleanup — minor for a dev probe but
      // do it cleanly so HMR doesn't leak.
      scene.traverse((o) => {
        if (o instanceof THREE.Mesh) {
          o.geometry.dispose();
          if (Array.isArray(o.material)) {
            for (const mat of o.material) mat.dispose();
          } else {
            o.material.dispose();
          }
        } else if (o instanceof THREE.LineSegments) {
          o.geometry.dispose();
          (o.material as THREE.Material).dispose();
        }
      });
    };
  }
};

export default experiment;
