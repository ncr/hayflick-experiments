import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import {
  PixelPerfectIsoScissorPane,
  PixelPerfectIsoViewportCore,
  SharedScissorStage,
  ThreeSceneScissorPane
} from "@common/render";
import type { ExperimentModule } from "../runtime/types";
import {
  CAMERA_DISTANCE,
  CAMERA_PITCH,
  CAMERA_YAW,
  FIXED_RENDER_HEIGHT,
  ORTHO_HEIGHT
} from "../pixel-perfect-camera-zoom/config";

declare global {
  interface ImportMeta {
    glob<T = unknown>(
      pattern: string,
      options?: { eager?: boolean; import?: string; query?: string }
    ): Record<string, T>;
  }
}

type PixelPaneKey = "north" | "east" | "south" | "west";

type PixelPaneSpec = {
  key: PixelPaneKey;
  label: string;
  yawOffset: number;
};

type PropSpec = {
  id: string;
  label: string;
  sourcePromptPath: string;
  sourceConceptPath: string;
};

type VariantSpec = {
  prop: PropSpec;
  faceLimit: number;
};

type RowDom = {
  card: HTMLDivElement;
  headerLine: HTMLDivElement;
  statusLine: HTMLDivElement;
  normalPaneSurface: HTMLDivElement;
  pixelPaneSurfaces: Record<PixelPaneKey, HTMLDivElement>;
};

type VariantRuntime = {
  rowDom: RowDom;
  scene: THREE.Scene;
  rootModel: THREE.Object3D;
  normalPane: ThreeSceneScissorPane;
  pixelPanes: PixelPerfectIsoScissorPane[];
};

type PropSectionRuntime = {
  renderMount: HTMLDivElement;
  rows: VariantRuntime[];
};

const GENERATED_GLB_URLS = import.meta.glob("./generated/**/*.glb", {
  eager: true,
  import: "default",
  query: "?url"
}) as Record<string, string>;

const PIXEL_PANES: PixelPaneSpec[] = [
  { key: "north", label: "North", yawOffset: 0 },
  { key: "east", label: "East", yawOffset: 1 },
  { key: "south", label: "South", yawOffset: 2 },
  { key: "west", label: "West", yawOffset: 3 }
];

const FACE_LIMITS = [1000, 3000, 5000, 10000] as const;

const PROPS: PropSpec[] = [
  {
    id: "chemical-flask",
    label: "Chemical Flask",
    sourcePromptPath: "assets/forge-v2/props/chemical-flask/raw/prompt.txt",
    sourceConceptPath: "assets/forge-v2/props/chemical-flask/raw/concept.png"
  },
  {
    id: "commodore-pet-inspired-computer",
    label: "Commodore PET Inspired Computer",
    sourcePromptPath: "assets/forge-v2/props/commodore-pet-inspired-computer/raw/prompt.txt",
    sourceConceptPath:
      "assets/forge-v2/props/commodore-pet-inspired-computer/raw/concept.png"
  },
  {
    id: "professional-workbench-chair",
    label: "Professional Workbench Chair",
    sourcePromptPath: "assets/forge-v2/props/professional-workbench-chair/raw/prompt.txt",
    sourceConceptPath: "assets/forge-v2/props/professional-workbench-chair/raw/concept.png"
  }
];

const CLEAR_COLOR = 0x1a1a2e;
const PANE_BG = "#1a1a2e";
const CARD_BG = "#202734";
const CARD_EDGE = "#394a5f";
const TEXT_DIM = "#9cb0c8";
const PIXEL_VIEWPORT_FRAMING_SCALE = 1.28;
const PIXEL_BASE_ORTHO_HEIGHT = ORTHO_HEIGHT * 2 * PIXEL_VIEWPORT_FRAMING_SCALE;
const PIXEL_BASE_ZOOM = 2;
const PIXEL_ZOOM_MIN = 1;
const PIXEL_ZOOM_MAX = 6;
const PIXEL_ZOOM_STEP = 1;
const PIXEL_ZOOM_ANIM_RATE = 14;
const PIXEL_ZOOM_BURST_RATE = 42;
const PIXEL_ROTATION_ANIM_RATE = 18;
const PIXEL_ROTATION_ANIM_EPSILON = 1e-3;
const PIXEL_ZOOM_ANIM_EPSILON = 1e-3;
const PIXEL_ZOOM_BURST_IDLE_MS = 200;
const OUTPUT_OVERSCAN_LOW_PIXELS = 2;
const NORMAL_CAMERA_FOV_DEG = 34;
const NORMAL_CAMERA_YAW = THREE.MathUtils.degToRad(42);
const NORMAL_CAMERA_PITCH = THREE.MathUtils.degToRad(24);

