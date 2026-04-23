import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import {
  SharedScissorStage,
  PixelPerfectPane,
  TILESET_VIEWER_TARGET_CONFIG,
  TILESET_VIEWER_NORMAL_CONFIG
} from "@common/render";
import { bindPixelPerfectPaneBroadcast } from "@common/input";
import type { ExperimentModule } from "../runtime/types";

import type { Surface, SurfaceState } from "./types";
import { DEFAULT_PBR_PARAMS } from "./types";
import { derivePbrMaps } from "./pbr-derive";
import {
  generateBaseColor,
  listBaseMeshes,
  bakeTexturedMesh,
  mapsToBakeMaterial
} from "./api-client";
import { createTextureSet, applyTexturesToGroup } from "./texture-swap";
import { createControlPanel } from "./control-panel";

// ---------------------------------------------------------------------------
// Layers & layout
// ---------------------------------------------------------------------------

const NORMAL_LAYER = 1;
const TARGET_LAYER = 2;
const PANEL_WIDTH = 340;

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

function setLinearTextureFiltering(group: THREE.Group): void {
  group.traverse((obj) => {
    if (!(obj instanceof THREE.Mesh)) return;
    const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
    for (const mat of mats) {
      if (mat instanceof THREE.MeshStandardMaterial && mat.map) {
        mat.map.magFilter = THREE.LinearFilter;
        mat.map.minFilter = THREE.LinearFilter;
        mat.map.needsUpdate = true;
      }
    }
  });
}

const gltfLoader = new GLTFLoader();

async function loadBaseMesh(meshId: string): Promise<THREE.Group> {
  const url = `/api/assets/read?path=${encodeURIComponent(`meshes/${meshId}.glb`)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to load mesh ${meshId}: ${res.status}`);
  const buffer = await res.arrayBuffer();
  const gltf = await new Promise<{ scene: THREE.Group }>((resolve, reject) => {
    gltfLoader.parse(buffer, "", resolve, reject);
  });
  return gltf.scene;
}

type BaseMeshSidecar = {
  id: string;
  part: { dimensions: [number, number, number] };
};

async function loadBaseMeshSidecar(meshId: string): Promise<BaseMeshSidecar | null> {
  const url = `/api/assets/read?path=${encodeURIComponent(`meshes/${meshId}.manifest.json`)}`;
  const res = await fetch(url);
  if (!res.ok) return null;
  const json = await res.json();
  return (typeof json.content === "string" ? JSON.parse(json.content) : json) as BaseMeshSidecar;
}

