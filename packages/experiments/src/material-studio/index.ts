import * as THREE from "three";
import {
  SharedScissorStage,
  PixelPerfectPane,
  TILESET_VIEWER_TARGET_CONFIG,
  TILESET_VIEWER_NORMAL_CONFIG
} from "@common/render";
import { bindPixelPerfectPaneBroadcast } from "@common/input";
import type { ExperimentModule } from "../runtime/types";
import { loadTilesetAssets, type LoadedTile } from "../map-editor-2d/tileset-loader";

import type { KitInfo, MaterialRole, GeneratedMaps } from "./types";
import { DEFAULT_PBR_PARAMS } from "./types";
import { derivePbrMaps } from "./pbr-derive";
import { generateBaseColor, saveTexturesToAssets, buildPromptForMaterial } from "./api-client";
import { createTextureSet, applyTexturesToGroup } from "./texture-swap";
import { createControlPanel } from "./control-panel";

// ---------------------------------------------------------------------------
// Layers
// ---------------------------------------------------------------------------

const NORMAL_LAYER = 1;
const TARGET_LAYER = 2;

const PANEL_WIDTH = 320;

const TARGET_VIEW_CONFIG = TILESET_VIEWER_TARGET_CONFIG;
const NORMAL_VIEW_CONFIG = TILESET_VIEWER_NORMAL_CONFIG;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function addPaneLabel(parent: HTMLElement, text: string): void {
  const el = document.createElement("div");
  el.textContent = text;
  el.style.cssText = `
    position: absolute; top: 4px; left: 8px; z-index: 5;
    font: 11px/1 monospace; color: #556; pointer-events: none;
  `;
  parent.appendChild(el);
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
// Kit metadata extraction
// ---------------------------------------------------------------------------

/** Tileset directory names — same order as tileset-loader's KIT_IDS. */
const KIT_DIR_IDS: ReadonlyArray<string> = ["desert_sandstone", "greek_island_white", "ground_tiles"];

async function loadKitRoles(dirId: string): Promise<{ kind: "wall_kit" | "ground"; roles: MaterialRole[] }> {
  const res = await fetch(`/api/assets/read?path=tilesets/${dirId}/tileset.json`);
  if (!res.ok) throw new Error(`Failed to load tileset.json for ${dirId}`);
  const json = await res.json();
  const spec = typeof json.content === "string" ? JSON.parse(json.content) : json;

  const roles: MaterialRole[] = [];
  const kind = spec.kind === "ground" ? "ground" as const : "wall_kit" as const;
  const authoring = spec.textures?.authoring;

  if (kind === "wall_kit" && authoring) {
    if (authoring.wallMaterial) roles.push({ role: "wall", materialId: authoring.wallMaterial });
    if (authoring.trimMaterial) roles.push({ role: "trim", materialId: authoring.trimMaterial });
    // accent (glass) is synthetic — skip it
  } else if (kind === "ground" && authoring?.tileMaterials) {
    for (const [tileName, matId] of Object.entries(authoring.tileMaterials)) {
      roles.push({ role: tileName, materialId: matId as string });
    }
  }

  return { kind, roles };
}

// ---------------------------------------------------------------------------
// Experiment
// ---------------------------------------------------------------------------

const experiment: ExperimentModule = {
  id: "material-studio",
  title: "Material Studio",
  tags: ["editor", "tileset", "pbr", "texture", "ai"],

  async init(ctx) {
    const { mount, width, height } = ctx;
    mount.style.position = "relative";

    // Scene shared by both panes
    const scene = new THREE.Scene();
    scene.add(createGroundPlane());

    // Lighting (same as tile-viewer)
    const KEY_RADIUS = 20;
    const KEY_HEIGHT = 18;
    const KEY_ORBIT_SPEED = 2 * Math.PI / 10;

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

    scene.add(new THREE.HemisphereLight(0xa9c6ff, 0x4d3a26, 0.85));

    const rimLight = new THREE.DirectionalLight(0x9ec6ff, 2.2);
    rimLight.position.set(-14, 5, -16);
    scene.add(rimLight);
    scene.add(rimLight.target);

    // Tile groups on private layers
    const normalTileGroup = new THREE.Group();
    const targetTileGroup = new THREE.Group();
    scene.add(normalTileGroup);
    scene.add(targetTileGroup);

    // Load tileset assets + build kit info
    const assets = await loadTilesetAssets();

    const kitInfos: KitInfo[] = assets.tilesets.map((kit, i) => ({
      id: KIT_DIR_IDS[i],
      name: kit.manifest.name,
      kind: "wall_kit" as const,
      roles: []
    }));

    // Load roles for each kit
    await Promise.all(kitInfos.map(async (info) => {
      const { kind, roles } = await loadKitRoles(info.id);
      info.kind = kind;
      info.roles = roles;
    }));

    // --- State ---
    let currentRole: MaterialRole | null = null;
    let currentBaseColor: ImageData | null = null;
    let currentMaps: GeneratedMaps | null = null;
    let currentTextures: ReturnType<typeof createTextureSet> | null = null;

    // Pick the first tile from a kit to show in the 3D view
    function getDefaultTileForKit(kit: KitInfo): LoadedTile | undefined {
      const idx = kitInfos.indexOf(kit);
      const kitAsset = idx >= 0 ? assets.tilesets[idx] : undefined;
      if (!kitAsset) return undefined;
      // For wall kits, show "wall"; for ground, show the first tile
      if (kit.kind === "wall_kit") {
        return kitAsset.tiles.get("wall") ?? kitAsset.tiles.values().next().value;
      }
      return kitAsset.tiles.values().next().value;
    }

    function showTile(tile: LoadedTile): void {
      while (normalTileGroup.children.length > 0) normalTileGroup.remove(normalTileGroup.children[0]);
      while (targetTileGroup.children.length > 0) targetTileGroup.remove(targetTileGroup.children[0]);

      const measure = tile.template.clone();
      const box = new THREE.Box3().setFromObject(measure);
      const center = new THREE.Vector3();
      box.getCenter(center);
      const ox = -center.x, oy = -box.min.y, oz = -center.z;

      const normalClone = tile.template.clone();
      normalClone.position.set(ox, oy, oz);
      setTextureFiltering(normalClone, THREE.LinearFilter);
      normalClone.traverse((o) => {
        if (o instanceof THREE.Mesh) { o.castShadow = true; o.receiveShadow = true; }
      });
      setLayerRecursive(normalClone, NORMAL_LAYER);
      normalTileGroup.add(normalClone);

      const targetClone = tile.template.clone();
      targetClone.position.set(ox, oy, oz);
      setTextureFiltering(targetClone, THREE.LinearFilter);
      targetClone.traverse((o) => {
        if (o instanceof THREE.Mesh) { o.castShadow = true; o.receiveShadow = true; }
      });
      setLayerRecursive(targetClone, TARGET_LAYER);
      targetTileGroup.add(targetClone);

      // Clear texture state when tile changes
      currentBaseColor = null;
      currentMaps = null;
      currentTextures = null;
    }

    function applyCurrentTextures(): void {
      if (!currentTextures || !currentRole) return;
      for (const child of normalTileGroup.children) {
        applyTexturesToGroup(child, currentRole.role, currentTextures);
      }
      for (const child of targetTileGroup.children) {
        applyTexturesToGroup(child, currentRole.role, currentTextures);
      }
    }

    // --- Layout: control panel (left) + 3D view (right) ---

    const viewContainer = document.createElement("div");
    viewContainer.style.cssText = `
      position: absolute; top: 0; left: ${PANEL_WIDTH}px; right: 0; bottom: 0;
    `;
    mount.appendChild(viewContainer);

    const topEl = document.createElement("div");
    topEl.style.cssText = `
      position: absolute; top: 0; left: 0; right: 0;
      height: 50%;
    `;
    viewContainer.appendChild(topEl);
    addPaneLabel(topEl, "normal");

    const bottomEl = document.createElement("div");
    bottomEl.style.cssText = `
      position: absolute; bottom: 0; left: 0; right: 0;
      height: 50%;
      border-top: 1px solid #2a2e36;
    `;
    viewContainer.appendChild(bottomEl);
    addPaneLabel(bottomEl, "target");

    // Stage
    const stage = new SharedScissorStage({
      mount: viewContainer, width: width - PANEL_WIDTH, height,
      pixelRatio: Math.max(1, window.devicePixelRatio || 1),
      antialias: false,
      clearColor: 0x14181e,
      clearAlpha: 1,
      shadows: true
    });

    stage.renderer.outputColorSpace = THREE.SRGBColorSpace;

    // Normal pane (720p, MSAA)
    const normalPane = new PixelPerfectPane({
      stage,
      id: "normal",
      element: topEl,
      scene,
      width: topEl.clientWidth || (width - PANEL_WIDTH),
      height: topEl.clientHeight || Math.round(height / 2),
      ...NORMAL_VIEW_CONFIG,
      clearColor: 0x14181e,
      layers: [NORMAL_LAYER],
      toneMapping: "aces",
      shadows: true
    });

    // Target pane (360p, no MSAA)
    const targetPane = new PixelPerfectPane({
      stage,
      id: "target",
      element: bottomEl,
      scene,
      width: bottomEl.clientWidth || (width - PANEL_WIDTH),
      height: bottomEl.clientHeight || Math.round(height / 2),
      ...TARGET_VIEW_CONFIG,
      clearColor: 0x14181e,
      lowTargetSamples: 0,
      layers: [TARGET_LAYER],
      toneMapping: "aces",
      shadows: true
    });

    // --- Control panel ---

    const controlPanel = createControlPanel({
      onKitChange(kit: KitInfo): void {
        const tile = getDefaultTileForKit(kit);
        if (tile) showTile(tile);
      },

      onRoleChange(role: MaterialRole): void {
        currentRole = role;
      },

      async onGenerate(prompt: string) {
        if (!currentRole) return;
        controlPanel.setGenerating(true);
        controlPanel.setStatus("Generating...");

        try {
          const fullPrompt = prompt || buildPromptForMaterial(currentRole.materialId);
          currentBaseColor = await generateBaseColor(fullPrompt);
          controlPanel.setPreview(currentBaseColor);

          currentMaps = derivePbrMaps(currentBaseColor, DEFAULT_PBR_PARAMS);
          currentTextures = createTextureSet(currentMaps);
          applyCurrentTextures();

          controlPanel.setStatus("Done — tweak prompt and regenerate to iterate");
        } catch (err) {
          controlPanel.setStatus(`Error: ${(err as Error).message}`);
        } finally {
          controlPanel.setGenerating(false);
        }
      },

      async onSave() {
        if (!currentRole || !currentMaps) {
          controlPanel.setStatus("Nothing to save — generate first");
          return;
        }

        controlPanel.setSaving(true);
        controlPanel.setStatus("Saving...");

        try {
          await saveTexturesToAssets(currentRole.materialId, currentMaps);
          controlPanel.setStatus(`Saved ${currentRole.materialId} textures`);
        } catch (err) {
          controlPanel.setStatus(`Save error: ${(err as Error).message}`);
        } finally {
          controlPanel.setSaving(false);
        }
      }
    });

    mount.appendChild(controlPanel.element);
    controlPanel.setKits(kitInfos);

    // Show default tile
    if (kitInfos.length > 0) {
      const defaultKit = kitInfos[0];
      const tile = getDefaultTileForKit(defaultKit);
      if (tile) showTile(tile);
    }

    const unbindInput = bindPixelPerfectPaneBroadcast({
      stage,
      panes: [normalPane, targetPane]
    });

    // --- Resize ---

    const resizeObs = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const { width: w, height: h } = entry.contentRect;
        if (w > 0 && h > 0) stage.resize(w, h, Math.max(1, window.devicePixelRatio || 1));
      }
    });
    resizeObs.observe(viewContainer);

    // --- Frame loop ---

    let animId = 0;
    let lastTime = performance.now();
    let keyAngle = 0;

    const frame = (now: number): void => {
      animId = requestAnimationFrame(frame);
      const dt = Math.min((now - lastTime) / 1000, 0.1);
      lastTime = now;

      keyAngle += KEY_ORBIT_SPEED * dt;
      keyLight.position.set(
        Math.cos(keyAngle) * KEY_RADIUS,
        KEY_HEIGHT,
        Math.sin(keyAngle) * KEY_RADIUS
      );

      stage.drawFrame(now, dt);
    };
    animId = requestAnimationFrame(frame);

    // --- Cleanup ---

    return () => {
      cancelAnimationFrame(animId);
      resizeObs.disconnect();
      unbindInput();
      controlPanel.destroy();
      stage.dispose();
      topEl.remove();
      bottomEl.remove();
      viewContainer.remove();
    };
  }
};

export default experiment;
