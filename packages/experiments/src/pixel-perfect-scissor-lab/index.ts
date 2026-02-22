import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { bindSharedScissorStageInput } from "@common/input";
import {
  PixelPerfectIsoScissorPane,
  PixelPerfectIsoViewportCore,
  SharedScissorStage,
  type PixelPerfectIsoViewPose,
  type PixelPerfectIsoViewportCoreVisualState
} from "@common/render";
import type { ExperimentModule } from "../runtime/types";
import {
  CAMERA_DISTANCE,
  CAMERA_PITCH,
  CAMERA_YAW,
  FIXED_RENDER_HEIGHT,
  ORTHO_HEIGHT
} from "../pixel-perfect-camera-zoom/config";

const PET_MODEL_URL = new URL(
  "../../../../assets/forge/props/commodore-pet-inspired-computer/processed/model.glb",
  import.meta.url
).href;

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
const PANE_CLEAR_COLOR = 0x101823;

type Mode = "independent" | "shared";
type PaneKey = "north" | "east" | "south" | "west";

type PaneSpec = {
  key: PaneKey;
  label: string;
  yawOffset: number;
  accent: number;
};

type PaneDom = {
  frame: HTMLDivElement;
  surface: HTMLDivElement;
  label: HTMLDivElement;
  labelText: string;
  accentCss: string;
};

type PaneRuntime = {
  pane: PixelPerfectIsoScissorPane;
  stage: SharedScissorStage;
  scene: THREE.Scene;
  disposables: THREE.Object3D[];
};

type SharedBackend = {
  stage: SharedScissorStage;
  paneRuntimes: Record<PaneKey, PaneRuntime>;
  canvasLayer: HTMLDivElement;
  disposeInputs: Array<() => void>;
  focusState: { paneKey: PaneKey | null };
};

type IndependentBackend = {
  paneRuntimes: Record<PaneKey, PaneRuntime>;
  disposeInputs: Array<() => void>;
  focusState: { paneKey: PaneKey | null };
};

type Backend =
  | { mode: "shared"; impl: SharedBackend }
  | { mode: "independent"; impl: IndependentBackend };

type PaneVisualStateMap = Record<PaneKey, PixelPerfectIsoViewportCoreVisualState>;

type PaneDebugState = {
  yawIndex: number;
  zoom: number;
  targetX: number;
  targetZ: number;
};

type ScissorLabDebugApi = {
  getMode(): Mode;
  setMode(mode: Mode): void;
  getPaneStates(): Record<PaneKey, PaneDebugState>;
  getCanvasCount(): number;
  getCanvasRects(): Array<{ x: number; y: number; w: number; h: number }>;
  getPaneRects(): Record<PaneKey, { x: number; y: number; w: number; h: number }>;
  projectPetCenterInPane(id: PaneKey): { x: number; y: number } | null;
};

const PANES: PaneSpec[] = [
  { key: "north", label: "North", yawOffset: 0, accent: 0x7fb6ff },
  { key: "east", label: "East", yawOffset: 1, accent: 0xffbf7d },
  { key: "south", label: "South", yawOffset: 2, accent: 0x9be28f },
  { key: "west", label: "West", yawOffset: 3, accent: 0xd0a4ff }
];

function normalizeModelToGroundedCenter(root: THREE.Object3D): { center: THREE.Vector3; size: THREE.Vector3 } {
  root.updateMatrixWorld(true);
  const bbox = new THREE.Box3().setFromObject(root);
  if (bbox.isEmpty()) {
    return { center: new THREE.Vector3(), size: new THREE.Vector3(1, 1, 1) };
  }
  const center = bbox.getCenter(new THREE.Vector3());
  const size = bbox.getSize(new THREE.Vector3());
  root.position.x -= center.x;
  root.position.z -= center.z;
  root.position.y -= bbox.min.y;
  root.updateMatrixWorld(true);
  return {
    center: new THREE.Vector3(0, size.y * 0.5, 0),
    size
  };
}