/** Walk a GLB group and collect unique textureRole surfaces, keyed by role. */
function discoverSurfaces(group: THREE.Object3D): Surface[] {
  const byRole = new Map<string, Surface>();
  group.traverse((obj) => {
    const role = obj.userData?.textureRole as string | undefined;
    if (!role || byRole.has(role)) return;
    const isGlass = role === "accent";
    byRole.set(role, {
      role,
      kind: isGlass ? "synthetic" : "pbr",
      synthetic: isGlass ? "glass" : undefined
    });
  });
  return Array.from(byRole.values());
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

    // --- Scene ---
    const scene = new THREE.Scene();
    scene.add(createGroundPlane());

    // Lighting (same as the old tile-viewer)
    const KEY_RADIUS = 20;
    const KEY_HEIGHT = 18;
    const KEY_ORBIT_SPEED = (2 * Math.PI) / 10;

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

    const normalTileGroup = new THREE.Group();
    const targetTileGroup = new THREE.Group();
    scene.add(normalTileGroup);
    scene.add(targetTileGroup);

    // --- Layout: control panel + dual pane ---
    const viewContainer = document.createElement("div");
    viewContainer.style.cssText = `position: absolute; top: 0; left: ${PANEL_WIDTH}px; right: 0; bottom: 0;`;
    mount.appendChild(viewContainer);

    const topEl = document.createElement("div");
    topEl.style.cssText = "position: absolute; top: 0; left: 0; right: 0; height: 50%;";
    viewContainer.appendChild(topEl);
    addPaneLabel(topEl, "normal");

    const bottomEl = document.createElement("div");
    bottomEl.style.cssText = `
      position: absolute; bottom: 0; left: 0; right: 0; height: 50%;
      border-top: 1px solid #2a2e36;
    `;
    viewContainer.appendChild(bottomEl);
    addPaneLabel(bottomEl, "target");

    const stage = new SharedScissorStage({
      mount: viewContainer,
      width: width - PANEL_WIDTH,
      height,
      pixelRatio: Math.max(1, window.devicePixelRatio || 1),
      antialias: false,
      clearColor: 0x14181e,
      clearAlpha: 1,
      shadows: true
    });
    stage.renderer.outputColorSpace = THREE.SRGBColorSpace;

    const normalPane = new PixelPerfectPane({
      stage,
      id: "normal",
      element: topEl,
      scene,
      width: topEl.clientWidth || width - PANEL_WIDTH,
      height: topEl.clientHeight || Math.round(height / 2),
      ...TILESET_VIEWER_NORMAL_CONFIG,
      clearColor: 0x14181e,
      layers: [NORMAL_LAYER],
      toneMapping: "aces",
      shadows: true
    });

    const targetPane = new PixelPerfectPane({
      stage,
      id: "target",
      element: bottomEl,
      scene,
      width: bottomEl.clientWidth || width - PANEL_WIDTH,
      height: bottomEl.clientHeight || Math.round(height / 2),
      ...TILESET_VIEWER_TARGET_CONFIG,
      clearColor: 0x14181e,
      lowTargetSamples: 0,
      layers: [TARGET_LAYER],
      toneMapping: "aces",
      shadows: true
    });

    // --- State ---
    let currentSurfaces: Surface[] = [];
    let currentTextures: Map<string, ReturnType<typeof createTextureSet>> = new Map();

    function clearGroups(): void {
      while (normalTileGroup.children.length > 0) normalTileGroup.remove(normalTileGroup.children[0]);
      while (targetTileGroup.children.length > 0) targetTileGroup.remove(targetTileGroup.children[0]);
      currentTextures = new Map();
    }

    function installMesh(group: THREE.Group): void {
      clearGroups();

      // Center & settle on ground plane
      const box = new THREE.Box3().setFromObject(group);
      const center = new THREE.Vector3();
      box.getCenter(center);
      const ox = -center.x;
      const oy = -box.min.y;
      const oz = -center.z;

      const normalClone = group.clone();
      normalClone.position.set(ox, oy, oz);
      setLinearTextureFiltering(normalClone);
      normalClone.traverse((o) => {
        if (o instanceof THREE.Mesh) {
          o.castShadow = true;
          o.receiveShadow = true;
        }
      });
      setLayerRecursive(normalClone, NORMAL_LAYER);
      normalTileGroup.add(normalClone);

      const targetClone = group.clone();
      targetClone.position.set(ox, oy, oz);
      setLinearTextureFiltering(targetClone);
      targetClone.traverse((o) => {
        if (o instanceof THREE.Mesh) {
          o.castShadow = true;
          o.receiveShadow = true;
        }
      });
      setLayerRecursive(targetClone, TARGET_LAYER);
      targetTileGroup.add(targetClone);
    }

    function applyTexturesForRole(role: string, textures: ReturnType<typeof createTextureSet>): void {
      currentTextures.set(role, textures);
      for (const child of normalTileGroup.children) applyTexturesToGroup(child, role, textures);
      for (const child of targetTileGroup.children) applyTexturesToGroup(child, role, textures);
    }

    // --- Control panel ---
    const controlPanel = createControlPanel({
      async onMeshChange(meshId) {
        try {
          const [group, sidecar] = await Promise.all([
            loadBaseMesh(meshId),
            loadBaseMeshSidecar(meshId)
          ]);
          installMesh(group);
          currentSurfaces = discoverSurfaces(group);
          controlPanel.setSurfaces(currentSurfaces);
          controlPanel.setDimensions(sidecar?.part?.dimensions ?? null);
        } catch (err) {
          controlPanel.setStatus(`Load error: ${(err as Error).message}`);
        }
      },

      onSurfaceFocus() {
        // No 3D highlight for now — surface focus is a UI-only cue in the panel.
      },

      async onGenerate(role, prompt) {
        const baseColor = await generateBaseColor(prompt);
        const maps = derivePbrMaps(baseColor, DEFAULT_PBR_PARAMS);
        const textures = createTextureSet(maps);
        applyTexturesForRole(role, textures);
        return maps;
      },

      onApprove() {
        // No-op; the panel marks it approved and gates the Bake button.
      },

      async onBake(entryName, states) {
        const materials: Record<string, unknown> = {};
        const prompts: Record<string, string> = {};
        for (const s of states) {
          if (s.surface.kind === "synthetic") {
            materials[s.surface.role] = { synthetic: s.surface.synthetic ?? "glass" };
          } else if (s.maps) {
            materials[s.surface.role] = await mapsToBakeMaterial(s.maps);
            prompts[s.surface.role] = s.prompt;
          }
        }
        await bakeTexturedMesh({
          name: entryName,
          baseMeshId: baseMeshIdFromPanel() ?? "",
          materials: materials as never,
          prompts
        });
      }
    });

    mount.appendChild(controlPanel.element);

    // We track the base mesh id via the last onMeshChange call. Simpler than
    // threading it into panel state.
    let currentBaseMeshId: string | null = null;
    function baseMeshIdFromPanel(): string | null {
      return currentBaseMeshId;
    }

    // Populate meshes catalog
    try {
      const meshes = await listBaseMeshes();
      controlPanel.setMeshList(meshes);
      // setMeshList may trigger onMeshChange synchronously for the first mesh
      if (meshes.length > 0) currentBaseMeshId = meshes[0];
    } catch (err) {
      controlPanel.setStatus(`Catalog error: ${(err as Error).message}`);
    }

    // Shadow the onMeshChange to also track the id — we rebuild the panel
    // with a wrapped callback so the base id stays in scope.
    // (The simpler alternative is storing on the DOM; this avoids that.)
    const meshSelect = controlPanel.element.querySelector("select") as HTMLSelectElement | null;
    if (meshSelect) {
      meshSelect.addEventListener("change", () => {
        currentBaseMeshId = meshSelect.value;
      });
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

// Keep the state types exported so the panel file can import them without
// pulling index.ts into a circular dep.
export type { Surface, SurfaceState };