function glbKeyFor(propId: string, faceLimit: number): string {
  return `./generated/${propId}/${faceLimit}.glb`;
}

function getGeneratedGlbUrl(propId: string, faceLimit: number): string | null {
  return GENERATED_GLB_URLS[glbKeyFor(propId, faceLimit)] ?? null;
}

function round(value: number, places = 1): number {
  const scale = 10 ** places;
  return Math.round(value * scale) / scale;
}

function computeTriangleCount(root: THREE.Object3D): number {
  let tris = 0;
  root.traverse((node) => {
    if (!(node instanceof THREE.Mesh)) return;
    const geom = node.geometry;
    const index = geom.getIndex();
    if (index) {
      tris += Math.floor(index.count / 3);
      return;
    }
    const pos = geom.getAttribute("position");
    if (pos) {
      tris += Math.floor(pos.count / 3);
    }
  });
  return tris;
}

function normalizeModelToGroundedCenter(root: THREE.Object3D): {
  size: THREE.Vector3;
  focus: THREE.Vector3;
  radius: number;
} {
  root.updateMatrixWorld(true);
  const bbox = new THREE.Box3().setFromObject(root);
  if (bbox.isEmpty()) {
    return {
      size: new THREE.Vector3(1, 1, 1),
      focus: new THREE.Vector3(0, 0.5, 0),
      radius: 1
    };
  }

  const center = bbox.getCenter(new THREE.Vector3());
  root.position.x -= center.x;
  root.position.z -= center.z;
  root.position.y -= bbox.min.y;
  root.updateMatrixWorld(true);

  const normalizedBBox = new THREE.Box3().setFromObject(root);
  const size = normalizedBBox.getSize(new THREE.Vector3());
  const sphere = normalizedBBox.getBoundingSphere(new THREE.Sphere());
  const focus = new THREE.Vector3(0, Math.max(0.18, size.y * 0.45), 0);
  return {
    size,
    focus,
    radius: Math.max(0.25, sphere.radius)
  };
}

function makeTileMaterial(color: number): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({
    color,
    roughness: 0.95,
    metalness: 0.02
  });
}

function addPixelPreviewGroundEnvironment(root: THREE.Group): void {
  const gridSize = 12;
  const darkGridColor = 0x6b8fb5;
  const brightCenterGridColor = 0xa7d2ff;

  const floor = new THREE.Mesh(
    new THREE.BoxGeometry(14, 0.1, 14),
    new THREE.MeshStandardMaterial({
      color: 0x5d748b,
      roughness: 0.95,
      metalness: 0.02
    })
  );
  floor.position.set(0, -0.05, 0);
  floor.receiveShadow = true;
  root.add(floor);

  const grid = new THREE.GridHelper(
    gridSize,
    12,
    brightCenterGridColor,
    darkGridColor
  );
  grid.position.y = 0.002;
  root.add(grid);
}

function buildSceneForVariant(
  loadedRoot: THREE.Group
): {
  scene: THREE.Scene;
  modelRoot: THREE.Group;
  focus: THREE.Vector3;
  radius: number;
  size: THREE.Vector3;
} {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(CLEAR_COLOR);

  const ambient = new THREE.AmbientLight(0xffffff, 0.95);
  scene.add(ambient);

  const key = new THREE.DirectionalLight(0xffffff, 1.8);
  key.position.set(3.0, 5.0, 2.0);
  scene.add(key);

  const fill = new THREE.DirectionalLight(0x8899bb, 0.8);
  fill.position.set(-2.0, 3.0, -1.0);
  scene.add(fill);

  const rim = new THREE.DirectionalLight(0x6aa8ff, 0.35);
  rim.position.set(-3.5, 5.5, 4.5);
  scene.add(rim);

  const refs = new THREE.Group();
  refs.name = "pixel-preview-ground";
  addPixelPreviewGroundEnvironment(refs);
  scene.add(refs);

  const modelRoot = loadedRoot;
  modelRoot.traverse((node) => {
    if (!(node instanceof THREE.Mesh)) return;
    node.castShadow = true;
    node.receiveShadow = true;
  });
  scene.add(modelRoot);

  const normalized = normalizeModelToGroundedCenter(modelRoot);
  return {
    scene,
    modelRoot,
    focus: normalized.focus,
    radius: normalized.radius,
    size: normalized.size
  };
}