function cloneWithMaterials<T extends THREE.Object3D>(root: T): T {
  const clone = root.clone(true) as T;
  clone.traverse((node) => {
    if (!(node instanceof THREE.Mesh)) {
      return;
    }
    if (Array.isArray(node.material)) {
      node.material = node.material.map((m) => m.clone());
    } else {
      node.material = node.material.clone();
    }
    node.castShadow = true;
    node.receiveShadow = true;
  });
  return clone;
}

function disposeObjectDeep(root: THREE.Object3D): void {
  root.traverse((node) => {
    if (!(node instanceof THREE.Mesh)) {
      return;
    }
    node.geometry?.dispose();
    if (Array.isArray(node.material)) {
      for (const m of node.material) m.dispose();
    } else {
      node.material?.dispose();
    }
  });
}

function buildPaneScene(modelTemplate: THREE.Group, pane: PaneSpec): {
  scene: THREE.Scene;
  disposables: THREE.Object3D[];
} {
  const scene = new THREE.Scene();

  const ambient = new THREE.AmbientLight(0xffffff, 0.95);
  scene.add(ambient);

  const key = new THREE.DirectionalLight(0xffffff, 1.7);
  key.position.set(3.2, 5.6, 2.4);
  scene.add(key);

  const fill = new THREE.DirectionalLight(0x91a8c6, 0.65);
  fill.position.set(-2.8, 3.1, -1.4);
  scene.add(fill);

  const floorGroup = new THREE.Group();
  floorGroup.name = `floor-${pane.key}`;
  scene.add(floorGroup);

  const tileGeo = new THREE.PlaneGeometry(1, 1);
  const tileA = new THREE.MeshStandardMaterial({ color: 0x5f6d7e, roughness: 0.96, metalness: 0.02 });
  const tileB = new THREE.MeshStandardMaterial({ color: 0x718195, roughness: 0.96, metalness: 0.02 });
  const boardSize = 10;
  for (let x = 0; x < boardSize; x += 1) {
    for (let z = 0; z < boardSize; z += 1) {
      const tile = new THREE.Mesh(tileGeo, (x + z) % 2 === 0 ? tileA : tileB);
      tile.rotation.x = -Math.PI * 0.5;
      tile.position.set(x - boardSize * 0.5 + 0.5, -0.002, z - boardSize * 0.5 + 0.5);
      tile.receiveShadow = true;
      floorGroup.add(tile);
    }
  }

  const accentBox = new THREE.Mesh(
    new THREE.BoxGeometry(1, 1, 1),
    new THREE.MeshStandardMaterial({ color: pane.accent, roughness: 0.82, metalness: 0.05 })
  );
  accentBox.position.set(3.0, 0.5, -2.0);
  scene.add(accentBox);

  const pet = cloneWithMaterials(modelTemplate);
  pet.name = "pet";
  scene.add(pet);

  return {
    scene,
    disposables: [floorGroup, accentBox, pet]
  };
}

async function loadPetModel(): Promise<{ template: THREE.Group; center: THREE.Vector3 }> {
  const loader = new GLTFLoader();
  const gltf = await loader.loadAsync(PET_MODEL_URL);
  const root = (gltf.scene ?? new THREE.Group()) as THREE.Group;
  const { center } = normalizeModelToGroundedCenter(root);
  return { template: root, center };
}

function createPaneDom(pane: PaneSpec): PaneDom {
  const frame = document.createElement("div");
  frame.dataset.testid = `pixel-scissor-pane-${pane.key}`;
  frame.style.position = "relative";
  frame.style.display = "grid";
  frame.style.border = "1px solid #42566d";
  frame.style.borderRadius = "0";
  frame.style.overflow = "hidden";
  frame.style.background = "transparent";
  frame.style.minHeight = "240px";
  frame.style.height = "100%";
  frame.style.boxShadow = "none";
  frame.style.pointerEvents = "none";
  frame.style.zIndex = "1";

  const surface = document.createElement("div");
  surface.style.position = "absolute";
  surface.style.inset = "0";
  surface.style.pointerEvents = "auto";
  surface.style.zIndex = "0";
  frame.appendChild(surface);

  const label = document.createElement("div");
  label.textContent = pane.label;
  label.style.position = "absolute";
  label.style.left = "8px";
  label.style.top = "8px";
  label.style.padding = "3px 6px";
  label.style.borderRadius = "6px";
  label.style.background = "#090d14";
  const accentCss = `#${new THREE.Color(pane.accent).getHexString()}`;
  label.style.border = `1px solid ${accentCss}`;
  label.style.color = "#e9f0f7";
  label.style.font = "11px/1.2 ui-monospace, Menlo, monospace";
  label.style.pointerEvents = "none";
  label.style.zIndex = "3";
  frame.appendChild(label);

  return { frame, surface, label, labelText: pane.label, accentCss };
}

