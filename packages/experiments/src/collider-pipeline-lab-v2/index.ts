import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { makeRenderer } from "@common/render";
import type { ExperimentModule } from "../runtime/types";
import {
  listSavedPropDefinitions,
  loadSavedPropBinary,
  type SavedPropDefinition
} from "../settlement-builder-ecs/prop-library";
import { applyNormalizationTransform, normalizePropGeometry } from "./pipeline/normalize";
import { runPipelineForProp } from "./pipeline/run-all";
import { buildColliderOverlay, disposeOverlay } from "./preview/build-overlay";
import {
  DEFAULT_QUALITY_WEIGHTS,
  DEFAULT_STRATEGY_PARAMS,
  resolveDefaultStrategyParams,
  STRATEGY_LABELS,
  STRATEGY_PARAM_SPECS
} from "./state/defaults";
import type {
  NormalizedProp,
  PipelineOutput,
  StrategyId,
  StrategyParamsById
} from "./types";
import { ACTIVE_STRATEGY_IDS } from "./types";

type PreparedProp = {
  definition: SavedPropDefinition;
  normalized: NormalizedProp;
  renderTemplate: THREE.Object3D;
};

type StrategyCardRuntime = {
  strategyId: StrategyId;
  root: HTMLDivElement;
  collapseButton: HTMLButtonElement;
  rankBadge: HTMLSpanElement;
  viewport: HTMLDivElement;
  stats: HTMLPreElement;
  renderer: THREE.WebGLRenderer | null;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  controls: OrbitControls | null;
  cameraTarget: THREE.Vector3;
  focusPoint: THREE.Vector3;
  collapsed: boolean;
  isVisible: boolean;
  modelRoot: THREE.Group;
  overlayRoot: THREE.Group;
  resizeObserver: ResizeObserver;
};

type StrategyCollapseState = Partial<Record<StrategyId, boolean>>;

const CARD_COLOR_PALETTE = [
  0x7dd5ff,
  0x7af2bf,
  0xf8de76,
  0x8cf8de,
  0xffd78b,
  0xff9b6b,
  0xd09bff,
  0x8dc2ff,
  0x8bf9c9,
  0x9ad6ff,
  0xffc985,
  0xbaf58f
] as const;

const CARD_COLORS = Object.fromEntries(
  ACTIVE_STRATEGY_IDS.map((strategyId, index) => [
    strategyId,
    CARD_COLOR_PALETTE[index % CARD_COLOR_PALETTE.length]
  ])
) as Record<StrategyId, number>;

const STRATEGY_COLLAPSE_STORAGE_KEY =
  "collider_pipeline_lab_v2_collapsed_strategies_v1";
const STRATEGY_GRID_ROW_HEIGHT_PX = 8;
const STRATEGY_GRID_GAP_PX = 10;

function readCollapsedStrategyState(): StrategyCollapseState {
  try {
    const raw = window.localStorage.getItem(STRATEGY_COLLAPSE_STORAGE_KEY);
    if (!raw) {
      return {};
    }
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") {
      return {};
    }
    const state: StrategyCollapseState = {};
    for (const strategyId of ACTIVE_STRATEGY_IDS) {
      const value = (parsed as Record<string, unknown>)[strategyId];
      if (typeof value === "boolean") {
        state[strategyId] = value;
      }
    }
    return state;
  } catch {
    return {};
  }
}

function writeCollapsedStrategyState(state: StrategyCollapseState): void {
  try {
    window.localStorage.setItem(
      STRATEGY_COLLAPSE_STORAGE_KEY,
      JSON.stringify(state)
    );
  } catch {
    // Ignore write errors (e.g. privacy mode or storage quota).
  }
}

function deepCloneStrategyParams(source: StrategyParamsById): StrategyParamsById {
  return JSON.parse(JSON.stringify(source)) as StrategyParamsById;
}

function createFallbackProp(): THREE.Group {
  const root = new THREE.Group();
  const material = new THREE.MeshStandardMaterial({
    color: 0x95a7b8,
    roughness: 0.88,
    metalness: 0.04
  });

  const top = new THREE.Mesh(new THREE.BoxGeometry(0.75, 0.16, 0.48), material);
  top.position.set(0, 0.62, 0);
  const body = new THREE.Mesh(new THREE.BoxGeometry(0.58, 0.58, 0.42), material);
  body.position.set(0, 0.29, 0);
  root.add(top, body);
  return root;
}

async function loadPropScene(loader: GLTFLoader, propId: string): Promise<THREE.Group | null> {
  const binary = await loadSavedPropBinary(propId);
  if (!binary) {
    return null;
  }
  return await new Promise<THREE.Group>((resolve, reject) => {
    loader.parse(
      binary,
      "",
      (gltf) => resolve((gltf.scene ?? new THREE.Group()) as THREE.Group),
      (cause) => reject(cause)
    );
  });
}

function markRenderable(root: THREE.Object3D): void {
  root.traverse((node) => {
    if (!(node instanceof THREE.Mesh)) {
      return;
    }
    if (!node.geometry.getAttribute("normal")) {
      node.geometry.computeVertexNormals();
    }
    node.castShadow = true;
    node.receiveShadow = true;
    if (Array.isArray(node.material)) {
      node.material = node.material.map((material) =>
        material instanceof THREE.MeshStandardMaterial
          ? material
          : new THREE.MeshStandardMaterial({
              color:
                material instanceof THREE.MeshBasicMaterial ||
                material instanceof THREE.MeshPhongMaterial ||
                material instanceof THREE.MeshLambertMaterial
                  ? material.color
                  : new THREE.Color(0xc9d8e6),
              roughness: 0.84,
              metalness: 0.05
            })
      );
      return;
    }

    if (
      node.material instanceof THREE.MeshBasicMaterial ||
      node.material instanceof THREE.MeshLambertMaterial ||
      node.material instanceof THREE.MeshPhongMaterial
    ) {
      node.material = new THREE.MeshStandardMaterial({
        color: node.material.color.clone(),
        map: node.material.map,
        transparent: node.material.transparent,
        opacity: node.material.opacity,
        roughness: 0.84,
        metalness: 0.05
      });
    }
  });
}