function fitPerspectiveCamera(
  camera: THREE.PerspectiveCamera,
  focus: THREE.Vector3,
  radius: number,
  aspect: number
): void {
  camera.aspect = Math.max(0.01, aspect);
  camera.fov = NORMAL_CAMERA_FOV_DEG;

  const vHalf = THREE.MathUtils.degToRad(camera.fov * 0.5);
  const hHalf = Math.atan(Math.tan(vHalf) * camera.aspect);
  const fitDist = Math.max(
    radius / Math.sin(Math.max(0.01, vHalf)),
    radius / Math.sin(Math.max(0.01, hHalf))
  );
  const dist = fitDist * 1.08 + 0.35;

  const dir = new THREE.Vector3(
    Math.sin(NORMAL_CAMERA_YAW) * Math.cos(NORMAL_CAMERA_PITCH),
    Math.sin(NORMAL_CAMERA_PITCH),
    Math.cos(NORMAL_CAMERA_YAW) * Math.cos(NORMAL_CAMERA_PITCH)
  );
  camera.position.copy(focus).addScaledVector(dir, dist);
  camera.near = Math.max(0.01, dist - radius * 4.0);
  camera.far = dist + radius * 8.0 + 12.0;
  camera.lookAt(focus);
  camera.updateProjectionMatrix();
}

function deepDisposeObject(root: THREE.Object3D): void {
  root.traverse((node) => {
    if (!(node instanceof THREE.Mesh)) return;
    node.geometry?.dispose();
    if (Array.isArray(node.material)) {
      for (const material of node.material) material.dispose();
      return;
    }
    node.material?.dispose();
  });
}

