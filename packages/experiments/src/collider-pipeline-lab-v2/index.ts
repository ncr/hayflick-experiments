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
  STRATEGY_LABELS,
  STRATEGY_PARAM_SPECS
} from "./state/defaults";
import type {
  NormalizedProp,
  PipelineOutput,
  StrategyId,
  StrategyParamsById
} from "./types";
import { STRATEGY_IDS } from "./types";

type PreparedProp = {
  definition: SavedPropDefinition;
  normalized: NormalizedProp;
  renderTemplate: THREE.Object3D;
};

type StrategyCardRuntime = {
  strategyId: StrategyId;
  root: HTMLDivElement;
  viewport: HTMLDivElement;
  stats: HTMLPreElement;
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  controls: OrbitControls;
  modelRoot: THREE.Group;
  overlayRoot: THREE.Group;
  resizeObserver: ResizeObserver;
};

const CARD_COLORS: Record<StrategyId, number> = {
  "aabb": 0x7dd5ff,
  "obb-pca": 0x7af2bf,
  "layered-y": 0xf8de76,
  "layered-x": 0x8cf8de,
  "layered-z": 0xffd78b,
  "voxel-greedy": 0xff9b6b,
  "split-fit": 0xd09bff,
  "support-columns": 0x8dc2ff
};

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

function disposeRendererCard(card: StrategyCardRuntime): void {
  card.controls.dispose();
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
  card.renderer.dispose();
}