function setFocusedVisual(paneDom: PaneDom, focused: boolean): void {
  paneDom.frame.style.borderColor = focused ? paneDom.accentCss : "#42566d";
  paneDom.frame.style.boxShadow = focused ? `inset 0 0 0 1px ${paneDom.accentCss}` : "none";
  paneDom.label.style.background = focused ? "#0f1722" : "#090d14";
  paneDom.label.style.color = focused ? "#ffffff" : "#e9f0f7";
  paneDom.label.textContent = focused ? `${paneDom.labelText} (active)` : paneDom.labelText;
}

function defaultVisualStateMap(): PaneVisualStateMap {
  return {
    north: {
      targetX: 0,
      targetZ: 0,
      yawIndex: 0,
      animatedYawTurns: 0,
      zoomTarget: 1,
      zoomCurrent: 1,
      zoomPivotSceneX: 0.5,
      zoomPivotSceneY: 0.5,
      panDeviceCarryX: 0,
      panDeviceCarryY: 0,
      panDeviceRemainderX: 0,
      panDeviceRemainderY: 0
    },
    east: {
      targetX: 0,
      targetZ: 0,
      yawIndex: 1,
      animatedYawTurns: 1,
      zoomTarget: 1,
      zoomCurrent: 1,
      zoomPivotSceneX: 0.5,
      zoomPivotSceneY: 0.5,
      panDeviceCarryX: 0,
      panDeviceCarryY: 0,
      panDeviceRemainderX: 0,
      panDeviceRemainderY: 0
    },
    south: {
      targetX: 0,
      targetZ: 0,
      yawIndex: 2,
      animatedYawTurns: 2,
      zoomTarget: 1,
      zoomCurrent: 1,
      zoomPivotSceneX: 0.5,
      zoomPivotSceneY: 0.5,
      panDeviceCarryX: 0,
      panDeviceCarryY: 0,
      panDeviceRemainderX: 0,
      panDeviceRemainderY: 0
    },
    west: {
      targetX: 0,
      targetZ: 0,
      yawIndex: 3,
      animatedYawTurns: 3,
      zoomTarget: 1,
      zoomCurrent: 1,
      zoomPivotSceneX: 0.5,
      zoomPivotSceneY: 0.5,
      panDeviceCarryX: 0,
      panDeviceCarryY: 0,
      panDeviceRemainderX: 0,
      panDeviceRemainderY: 0
    }
  };
}

function buildCore(stage: SharedScissorStage, scene: THREE.Scene, paneHost: HTMLElement): PixelPerfectIsoViewportCore {
  const rect = paneHost.getBoundingClientRect();
  return new PixelPerfectIsoViewportCore({
    width: Math.max(1, rect.width || 320),
    height: Math.max(1, rect.height || 240),
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
    clearColor: PANE_CLEAR_COLOR,
    clearAlpha: 1,
    maxBackingWidth: stage.maxBackingWidth,
    maxBackingHeight: stage.maxBackingHeight,
    devicePixelRatio: stage.getDevicePixelRatio()
  });
}

function applyVisualStatesToRuntimes(
  runtimes: Record<PaneKey, PaneRuntime>,
  states: PaneVisualStateMap
): void {
  for (const pane of PANES) {
    runtimes[pane.key].pane.setVisualState(states[pane.key]);
  }
}

function collectVisualStatesFromRuntimes(
  runtimes: Record<PaneKey, PaneRuntime>
): PaneVisualStateMap {
  const result = {} as PaneVisualStateMap;
  for (const pane of PANES) {
    result[pane.key] = runtimes[pane.key].pane.getVisualState();
  }
  return result;
}