function createRowDom(variant: VariantSpec): RowDom {
  const card = document.createElement("div");
  card.style.display = "grid";
  card.style.gridTemplateRows = "auto auto auto";
  card.style.gap = "8px";
  card.style.padding = "10px";
  card.style.border = `1px solid ${CARD_EDGE}`;
  card.style.borderRadius = "10px";
  card.style.background = "transparent";
  card.style.boxShadow = "0 8px 24px rgba(0,0,0,0.14)";

  const headerLine = document.createElement("div");
  headerLine.style.display = "flex";
  headerLine.style.justifyContent = "space-between";
  headerLine.style.gap = "8px";
  headerLine.style.alignItems = "baseline";
  headerLine.style.font = "600 13px/1.2 ui-sans-serif, system-ui, sans-serif";
  headerLine.style.color = "#ecf3fb";
  headerLine.textContent = `${variant.prop.label} • target ${variant.faceLimit.toLocaleString()} faces`;
  card.appendChild(headerLine);

  const statusLine = document.createElement("div");
  statusLine.style.font = "12px/1.35 ui-monospace, SFMono-Regular, Menlo, monospace";
  statusLine.style.color = TEXT_DIM;
  statusLine.textContent = "Loading local GLB…";
  card.appendChild(statusLine);

  const previewLayout = document.createElement("div");
  previewLayout.style.display = "grid";
  previewLayout.style.gridTemplateColumns = "minmax(240px, 1.05fr) minmax(360px, 1.35fr)";
  previewLayout.style.gap = "10px";
  previewLayout.style.alignItems = "start";
  card.appendChild(previewLayout);

  const normalCol = document.createElement("div");
  normalCol.style.display = "grid";
  normalCol.style.gap = "6px";
  previewLayout.appendChild(normalCol);

  const normalLabel = document.createElement("div");
  normalLabel.style.font = "600 11px/1.2 ui-sans-serif, system-ui, sans-serif";
  normalLabel.style.color = TEXT_DIM;
  normalLabel.style.textTransform = "uppercase";
  normalLabel.style.letterSpacing = "0.06em";
  normalLabel.textContent = "Mesh View";
  normalCol.appendChild(normalLabel);

  const normalPaneFrame = document.createElement("div");
  normalPaneFrame.style.position = "relative";
  normalPaneFrame.style.border = "1px solid #455a74";
  normalPaneFrame.style.borderRadius = "8px";
  normalPaneFrame.style.overflow = "hidden";
  normalPaneFrame.style.background = "transparent";
  normalPaneFrame.style.aspectRatio = "4 / 3";
  normalPaneFrame.style.minHeight = "140px";
  normalCol.appendChild(normalPaneFrame);

  const normalPaneSurface = document.createElement("div");
  normalPaneSurface.style.position = "absolute";
  normalPaneSurface.style.inset = "0";
  normalPaneSurface.style.zIndex = "1";
  normalPaneSurface.style.pointerEvents = "none";
  normalPaneFrame.appendChild(normalPaneSurface);

  const pixelCol = document.createElement("div");
  pixelCol.style.display = "grid";
  pixelCol.style.gap = "6px";
  previewLayout.appendChild(pixelCol);

  const pixelLabel = document.createElement("div");
  pixelLabel.style.font = "600 11px/1.2 ui-sans-serif, system-ui, sans-serif";
  pixelLabel.style.color = TEXT_DIM;
  pixelLabel.style.textTransform = "uppercase";
  pixelLabel.style.letterSpacing = "0.06em";
  pixelLabel.textContent = "Pixel Views (N / E / S / W)";
  pixelCol.appendChild(pixelLabel);

  const pixelGrid = document.createElement("div");
  pixelGrid.style.display = "grid";
  pixelGrid.style.gridTemplateColumns = "repeat(4, minmax(0, 1fr))";
  pixelGrid.style.gap = "8px";
  pixelCol.appendChild(pixelGrid);

  const pixelPaneSurfaces = {} as Record<PixelPaneKey, HTMLDivElement>;

  for (const pane of PIXEL_PANES) {
    const wrapper = document.createElement("div");
    wrapper.style.display = "flex";
    wrapper.style.flexDirection = "column";
    wrapper.style.alignItems = "center";
    wrapper.style.gap = "4px";
    pixelGrid.appendChild(wrapper);

    const cell = document.createElement("div");
    cell.style.position = "relative";
    cell.style.border = "1px solid #455a74";
    cell.style.borderRadius = "8px";
    cell.style.overflow = "hidden";
    cell.style.background = "transparent";
    cell.style.aspectRatio = "4 / 3";
    cell.style.minHeight = "76px";
    cell.style.width = "100%";
    wrapper.appendChild(cell);

    const surface = document.createElement("div");
    surface.style.position = "absolute";
    surface.style.inset = "0";
    surface.style.zIndex = "1";
    surface.style.pointerEvents = "none";
    cell.appendChild(surface);
    pixelPaneSurfaces[pane.key] = surface;

    const label = document.createElement("div");
    label.textContent = pane.label;
    label.style.font = "600 10px/1 ui-monospace, Menlo, monospace";
    label.style.color = "#4b617b";
    label.style.letterSpacing = "0.04em";
    label.style.textTransform = "uppercase";
    wrapper.appendChild(label);
  }

  return {
    card,
    headerLine,
    statusLine,
    normalPaneSurface,
    pixelPaneSurfaces
  };
}

function createPropSectionShell(prop: PropSpec): {
  shell: HTMLDivElement;
  header: HTMLDivElement;
  subtitle: HTMLDivElement;
  renderMount: HTMLDivElement;
  rowsGrid: HTMLDivElement;
} {
  const shell = document.createElement("div");
  shell.style.display = "grid";
  shell.style.gap = "10px";
  shell.style.padding = "14px";
  shell.style.border = "1px solid #c4d1df";
  shell.style.borderRadius = "12px";
  shell.style.background = "#d6e0ea";
  shell.style.boxShadow = "0 10px 24px rgba(33,47,67,0.10)";

  const header = document.createElement("div");
  header.style.font = "700 18px/1.15 Georgia, serif";
  header.style.color = "#1a2532";
  header.textContent = prop.label;
  shell.appendChild(header);

  const subtitle = document.createElement("div");
  subtitle.style.font = "12px/1.45 ui-monospace, Menlo, monospace";
  subtitle.style.color = "#4b617b";
  subtitle.textContent = `Source prompt: ${prop.sourcePromptPath} • concept: ${prop.sourceConceptPath}`;
  shell.appendChild(subtitle);

  const renderMount = document.createElement("div");
  renderMount.style.position = "relative";
  renderMount.style.display = "block";
  renderMount.style.minHeight = "80px";
  renderMount.style.borderRadius = "10px";
  renderMount.style.overflow = "hidden";
  shell.appendChild(renderMount);

  const rowsGrid = document.createElement("div");
  rowsGrid.style.position = "relative";
  rowsGrid.style.zIndex = "1";
  rowsGrid.style.display = "grid";
  rowsGrid.style.gap = "10px";
  rowsGrid.style.padding = "2px";
  renderMount.appendChild(rowsGrid);

  return { shell, header, subtitle, renderMount, rowsGrid };
}