function formatPipelineSummary(result: PipelineOutput): string {
  const classification = result.classification;
  const lines = [
    `Labels`,
    `  size: ${classification.labels.size}`,
    `  complexity: ${classification.labels.complexity}`,
    `  slenderness: ${classification.labels.slenderness}`,
    `  concavity: ${classification.labels.concavity}`,
    `  flatness: ${classification.labels.flatness}`,
    ``,
    `Metrics`,
    `  dims (w/h/d): ${classification.metrics.width.toFixed(3)} / ${classification.metrics.height.toFixed(3)} / ${classification.metrics.depth.toFixed(3)}`,
    `  triangleCount: ${classification.metrics.triangleCount}`,
    `  pointCount: ${classification.metrics.pointCount}`,
    `  slenderness: ${classification.metrics.slenderness.toFixed(3)}`,
    `  compactness: ${classification.metrics.compactness.toFixed(3)}`,
    `  concavityHint: ${classification.metrics.concavityHint.toFixed(3)}`,
    `  baseContact: ${classification.metrics.baseContactRatio.toFixed(3)}`,
    `  baseUpward: ${classification.metrics.baseUpwardRatio.toFixed(3)}`,
    `  flatness: ${classification.metrics.flatnessScore.toFixed(3)}`,
    `  axisAnisotropy: ${classification.metrics.axisAnisotropy.toFixed(3)}`,
    ``,
    `Rank Agreement`,
    `  spearman: ${result.rankAgreement.spearman.toFixed(3)}`,
    `  top1 match: ${result.rankAgreement.top1Match ? "yes" : "no"}`
  ];
  return lines.join("\n");
}

function disposeCardRenderer(card: StrategyCardRuntime): void {
  if (card.controls) {
    card.controls.dispose();
    card.controls = null;
  }
  if (card.renderer) {
    card.renderer.forceContextLoss();
    card.renderer.dispose();
    const canvas = card.renderer.domElement;
    if (canvas.parentElement === card.viewport) {
      canvas.remove();
    }
    card.renderer = null;
  }
}

function disposeRendererCard(card: StrategyCardRuntime): void {
  disposeCardRenderer(card);
  card.resizeObserver.disconnect();
  card.scene.traverse((node) => {
    if (node instanceof THREE.Mesh || node instanceof THREE.LineSegments) {
      node.geometry.dispose();
      const material = node.material;
      if (Array.isArray(material)) {
        for (const entry of material) {
          entry.dispose();
        }
      } else {
        material.dispose();
      }
    }
  });
}

function frameStrategyCardToModel(card: StrategyCardRuntime): void {
  if (card.modelRoot.children.length <= 0) {
    return;
  }

  const bounds = new THREE.Box3().setFromObject(card.modelRoot);
  if (bounds.isEmpty()) {
    return;
  }

  const sphere = bounds.getBoundingSphere(new THREE.Sphere());
  const radius = Math.max(0.12, sphere.radius);
  const fovRadians = (card.camera.fov * Math.PI) / 180;
  const fitDistance = radius / Math.tan(fovRadians * 0.5);
  const distance = fitDistance * 1.22;

  const viewDirection = new THREE.Vector3(1, 0.76, 1).normalize();
  const position = sphere.center.clone().addScaledVector(viewDirection, distance);

  card.focusPoint.copy(sphere.center);
  card.cameraTarget.copy(card.focusPoint);
  card.camera.position.copy(position);
  card.camera.lookAt(card.cameraTarget);
  card.camera.near = Math.max(0.01, radius * 0.02);
  card.camera.far = Math.max(24, radius * 18);
  card.camera.updateProjectionMatrix();
  if (card.controls) {
    card.controls.target.copy(card.cameraTarget);
    card.controls.update();
  }
}

function setStrategyCardCollapsed(
  card: StrategyCardRuntime,
  collapsed: boolean
): void {
  card.collapsed = collapsed;
  card.root.dataset.collapsed = collapsed ? "true" : "false";
  card.collapseButton.textContent = collapsed ? "Expand" : "Collapse";
  card.collapseButton.title = collapsed
    ? `Expand ${STRATEGY_LABELS[card.strategyId]}`
    : `Collapse ${STRATEGY_LABELS[card.strategyId]}`;
  card.collapseButton.setAttribute(
    "aria-label",
    card.collapseButton.title
  );

  if (collapsed) {
    card.root.style.gridTemplateRows = "28px 0px 0px";
    card.root.style.minHeight = "28px";
    card.viewport.style.display = "none";
    card.stats.style.display = "none";
    if (card.controls) {
      card.controls.enabled = false;
    }
  } else {
    card.root.style.gridTemplateRows = "28px 220px auto";
    card.root.style.minHeight = "360px";
    card.viewport.style.display = "block";
    card.stats.style.display = "block";
    if (card.controls) {
      card.controls.enabled = true;
    }
    if (card.renderer) {
      const rect = card.viewport.getBoundingClientRect();
      const width = Math.max(8, Math.floor(rect.width));
      const height = Math.max(8, Math.floor(rect.height));
      card.renderer.setSize(width, height, true);
      card.camera.aspect = width / height;
      card.camera.updateProjectionMatrix();
    }
  }

  window.requestAnimationFrame(() => {
    const cardHeight = Math.max(1, card.root.scrollHeight);
    const span = Math.max(
      1,
      Math.ceil((cardHeight + STRATEGY_GRID_GAP_PX) / (STRATEGY_GRID_ROW_HEIGHT_PX + STRATEGY_GRID_GAP_PX))
    );
    card.root.style.gridRowEnd = `span ${span}`;
  });
}

function applyStrategyRankHighlight(
  card: StrategyCardRuntime,
  actualRank: number | null
): void {
  card.root.dataset.actualRank = actualRank === null ? "" : String(actualRank);
  if (actualRank === null) {
    card.root.style.borderColor = "rgba(95, 139, 170, 0.42)";
    card.root.style.boxShadow = "none";
    card.rankBadge.textContent = "";
    card.rankBadge.style.display = "none";
    return;
  }

  if (actualRank <= 3) {
    const rankStyles: Array<{ border: string; shadow: string; text: string }> = [
      {
        border: "rgba(248, 210, 96, 0.95)",
        shadow: "0 0 0 1px rgba(248, 210, 96, 0.42), 0 0 18px rgba(248, 210, 96, 0.2)",
        text: "TOP 1"
      },
      {
        border: "rgba(163, 219, 255, 0.92)",
        shadow: "0 0 0 1px rgba(163, 219, 255, 0.38), 0 0 14px rgba(143, 196, 255, 0.18)",
        text: "TOP 2"
      },
      {
        border: "rgba(226, 174, 122, 0.9)",
        shadow: "0 0 0 1px rgba(226, 174, 122, 0.35), 0 0 12px rgba(226, 174, 122, 0.16)",
        text: "TOP 3"
      }
    ];
    const style = rankStyles[actualRank - 1];
    card.root.style.borderColor = style.border;
    card.root.style.boxShadow = style.shadow;
    card.rankBadge.textContent = style.text;
    card.rankBadge.style.display = "inline-flex";
    return;
  }

  card.root.style.borderColor = "rgba(95, 139, 170, 0.42)";
  card.root.style.boxShadow = "none";
  card.rankBadge.textContent = "";
  card.rankBadge.style.display = "none";
}

