import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { makeRenderer } from "@common/render";
import {
  listSavedPropDefinitions,
  loadSavedPropBinary
} from "../settlement-builder-ecs/prop-library";
import {
  generateColliderFromObject,
  type ColliderResult
} from "../auto-collider";
import {
  segmentIntoConvexHulls,
  type ConvexSegmentationResult
} from "./convex-segmentation";
import type { ExperimentModule } from "../runtime/types";

const DEFAULT_PROP_ID = "commodore-pet-inspired-computer";
const DEFAULT_HULL_COUNT = 4;

type LabAlgorithm = "convex" | "auto";
type FitMode = "balanced" | "tight" | "max";

type PropChoice = {
  id: string;
  label: string;
};

type PropPreset = {
  algorithm?: LabAlgorithm;
  hulls?: number;
  fitMode?: FitMode;
  note?: string;
};

const FALLBACK_PROP_CHOICES: PropChoice[] = [
  {
    id: "commodore-pet-inspired-computer",
    label: "Commodore PET Inspired Computer"
  },
  {
    id: "large-desk-without-drawers",
    label: "Large Desk Without Drawers"
  }
];

const PROP_PRESETS: Record<string, PropPreset> = {
  "commodore-pet-inspired-computer": {
    algorithm: "convex",
    hulls: 3,
    fitMode: "max",
    note: "PET target: local Y cuts (XZ planes), 3 hulls, max fit."
  },
  "large-desk-without-drawers": {
    algorithm: "auto",
    note: "Desk target: 3 boxes (left support, right support, top slab)."
  }
};