async function loadGltfScene(url: string): Promise<THREE.Group> {
  const loader = new GLTFLoader();
  const gltf = await loader.loadAsync(url);
  return (gltf.scene ?? new THREE.Group()) as THREE.Group;
}

function buildVariantVisuals(
  stage: SharedScissorStage,
  variant: VariantSpec,
  rowDom: RowDom,
  scene: THREE.Scene,
  focus: THREE.Vector3,
  radius: number
): VariantRuntime {
  const normalCamera = new THREE.PerspectiveCamera(
    NORMAL_CAMERA_FOV_DEG,
    4 / 3,
    0.01,
    200
  );
  const fitCamera = (widthCss: number, heightCss: number): void => {
    fitPerspectiveCamera(
      normalCamera,
      focus,
      radius,
      Math.max(0.01, widthCss / Math.max(1, heightCss))
    );
  };
  fitCamera(4, 3);

  const normalPane = new ThreeSceneScissorPane({
    id: `${variant.prop.id}-${variant.faceLimit}-mesh`,
    element: rowDom.normalPaneSurface,
    scene,
    camera: normalCamera,
    clearColor: CLEAR_COLOR,
    clearAlpha: 1,
    autoResizePerspectiveCamera: false,
    onResize: (rect) => {
      fitCamera(rect.cssWidth, rect.cssHeight);
    }
  });
  stage.registerPane(normalPane);

  const pixelPanes: PixelPerfectIsoScissorPane[] = [];
  for (const pane of PIXEL_PANES) {
    const surface = rowDom.pixelPaneSurfaces[pane.key];
    const core = new PixelPerfectIsoViewportCore({
      width: Math.max(1, surface.clientWidth || 160),
      height: Math.max(1, surface.clientHeight || 120),
      scene,
      fixedRenderHeight: FIXED_RENDER_HEIGHT,
      baseOrthoHeight: PIXEL_BASE_ORTHO_HEIGHT,
      cameraDistance: CAMERA_DISTANCE,
      cameraPitch: CAMERA_PITCH,
      cameraYaw: CAMERA_YAW,
      basePixelZoom: PIXEL_BASE_ZOOM,
      zoomMin: PIXEL_ZOOM_MIN,
      zoomMax: PIXEL_ZOOM_MAX,
      zoomStep: PIXEL_ZOOM_STEP,
      zoomAnimationRate: PIXEL_ZOOM_ANIM_RATE,
      zoomAnimationBurstRate: PIXEL_ZOOM_BURST_RATE,
      zoomAnimationEpsilon: PIXEL_ZOOM_ANIM_EPSILON,
      rotationAnimationRate: PIXEL_ROTATION_ANIM_RATE,
      rotationAnimationEpsilon: PIXEL_ROTATION_ANIM_EPSILON,
      zoomBurstIdleMs: PIXEL_ZOOM_BURST_IDLE_MS,
      outputOverscanLowPixels: OUTPUT_OVERSCAN_LOW_PIXELS,
      clearColor: CLEAR_COLOR,
      clearAlpha: 1,
      maxBackingWidth: stage.maxBackingWidth,
      maxBackingHeight: stage.maxBackingHeight
    });
    core.setViewPose({
      targetX: 0,
      targetZ: 0,
      yawIndex: pane.yawOffset,
      zoom: 1
    });

    const paneAdapter = new PixelPerfectIsoScissorPane({
      id: `${variant.prop.id}-${variant.faceLimit}-${pane.key}`,
      element: surface,
      core
    });
    stage.registerPane(paneAdapter);
    pixelPanes.push(paneAdapter);
  }

  return {
    rowDom,
    scene,
    rootModel: scene,
    normalPane,
    pixelPanes
  };
}