function collectPaneStates(runtimes: Record<PaneKey, PaneRuntime>): Record<PaneKey, PaneDebugState> {
  const result = {} as Record<PaneKey, PaneDebugState>;
  for (const pane of PANES) {
    const pose = runtimes[pane.key].pane.getViewPose();
    result[pane.key] = {
      yawIndex: pose.yawIndex,
      zoom: pose.zoom,
      targetX: pose.targetX,
      targetZ: pose.targetZ
    };
  }
  return result;
}

function collectProjectedPetCenters(
  runtimes: Record<PaneKey, PaneRuntime>,
  petCenterWorld: THREE.Vector3
): Record<PaneKey, { x: number; y: number } | null> {
  const outVec = new THREE.Vector2();
  const result = {} as Record<PaneKey, { x: number; y: number } | null>;
  for (const pane of PANES) {
    const ok = runtimes[pane.key].pane.projectWorldToLocalCss(petCenterWorld, outVec);
    result[pane.key] = ok ? { x: outVec.x, y: outVec.y } : null;
  }
  return result;
}

function disposeRuntimes(runtimes: Record<PaneKey, PaneRuntime>): void {
  for (const pane of PANES) {
    const runtime = runtimes[pane.key];
    runtime.stage.dispose();
    for (const obj of runtime.disposables) {
      disposeObjectDeep(obj);
    }
  }
}

function makeIndependentBackend(
  paneDoms: Record<PaneKey, PaneDom>,
  petTemplate: THREE.Group,
  states: PaneVisualStateMap
): IndependentBackend {
  const paneRuntimes = {} as Record<PaneKey, PaneRuntime>;
  const disposeInputs: Array<() => void> = [];
  const focusState: { paneKey: PaneKey | null } = { paneKey: null };

  for (const pane of PANES) {
    paneDoms[pane.key].surface.style.display = "block";
    paneDoms[pane.key].surface.style.pointerEvents = "auto";
    const stage = new SharedScissorStage({
      mount: paneDoms[pane.key].surface,
      width: Math.max(1, paneDoms[pane.key].surface.clientWidth || 320),
      height: Math.max(1, paneDoms[pane.key].surface.clientHeight || 240),
      pixelRatio: Math.max(1, window.devicePixelRatio || 1),
      antialias: false,
      clearColor: PANE_CLEAR_COLOR,
      clearAlpha: 1
    });

    const { scene, disposables } = buildPaneScene(petTemplate, pane);
    const core = buildCore(stage, scene, paneDoms[pane.key].surface);
    const paneAdapter = new PixelPerfectIsoScissorPane({
      id: pane.key,
      element: paneDoms[pane.key].surface,
      core,
      devicePixelRatio: stage.getDevicePixelRatio()
    });
    stage.registerPane(paneAdapter);
    stage.start();
    disposeInputs.push(
      bindSharedScissorStageInput({
        stage,
        getFocusedPaneId: () => focusState.paneKey,
        setFocusedPaneId: (paneId) => {
          focusState.paneKey = (paneId as PaneKey | null) ?? null;
        },
        getPaneInputTarget: (paneId) => (paneId === pane.key ? paneAdapter : null)
      })
    );

    paneRuntimes[pane.key] = {
      pane: paneAdapter,
      stage,
      scene,
      disposables
    };
  }

  applyVisualStatesToRuntimes(paneRuntimes, states);
  return { paneRuntimes, disposeInputs, focusState };
}