function createStrategyCard(
  mount: HTMLDivElement,
  strategyId: StrategyId
): StrategyCardRuntime {
  const root = document.createElement("div");
  root.setAttribute("data-testid", `collider-v2-card-${strategyId}`);
  root.dataset.strategyId = strategyId;
  root.style.display = "grid";
  root.style.alignSelf = "start";
  root.style.gridTemplateColumns = "minmax(0, 1fr)";
  root.style.gridTemplateRows = "28px 220px auto";
  root.style.minHeight = "360px";
  root.style.background = "rgba(7, 17, 26, 0.92)";
  root.style.border = "1px solid rgba(95, 139, 170, 0.42)";
  root.style.borderRadius = "10px";
  root.style.overflow = "hidden";

  const titleRow = document.createElement("div");
  titleRow.style.display = "flex";
  titleRow.style.alignItems = "center";
  titleRow.style.justifyContent = "space-between";
  titleRow.style.gap = "6px";
  titleRow.style.padding = "5px 8px";
  titleRow.style.background = "rgba(31, 63, 89, 0.36)";
  titleRow.style.minWidth = "0";

  const title = document.createElement("div");
  title.textContent = STRATEGY_LABELS[strategyId];
  title.style.font = "600 12px/1.2 'IBM Plex Sans', ui-sans-serif, system-ui";
  title.style.letterSpacing = "0.02em";
  title.style.color = "#d8ebf7";
  title.style.minWidth = "0";
  title.style.overflow = "hidden";
  title.style.textOverflow = "ellipsis";
  title.style.whiteSpace = "nowrap";
  titleRow.appendChild(title);

  const rankBadge = document.createElement("span");
  rankBadge.style.display = "none";
  rankBadge.style.padding = "1px 7px";
  rankBadge.style.borderRadius = "999px";
  rankBadge.style.border = "1px solid rgba(158, 201, 230, 0.55)";
  rankBadge.style.background = "rgba(25, 56, 78, 0.65)";
  rankBadge.style.color = "#e5f4ff";
  rankBadge.style.font = "700 10px/1.1 'IBM Plex Sans', ui-sans-serif, system-ui";
  rankBadge.style.letterSpacing = "0.04em";
  rankBadge.style.textTransform = "uppercase";
  rankBadge.style.whiteSpace = "nowrap";
  rankBadge.style.flex = "none";
  titleRow.appendChild(rankBadge);

  const collapseButton = document.createElement("button");
  collapseButton.type = "button";
  collapseButton.setAttribute("data-testid", `collider-v2-collapse-${strategyId}`);
  collapseButton.style.padding = "2px 8px";
  collapseButton.style.borderRadius = "6px";
  collapseButton.style.border = "1px solid rgba(108, 168, 206, 0.7)";
  collapseButton.style.background = "rgba(17, 55, 83, 0.65)";
  collapseButton.style.color = "#dff2ff";
  collapseButton.style.font = "600 10px/1.1 'IBM Plex Sans', ui-sans-serif, system-ui";
  collapseButton.style.cursor = "pointer";
  collapseButton.style.flex = "none";
  titleRow.appendChild(collapseButton);

  root.appendChild(titleRow);

  const viewport = document.createElement("div");
  viewport.setAttribute("data-testid", `collider-v2-viewport-${strategyId}`);
  viewport.style.position = "relative";
  viewport.style.width = "100%";
  viewport.style.height = "220px";
  viewport.style.minWidth = "0";
  viewport.style.minHeight = "220px";
  viewport.style.background = "#08131e";
  root.appendChild(viewport);

  const stats = document.createElement("pre");
  stats.style.margin = "0";
  stats.style.padding = "8px 10px 10px";
  stats.style.borderTop = "1px solid rgba(95, 139, 170, 0.28)";
  stats.style.font = "11px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace";
  stats.style.color = "#cae6f6";
  stats.style.background = "rgba(4, 11, 18, 0.72)";
  stats.style.width = "100%";
  stats.style.minWidth = "0";
  stats.style.overflowX = "auto";
  stats.textContent = "No result yet.";
  root.appendChild(stats);

  mount.appendChild(root);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(42, 320 / 220, 0.01, 120);
  const focusPoint = new THREE.Vector3(0, 0.35, 0);
  const cameraTarget = focusPoint.clone();
  camera.position.set(1.6, 1.35, 1.6);
  camera.lookAt(cameraTarget);

  const hemi = new THREE.HemisphereLight(0xddf4ff, 0x19232c, 0.7);
  scene.add(hemi);

  const key = new THREE.DirectionalLight(0xffffff, 0.95);
  key.position.set(2, 3.2, 1.8);
  key.castShadow = true;
  key.shadow.mapSize.set(1024, 1024);
  key.shadow.camera.near = 0.1;
  key.shadow.camera.far = 20;
  key.shadow.camera.left = -2;
  key.shadow.camera.right = 2;
  key.shadow.camera.top = 2;
  key.shadow.camera.bottom = -2;
  scene.add(key);

  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(4, 4),
    new THREE.MeshStandardMaterial({
      color: 0x1b2a36,
      roughness: 0.95,
      metalness: 0.01
    })
  );
  floor.rotation.x = -Math.PI * 0.5;
  floor.position.y = -0.001;
  floor.receiveShadow = true;
  scene.add(floor);

  const grid = new THREE.GridHelper(2.4, 12, 0x2c4f63, 0x203748);
  grid.position.y = 0.001;
  scene.add(grid);

  const modelRoot = new THREE.Group();
  const overlayRoot = new THREE.Group();
  scene.add(modelRoot, overlayRoot);

  const runtime: StrategyCardRuntime = {
    strategyId,
    root,
    collapseButton,
    rankBadge,
    viewport,
    stats,
    renderer: null,
    scene,
    camera,
    controls: null,
    cameraTarget,
    focusPoint,
    collapsed: false,
    isVisible: false,
    modelRoot,
    overlayRoot,
    resizeObserver: undefined as unknown as ResizeObserver
  };

  const resizeObserver = new ResizeObserver(() => {
    if (!runtime.renderer) {
      return;
    }
    const rect = viewport.getBoundingClientRect();
    const width = Math.max(8, Math.floor(rect.width));
    const height = Math.max(8, Math.floor(rect.height));
    runtime.renderer.setSize(width, height, true);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
  });
  resizeObserver.observe(viewport);
  runtime.resizeObserver = resizeObserver;

  return runtime;
}