function createPageStyles(): HTMLStyleElement {
  const style = document.createElement("style");
  style.textContent = `
    .tripo-face-limit-compare-root {
      position: relative;
      width: 100%;
      height: 100%;
      overflow: auto;
      box-sizing: border-box;
      padding: 14px;
      background:
        radial-gradient(1200px 500px at 5% 0%, rgba(128,166,204,0.15), transparent 60%),
        radial-gradient(900px 420px at 95% 0%, rgba(255,255,255,0.16), transparent 60%),
        #c7d3df;
    }

    .tripo-face-limit-compare-stack {
      display: grid;
      gap: 14px;
      max-width: 1500px;
      margin: 0 auto;
    }

    .tripo-face-limit-compare-topbar {
      display: grid;
      gap: 6px;
      padding: 14px;
      border: 1px solid #bccbda;
      border-radius: 12px;
      background: rgba(238, 244, 249, 0.9);
      box-shadow: 0 10px 20px rgba(33,47,67,0.08);
    }

    .tripo-face-limit-compare-title {
      font: 700 22px/1.15 Georgia, serif;
      color: #1a2532;
    }

    .tripo-face-limit-compare-subtitle {
      font: 13px/1.35 ui-sans-serif, system-ui, sans-serif;
      color: #4f657c;
    }

    .tripo-face-limit-compare-status {
      font: 12px/1.4 ui-monospace, Menlo, monospace;
      color: #5d748b;
      white-space: pre-wrap;
    }

    @media (max-width: 1100px) {
      .tripo-face-limit-compare-row-preview {
        grid-template-columns: 1fr !important;
      }
    }
  `;
  return style;
}