function makeSharedBackend(
  gridCanvasLayer: HTMLDivElement,
  paneDoms: Record<PaneKey, PaneDom>,
  petTemplate: THREE.Group,
  states: PaneVisualStateMap
): SharedBackend {
  for (const pane of PANES) {
    paneDoms[pane.key].surface.style.display = "block";
    paneDoms[pane.key].surface.style.pointerEvents = "none";
  }

  const stage = new SharedScissorStage({
    mount: gridCanvasLayer,
    width: Math.max(1, gridCanvasLayer.clientWidth || 640),
    height: Math.max(1, gridCanvasLayer.clientHeight || 480),
    pixelRatio: Math.max(1, window.devicePixelRatio || 1),
    antialias: false,
    clearColor: PANE_CLEAR_COLOR,
    clearAlpha: 0
  });
  const disposeInputs: Array<() => void> = [];
  const focusState: { paneKey: PaneKey | null } = { paneKey: null };

  const paneRuntimes = {} as Record<PaneKey, PaneRuntime>;
  for (const pane of PANES) {
    const { scene, disposables } = buildPaneScene(petTemplate, pane);
    const core = buildCore(stage, scene, paneDoms[pane.key].surface);
    const paneAdapter = new PixelPerfectIsoScissorPane({
      id: pane.key,
      element: paneDoms[pane.key].surface,
      core,
      devicePixelRatio: stage.getDevicePixelRatio()
    });
    stage.registerPane(paneAdapter);
    paneRuntimes[pane.key] = {
      pane: paneAdapter,
      stage,
      scene,
      disposables
    };
  }
  applyVisualStatesToRuntimes(paneRuntimes, states);
  stage.start();
  disposeInputs.push(
    bindSharedScissorStageInput({
      stage,
      getFocusedPaneId: () => focusState.paneKey,
      setFocusedPaneId: (paneId) => {
        focusState.paneKey = (paneId as PaneKey | null) ?? null;
      },
      getPaneInputTarget: (paneId) => paneRuntimes[paneId as PaneKey]?.pane ?? null
    })
  );

  return { stage, paneRuntimes, canvasLayer: gridCanvasLayer, disposeInputs, focusState };
}

function backendGetRuntimes(backend: Backend): Record<PaneKey, PaneRuntime> {
  return backend.impl.paneRuntimes;
}

function backendGetFocusedPane(backend: Backend): PaneKey | null {
  return backend.impl.focusState.paneKey;
}

function backendSetFocusedPane(backend: Backend, paneKey: PaneKey | null): void {
  backend.impl.focusState.paneKey = paneKey;
}

function paneKeyAtClientPoint(
  paneDoms: Record<PaneKey, PaneDom>,
  clientX: number,
  clientY: number
): PaneKey | null {
  for (const pane of PANES) {
    const rect = paneDoms[pane.key].frame.getBoundingClientRect();
    if (clientX < rect.left || clientY < rect.top || clientX > rect.right || clientY > rect.bottom) {
      continue;
    }
    return pane.key;
  }
  return null;
}

function backendDispose(backend: Backend): void {
  if (backend.mode === "shared") {
    for (const disposeInput of backend.impl.disposeInputs) {
      disposeInput();
    }
    backend.impl.stage.dispose();
    for (const pane of PANES) {
      for (const obj of backend.impl.paneRuntimes[pane.key].disposables) {
        disposeObjectDeep(obj);
      }
    }
    return;
  }
  for (const disposeInput of backend.impl.disposeInputs) {
    disposeInput();
  }
  disposeRuntimes(backend.impl.paneRuntimes);
}