function ensureCardRenderer(
  card: StrategyCardRuntime,
  dpr: number,
  onControlsChange: (card: StrategyCardRuntime) => void
): void {
  if (card.renderer || card.collapsed) {
    return;
  }
  const rect = card.viewport.getBoundingClientRect();
  const width = Math.max(8, Math.floor(rect.width));
  const height = Math.max(8, Math.floor(rect.height));

  const renderer = makeRenderer(width, height, dpr);
  renderer.setClearColor(0x08131e, 1);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  card.viewport.appendChild(renderer.domElement);

  card.renderer = renderer;
  card.camera.aspect = width / height;
  card.camera.updateProjectionMatrix();

  const controls = new OrbitControls(card.camera, renderer.domElement);
  controls.enableDamping = false;
  controls.target.copy(card.cameraTarget);
  controls.minDistance = 0.35;
  controls.maxDistance = 6;
  controls.enablePan = true;
  controls.maxPolarAngle = Math.PI * 0.48;
  controls.addEventListener("change", () => {
    onControlsChange(card);
  });
  controls.update();
  card.controls = controls;
}

const experiment: ExperimentModule = {
  id: "collider-pipeline-lab-v2",
  title: "Collider Pipeline Lab V2",
  tags: ["colliders", "props", "analysis", "physics", "threejs"],
  init: async ({ mount, dpr }) => {
    mount.style.position = "relative";
    mount.style.height = "100%";
    mount.style.background = "#07121d";
    mount.style.overflow = "hidden";

    const shell = document.createElement("div");
    shell.style.position = "absolute";
    shell.style.inset = "0";
    shell.style.display = "grid";
    shell.style.gridTemplateRows = "108px minmax(0, 1fr)";
    shell.style.gap = "10px";
    shell.style.padding = "10px";
    shell.style.boxSizing = "border-box";
    shell.style.color = "#e3f2fb";
    shell.style.fontFamily = "'IBM Plex Sans', ui-sans-serif, system-ui";
    mount.appendChild(shell);

    const topBar = document.createElement("div");
    topBar.style.display = "flex";
    topBar.style.gap = "9px";
    topBar.style.alignItems = "stretch";
    topBar.style.overflowX = "auto";
    topBar.style.overflowY = "hidden";
    topBar.style.padding = "6px";
    topBar.style.background = "rgba(6, 18, 30, 0.94)";
    topBar.style.border = "1px solid rgba(88, 136, 169, 0.44)";
    topBar.style.borderRadius = "12px";
    shell.appendChild(topBar);

    const body = document.createElement("div");
    body.style.minHeight = "0";
    body.style.display = "grid";
    body.style.gap = "10px";
    body.style.gridTemplateColumns = "300px minmax(0, 1fr) 360px";
    shell.appendChild(body);

    const leftPane = document.createElement("div");
    leftPane.style.minHeight = "0";
    leftPane.style.overflow = "auto";
    leftPane.style.background = "rgba(6, 18, 30, 0.94)";
    leftPane.style.border = "1px solid rgba(88, 136, 169, 0.44)";
    leftPane.style.borderRadius = "12px";
    leftPane.style.padding = "12px";
    body.appendChild(leftPane);

    const leftHeader = document.createElement("h3");
    leftHeader.textContent = "Classification";
    leftHeader.style.margin = "0 0 10px";
    leftHeader.style.font = "600 14px/1.2 'IBM Plex Sans', ui-sans-serif, system-ui";
    leftHeader.style.letterSpacing = "0.02em";
    leftPane.appendChild(leftHeader);

    const leftInfo = document.createElement("pre");
    leftInfo.style.margin = "0";
    leftInfo.style.font = "12px/1.45 ui-monospace, SFMono-Regular, Menlo, monospace";
    leftInfo.style.color = "#cce8f7";
    leftInfo.textContent = "Select a prop to evaluate.";
    leftPane.appendChild(leftInfo);

    const middlePane = document.createElement("div");
    middlePane.style.minHeight = "0";
    middlePane.style.display = "grid";
    middlePane.style.gridTemplateRows = "34px minmax(0, 1fr)";
    middlePane.style.background = "rgba(6, 18, 30, 0.94)";
    middlePane.style.border = "1px solid rgba(88, 136, 169, 0.44)";
    middlePane.style.borderRadius = "12px";
    middlePane.style.overflow = "hidden";
    body.appendChild(middlePane);

    const middleHeader = document.createElement("div");
    middleHeader.style.padding = "6px 10px";
    middleHeader.style.borderBottom = "1px solid rgba(88, 136, 169, 0.32)";
    middleHeader.style.display = "flex";
    middleHeader.style.alignItems = "center";
    middleHeader.style.justifyContent = "flex-start";
    middleHeader.style.gap = "10px";

    const middleHeaderTitle = document.createElement("div");
    middleHeaderTitle.textContent = "Strategy Grid";
    middleHeaderTitle.style.font = "600 13px/1.15 'IBM Plex Sans', ui-sans-serif, system-ui";
    middleHeaderTitle.style.letterSpacing = "0.02em";
    middleHeaderTitle.style.color = "#d6ecfa";
    middleHeader.appendChild(middleHeaderTitle);
    middlePane.appendChild(middleHeader);

    const middleGrid = document.createElement("div");
    middleGrid.style.minHeight = "0";
    middleGrid.style.overflow = "auto";
    middleGrid.style.padding = "10px";
    middleGrid.style.display = "grid";
    middleGrid.style.gap = "10px";
    middleGrid.style.alignContent = "start";
    middleGrid.style.gridAutoRows = `${STRATEGY_GRID_ROW_HEIGHT_PX}px`;
    middleGrid.style.gridAutoFlow = "row dense";
    middlePane.appendChild(middleGrid);

    const rightPane = document.createElement("div");
    rightPane.style.minHeight = "0";
    rightPane.style.overflow = "auto";
    rightPane.style.background = "rgba(6, 18, 30, 0.94)";
    rightPane.style.border = "1px solid rgba(88, 136, 169, 0.44)";
    rightPane.style.borderRadius = "12px";
    rightPane.style.padding = "12px";
    body.appendChild(rightPane);

    const controlsHeader = document.createElement("h3");
    controlsHeader.textContent = "Strategy Controls";
    controlsHeader.style.margin = "0 0 10px";
    controlsHeader.style.font = "600 14px/1.2 'IBM Plex Sans', ui-sans-serif, system-ui";
    controlsHeader.style.letterSpacing = "0.02em";
    rightPane.appendChild(controlsHeader);

    const controlsHint = document.createElement("div");
    controlsHint.textContent =
      "Adjust strategy-specific knobs. Any change recomputes all strategies and reranks.";
    controlsHint.style.font = "12px/1.35 'IBM Plex Sans', ui-sans-serif, system-ui";
    controlsHint.style.color = "#b8d8eb";
    controlsHint.style.marginBottom = "10px";
    rightPane.appendChild(controlsHint);

    const collapsedState = readCollapsedStrategyState();
    const strategyCards = ACTIVE_STRATEGY_IDS.map((strategyId) => {
      const card = createStrategyCard(middleGrid, strategyId);
      setStrategyCardCollapsed(card, collapsedState[strategyId] ?? false);
      return card;
    });
    const cardByRoot = new Map<HTMLElement, StrategyCardRuntime>();
    for (const card of strategyCards) {
      cardByRoot.set(card.root, card);
    }

    const refreshStrategyGridSpans = (): void => {
      window.requestAnimationFrame(() => {
        for (const card of strategyCards) {
          const cardHeight = Math.max(1, card.root.scrollHeight);
          const span = Math.max(
            1,
            Math.ceil((cardHeight + STRATEGY_GRID_GAP_PX) / (STRATEGY_GRID_ROW_HEIGHT_PX + STRATEGY_GRID_GAP_PX))
          );
          card.root.style.gridRowEnd = `span ${span}`;
        }
      });
    };

    const updateStrategyGridColumns = (): void => {
      const widthPx = middleGrid.getBoundingClientRect().width;
      let columns = 1;
      if (widthPx >= 1650) {
        columns = 4;
      } else if (widthPx >= 1180) {
        columns = 3;
      } else if (widthPx >= 760) {
        columns = 2;
      }
      middleGrid.style.gridTemplateColumns = `repeat(${columns}, minmax(0, 1fr))`;
      refreshStrategyGridSpans();
      window.requestAnimationFrame(() => {
        for (const card of strategyCards) {
          if (card.renderer) {
            const rect = card.viewport.getBoundingClientRect();
            const width = Math.max(8, Math.floor(rect.width));
            const height = Math.max(8, Math.floor(rect.height));
            card.renderer.setSize(width, height, true);
            card.camera.aspect = width / height;
            card.camera.updateProjectionMatrix();
          }
        }
      });
    };

    let applyingSharedPose = false;
    const sharedCameraOffset = new THREE.Vector3(1.6, 1.0, 1.6);
    const sharedTargetOffset = new THREE.Vector3(0, 0, 0);

    const applySharedPoseToCard = (card: StrategyCardRuntime): void => {
      const target = card.focusPoint.clone().add(sharedTargetOffset);
      card.cameraTarget.copy(target);
      if (card.controls) {
        card.controls.target.copy(target);
      }
      card.camera.position.copy(target.clone().add(sharedCameraOffset));
      card.camera.lookAt(target);
      card.camera.updateMatrixWorld(true);
      if (card.controls) {
        card.controls.update();
      }
    };

    const syncSharedPoseFromCard = (source: StrategyCardRuntime): void => {
      if (source.collapsed || !source.controls) {
        return;
      }
      sharedTargetOffset.copy(source.controls.target).sub(source.focusPoint);
      const offset = source.camera.position.clone().sub(source.controls.target);
      const length = Math.max(
        source.controls.minDistance,
        Math.min(source.controls.maxDistance, offset.length())
      );
      if (!Number.isFinite(length) || length <= 1e-5) {
        return;
      }
      sharedCameraOffset.copy(offset.normalize().multiplyScalar(length));

      applyingSharedPose = true;
      for (const card of strategyCards) {
        if (card === source) {
          continue;
        }
        applySharedPoseToCard(card);
      }
      applyingSharedPose = false;
    };

    const frameAllStrategyCards = (): void => {
      for (const card of strategyCards) {
        frameStrategyCardToModel(card);
      }
      if (strategyCards.length > 0) {
        const source = strategyCards.find((entry) => !entry.collapsed) ?? strategyCards[0];
        if (source) {
          sharedTargetOffset.copy(source.cameraTarget).sub(source.focusPoint);
          const offset = source.camera.position.clone().sub(source.cameraTarget);
          const sourceMinDistance = source.controls?.minDistance ?? 0.35;
          const sourceMaxDistance = source.controls?.maxDistance ?? 6;
          const length = Math.max(sourceMinDistance, Math.min(sourceMaxDistance, offset.length()));
          if (Number.isFinite(length) && length > 1e-5) {
            sharedCameraOffset.copy(offset.normalize().multiplyScalar(length));
          }
        }
      }
      applyingSharedPose = true;
      for (const card of strategyCards) {
        applySharedPoseToCard(card);
      }
      applyingSharedPose = false;
    };

    const onCardControlsChange = (card: StrategyCardRuntime): void => {
      if (applyingSharedPose || card.collapsed) {
        return;
      }
      syncSharedPoseFromCard(card);
    };

    const updateCardRendererActivation = (card: StrategyCardRuntime): void => {
      const shouldBeActive = !card.collapsed && card.isVisible;
      if (shouldBeActive) {
        ensureCardRenderer(card, dpr, onCardControlsChange);
        applySharedPoseToCard(card);
      } else {
        disposeCardRenderer(card);
      }
    };

    const visibilityObserver = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const target = entry.target;
          if (!(target instanceof HTMLElement)) {
            continue;
          }
          const card = cardByRoot.get(target);
          if (!card) {
            continue;
          }
          card.isVisible = entry.isIntersecting && entry.intersectionRatio > 0;
          updateCardRendererActivation(card);
        }
      },
      {
        root: middleGrid,
        threshold: [0, 0.01, 0.1]
      }
    );

    for (const card of strategyCards) {
      visibilityObserver.observe(card.root);
      card.collapseButton.addEventListener("click", () => {
        const nextCollapsed = !card.collapsed;
        setStrategyCardCollapsed(card, nextCollapsed);
        collapsedState[card.strategyId] = nextCollapsed;
        writeCollapsedStrategyState(collapsedState);
        if (!nextCollapsed) {
          applySharedPoseToCard(card);
        }
        updateCardRendererActivation(card);
        updateStrategyGridColumns();
        refreshStrategyGridSpans();
      });
    }

    const propParamState = new Map<string, StrategyParamsById>();
    let paramState = deepCloneStrategyParams(DEFAULT_STRATEGY_PARAMS);
    const getParamsForProp = (propId: string): StrategyParamsById => {
      const existing = propParamState.get(propId);
      if (existing) {
        return existing;
      }
      const seeded = deepCloneStrategyParams(resolveDefaultStrategyParams(propId));
      propParamState.set(propId, seeded);
      return seeded;
    };
    const propButtonsById = new Map<string, HTMLButtonElement>();
    const preparedCache = new Map<string, PreparedProp>();
    const gltfLoader = new GLTFLoader();

    let selected: SavedPropDefinition | null = null;
    let disposed = false;
    let animationFrame = 0;
    let debounceHandle: number | null = null;
    let runToken = 0;

    const statusBar = document.createElement("div");
    statusBar.style.position = "absolute";
    statusBar.style.right = "12px";
    statusBar.style.bottom = "10px";
    statusBar.style.padding = "6px 10px";
    statusBar.style.borderRadius = "10px";
    statusBar.style.background = "rgba(4, 10, 16, 0.88)";
    statusBar.style.border = "1px solid rgba(88, 136, 169, 0.44)";
    statusBar.style.font = "12px/1.25 ui-monospace, SFMono-Regular, Menlo, monospace";
    statusBar.style.color = "#b7dbef";
    statusBar.textContent = "Loading props...";
    shell.appendChild(statusBar);

    const clearCardContent = (card: StrategyCardRuntime): void => {
      while (card.modelRoot.children.length > 0) {
        card.modelRoot.remove(card.modelRoot.children[0]);
      }
      while (card.overlayRoot.children.length > 0) {
        const child = card.overlayRoot.children[0];
        card.overlayRoot.remove(child);
        disposeOverlay(child);
      }
    };

    const applyResultToCards = (
      result: PipelineOutput,
      template: THREE.Object3D
    ): void => {
      const byId = new Map(result.strategyResults.map((entry) => [entry.strategyId, entry]));
      const rankById = new Map(
        result.strategyResults.map((entry) => [entry.strategyId, entry.actualRank])
      );

      strategyCards.sort((a, b) => {
        const rankA = rankById.get(a.strategyId) ?? Number.POSITIVE_INFINITY;
        const rankB = rankById.get(b.strategyId) ?? Number.POSITIVE_INFINITY;
        if (rankA !== rankB) {
          return rankA - rankB;
        }
        return a.strategyId.localeCompare(b.strategyId);
      });
      for (const card of strategyCards) {
        middleGrid.appendChild(card.root);
      }

      for (const card of strategyCards) {
        clearCardContent(card);
        const strategyResult = byId.get(card.strategyId);
        if (!strategyResult) {
          applyStrategyRankHighlight(card, null);
          card.stats.textContent = "No result.";
          continue;
        }

        const modelClone = template.clone(true);
        markRenderable(modelClone);
        card.modelRoot.add(modelClone);

        const overlay = buildColliderOverlay(
          strategyResult.parts,
          CARD_COLORS[card.strategyId]
        );
        card.overlayRoot.add(overlay);

        card.stats.textContent = [
          `actual rank: #${strategyResult.actualRank}    predicted rank: #${strategyResult.predictedRank}`,
          `quality score: ${strategyResult.quality.finalScore.toFixed(4)}    suitability: ${strategyResult.predicted.suitability.toFixed(3)}`,
          `voxel IoU: ${strategyResult.quality.voxelIoU.toFixed(3)}  underfill: ${strategyResult.quality.underfill.toFixed(3)}  overfill: ${strategyResult.quality.overfill.toFixed(3)}`,
          `overlap agreement: ${strategyResult.quality.overlapAgreement.toFixed(3)}  mesh/collider hit: ${strategyResult.quality.meshOverlap.toFixed(3)} / ${strategyResult.quality.colliderOverlap.toFixed(3)}  self-overlap: ${strategyResult.quality.colliderSelfOverlap.toFixed(3)}`,
          `volumes (mesh/colliderUnion/overlap): ${strategyResult.quality.meshVolume.toFixed(4)} / ${strategyResult.quality.colliderUnionVolume.toFixed(4)} / ${strategyResult.quality.overlapVolume.toFixed(4)}`,
          `thin penalty: ${strategyResult.quality.thinPenalty.toFixed(3)}  part penalty: ${strategyResult.quality.partPenalty.toFixed(3)}`,
          `base overreach: ${strategyResult.quality.baseOverreachPenalty.toFixed(3)}  base bonus: ${strategyResult.quality.flatBaseBonus.toFixed(3)}`,
          `parts: ${strategyResult.parts.length}`,
          `compute: ${strategyResult.elapsedMs.toFixed(2)} ms`
        ].join("\n");
        applyStrategyRankHighlight(card, strategyResult.actualRank);
      }
      frameAllStrategyCards();
      refreshStrategyGridSpans();
    };

    const ensurePreparedProp = async (
      definition: SavedPropDefinition
    ): Promise<PreparedProp> => {
      const cached = preparedCache.get(definition.id);
      if (cached) {
        return cached;
      }

      let scene: THREE.Group | null = null;
      try {
        scene = await loadPropScene(gltfLoader, definition.id);
      } catch {
        scene = null;
      }
      if (!scene) {
        scene = createFallbackProp();
      }

      const normalized = normalizePropGeometry(scene, definition.id);
      const renderTemplate = scene.clone(true);
      applyNormalizationTransform(renderTemplate, normalized.transform);
      markRenderable(renderTemplate);

      const prepared: PreparedProp = {
        definition,
        normalized,
        renderTemplate
      };
      preparedCache.set(definition.id, prepared);
      return prepared;
    };

    const runForCurrentSelection = async (): Promise<void> => {
      if (!selected) {
        return;
      }
      const localToken = ++runToken;
      statusBar.textContent = `Running pipeline for ${selected.id}...`;
      const prepared = await ensurePreparedProp(selected);
      if (disposed || localToken !== runToken) {
        return;
      }

      const result = runPipelineForProp(
        prepared.normalized,
        paramState,
        DEFAULT_QUALITY_WEIGHTS
      );
      leftInfo.textContent = formatPipelineSummary(result);
      applyResultToCards(result, prepared.renderTemplate);
      statusBar.textContent = `${selected.id}: pipeline complete (${result.strategyResults.length} strategies)`;
    };

    const scheduleRun = (): void => {
      if (debounceHandle !== null) {
        window.clearTimeout(debounceHandle);
      }
      debounceHandle = window.setTimeout(() => {
        debounceHandle = null;
        void runForCurrentSelection();
      }, 140);
    };

    const setSelectedProp = (definition: SavedPropDefinition): void => {
      selected = definition;
      paramState = getParamsForProp(definition.id);
      for (const [id, button] of propButtonsById.entries()) {
        if (id === definition.id) {
          button.style.borderColor = "rgba(136, 210, 255, 0.96)";
          button.style.background = "rgba(35, 86, 118, 0.55)";
          button.style.transform = "translateY(-1px)";
        } else {
          button.style.borderColor = "rgba(86, 127, 155, 0.6)";
          button.style.background = "rgba(9, 21, 33, 0.72)";
          button.style.transform = "none";
        }
      }
      rebuildControls();
      scheduleRun();
    };

    const createSliderControl = <K extends StrategyId>(
      strategyId: K,
      key: keyof StrategyParamsById[K] & string,
      label: string,
      min: number,
      max: number,
      step: number,
      initialValue: number,
      asInt: boolean
    ): HTMLDivElement => {
      const row = document.createElement("div");
      row.style.display = "grid";
      row.style.gridTemplateColumns = "1fr auto";
      row.style.gap = "8px";
      row.style.alignItems = "center";
      row.style.marginBottom = "8px";

      const name = document.createElement("label");
      name.textContent = label;
      name.style.font = "12px/1.25 'IBM Plex Sans', ui-sans-serif, system-ui";
      name.style.color = "#d3eaf8";
      row.appendChild(name);

      const value = document.createElement("span");
      value.style.font = "11px/1.2 ui-monospace, SFMono-Regular, Menlo, monospace";
      value.style.color = "#9ed2ee";
      row.appendChild(value);

      const slider = document.createElement("input");
      slider.type = "range";
      slider.min = String(min);
      slider.max = String(max);
      slider.step = String(step);
      slider.value = String(initialValue);
      slider.style.gridColumn = "1 / -1";
      slider.style.width = "100%";
      row.appendChild(slider);

      const renderValue = (raw: number): void => {
        value.textContent = asInt ? String(Math.round(raw)) : raw.toFixed(3);
      };
      renderValue(initialValue);

      slider.addEventListener("input", () => {
        const raw = Number.parseFloat(slider.value);
        const parsed = asInt ? Math.round(raw) : raw;
        (paramState[strategyId] as Record<string, number>)[key] = parsed;
        renderValue(parsed);
        scheduleRun();
      });

      return row;
    };

    const controlsRoot = document.createElement("div");
    rightPane.appendChild(controlsRoot);
    const controlsSectionById = new Map<StrategyId, HTMLElement>();
    const controlsHighlightTimeoutById = new Map<StrategyId, number>();

    const rebuildControls = (): void => {
      controlsRoot.replaceChildren();
      controlsSectionById.clear();
      for (const strategyId of ACTIVE_STRATEGY_IDS) {
        const section = document.createElement("section");
        section.setAttribute("data-testid", `collider-v2-controls-${strategyId}`);
        section.style.padding = "9px 10px 10px";
        section.style.border = "1px solid rgba(88, 136, 169, 0.35)";
        section.style.borderRadius = "9px";
        section.style.background = "rgba(8, 22, 35, 0.7)";
        section.style.marginBottom = "9px";

        const header = document.createElement("div");
        header.textContent = STRATEGY_LABELS[strategyId];
        header.style.font = "600 12px/1.2 'IBM Plex Sans', ui-sans-serif, system-ui";
        header.style.color = "#ddf2ff";
        header.style.marginBottom = "8px";
        section.appendChild(header);

        for (const spec of STRATEGY_PARAM_SPECS[strategyId]) {
          section.appendChild(
            createSliderControl(
              strategyId,
              spec.key as keyof StrategyParamsById[typeof strategyId] & string,
              spec.label,
              spec.min,
              spec.max,
              spec.step,
              Number((paramState[strategyId] as Record<string, number>)[spec.key]),
              spec.type === "int"
            )
          );
        }
        controlsRoot.appendChild(section);
        controlsSectionById.set(strategyId, section);
      }
    };

    const scrollControlsToStrategy = (strategyId: StrategyId): void => {
      const section = controlsSectionById.get(strategyId);
      if (!section) {
        return;
      }

      const rightRect = rightPane.getBoundingClientRect();
      const sectionRect = section.getBoundingClientRect();
      const deltaTop = sectionRect.top - rightRect.top;
      rightPane.scrollTo({
        top: Math.max(0, rightPane.scrollTop + deltaTop - 8),
        behavior: "smooth"
      });

      section.style.borderColor = "rgba(136, 210, 255, 0.95)";
      section.style.boxShadow = "0 0 0 1px rgba(136, 210, 255, 0.55)";
      const priorTimeout = controlsHighlightTimeoutById.get(strategyId);
      if (priorTimeout !== undefined) {
        window.clearTimeout(priorTimeout);
      }
      const timeoutHandle = window.setTimeout(() => {
        if (!section.isConnected) {
          return;
        }
        section.style.borderColor = "rgba(88, 136, 169, 0.35)";
        section.style.boxShadow = "none";
      }, 520);
      controlsHighlightTimeoutById.set(strategyId, timeoutHandle);
    };

    rebuildControls();

    for (const card of strategyCards) {
      let pointerDownPosition: { x: number; y: number } | null = null;
      card.viewport.addEventListener("pointerdown", (event) => {
        if (event.button !== 0) {
          return;
        }
        pointerDownPosition = { x: event.clientX, y: event.clientY };
      });
      card.viewport.addEventListener("pointerup", (event) => {
        if (event.button !== 0 || pointerDownPosition === null) {
          pointerDownPosition = null;
          return;
        }
        const dx = event.clientX - pointerDownPosition.x;
        const dy = event.clientY - pointerDownPosition.y;
        pointerDownPosition = null;
        if (Math.hypot(dx, dy) <= 6) {
          scrollControlsToStrategy(card.strategyId);
        }
      });
      card.viewport.addEventListener("pointercancel", () => {
        pointerDownPosition = null;
      });
    }

    const resetRow = document.createElement("div");
    resetRow.style.display = "flex";
    resetRow.style.gap = "8px";
    resetRow.style.marginTop = "10px";
    rightPane.appendChild(resetRow);

    const resetAllButton = document.createElement("button");
    resetAllButton.textContent = "Reset All";
    resetAllButton.style.flex = "1";
    resetAllButton.style.padding = "8px";
    resetAllButton.style.borderRadius = "8px";
    resetAllButton.style.border = "1px solid rgba(98, 152, 185, 0.62)";
    resetAllButton.style.background = "rgba(27, 69, 97, 0.55)";
    resetAllButton.style.color = "#d9efff";
    resetAllButton.style.cursor = "pointer";
    resetAllButton.addEventListener("click", () => {
      if (selected) {
        const freshForSelected = deepCloneStrategyParams(
          resolveDefaultStrategyParams(selected.id)
        );
        propParamState.set(selected.id, freshForSelected);
        paramState = freshForSelected;
      } else {
        paramState = deepCloneStrategyParams(DEFAULT_STRATEGY_PARAMS);
      }
      rebuildControls();
      scheduleRun();
    });
    resetRow.appendChild(resetAllButton);

    const renderLoop = (): void => {
      if (disposed) {
        return;
      }
      for (const card of strategyCards) {
        if (card.collapsed || !card.renderer) {
          continue;
        }
        const activeTarget = card.controls ? card.controls.target : card.cameraTarget;
        const cameraOffset = card.camera.position.clone().sub(activeTarget);
        const targetOffset = activeTarget.clone().sub(card.focusPoint);
        card.viewport.dataset.cameraOffset = `${cameraOffset.x.toFixed(4)},${cameraOffset.y.toFixed(4)},${cameraOffset.z.toFixed(4)}`;
        card.viewport.dataset.targetOffset = `${targetOffset.x.toFixed(4)},${targetOffset.y.toFixed(4)},${targetOffset.z.toFixed(4)}`;
        card.viewport.dataset.cameraDistance = cameraOffset.length().toFixed(4);
        card.renderer.render(card.scene, card.camera);
      }
      animationFrame = window.requestAnimationFrame(renderLoop);
    };
    animationFrame = window.requestAnimationFrame(renderLoop);

    let definitions: SavedPropDefinition[] = [];
    try {
      definitions = await listSavedPropDefinitions();
    } catch {
      definitions = [];
    }
    if (definitions.length <= 0) {
      statusBar.textContent = "No props found in assets library.";
    } else {
      for (const definition of definitions) {
        const button = document.createElement("button");
        button.type = "button";
        button.style.minWidth = "108px";
        button.style.width = "108px";
        button.style.display = "grid";
        button.style.gridTemplateRows = "64px auto";
        button.style.gap = "6px";
        button.style.padding = "6px";
        button.style.borderRadius = "9px";
        button.style.border = "1px solid rgba(86, 127, 155, 0.6)";
        button.style.background = "rgba(9, 21, 33, 0.72)";
        button.style.color = "#d6edf9";
        button.style.cursor = "pointer";
        button.style.textAlign = "left";
        button.style.transition = "transform 120ms ease";

        const thumb = document.createElement("div");
        thumb.style.width = "100%";
        thumb.style.height = "64px";
        thumb.style.borderRadius = "6px";
        thumb.style.overflow = "hidden";
        thumb.style.background = "linear-gradient(140deg, #183145, #0b1b2b)";

        const image = document.createElement("img");
        image.alt = definition.description;
        image.loading = "lazy";
        image.decoding = "async";
        image.src = `/api/fs/read?path=${encodeURIComponent(definition.conceptImagePath)}`;
        image.style.width = "100%";
        image.style.height = "100%";
        image.style.objectFit = "cover";
        image.addEventListener("error", () => {
          image.remove();
          const fallback = document.createElement("div");
          fallback.textContent = definition.description.slice(0, 2).toUpperCase();
          fallback.style.width = "100%";
          fallback.style.height = "100%";
          fallback.style.display = "grid";
          fallback.style.placeItems = "center";
          fallback.style.font = "600 13px/1.2 ui-sans-serif, system-ui";
          fallback.style.color = "#b7dff6";
          thumb.appendChild(fallback);
        });
        thumb.appendChild(image);
        button.appendChild(thumb);

        const label = document.createElement("div");
        label.textContent = definition.description;
        label.style.font = "11px/1.25 'IBM Plex Sans', ui-sans-serif, system-ui";
        label.style.height = "28px";
        label.style.overflow = "hidden";
        label.style.textOverflow = "ellipsis";
        label.style.display = "-webkit-box";
        (label.style as CSSStyleDeclaration & { WebkitLineClamp?: string }).WebkitLineClamp = "2";
        (label.style as CSSStyleDeclaration & { WebkitBoxOrient?: string }).WebkitBoxOrient = "vertical";
        button.appendChild(label);

        button.addEventListener("click", () => {
          setSelectedProp(definition);
        });

        propButtonsById.set(definition.id, button);
        topBar.appendChild(button);
      }

      setSelectedProp(definitions[0]);
    }

    const shellResizeObserver = new ResizeObserver(() => {
      const rect = mount.getBoundingClientRect();
      if (rect.width < 1240) {
        body.style.gridTemplateColumns = "280px minmax(0, 1fr)";
        rightPane.style.gridColumn = "1 / -1";
      } else {
        body.style.gridTemplateColumns = "300px minmax(0, 1fr) 360px";
        rightPane.style.gridColumn = "auto";
      }
      if (rect.width < 980) {
        body.style.gridTemplateColumns = "1fr";
        leftPane.style.gridColumn = "1";
        middlePane.style.gridColumn = "1";
        rightPane.style.gridColumn = "1";
      }
      updateStrategyGridColumns();
      frameAllStrategyCards();
    });
    shellResizeObserver.observe(mount);
    updateStrategyGridColumns();
    for (const card of strategyCards) {
      updateCardRendererActivation(card);
    }

    return () => {
      disposed = true;
      shellResizeObserver.disconnect();
      visibilityObserver.disconnect();
      for (const timeoutHandle of controlsHighlightTimeoutById.values()) {
        window.clearTimeout(timeoutHandle);
      }
      if (debounceHandle !== null) {
        window.clearTimeout(debounceHandle);
      }
      window.cancelAnimationFrame(animationFrame);
      for (const card of strategyCards) {
        disposeRendererCard(card);
      }
      shell.remove();
    };
  }
};

export default experiment;