function createStrategyCard(
  mount: HTMLDivElement,
  strategyId: StrategyId,
  dpr: number
): StrategyCardRuntime {
  const root = document.createElement("div");
  root.style.display = "grid";
  root.style.gridTemplateRows = "28px minmax(180px, 1fr) auto";
  root.style.background = "rgba(7, 17, 26, 0.92)";
  root.style.border = "1px solid rgba(95, 139, 170, 0.42)";
  root.style.borderRadius = "10px";
  root.style.overflow = "hidden";

  const title = document.createElement("div");
  title.textContent = STRATEGY_LABELS[strategyId];
  title.style.padding = "7px 10px";
  title.style.font = "600 12px/1.2 'IBM Plex Sans', ui-sans-serif, system-ui";
  title.style.letterSpacing = "0.02em";
  title.style.color = "#d8ebf7";
  title.style.background = "rgba(31, 63, 89, 0.36)";
  root.appendChild(title);

  const viewport = document.createElement("div");
  viewport.style.position = "relative";
  viewport.style.minHeight = "190px";
  viewport.style.background = "#08131e";
  root.appendChild(viewport);

  const stats = document.createElement("pre");
  stats.style.margin = "0";
  stats.style.padding = "8px 10px 10px";
  stats.style.borderTop = "1px solid rgba(95, 139, 170, 0.28)";
  stats.style.font = "11px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace";
  stats.style.color = "#cae6f6";
  stats.style.background = "rgba(4, 11, 18, 0.72)";
  stats.textContent = "No result yet.";
  root.appendChild(stats);

  mount.appendChild(root);

  const renderer = makeRenderer(320, 220, dpr);
  renderer.setClearColor(0x08131e, 1);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  viewport.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(42, 320 / 220, 0.01, 120);
  camera.position.set(1.6, 1.35, 1.6);
  camera.lookAt(0, 0.33, 0);

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.07;
  controls.target.set(0, 0.35, 0);
  controls.minDistance = 0.35;
  controls.maxDistance = 6;
  controls.enablePan = false;
  controls.maxPolarAngle = Math.PI * 0.48;

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

  const resizeObserver = new ResizeObserver(() => {
    const rect = viewport.getBoundingClientRect();
    const width = Math.max(8, Math.floor(rect.width));
    const height = Math.max(8, Math.floor(rect.height));
    renderer.setSize(width, height, true);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
  });
  resizeObserver.observe(viewport);

  return {
    strategyId,
    root,
    viewport,
    stats,
    renderer,
    scene,
    camera,
    controls,
    modelRoot,
    overlayRoot,
    resizeObserver
  };
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
    middleHeader.textContent = "Strategy Grid";
    middleHeader.style.padding = "9px 12px";
    middleHeader.style.borderBottom = "1px solid rgba(88, 136, 169, 0.32)";
    middleHeader.style.font = "600 13px/1.15 'IBM Plex Sans', ui-sans-serif, system-ui";
    middleHeader.style.letterSpacing = "0.02em";
    middleHeader.style.color = "#d6ecfa";
    middlePane.appendChild(middleHeader);

    const middleGrid = document.createElement("div");
    middleGrid.style.minHeight = "0";
    middleGrid.style.overflow = "auto";
    middleGrid.style.padding = "10px";
    middleGrid.style.display = "grid";
    middleGrid.style.gap = "10px";
    middleGrid.style.alignContent = "start";
    middleGrid.style.gridAutoRows = "minmax(360px, auto)";
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

    const strategyCards = STRATEGY_IDS.map((strategyId) =>
      createStrategyCard(middleGrid, strategyId, dpr)
    );

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
    };

    let isSyncingCameras = false;
    const syncFromCard = (source: StrategyCardRuntime): void => {
      if (isSyncingCameras) {
        return;
      }
      isSyncingCameras = true;
      for (const card of strategyCards) {
        if (card === source) {
          continue;
        }
        card.controls.target.copy(source.controls.target);
        card.camera.position.copy(source.camera.position);
        card.camera.quaternion.copy(source.camera.quaternion);
        card.controls.update();
      }
      isSyncingCameras = false;
    };
    for (const card of strategyCards) {
      card.controls.addEventListener("change", () => syncFromCard(card));
    }

    const paramState = deepCloneStrategyParams(DEFAULT_STRATEGY_PARAMS);
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

      for (const card of strategyCards) {
        clearCardContent(card);
        const strategyResult = byId.get(card.strategyId);
        if (!strategyResult) {
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
          `underfill: ${strategyResult.quality.underfill.toFixed(3)}  overfill: ${strategyResult.quality.overfill.toFixed(3)}`,
          `thin penalty: ${strategyResult.quality.thinPenalty.toFixed(3)}  part penalty: ${strategyResult.quality.partPenalty.toFixed(3)}`,
          `base bonus: ${strategyResult.quality.flatBaseBonus.toFixed(3)}  parts: ${strategyResult.parts.length}`,
          `compute: ${strategyResult.elapsedMs.toFixed(2)} ms`
        ].join("\n");
      }
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

    const rebuildControls = (): void => {
      controlsRoot.replaceChildren();
      for (const strategyId of STRATEGY_IDS) {
        const section = document.createElement("section");
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
      }
    };

    rebuildControls();

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
      const fresh = deepCloneStrategyParams(DEFAULT_STRATEGY_PARAMS);
      Object.assign(paramState["aabb"], fresh["aabb"]);
      Object.assign(paramState["obb-pca"], fresh["obb-pca"]);
      Object.assign(paramState["layered-y"], fresh["layered-y"]);
      Object.assign(paramState["layered-x"], fresh["layered-x"]);
      Object.assign(paramState["layered-z"], fresh["layered-z"]);
      Object.assign(paramState["voxel-greedy"], fresh["voxel-greedy"]);
      Object.assign(paramState["split-fit"], fresh["split-fit"]);
      Object.assign(paramState["support-columns"], fresh["support-columns"]);
      rebuildControls();
      scheduleRun();
    });
    resetRow.appendChild(resetAllButton);

    const renderLoop = (): void => {
      if (disposed) {
        return;
      }
      for (const card of strategyCards) {
        card.controls.update();
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
    });
    shellResizeObserver.observe(mount);
    updateStrategyGridColumns();

    return () => {
      disposed = true;
      shellResizeObserver.disconnect();
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