const experiment: ExperimentModule = {
  id: "pixel-perfect-scissor-lab",
  title: "Pixel Perfect Scissor Lab",
  tags: ["pixel", "isometric", "rendering", "prototype"],
  init: async ({ mount, width, height }) => {
    mount.style.position = "relative";
    mount.style.background = "#0b0f14";

    const shell = document.createElement("div");
    shell.style.position = "absolute";
    shell.style.inset = "0";
    shell.style.display = "grid";
    shell.style.gridTemplateRows = "auto 1fr";
    shell.style.gap = "8px";
    shell.style.padding = "8px";
    shell.style.boxSizing = "border-box";
    shell.style.minHeight = "0";
    mount.appendChild(shell);

    const hud = document.createElement("div");
    hud.style.display = "flex";
    hud.style.alignItems = "center";
    hud.style.justifyContent = "space-between";
    hud.style.gap = "12px";
    hud.style.padding = "6px 8px";
    hud.style.borderRadius = "8px";
    hud.style.border = "1px solid #2a3b4d";
    hud.style.background = "rgba(11, 15, 20, 0.84)";
    hud.style.color = "#d7dde6";
    hud.style.font = "12px/1.35 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";
    shell.appendChild(hud);

    const hudLeft = document.createElement("div");
    hudLeft.textContent =
      "A/B parity check: toggle between 4 independent GL contexts and shared scissor context. If nothing visibly changes, shared mode is correct.";
    hudLeft.style.flex = "1";
    hud.appendChild(hudLeft);

    const toggleWrap = document.createElement("label");
    toggleWrap.style.display = "inline-flex";
    toggleWrap.style.alignItems = "center";
    toggleWrap.style.gap = "8px";
    toggleWrap.style.whiteSpace = "nowrap";
    const toggle = document.createElement("input");
    toggle.type = "checkbox";
    toggle.dataset.testid = "pixel-scissor-mode-toggle";
    const toggleText = document.createElement("span");
    toggleText.textContent = "Use shared context (scissor)";
    toggleWrap.append(toggle, toggleText);
    hud.appendChild(toggleWrap);

    const grid = document.createElement("div");
    grid.style.position = "relative";
    grid.style.display = "grid";
    grid.style.gridTemplateColumns = "1fr 1fr";
    grid.style.gridTemplateRows = "1fr 1fr";
    grid.style.gap = "0";
    grid.style.minHeight = "0";
    grid.style.height = "100%";
    grid.style.background = "#101823";
    grid.style.borderRadius = "10px";
    shell.appendChild(grid);

    const gridCanvasLayer = document.createElement("div");
    gridCanvasLayer.style.position = "absolute";
    gridCanvasLayer.style.inset = "0";
    gridCanvasLayer.style.zIndex = "0";
    gridCanvasLayer.style.pointerEvents = "auto";
    grid.appendChild(gridCanvasLayer);

    const paneDoms = {} as Record<PaneKey, PaneDom>;
    for (const pane of PANES) {
      const paneDom = createPaneDom(pane);
      paneDoms[pane.key] = paneDom;
      grid.appendChild(paneDom.frame);
    }

    const loading = document.createElement("div");
    loading.textContent = "Loading Commodore PET mesh...";
    loading.style.position = "absolute";
    loading.style.inset = "0";
    loading.style.display = "grid";
    loading.style.placeItems = "center";
    loading.style.color = "#d7dde6";
    loading.style.font = "13px/1.35 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";
    loading.style.zIndex = "4";
    grid.appendChild(loading);

    let disposed = false;
    let uiRaf = 0;
    let backend: Backend | null = null;
    let petTemplateForCleanup: THREE.Group | null = null;
    let petCenterWorld = new THREE.Vector3(0, 0.25, 0);
    let currentMode: Mode = "independent";
    let visualStateStore = defaultVisualStateMap();
    const interactionCleanup: Array<() => void> = [];

    const setMode = (nextMode: Mode): void => {
      if (disposed) return;
      if (currentMode === nextMode && backend) return;
      const focusedBefore = backend ? backendGetFocusedPane(backend) : null;
      if (backend) {
        visualStateStore = collectVisualStatesFromRuntimes(backendGetRuntimes(backend));
        backendDispose(backend);
        backend = null;
      }
      currentMode = nextMode;
      toggle.checked = nextMode === "shared";
      if (!petTemplateForCleanup) return;
      backend = nextMode === "shared"
        ? {
            mode: "shared",
            impl: makeSharedBackend(gridCanvasLayer, paneDoms, petTemplateForCleanup, visualStateStore)
          }
        : {
            mode: "independent",
            impl: makeIndependentBackend(paneDoms, petTemplateForCleanup, visualStateStore)
          };
      if (backend) {
        backendSetFocusedPane(backend, focusedBefore);
      }
    };

    const syncUi = (): void => {
      if (!backend) return;
      const focused = backendGetFocusedPane(backend);
      for (const pane of PANES) {
        setFocusedVisual(paneDoms[pane.key], focused === pane.key);
      }
    };

    const focusPane = (paneKey: PaneKey | null): void => {
      if (!backend) return;
      backendSetFocusedPane(backend, paneKey);
    };

    for (const pane of PANES) {
      const focusThisPane = (): void => {
        focusPane(pane.key);
      };
      const surface = paneDoms[pane.key].surface;
      surface.addEventListener("pointerdown", focusThisPane);
      surface.addEventListener("wheel", focusThisPane);
      interactionCleanup.push(() => {
        surface.removeEventListener("pointerdown", focusThisPane);
        surface.removeEventListener("wheel", focusThisPane);
      });
    }

    const focusSharedHitPane = (event: PointerEvent | WheelEvent): void => {
      const paneKey = paneKeyAtClientPoint(paneDoms, event.clientX, event.clientY);
      if (paneKey) {
        focusPane(paneKey);
      }
    };
    gridCanvasLayer.addEventListener("pointerdown", focusSharedHitPane);
    gridCanvasLayer.addEventListener("wheel", focusSharedHitPane);
    interactionCleanup.push(() => {
      gridCanvasLayer.removeEventListener("pointerdown", focusSharedHitPane);
      gridCanvasLayer.removeEventListener("wheel", focusSharedHitPane);
    });

    toggle.addEventListener("change", () => {
      setMode(toggle.checked ? "shared" : "independent");
    });

    const debugWindow = window as Window & {
      __pixelPerfectScissorLabDebug?: ScissorLabDebugApi;
    };

    const debugApi: ScissorLabDebugApi = {
      getMode: () => currentMode,
      setMode: (mode) => setMode(mode),
      getPaneStates: () => {
        if (!backend) {
          const empty = {} as Record<PaneKey, PaneDebugState>;
          for (const pane of PANES) {
            const pose = visualStateStore[pane.key];
            empty[pane.key] = {
              yawIndex: pose.yawIndex,
              zoom: pose.zoomTarget,
              targetX: pose.targetX,
              targetZ: pose.targetZ
            };
          }
          return empty;
        }
        return collectPaneStates(backendGetRuntimes(backend));
      },
      getCanvasCount: () => Array.from(shell.querySelectorAll("canvas")).length,
      getCanvasRects: () =>
        Array.from(shell.querySelectorAll("canvas")).map((canvas) => {
          const r = canvas.getBoundingClientRect();
          return { x: r.left, y: r.top, w: r.width, h: r.height };
        }),
      getPaneRects: () => {
        const out = {} as Record<PaneKey, { x: number; y: number; w: number; h: number }>;
        for (const pane of PANES) {
          const r = paneDoms[pane.key].frame.getBoundingClientRect();
          out[pane.key] = { x: r.left, y: r.top, w: r.width, h: r.height };
        }
        return out;
      },
      projectPetCenterInPane: (id) => {
        if (!backend) return null;
        const runtime = backendGetRuntimes(backend)[id];
        if (!runtime) return null;
        const out = new THREE.Vector2();
        if (!runtime.pane.projectWorldToLocalCss(petCenterWorld, out)) {
          return null;
        }
        return { x: out.x, y: out.y };
      }
    };
    debugWindow.__pixelPerfectScissorLabDebug = debugApi;

    try {
      const loaded = await loadPetModel();
      if (disposed) {
        disposeObjectDeep(loaded.template);
        throw new Error("disposed");
      }
      petTemplateForCleanup = loaded.template;
      petCenterWorld = loaded.center;
      loading.remove();
      setMode("independent");

      const animateUi = () => {
        if (disposed) return;
        syncUi();
        uiRaf = requestAnimationFrame(animateUi);
      };
      uiRaf = requestAnimationFrame(animateUi);
    } catch (err) {
      if (!(err instanceof Error && err.message === "disposed")) {
        loading.textContent = `Failed to load PET mesh: ${err instanceof Error ? err.message : "unknown error"}`;
      }
    }

    return () => {
      disposed = true;
      cancelAnimationFrame(uiRaf);
      toggle.remove();
      backend && backendDispose(backend);
      if (petTemplateForCleanup) {
        disposeObjectDeep(petTemplateForCleanup);
      }
      if (debugWindow.__pixelPerfectScissorLabDebug === debugApi) {
        delete debugWindow.__pixelPerfectScissorLabDebug;
      }
      for (const cleanup of interactionCleanup) {
        cleanup();
      }
      shell.remove();
    };
  }
};

export default experiment;
