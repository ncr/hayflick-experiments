import * as THREE from "three";
import {
  SharedScissorStage,
  PixelPerfectViewportCore,
  PixelPerfectScissorPane
} from "@common/render";
import { bindSharedScissorStageInput } from "@common/input";
import { LEVEL_EDITOR_WORLD_UNIT } from "@common/level-editor";
import type { ExperimentModule } from "../runtime/types";
import { loadTilesetAssets, type TilesetAssets, type LoadedTile } from "../map-editor-2d/tileset-loader";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CAMERA_DISTANCE = 10;
const ISO_YAW = Math.PI / 4;

const VIEW_CONFIG = {
  fixedRenderHeight: 360,
  baseOrthoHeight: 2.5 * LEVEL_EDITOR_WORLD_UNIT,
  cameraDistance: CAMERA_DISTANCE,
  basePixelZoom: 1,
  zoomMin: 0.5,
  zoomMax: 10,
  zoomStep: 0.5,
  zoomAnimationRate: 12,
  zoomAnimationBurstRate: 24,
  zoomAnimationEpsilon: 0.01,
  rotationAnimationRate: 12,
  rotationAnimationEpsilon: 0.005,
  zoomBurstIdleMs: 300,
  outputOverscanLowPixels: 2
};

// ---------------------------------------------------------------------------
// Tile selector UI
// ---------------------------------------------------------------------------

function createTileSelector(
  parent: HTMLElement,
  assets: TilesetAssets,
  onSelect: (tile: LoadedTile) => void
): { destroy(): void; setActive(name: string): void } {
  const bar = document.createElement("div");
  bar.style.cssText = `
    position: absolute; top: 0; left: 0; right: 0; height: 36px;
    display: flex; align-items: center; gap: 6px; padding: 0 10px;
    background: #14181e; border-bottom: 1px solid #2a2e36;
    font: 12px/1 monospace; color: #aab; overflow-x: auto; z-index: 10;
  `;
  parent.appendChild(bar);

  const buttons = new Map<string, HTMLButtonElement>();

  for (const kit of assets.tilesets) {
    // Kit label
    const label = document.createElement("span");
    label.textContent = kit.manifest.name;
    label.style.cssText = "color:#667;margin-right:2px;";
    bar.appendChild(label);

    for (const [name, tile] of kit.tiles) {
      const btn = document.createElement("button");
      btn.textContent = name;
      btn.style.cssText = `
        background: #1e2430; color: #ccd; border: 1px solid #333;
        border-radius: 3px; padding: 3px 8px; cursor: pointer; font: inherit;
      `;
      btn.addEventListener("click", () => onSelect(tile));
      bar.appendChild(btn);
      buttons.set(name, btn);
    }

    // Separator between kits
    const sep = document.createElement("span");
    sep.style.cssText = "width:1px;height:18px;background:#333;flex-shrink:0;";
    bar.appendChild(sep);
  }

  function setActive(name: string): void {
    for (const [n, btn] of buttons) {
      btn.style.background = n === name ? "#36506a" : "#1e2430";
      btn.style.borderColor = n === name ? "#5a8ab4" : "#333";
    }
  }

  return {
    destroy() { bar.remove(); },
    setActive
  };
}

// ---------------------------------------------------------------------------
// Ground plane
// ---------------------------------------------------------------------------