const experiment: ExperimentModule = {
  id: "tripo-face-limit-compare",
  title: "Tripo Face Limit Compare",
  tags: ["tripo", "mesh", "pixel", "comparison", "scissor"],
  init: async ({ mount }) => {
    const disposers: Array<() => void> = [];
    const sectionRuntimes: PropSectionRuntime[] = [];
    let disposed = false;

    const root = document.createElement("div");
    root.className = "tripo-face-limit-compare-root";
    root.dataset.sharedScissorAllowOpaqueBackground = "true";
    mount.appendChild(root);

    const styleEl = createPageStyles();
    root.appendChild(styleEl);

    const stack = document.createElement("div");
    stack.className = "tripo-face-limit-compare-stack";
    root.appendChild(stack);

    const topBar = document.createElement("div");
    topBar.className = "tripo-face-limit-compare-topbar";
    stack.appendChild(topBar);

    const title = document.createElement("div");
    title.className = "tripo-face-limit-compare-title";
    title.textContent = "Tripo Face Limit Compare (Forge V2 Prompts)";
    topBar.appendChild(title);

    const subtitle = document.createElement("div");
    subtitle.className = "tripo-face-limit-compare-subtitle";
    subtitle.textContent =
      "Local offline GLBs generated via the Hub Tripo proxy for 3 props × 4 target face limits. Each row uses @common/render shared scissor panes only: 1 normal mesh view + 4 pixel views.";
    topBar.appendChild(subtitle);

    const globalStatus = document.createElement("div");
    globalStatus.className = "tripo-face-limit-compare-status";
    topBar.appendChild(globalStatus);

    const rowDomByVariantKey = new Map<string, RowDom>();
    const variantSpecs: VariantSpec[] = [];

    // Single viewport-fixed canvas overlay — one WebGL context for all sections.
    // Pane surfaces anywhere in the DOM are measured via getBoundingClientRect and
    // rendered into the matching scissor region of this viewport-sized canvas.
    const stageOverlay = document.createElement("div");
    stageOverlay.style.position = "fixed";
    stageOverlay.style.inset = "0";
    stageOverlay.style.pointerEvents = "none";
    stageOverlay.style.zIndex = "10";
    root.appendChild(stageOverlay);

    const stage = new SharedScissorStage({
      mount: stageOverlay,
      width: Math.max(1, window.innerWidth),
      height: Math.max(1, window.innerHeight),
      antialias: false,
      clearAlpha: 0
    });
    stage.canvas.style.pointerEvents = "none";
    stage.start();

    for (const prop of PROPS) {
      const sectionShell = createPropSectionShell(prop);
      sectionShell.shell.dataset.sharedScissorAllowOpaqueBackground = "true";
      stack.appendChild(sectionShell.shell);

      const sectionRuntime: PropSectionRuntime = {
        renderMount: sectionShell.renderMount,
        rows: []
      };
      sectionRuntimes.push(sectionRuntime);

      for (const faceLimit of FACE_LIMITS) {
        const variant: VariantSpec = { prop, faceLimit };
        variantSpecs.push(variant);
        const rowDom = createRowDom(variant);
        // Responsive hook for media query; easier than duplicating inline values.
        const previewLayout = rowDom.card.children[2] as HTMLDivElement;
        previewLayout.classList.add("tripo-face-limit-compare-row-preview");
        sectionShell.rowsGrid.appendChild(rowDom.card);
        rowDomByVariantKey.set(`${prop.id}:${faceLimit}`, rowDom);
      }
    }

    const totalVariants = variantSpecs.length;
    let loadedVariants = 0;
    let failedVariants = 0;

    const refreshGlobalStatus = (): void => {
      globalStatus.textContent =
        `GLBs discovered in experiment-local generated folder: ${Object.keys(GENERATED_GLB_URLS).length}\n` +
        `Rows loaded: ${loadedVariants}/${totalVariants} • failures: ${failedVariants}`;
    };
    refreshGlobalStatus();

    const sectionByPropId = new Map(PROPS.map((prop, i) => [prop.id, sectionRuntimes[i] as PropSectionRuntime]));

    for (const variant of variantSpecs) {
      if (disposed) break;
      const rowDom = rowDomByVariantKey.get(`${variant.prop.id}:${variant.faceLimit}`);
      const section = sectionByPropId.get(variant.prop.id);
      if (!rowDom || !section) continue;

      const url = getGeneratedGlbUrl(variant.prop.id, variant.faceLimit);
      if (!url) {
        failedVariants += 1;
        rowDom.statusLine.style.color = "#c46d6d";
        rowDom.statusLine.textContent =
          `Missing local GLB: ${glbKeyFor(variant.prop.id, variant.faceLimit)}. Run scripts/generate-tripo-face-limit-compare.mjs and reload.`;
        refreshGlobalStatus();
        continue;
      }

      try {
        rowDom.statusLine.textContent = "Loading local GLB and building shared-scissor panes…";
        const loaded = await loadGltfScene(url);
        if (disposed) {
          deepDisposeObject(loaded);
          break;
        }

        const faceCount = computeTriangleCount(loaded);
        const visuals = buildSceneForVariant(loaded);
        const runtime = buildVariantVisuals(
          stage,
          variant,
          rowDom,
          visuals.scene,
          visuals.focus,
          visuals.radius
        );
        section.rows.push(runtime);

        rowDom.headerLine.textContent =
          `${variant.prop.label} • target ${variant.faceLimit.toLocaleString()} faces`;
        rowDom.statusLine.style.color = TEXT_DIM;
        rowDom.statusLine.textContent =
          `Actual triangles: ${faceCount.toLocaleString()} • model size: ${round(visuals.size.x)} × ${round(visuals.size.y)} × ${round(visuals.size.z)}u`;

        loadedVariants += 1;
        refreshGlobalStatus();
      } catch (error) {
        failedVariants += 1;
        rowDom.statusLine.style.color = "#c46d6d";
        rowDom.statusLine.textContent =
          `Failed to load/render local GLB: ${error instanceof Error ? error.message : String(error)}`;
        refreshGlobalStatus();
      }
    }

    if (!disposed) {
      stage.drawFrame(performance.now(), 0);
    }

    const cleanup = (): void => {
      if (disposed) return;
      disposed = true;

      for (const dispose of disposers) dispose();

      stage.dispose();
      for (const section of sectionRuntimes) {
        for (const row of section.rows) {
          deepDisposeObject(row.scene);
        }
      }

      if (root.parentElement === mount) {
        mount.removeChild(root);
      }
    };

    return cleanup;
  }
};

export default experiment;
