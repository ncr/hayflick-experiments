import * as THREE from "three";
import {
  SharedScissorStage,
  PixelPerfectViewportCore,
  PixelPerfectScissorPane,
  TILESET_VIEWER_TARGET_CONFIG,
  TILESET_VIEWER_NORMAL_CONFIG
} from "@common/render";
import { bindPixelPerfectPaneBroadcast } from "@common/input";
import type { ExperimentModule } from "../runtime/types";
import { loadTilesetAssets, type TilesetAssets, type LoadedTile } from "../map-editor-2d/tileset-loader";

// ---------------------------------------------------------------------------
// Layers — both cameras see layer 0 (ground + lights). Each camera also
// enables its own private layer where a differently-filtered tile clone lives.
// ---------------------------------------------------------------------------

const NORMAL_LAYER = 1;
const TARGET_LAYER = 2;

const TARGET_VIEW_CONFIG = TILESET_VIEWER_TARGET_CONFIG;
const NORMAL_VIEW_CONFIG = TILESET_VIEWER_NORMAL_CONFIG;

// ---------------------------------------------------------------------------
// Tile selector UI (touch-friendly)
// ---------------------------------------------------------------------------

const SELECTOR_HEIGHT = 44;

function createTileSelector(
  parent: HTMLElement,
  assets: TilesetAssets,
  onSelect: (tile: LoadedTile) => void
): { destroy(): void; setActive(name: string): void } {
  const bar = document.createElement("div");
  bar.style.cssText = `
    position: absolute; top: 0; left: 0; right: 0; height: ${SELECTOR_HEIGHT}px;
    display: flex; align-items: center; gap: 4px; padding: 0 8px;
    background: #14181e; border-bottom: 1px solid #2a2e36;
    font: 13px/1 monospace; color: #aab; overflow-x: auto;
    -webkit-overflow-scrolling: touch; z-index: 10;
  `;
  parent.appendChild(bar);

  const buttons = new Map<string, HTMLButtonElement>();

  for (const kit of assets.tilesets) {
    const label = document.createElement("span");
    label.textContent = kit.manifest.name.replace(/_/g, " ");
    label.style.cssText = "color:#667;margin-right:2px;white-space:nowrap;font-size:11px;";
    bar.appendChild(label);

    for (const [name, tile] of kit.tiles) {
      const btn = document.createElement("button");
      btn.textContent = name.replace(/_/g, " ");
      btn.style.cssText = `
        background: #1e2430; color: #ccd; border: 1px solid #333;
        border-radius: 4px; padding: 6px 10px; cursor: pointer;
        font: inherit; white-space: nowrap; min-height: 32px;
      `;
      btn.addEventListener("click", () => onSelect(tile));
      bar.appendChild(btn);
      buttons.set(name, btn);
    }

    const sep = document.createElement("span");
    sep.style.cssText = "width:1px;height:20px;background:#333;flex-shrink:0;";
    bar.appendChild(sep);
  }

  function setActive(name: string): void {
    for (const [n, btn] of buttons) {
      btn.style.background = n === name ? "#36506a" : "#1e2430";
      btn.style.borderColor = n === name ? "#5a8ab4" : "#333";
    }
  }

  return { destroy() { bar.remove(); }, setActive };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function addPaneLabel(parent: HTMLElement, text: string): HTMLDivElement {
  const el = document.createElement("div");
  el.textContent = text;
  el.style.cssText = `
    position: absolute; top: 4px; left: 8px; z-index: 5;
    font: 11px/1 monospace; color: #556; pointer-events: none;
  `;
  parent.appendChild(el);
  return el;
}

function createGroundPlane(): THREE.Mesh {
  const geo = new THREE.PlaneGeometry(8, 8);
  geo.rotateX(-Math.PI / 2);
  const mat = new THREE.MeshStandardMaterial({ color: 0x2a2a2a, roughness: 0.95, metalness: 0 });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.receiveShadow = true;
  mesh.position.y = -0.001;
  return mesh;
}

function setLayerRecursive(obj: THREE.Object3D, layer: number): void {
  obj.layers.set(layer);
  for (const child of obj.children) setLayerRecursive(child, layer);
}

function setTextureFiltering(group: THREE.Group, filter: THREE.MagnificationTextureFilter): void {
  group.traverse((obj) => {
    if (!(obj instanceof THREE.Mesh)) return;
    const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
    for (const mat of mats) {
      if (mat instanceof THREE.MeshStandardMaterial && mat.map) {
        mat.map.magFilter = filter;
        mat.map.minFilter = filter;
        mat.map.needsUpdate = true;
      }
    }
  });
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

    // Scene (shared by both panes via layers)
    const scene = new THREE.Scene();

    const ground = createGroundPlane();
    scene.add(ground); // layer 0

    // Lighting on layer 0 (both cameras).
    // The key light orbits slowly so normal-map relief and roughness
    // variation are visible as the light angle changes.
    const KEY_RADIUS = 20;
    const KEY_HEIGHT = 18;
    const KEY_ORBIT_SPEED = 2 * Math.PI / 10; // one full revolution in 10s
    const keyLight = new THREE.DirectionalLight(0xfff1d6, 2.8);
    keyLight.castShadow = true;
    keyLight.shadow.mapSize.set(2048, 2048);
    const S = 6;
    keyLight.shadow.camera.left = -S;
    keyLight.shadow.camera.right = S;
    keyLight.shadow.camera.top = S;
    keyLight.shadow.camera.bottom = -S;
    keyLight.shadow.camera.near = 0.5;
    keyLight.shadow.camera.far = 80;
    keyLight.shadow.bias = -0.0004;
    keyLight.shadow.normalBias = 0.02;
    keyLight.shadow.radius = 3;
    scene.add(keyLight);
    scene.add(keyLight.target);

    const hemiFill = new THREE.HemisphereLight(0xa9c6ff, 0x4d3a26, 0.85);
    scene.add(hemiFill);

    const rimLight = new THREE.DirectionalLight(0x9ec6ff, 2.2);
    rimLight.position.set(-14, 5, -16);
    scene.add(rimLight);
    scene.add(rimLight.target);

    // Tile groups on private layers
    const normalTileGroup = new THREE.Group();
    const targetTileGroup = new THREE.Group();
    scene.add(normalTileGroup);
    scene.add(targetTileGroup);

    // Load tileset assets
    const assets = await loadTilesetAssets();

    function showTile(tile: LoadedTile): void {
      while (normalTileGroup.children.length > 0) normalTileGroup.remove(normalTileGroup.children[0]);
      while (targetTileGroup.children.length > 0) targetTileGroup.remove(targetTileGroup.children[0]);

      const measure = tile.template.clone();
      const box = new THREE.Box3().setFromObject(measure);
      const center = new THREE.Vector3();
      box.getCenter(center);
      const ox = -center.x, oy = -box.min.y, oz = -center.z;

      // Normal view: linear texture filtering
      const normalClone = tile.template.clone();
      normalClone.position.set(ox, oy, oz);
      setTextureFiltering(normalClone, THREE.LinearFilter);
      normalClone.traverse((o) => {
        if (o instanceof THREE.Mesh) { o.castShadow = true; o.receiveShadow = true; }
      });
      setLayerRecursive(normalClone, NORMAL_LAYER);
      normalTileGroup.add(normalClone);

      // Target view: linear filtering on baseColor — the pixel-art grid
      // comes from the low-res render target (360p), not from nearest
      // texture sampling. Linear smooths harsh texel boundaries within
      // surfaces while mesh edges stay sharp at the render budget.
      const targetClone = tile.template.clone();
      targetClone.position.set(ox, oy, oz);
      setTextureFiltering(targetClone, THREE.LinearFilter);
      targetClone.traverse((o) => {
        if (o instanceof THREE.Mesh) { o.castShadow = true; o.receiveShadow = true; }
      });
      setLayerRecursive(targetClone, TARGET_LAYER);
      targetTileGroup.add(targetClone);

      selector.setActive(tile.entry.name);
    }

    // --- Layout: selector bar + two panes stacked vertically ---

    const topEl = document.createElement("div");
    topEl.style.cssText = `
      position: absolute; top: ${SELECTOR_HEIGHT}px; left: 0; right: 0;
      height: calc(50% - ${SELECTOR_HEIGHT / 2}px);
    `;
    mount.appendChild(topEl);
    addPaneLabel(topEl, "normal");

    const bottomEl = document.createElement("div");
    bottomEl.style.cssText = `
      position: absolute; bottom: 0; left: 0; right: 0;
      height: calc(50% - ${SELECTOR_HEIGHT / 2}px);
      border-top: 1px solid #2a2e36;
    `;
    mount.appendChild(bottomEl);
    addPaneLabel(bottomEl, "target");

    // Stage
    const stage = new SharedScissorStage({
      mount, width, height,
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

    const dpr = stage.getDevicePixelRatio();
    const maxW = stage.maxBackingWidth;
    const maxH = stage.maxBackingHeight;

    // Top pane: normal (higher internal res, MSAA)
    const normalCore = new PixelPerfectViewportCore({
      ...NORMAL_VIEW_CONFIG,
      width: topEl.clientWidth || width,
      height: topEl.clientHeight || Math.round(height / 2),
      scene,
      clearColor: 0x14181e,
      maxBackingWidth: maxW, maxBackingHeight: maxH,
      devicePixelRatio: dpr
    });
    normalCore.camera.layers.enable(NORMAL_LAYER);
    normalCore.getLowTarget().texture.colorSpace = THREE.SRGBColorSpace;
    normalCore.beforeSceneRender = (r) => { r.toneMapping = THREE.ACESFilmicToneMapping; };
    normalCore.afterSceneRender = (r) => { r.toneMapping = THREE.NoToneMapping; };

    const normalPane = new PixelPerfectScissorPane({
      id: "normal", element: topEl, core: normalCore, devicePixelRatio: dpr
    });
    stage.registerPane(normalPane);

    // Bottom pane: target (canonical pixel-art, no MSAA)
    const targetCore = new PixelPerfectViewportCore({
      ...TARGET_VIEW_CONFIG,
      width: bottomEl.clientWidth || width,
      height: bottomEl.clientHeight || Math.round(height / 2),
      scene,
      clearColor: 0x14181e,
      maxBackingWidth: maxW, maxBackingHeight: maxH,
      devicePixelRatio: dpr,
      lowTargetSamples: 0
    });
    targetCore.camera.layers.enable(TARGET_LAYER);
    targetCore.getLowTarget().texture.colorSpace = THREE.SRGBColorSpace;
    targetCore.beforeSceneRender = (r) => { r.toneMapping = THREE.ACESFilmicToneMapping; };
    targetCore.afterSceneRender = (r) => { r.toneMapping = THREE.NoToneMapping; };

    const targetPane = new PixelPerfectScissorPane({
      id: "target", element: bottomEl, core: targetCore, devicePixelRatio: dpr
    });
    stage.registerPane(targetPane);

    const unbindInput = bindPixelPerfectPaneBroadcast({
      stage,
      panes: [normalPane, targetPane]
    });

    // Tile selector
    const selector = createTileSelector(mount, assets, showTile);

    // Show concrete_walk by default (good test case for pixel-art readability)
    const defaultTile = assets.tiles.get("concrete_walk") ?? assets.tiles.values().next().value;
    if (defaultTile) showTile(defaultTile);

    // Resize
    const resizeObs = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const { width: w, height: h } = entry.contentRect;
        if (w > 0 && h > 0) stage.resize(w, h, Math.max(1, window.devicePixelRatio || 1));
      }
    });
    resizeObs.observe(mount);

    // Frame loop
    let animId = 0;
    let lastTime = performance.now();
    let keyAngle = 0;
    const frame = (now: number): void => {
      animId = requestAnimationFrame(frame);
      const dt = Math.min((now - lastTime) / 1000, 0.1);
      lastTime = now;

      // Orbit the key light
      keyAngle += KEY_ORBIT_SPEED * dt;
      keyLight.position.set(
        Math.cos(keyAngle) * KEY_RADIUS,
        KEY_HEIGHT,
        Math.sin(keyAngle) * KEY_RADIUS
      );

      stage.drawFrame(now, dt);
    };
    animId = requestAnimationFrame(frame);

    return () => {
      cancelAnimationFrame(animId);
      resizeObs.disconnect();
      unbindInput();
      selector.destroy();
      stage.dispose();
      topEl.remove();
      bottomEl.remove();
    };
  }
};

export default experiment;