function createGroundPlane(): THREE.Mesh {
  const size = 8;
  const geo = new THREE.PlaneGeometry(size, size);
  geo.rotateX(-Math.PI / 2);
  const mat = new THREE.MeshStandardMaterial({
    color: 0x2a2a2a,
    roughness: 0.95,
    metalness: 0.0
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.receiveShadow = true;
  mesh.position.y = -0.001; // slightly below origin so tiles sit on top
  return mesh;
}

// ---------------------------------------------------------------------------
// Experiment
// ---------------------------------------------------------------------------

const experiment: ExperimentModule = {
  id: "tile-viewer",
  title: "Tile Viewer",
  tags: ["editor", "tileset", "pbr"],

  async init(ctx) {
    const { mount, width, height } = ctx;
    mount.style.position = "relative";

    const SELECTOR_HEIGHT = 36;

    // Scene
    const scene = new THREE.Scene();

    // Ground plane for shadow reception
    const ground = createGroundPlane();
    scene.add(ground);

    // --- Lighting rig (matches map-editor-2d 3D pane) ---

    const keyLight = new THREE.DirectionalLight(0xfff1d6, 2.8);
    keyLight.position.set(14, 20, 10);
    keyLight.target.position.set(0, 0, 0);
    keyLight.castShadow = true;
    keyLight.shadow.mapSize.set(2048, 2048);
    const SHADOW_SPAN = 6;
    keyLight.shadow.camera.left = -SHADOW_SPAN;
    keyLight.shadow.camera.right = SHADOW_SPAN;
    keyLight.shadow.camera.far = 80;
    keyLight.shadow.camera.near = 0.5;
    keyLight.shadow.camera.top = SHADOW_SPAN;
    keyLight.shadow.camera.bottom = -SHADOW_SPAN;
    keyLight.shadow.bias = -0.0004;
    keyLight.shadow.normalBias = 0.02;
    keyLight.shadow.radius = 3;
    scene.add(keyLight);
    scene.add(keyLight.target);

    const hemiFill = new THREE.HemisphereLight(0xa9c6ff, 0x4d3a26, 0.85);
    hemiFill.position.set(0, 10, 0);
    scene.add(hemiFill);

    const rimLight = new THREE.DirectionalLight(0x9ec6ff, 2.2);
    rimLight.position.set(-14, 5, -16);
    rimLight.target.position.set(0, 0, 0);
    scene.add(rimLight);
    scene.add(rimLight.target);

    // Load tileset assets
    const assets = await loadTilesetAssets();

    // Current tile display group — swapped when selecting a different tile
    const tileGroup = new THREE.Group();
    scene.add(tileGroup);

    function showTile(tile: LoadedTile): void {
      // Clear previous
      while (tileGroup.children.length > 0) tileGroup.remove(tileGroup.children[0]);
      // Clone and add
      const clone = tile.template.clone();
      // Tile meshes are already scaled by LEVEL_EDITOR_WORLD_UNIT in tileset-loader
      // Center vertically: move up by half the mesh height
      const box = new THREE.Box3().setFromObject(clone);
      const center = new THREE.Vector3();
      box.getCenter(center);
      clone.position.set(-center.x, -box.min.y, -center.z);
      tileGroup.add(clone);
      selector.setActive(tile.entry.name);
    }

    // Pane container (below selector bar)
    const viewerEl = document.createElement("div");
    viewerEl.style.cssText = `
      position: absolute; top: ${SELECTOR_HEIGHT}px; left: 0; right: 0;
      height: calc(100% - ${SELECTOR_HEIGHT}px);
    `;
    mount.appendChild(viewerEl);

    // Stage
    const stage = new SharedScissorStage({
      mount,
      width,
      height,
      pixelRatio: Math.max(1, window.devicePixelRatio || 1),
      antialias: false,
      clearColor: 0x14181e,
      clearAlpha: 1
    });

    stage.renderer.outputColorSpace = THREE.SRGBColorSpace;
    stage.renderer.toneMapping = THREE.NoToneMapping;
    stage.renderer.toneMappingExposure = 1.0;
    stage.renderer.shadowMap.enabled = true;
    stage.renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    // Single iso viewport
    const core = new PixelPerfectViewportCore({
      ...VIEW_CONFIG,
      width: viewerEl.clientWidth || width,
      height: (viewerEl.clientHeight || height) - SELECTOR_HEIGHT,
      scene,
      cameraPitch: "iso-2to1",
      cameraYaw: ISO_YAW,
      clearColor: 0x14181e,
      maxBackingWidth: stage.maxBackingWidth,
      maxBackingHeight: stage.maxBackingHeight,
      devicePixelRatio: stage.getDevicePixelRatio()
    });

    const pane = new PixelPerfectScissorPane({
      id: "tile-viewer",
      element: viewerEl,
      core,
      devicePixelRatio: stage.getDevicePixelRatio()
    });
    stage.registerPane(pane);

    // Tag low target as sRGB + per-pane ACES tone mapping
    core.getLowTarget().texture.colorSpace = THREE.SRGBColorSpace;
    core.beforeSceneRender = (renderer) => {
      renderer.toneMapping = THREE.ACESFilmicToneMapping;
    };
    core.afterSceneRender = (renderer) => {
      renderer.toneMapping = THREE.NoToneMapping;
    };

    // Input: rotate (Q/E), zoom (wheel), pan (middle-click drag)
    let focusedPaneId: string | null = "tile-viewer";

    const unbindInput = bindSharedScissorStageInput({
      stage,
      getFocusedPaneId: () => focusedPaneId,
      setFocusedPaneId: (id) => { focusedPaneId = id; },
      getPaneInputTarget: () => pane
    });

    // Tile selector bar
    const selector = createTileSelector(mount, assets, showTile);

    // Show first tile by default
    const firstTile = assets.tiles.values().next().value;
    if (firstTile) showTile(firstTile);

    // Resize
    const resizeObserver = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const { width: w, height: h } = entry.contentRect;
        if (w > 0 && h > 0) {
          stage.resize(w, h, Math.max(1, window.devicePixelRatio || 1));
        }
      }
    });
    resizeObserver.observe(mount);

    // Frame loop
    let animId = 0;
    let lastTime = performance.now();
    const frame = (now: number): void => {
      animId = requestAnimationFrame(frame);
      const dt = Math.min((now - lastTime) / 1000, 0.1);
      lastTime = now;
      stage.drawFrame(now, dt);
    };
    animId = requestAnimationFrame(frame);

    // Cleanup
    return () => {
      cancelAnimationFrame(animId);
      resizeObserver.disconnect();
      unbindInput();
      selector.destroy();
      stage.dispose();
      viewerEl.remove();
    };
  }
};

export default experiment;