function fitModeTuning(mode: FitMode): {
  maxSamplePoints: number;
  maxHullPoints: number;
  minSplitImprovement: number;
  minSplitImprovementAfterBase: number;
} {
  if (mode === "tight") {
    return {
      maxSamplePoints: 3600,
      maxHullPoints: 260,
      minSplitImprovement: 0.02,
      minSplitImprovementAfterBase: 0
    };
  }
  if (mode === "max") {
    return {
      maxSamplePoints: 5200,
      maxHullPoints: 420,
      minSplitImprovement: 0,
      minSplitImprovementAfterBase: 0
    };
  }
  return {
    maxSamplePoints: 2400,
    maxHullPoints: 140,
    minSplitImprovement: 0.07,
    minSplitImprovementAfterBase: 0.02
  };
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

async function listPropChoices(): Promise<PropChoice[]> {
  try {
    const definitions = await listSavedPropDefinitions();
    const fromDefinitions: PropChoice[] = definitions
      .map((entry) => ({
        id: entry.id,
        label: entry.description?.trim().length > 0 ? entry.description : entry.id
      }))
      .filter((entry) => entry.id.trim().length > 0);

    if (fromDefinitions.length <= 0) {
      return FALLBACK_PROP_CHOICES;
    }

    fromDefinitions.sort((a, b) => a.label.localeCompare(b.label));
    return fromDefinitions;
  } catch {
    return FALLBACK_PROP_CHOICES;
  }
}

async function loadPropModel(
  loader: GLTFLoader,
  propId: string
): Promise<THREE.Group | null> {
  const binary = await loadSavedPropBinary(propId);
  if (!binary) {
    return null;
  }

  return await new Promise<THREE.Group>((resolve, reject) => {
    loader.parse(
      binary,
      "",
      (gltf) => resolve((gltf.scene ?? new THREE.Group()) as THREE.Group),
      (error) => reject(error)
    );
  });
}

function createFallbackProp(): THREE.Group {
  const group = new THREE.Group();
  const material = new THREE.MeshStandardMaterial({
    color: 0x8f97a1,
    roughness: 0.84,
    metalness: 0.08
  });

  const screen = new THREE.Mesh(new THREE.BoxGeometry(0.96, 0.74, 0.3), material);
  screen.position.set(0, 0.82, -0.16);

  const body = new THREE.Mesh(new THREE.BoxGeometry(1.0, 0.44, 0.64), material);
  body.position.set(0, 0.35, 0.04);

  const keyboard = new THREE.Mesh(new THREE.BoxGeometry(1.0, 0.12, 0.5), material);
  keyboard.position.set(0, 0.12, 0.36);

  group.add(screen, body, keyboard);
  return group;
}

function markRenderable(root: THREE.Object3D): void {
  root.traverse((node) => {
    if (!(node instanceof THREE.Mesh)) {
      return;
    }
    if (!node.geometry.attributes.normal) {
      node.geometry.computeVertexNormals();
    }
    node.castShadow = true;
    node.receiveShadow = true;
  });
}

function disposeRenderable(root: THREE.Object3D): void {
  root.traverse((node) => {
    if (!(node instanceof THREE.Mesh || node instanceof THREE.Line || node instanceof THREE.LineSegments)) {
      return;
    }

    node.geometry.dispose();
    const material = node.material;
    if (Array.isArray(material)) {
      for (const entry of material) {
        entry.dispose();
      }
    } else {
      material.dispose();
    }
  });
}

const experiment: ExperimentModule = {
  id: "compound-collider-lab",
  title: "Compound Collider Lab",
  tags: ["colliders", "physics", "props", "debug"],
  init: async ({ mount, width, height, dpr }) => {
    mount.style.position = "relative";
    mount.style.background = "#0b1218";

    const renderer = makeRenderer(width, height, dpr);
    renderer.setClearColor(0x0b1218, 1);
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    mount.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    scene.fog = new THREE.Fog(0x0b1218, 14, 44);

    const camera = new THREE.PerspectiveCamera(48, width / height, 0.05, 120);
    camera.position.set(9.4, 7.8, 9.4);
    camera.lookAt(0, 0.8, 0);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.target.set(0, 0.9, 0);
    controls.minDistance = 4;
    controls.maxDistance = 40;
    controls.maxPolarAngle = Math.PI * 0.49;

    scene.add(new THREE.HemisphereLight(0xd8eaff, 0x1f2f38, 0.58));

    const sun = new THREE.DirectionalLight(0xffffff, 1.18);
    sun.position.set(9, 12, 5);
    sun.castShadow = true;
    sun.shadow.mapSize.set(3072, 3072);
    sun.shadow.camera.near = 0.2;
    sun.shadow.camera.far = 60;
    sun.shadow.camera.left = -18;
    sun.shadow.camera.right = 18;
    sun.shadow.camera.top = 18;
    sun.shadow.camera.bottom = -18;
    scene.add(sun);

    const floor = new THREE.Mesh(
      new THREE.PlaneGeometry(80, 80),
      new THREE.MeshStandardMaterial({
        color: 0x22313b,
        roughness: 0.97,
        metalness: 0.02
      })
    );
    floor.rotation.x = -Math.PI * 0.5;
    floor.position.y = -0.002;
    floor.receiveShadow = true;
    scene.add(floor);

    const grid = new THREE.GridHelper(40, 80, 0x35556d, 0x213543);
    grid.position.y = 0.001;
    scene.add(grid);

    const hud = document.createElement("div");
    hud.style.position = "absolute";
    hud.style.left = "12px";
    hud.style.top = "12px";
    hud.style.width = "420px";
    hud.style.maxWidth = "calc(100% - 24px)";
    hud.style.padding = "10px 12px";
    hud.style.borderRadius = "12px";
    hud.style.background = "rgba(8,14,20,0.88)";
    hud.style.border = "1px solid rgba(118,177,220,0.45)";
    hud.style.color = "#d3e8fa";
    hud.style.font = '12px/1.35 "IBM Plex Sans", "Segoe UI", sans-serif';
    hud.style.backdropFilter = "blur(6px)";
    hud.style.pointerEvents = "auto";
    hud.style.zIndex = "5";
    mount.appendChild(hud);

    hud.innerHTML = [
      "<div style='font-size:13px;font-weight:600;letter-spacing:0.02em;margin-bottom:8px'>Collider Heuristics Lab</div>",
      "<div style='font-size:11px;opacity:0.88;margin-bottom:8px'>Switch props and compare convex segmentation vs auto-collider behavior.</div>",
      "<div style='display:grid;grid-template-columns:1fr;gap:8px;margin:8px 0'>",
      "<label>Prop<select data-id='prop' style='width:100%;margin-top:4px'></select></label>",
      "<label>Algorithm<select data-id='algo' style='width:100%;margin-top:4px'><option value='convex' selected>convex segments</option><option value='auto'>auto collider (dynamic strict)</option></select></label>",
      "<label>Target Hull Count<select data-id='hulls' style='width:100%;margin-top:4px'><option value='2'>2</option><option value='3'>3</option><option value='4' selected>4</option><option value='5'>5</option><option value='6'>6</option></select></label>",
      "<label>Fit Mode<select data-id='fit-mode' style='width:100%;margin-top:4px'><option value='balanced' selected>balanced</option><option value='tight'>tight</option><option value='max'>max</option></select></label>",
      "</div>",
      "<div style='display:flex;gap:10px;flex-wrap:wrap;margin:9px 0'>",
      "<label style='display:flex;align-items:center;gap:5px'><input data-id='show-original' type='checkbox' checked>Original</label>",
      "<label style='display:flex;align-items:center;gap:5px'><input data-id='show-overlay' type='checkbox' checked>Collider Overlay</label>",
      "</div>",
      "<div style='display:flex;gap:8px;flex-wrap:wrap;margin:8px 0'>",
      "<button data-id='rebuild' style='padding:6px 10px;border-radius:8px;border:1px solid rgba(118,177,220,0.4);background:#122130;color:#d3e8fa'>Rebuild</button>",
      "<button data-id='determinism' style='padding:6px 10px;border-radius:8px;border:1px solid rgba(118,177,220,0.4);background:#122130;color:#d3e8fa'>Determinism Check</button>",
      "</div>",
      "<pre data-id='stats' style='margin:9px 0 0;padding:7px;border-radius:8px;background:rgba(5,10,15,0.6);white-space:pre-wrap;font:11px/1.35 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace'></pre>"
    ].join("");

    const showOriginal = hud.querySelector<HTMLInputElement>("[data-id='show-original']");
    const showOverlay = hud.querySelector<HTMLInputElement>("[data-id='show-overlay']");
    const propSelect = hud.querySelector<HTMLSelectElement>("[data-id='prop']");
    const algorithmSelect = hud.querySelector<HTMLSelectElement>("[data-id='algo']");
    const hullCountSelect = hud.querySelector<HTMLSelectElement>("[data-id='hulls']");
    const fitModeSelect = hud.querySelector<HTMLSelectElement>("[data-id='fit-mode']");
    const rebuildBtn = hud.querySelector<HTMLButtonElement>("[data-id='rebuild']");
    const determinismBtn = hud.querySelector<HTMLButtonElement>("[data-id='determinism']");
    const statsPre = hud.querySelector<HTMLPreElement>("[data-id='stats']");

    if (
      !showOriginal ||
      !showOverlay ||
      !propSelect ||
      !algorithmSelect ||
      !hullCountSelect ||
      !fitModeSelect ||
      !rebuildBtn ||
      !determinismBtn ||
      !statsPre
    ) {
      throw new Error("Failed to initialize collider lab controls.");
    }

    const choices = await listPropChoices();
    const labelById = new Map<string, string>();
    for (const choice of choices) {
      labelById.set(choice.id, choice.label);
    }
    propSelect.innerHTML = choices
      .map(
        (choice) =>
          `<option value="${escapeHtml(choice.id)}">${escapeHtml(choice.label)} (${escapeHtml(choice.id)})</option>`
      )
      .join("");

    const defaultChoice = choices.some((entry) => entry.id === DEFAULT_PROP_ID)
      ? DEFAULT_PROP_ID
      : choices[0]?.id;
    if (defaultChoice) {
      propSelect.value = defaultChoice;
    }

    const loader = new GLTFLoader();

    const modelRoot = new THREE.Group();
    scene.add(modelRoot);

    let model: THREE.Group | null = null;
    let modelLabel = "";
    let usedFallback = false;
    let overlayObject: THREE.Object3D | null = null;
    let lastConvexResult: ConvexSegmentationResult | null = null;
    let lastAutoResult: ColliderResult | null = null;
    let lastDeterminism = "not checked";
    let loadToken = 0;

    const syncVisibility = (): void => {
      if (model) {
        model.visible = showOriginal.checked;
      }
      if (overlayObject) {
        overlayObject.visible = showOverlay.checked;
      }
    };

    const disposeOverlay = (): void => {
      if (!overlayObject) {
        return;
      }
      modelRoot.remove(overlayObject);
      disposeRenderable(overlayObject);
      overlayObject = null;
    };

    const disposeModel = (): void => {
      if (!model) {
        return;
      }
      modelRoot.remove(model);
      disposeRenderable(model);
      model = null;
    };

    const applyPresetIfKnown = (): void => {
      const preset = PROP_PRESETS[propSelect.value];
      if (!preset) {
        return;
      }
      if (preset.algorithm) {
        algorithmSelect.value = preset.algorithm;
      }
      if (preset.hulls) {
        hullCountSelect.value = String(preset.hulls);
      }
      if (preset.fitMode) {
        fitModeSelect.value = preset.fitMode;
      }
    };

    const renderStats = (): void => {
      const propId = propSelect.value;
      const preset = PROP_PRESETS[propId];

      const header = [
        `Loaded prop: ${propId || "n/a"}`,
        `Label: ${modelLabel || propId || "n/a"}`,
        `Fallback mesh: ${usedFallback ? "yes" : "no"}`,
        `Algorithm: ${algorithmSelect.value}`,
        `Determinism: ${lastDeterminism}`,
        preset?.note ? `Preset: ${preset.note}` : "Preset: none"
      ];

      if (lastConvexResult) {
        const partLines = lastConvexResult.parts.map((part) =>
          `#${part.index + 1} seg=${part.segmentIndex + 1} y=[${part.yMin.toFixed(2)}, ${part.yMax.toFixed(2)}] center=(${part.centroid[0].toFixed(2)}, ${part.centroid[1].toFixed(2)}, ${part.centroid[2].toFixed(2)}) pts=${part.pointCount} hullPts=${part.hullPointCount} verts=${part.vertices.length} conc=${part.concavityProxy.toFixed(2)}`
        );
        const cutLine =
          lastConvexResult.cutHeights.length <= 0
            ? "Cuts: none"
            : `Cuts (local Y): ${lastConvexResult.cutHeights
                .map((value) => value.toFixed(3))
                .join(", ")}`;

        statsPre.textContent = [
          ...header,
          `Target hulls: ${lastConvexResult.targetParts}`,
          `Fit mode: ${fitModeSelect.value}`,
          `Actual hulls: ${lastConvexResult.parts.length}`,
          `Surface samples: ${lastConvexResult.sampledPoints}`,
          cutLine,
          `Signature: ${lastConvexResult.signature}`,
          "",
          ...partLines
        ].join("\n");
        return;
      }

      if (lastAutoResult) {
        const collider = lastAutoResult.rapier;
        const colliderLine =
          collider.type === "compound"
            ? `Collider: compound boxes (${collider.parts.length})`
            : `Collider: ${collider.type}`;
        const partLines =
          collider.type === "compound"
            ? collider.parts.map((part, index) =>
                `#${index + 1} pos=(${part.position[0].toFixed(2)}, ${part.position[1].toFixed(2)}, ${part.position[2].toFixed(2)}) half=(${part.halfExtents[0].toFixed(2)}, ${part.halfExtents[1].toFixed(2)}, ${part.halfExtents[2].toFixed(2)})`
              )
            : [];

        statsPre.textContent = [
          ...header,
          colliderLine,
          `Selected strategy: ${lastAutoResult.quality.selectedStrategy}`,
          `Outside ratio: ${(lastAutoResult.quality.error.outsideRatio * 100).toFixed(2)}%`,
          `Mean outside dist: ${lastAutoResult.quality.error.meanOutsideDistance.toFixed(4)}`,
          `Overfill ratio: ${(lastAutoResult.quality.error.overfillRatio * 100).toFixed(2)}%`,
          `Planarity: ${lastAutoResult.metrics.planarity.toFixed(3)}`,
          `Concavity proxy: ${lastAutoResult.metrics.concavityProxy.toFixed(3)}`,
          `Cavity score: ${lastAutoResult.metrics.cavityScore.toFixed(3)}`,
          `Layer score: ${lastAutoResult.metrics.layerScore.toFixed(3)}`,
          `Signature: ${lastAutoResult.quality.signature}`,
          "",
          ...partLines
        ].join("\n");
        return;
      }

      statsPre.textContent = [...header, "No collider result yet."].join("\n");
    };

    const rebuildCollider = (): void => {
      if (!model) {
        lastConvexResult = null;
        lastAutoResult = null;
        disposeOverlay();
        renderStats();
        return;
      }

      disposeOverlay();

      const algorithm = (algorithmSelect.value as LabAlgorithm) || "convex";
      if (algorithm === "auto") {
        const autoResult = generateColliderFromObject(model, {
          mode: "dynamic",
          budget: "strict",
          debug: true
        });
        const overlay = autoResult.debug?.three ?? new THREE.Group();
        overlay.name = "auto-collider-overlay";
        modelRoot.add(overlay);

        overlayObject = overlay;
        lastAutoResult = autoResult;
        lastConvexResult = null;
        lastDeterminism = "not checked";
        syncVisibility();
        renderStats();
        return;
      }

      const target = Number(hullCountSelect.value);
      const fitMode = (fitModeSelect.value as FitMode) || "balanced";
      const tuning = fitModeTuning(fitMode);
      const convexResult = segmentIntoConvexHulls(model, {
        targetParts: Number.isFinite(target) ? target : DEFAULT_HULL_COUNT,
        iterations: 10,
        maxSamplePoints: tuning.maxSamplePoints,
        maxHullPoints: tuning.maxHullPoints,
        minSplitImprovement: tuning.minSplitImprovement,
        minSplitImprovementAfterBase: tuning.minSplitImprovementAfterBase,
        minClusterPoints: 32
      });

      modelRoot.add(convexResult.overlay);
      overlayObject = convexResult.overlay;
      lastConvexResult = convexResult;
      lastAutoResult = null;
      lastDeterminism = "not checked";
      syncVisibility();
      renderStats();
    };

    const runDeterminismCheck = (): void => {
      if (!model) {
        return;
      }

      const algorithm = (algorithmSelect.value as LabAlgorithm) || "convex";
      if (algorithm === "auto") {
        if (!lastAutoResult) {
          return;
        }
        const rerun = generateColliderFromObject(model, {
          mode: "dynamic",
          budget: "strict"
        });
        lastDeterminism =
          rerun.quality.signature === lastAutoResult.quality.signature ? "pass" : "fail";
        renderStats();
        return;
      }

      if (!lastConvexResult) {
        return;
      }

      const target = Number(hullCountSelect.value);
      const fitMode = (fitModeSelect.value as FitMode) || "balanced";
      const tuning = fitModeTuning(fitMode);
      const rerun = segmentIntoConvexHulls(model, {
        targetParts: Number.isFinite(target) ? target : DEFAULT_HULL_COUNT,
        iterations: 10,
        maxSamplePoints: tuning.maxSamplePoints,
        maxHullPoints: tuning.maxHullPoints,
        minSplitImprovement: tuning.minSplitImprovement,
        minSplitImprovementAfterBase: tuning.minSplitImprovementAfterBase,
        minClusterPoints: 32
      });

      lastDeterminism = rerun.signature === lastConvexResult.signature ? "pass" : "fail";
      disposeRenderable(rerun.overlay);
      renderStats();
    };

    const loadSelectedProp = async (applyPreset: boolean): Promise<void> => {
      const token = ++loadToken;
      const propId = propSelect.value;

      rebuildBtn.disabled = true;
      determinismBtn.disabled = true;
      statsPre.textContent = `Loading prop ${propId}...`;

      let loaded: THREE.Group | null = null;
      try {
        loaded = await loadPropModel(loader, propId);
      } catch {
        loaded = null;
      }

      if (token !== loadToken) {
        if (loaded) {
          disposeRenderable(loaded);
        }
        return;
      }

      disposeOverlay();
      disposeModel();

      const nextModel = loaded ?? createFallbackProp();
      usedFallback = loaded === null;
      markRenderable(nextModel);
      model = nextModel;
      modelLabel = labelById.get(propId) ?? propId;
      modelRoot.add(nextModel);

      if (applyPreset) {
        applyPresetIfKnown();
      }

      rebuildBtn.disabled = false;
      determinismBtn.disabled = false;
      rebuildCollider();
    };

    const onToggleVisibility = (): void => {
      syncVisibility();
    };
    const onPropChange = (): void => {
      void loadSelectedProp(true);
    };
    const onAlgoChange = (): void => {
      rebuildCollider();
    };
    const onRebuild = (): void => {
      rebuildCollider();
    };
    const onDeterminism = (): void => {
      runDeterminismCheck();
    };

    showOriginal.addEventListener("change", onToggleVisibility);
    showOverlay.addEventListener("change", onToggleVisibility);
    propSelect.addEventListener("change", onPropChange);
    algorithmSelect.addEventListener("change", onAlgoChange);
    hullCountSelect.addEventListener("change", onRebuild);
    fitModeSelect.addEventListener("change", onRebuild);
    rebuildBtn.addEventListener("click", onRebuild);
    determinismBtn.addEventListener("click", onDeterminism);

    await loadSelectedProp(true);

    let raf = 0;
    const tick = (): void => {
      controls.update();
      renderer.render(scene, camera);
      raf = requestAnimationFrame(tick);
    };
    tick();

    return () => {
      cancelAnimationFrame(raf);

      showOriginal.removeEventListener("change", onToggleVisibility);
      showOverlay.removeEventListener("change", onToggleVisibility);
      propSelect.removeEventListener("change", onPropChange);
      algorithmSelect.removeEventListener("change", onAlgoChange);
      hullCountSelect.removeEventListener("change", onRebuild);
      fitModeSelect.removeEventListener("change", onRebuild);
      rebuildBtn.removeEventListener("click", onRebuild);
      determinismBtn.removeEventListener("click", onDeterminism);

      disposeOverlay();
      disposeModel();
      controls.dispose();
      renderer.dispose();
      mount.removeChild(renderer.domElement);
      hud.remove();
    };
  }
};

export default experiment;
