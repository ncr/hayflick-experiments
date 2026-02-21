import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import type { ExperimentModule } from "../runtime/types";
import {
  deserializeVhacdResult,
  disposeVhacdResult,
  extractVhacdSourceData,
  type VhacdHull,
  type VhacdProgress,
  type VhacdOptions,
  type VhacdResult,
  type VhacdSerializedResult,
  type VhacdSourceData
} from "./vhacd";

type PropChoice = {
  id: string;
  label: string;
};

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

type PropClassification = {
  furnitureScore: number;
};

type PropCard = {
  choice: PropChoice;
  root: HTMLDivElement;
  viewport: HTMLDivElement;
  status: HTMLDivElement;
  classification: HTMLDivElement;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  controls: OrbitControls;
  modelRoot: THREE.Group;
  hullRoot: THREE.Group;
  voxelRoot: THREE.Group;
  floor: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshStandardMaterial>;
  grid: THREE.GridHelper;
  model: THREE.Group | null;
  result: VhacdResult | null;
  fallbackUsed: boolean;
  hullMaterials: THREE.MeshStandardMaterial[];
  hullEdgeMaterials: THREE.LineBasicMaterial[];
  voxelMaterials: THREE.MeshStandardMaterial[];
  voxelGeometry: THREE.BoxGeometry | null;
  sourceData: VhacdSourceData | null;
  classificationData: PropClassification | null;
  runtimeMs: number | null;
  selectHandler: ((event: PointerEvent) => void) | null;
};

type WorkerRunRequest = {
  type: "run";
  requestId: number;
  sourceData: VhacdSourceData;
  options: VhacdOptions;
};

type WorkerProgressResponse = {
  type: "progress";
  requestId: number;
  progress: VhacdProgress;
};

type WorkerResultResponse = {
  type: "result";
  requestId: number;
  result: VhacdSerializedResult;
};

type WorkerErrorResponse = {
  type: "error";
  requestId: number;
  error: string;
};

type WorkerResponse = WorkerProgressResponse | WorkerResultResponse | WorkerErrorResponse;

type SharedViewPose = {
  position: THREE.Vector3;
  target: THREE.Vector3;
  up: THREE.Vector3;
  zoom: number;
};

const FALLBACK_PROPS: PropChoice[] = [
  {
    id: "commodore-pet-inspired-computer",
    label: "Commodore PET Inspired Computer"
  },
  {
    id: "large-desk-without-drawers",
    label: "Large Desk Without Drawers"
  },
  {
    id: "eames-style-chair-but-in-our-scifi-style",
    label: "Eames Style Chair"
  }
];

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function readRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  return value as Record<string, unknown>;
}

function decodeFsPayload(data: unknown): unknown {
  const record = readRecord(data);
  if (!record) {
    return data;
  }

  const content = record.content;
  if (typeof content !== "string") {
    return data;
  }

  try {
    return JSON.parse(content);
  } catch {
    return data;
  }
}

async function listDirs(fetchImpl: FetchLike, dir: string): Promise<string[]> {
  const response = await fetchImpl(`/api/fs/list?dir=${encodeURIComponent(dir)}`);
  if (!response.ok) {
    throw new Error(`list failed: ${response.status}`);
  }
  const payload = await response.json();
  if (!Array.isArray(payload)) {
    return [];
  }
  return payload.filter((entry): entry is string => typeof entry === "string");
}

async function readJson(fetchImpl: FetchLike, path: string): Promise<unknown> {
  const response = await fetchImpl(`/api/fs/read?path=${encodeURIComponent(path)}`);
  if (!response.ok) {
    throw new Error(`read failed: ${response.status}`);
  }
  const payload = await response.json();
  return decodeFsPayload(payload);
}

async function tryReadBinary(fetchImpl: FetchLike, path: string): Promise<ArrayBuffer | null> {
  const response = await fetchImpl(`/api/fs/read?path=${encodeURIComponent(path)}`);
  if (!response.ok) {
    return null;
  }
  return response.arrayBuffer();
}

async function listPropChoices(fetchImpl: FetchLike = fetch): Promise<PropChoice[]> {
  try {
    const propIds = await listDirs(fetchImpl, "props");
    if (propIds.length <= 0) {
      return FALLBACK_PROPS;
    }

    const choices = await Promise.all(
      propIds.map(async (id) => {
        try {
          const raw = await readJson(fetchImpl, `props/${id}/meta.json`);
          const record = readRecord(raw);
          const description =
            record && typeof record.description === "string" && record.description.trim().length > 0
              ? record.description.trim()
              : id;
          return {
            id,
            label: description
          } satisfies PropChoice;
        } catch {
          return {
            id,
            label: id
          } satisfies PropChoice;
        }
      })
    );

    choices.sort((a, b) => a.label.localeCompare(b.label));
    return choices;
  } catch {
    return FALLBACK_PROPS;
  }
}

async function loadPropBinary(propId: string, fetchImpl: FetchLike = fetch): Promise<ArrayBuffer | null> {
  const processed = await tryReadBinary(fetchImpl, `props/${propId}/processed/model.glb`);
  if (processed) {
    return processed;
  }
  return tryReadBinary(fetchImpl, `props/${propId}/raw/tripo-output.glb`);
}

async function loadPropModel(loader: GLTFLoader, propId: string): Promise<THREE.Group | null> {
  const binary = await loadPropBinary(propId);
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
  const root = new THREE.Group();
  const material = new THREE.MeshStandardMaterial({
    color: 0x9aa7b9,
    roughness: 0.82,
    metalness: 0.06
  });

  const top = new THREE.Mesh(new THREE.BoxGeometry(1.0, 0.16, 0.68), material);
  top.position.set(0, 0.76, -0.12);

  const body = new THREE.Mesh(new THREE.BoxGeometry(1.02, 0.58, 0.66), material);
  body.position.set(0, 0.4, 0.08);

  const keyboard = new THREE.Mesh(new THREE.BoxGeometry(1.04, 0.1, 0.56), material);
  keyboard.position.set(0, 0.12, 0.45);

  root.add(top, body, keyboard);
  return root;
}

function disposeObjectResources(root: THREE.Object3D): void {
  root.traverse((node) => {
    if (!(node instanceof THREE.Mesh || node instanceof THREE.LineSegments || node instanceof THREE.Line)) {
      return;
    }

    node.geometry.dispose();
    if (Array.isArray(node.material)) {
      for (const material of node.material) {
        material.dispose();
      }
    } else {
      node.material.dispose();
    }
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
      node.material = node.material.map((material) => {
        if (material instanceof THREE.MeshStandardMaterial) {
          material.roughness = 0.82;
          material.metalness = 0.06;
          return material;
        }
        const color =
          material instanceof THREE.MeshBasicMaterial ||
          material instanceof THREE.MeshLambertMaterial ||
          material instanceof THREE.MeshPhongMaterial
            ? material.color
            : new THREE.Color(0xc5d2e0);
        return new THREE.MeshStandardMaterial({
          color,
          roughness: 0.82,
          metalness: 0.06,
          transparent: material.transparent,
          opacity: material.opacity
        });
      });
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
        roughness: 0.82,
        metalness: 0.06
      });
    }
  });
}

function normalizeModel(root: THREE.Object3D): void {
  const bounds = new THREE.Box3().setFromObject(root);
  if (bounds.isEmpty()) {
    return;
  }

  const size = bounds.getSize(new THREE.Vector3());
  const longest = Math.max(size.x, size.y, size.z);
  const target = 2.8;
  if (longest > 1e-6) {
    const scale = target / longest;
    root.scale.multiplyScalar(scale);
  }

  root.updateMatrixWorld(true);
  const scaledBounds = new THREE.Box3().setFromObject(root);
  const center = scaledBounds.getCenter(new THREE.Vector3());
  root.position.x -= center.x;
  root.position.z -= center.z;
  root.position.y -= scaledBounds.min.y;
  root.updateMatrixWorld(true);
}

function readNumberInput(input: HTMLInputElement, fallback: number): number {
  const value = Number(input.value);
  if (!Number.isFinite(value)) {
    return fallback;
  }
  return value;
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function classifyFurniture(sourceData: VhacdSourceData | null): PropClassification | null {
  if (!sourceData || sourceData.positions.length < 9) {
    return null;
  }

  let totalArea = 0;
  let axisAlignedArea = 0;
  let horizontalArea = 0;
  let verticalArea = 0;

  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let minZ = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  let maxZ = Number.NEGATIVE_INFINITY;

  const includePoint = (x: number, y: number, z: number): void => {
    if (x < minX) {
      minX = x;
    }
    if (y < minY) {
      minY = y;
    }
    if (z < minZ) {
      minZ = z;
    }
    if (x > maxX) {
      maxX = x;
    }
    if (y > maxY) {
      maxY = y;
    }
    if (z > maxZ) {
      maxZ = z;
    }
  };

  for (let i = 0; i < sourceData.positions.length; i += 9) {
    const ax = sourceData.positions[i] ?? 0;
    const ay = sourceData.positions[i + 1] ?? 0;
    const az = sourceData.positions[i + 2] ?? 0;
    const bx = sourceData.positions[i + 3] ?? 0;
    const by = sourceData.positions[i + 4] ?? 0;
    const bz = sourceData.positions[i + 5] ?? 0;
    const cx = sourceData.positions[i + 6] ?? 0;
    const cy = sourceData.positions[i + 7] ?? 0;
    const cz = sourceData.positions[i + 8] ?? 0;

    includePoint(ax, ay, az);
    includePoint(bx, by, bz);
    includePoint(cx, cy, cz);

    const abx = bx - ax;
    const aby = by - ay;
    const abz = bz - az;
    const acx = cx - ax;
    const acy = cy - ay;
    const acz = cz - az;

    const nx = aby * acz - abz * acy;
    const ny = abz * acx - abx * acz;
    const nz = abx * acy - aby * acx;

    const normalLength = Math.sqrt(nx * nx + ny * ny + nz * nz);
    if (normalLength <= 1e-9) {
      continue;
    }

    const area = normalLength * 0.5;
    totalArea += area;

    const invLength = 1 / normalLength;
    const absNx = Math.abs(nx * invLength);
    const absNy = Math.abs(ny * invLength);
    const absNz = Math.abs(nz * invLength);
    const maxAbs = Math.max(absNx, absNy, absNz);

    if (maxAbs >= 0.92) {
      axisAlignedArea += area;
    }
    if (absNy >= 0.82) {
      horizontalArea += area;
    }
    if (absNy <= 0.28) {
      verticalArea += area;
    }
  }

  if (totalArea <= 1e-9) {
    return null;
  }

  const axisScore = clamp01((axisAlignedArea / totalArea - 0.45) / 0.45);
  const horizontalScore = clamp01((horizontalArea / totalArea) / 0.2);
  const verticalScore = clamp01((verticalArea / totalArea) / 0.25);
  const orientationMixScore = Math.sqrt(horizontalScore * verticalScore);

  const sizeX = Math.max(1e-6, maxX - minX);
  const sizeY = Math.max(1e-6, maxY - minY);
  const sizeZ = Math.max(1e-6, maxZ - minZ);

  const footprintDominance = Math.max(sizeX, sizeZ) / Math.max(sizeY, 1e-6);
  const footprintScore = clamp01((footprintDominance - 0.75) / 2.5);

  const horizontalAspect = Math.max(sizeX, sizeZ) / Math.max(1e-6, Math.min(sizeX, sizeZ));
  const horizontalBalanceScore = 1 - clamp01((horizontalAspect - 1) / 5);

  const furnitureScore = clamp01(
    axisScore * 0.45 +
      orientationMixScore * 0.3 +
      footprintScore * 0.15 +
      horizontalBalanceScore * 0.1
  );

  return {
    furnitureScore
  };
}

function setCardClassification(card: PropCard, classification: PropClassification | null): void {
  card.classificationData = classification;
  if (!classification) {
    card.classification.textContent = "class: furniture n/a";
    card.classification.style.color = "#8db4cf";
    return;
  }

  const score = classification.furnitureScore;
  card.classification.textContent = `class: furniture ${score.toFixed(2)}`;
  const hue = Math.round(8 + score * 122);
  card.classification.style.color = `hsl(${hue}, 78%, 80%)`;
}

function readCardViewPose(card: PropCard): SharedViewPose {
  return {
    position: card.camera.position.clone(),
    target: card.controls.target.clone(),
    up: card.camera.up.clone(),
    zoom: card.camera.zoom
  };
}

function applyCardViewPose(card: PropCard, pose: SharedViewPose): void {
  card.controls.target.copy(pose.target);
  card.camera.position.copy(pose.position);
  card.camera.up.copy(pose.up);
  card.camera.zoom = pose.zoom;
  card.camera.updateProjectionMatrix();
  card.controls.update();
}

function createCard(choice: PropChoice, cardsGrid: HTMLElement): PropCard {
  const root = document.createElement("div");
  root.style.borderRadius = "12px";
  root.style.border = "1px solid rgba(126, 185, 220, 0.45)";
  root.style.background = "rgba(17, 30, 42, 0.16)";
  root.style.padding = "8px";
  root.style.boxSizing = "border-box";
  root.style.display = "grid";
  root.style.gridTemplateRows = "auto auto auto auto";
  root.style.gap = "6px";
  root.style.minWidth = "0";

  const title = document.createElement("div");
  title.style.display = "flex";
  title.style.justifyContent = "space-between";
  title.style.alignItems = "baseline";
  title.style.gap = "8px";

  const titleMain = document.createElement("div");
  titleMain.style.font = '600 12px/1.2 "IBM Plex Sans", "Segoe UI", sans-serif';
  titleMain.style.color = "#d8ecfd";
  titleMain.textContent = choice.label;

  const titleId = document.createElement("div");
  titleId.style.font = "10px/1.2 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";
  titleId.style.color = "#8db4cf";
  titleId.style.opacity = "0.9";
  titleId.textContent = choice.id;

  title.append(titleMain, titleId);

  const status = document.createElement("div");
  status.style.font = "10px/1.2 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";
  status.style.color = "#9cc0d8";
  status.textContent = "waiting";

  const classification = document.createElement("div");
  classification.style.font = "10px/1.2 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";
  classification.style.color = "#8db4cf";
  classification.style.opacity = "0.96";
  classification.textContent = "class: furniture n/a";

  const viewport = document.createElement("div");
  viewport.style.height = "258px";
  viewport.style.borderRadius = "8px";
  viewport.style.border = "1px solid rgba(145, 199, 230, 0.5)";
  viewport.style.background = "rgba(0, 0, 0, 0)";
  viewport.style.touchAction = "none";
  viewport.style.overflow = "hidden";

  root.append(title, status, classification, viewport);
  cardsGrid.appendChild(root);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x27455d);

  const camera = new THREE.PerspectiveCamera(45, 1, 0.05, 220);
  camera.position.set(4.8, 3.4, 4.8);

  const controls = new OrbitControls(camera, viewport);
  controls.enableDamping = true;
  controls.dampingFactor = 0.09;
  controls.screenSpacePanning = true;
  controls.minDistance = 0.8;
  controls.maxDistance = 80;
  controls.maxPolarAngle = Math.PI * 0.49;
  controls.target.set(0, 0.8, 0);
  controls.update();

  scene.add(new THREE.AmbientLight(0xffffff, 0.42));
  scene.add(new THREE.HemisphereLight(0xf1f8ff, 0x426078, 1.28));

  const sun = new THREE.DirectionalLight(0xffffff, 1.8);
  sun.position.set(7, 11, 6);
  sun.castShadow = false;
  scene.add(sun);

  const fill = new THREE.DirectionalLight(0xdceaff, 0.95);
  fill.position.set(-6, 8, -5);
  fill.castShadow = false;
  scene.add(fill);

  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(80, 80),
    new THREE.MeshStandardMaterial({
      color: 0x55788f,
      roughness: 0.8,
      metalness: 0.02
    })
  );
  floor.rotation.x = -Math.PI * 0.5;
  floor.position.y = -0.001;
  floor.receiveShadow = true;
  scene.add(floor);

  const grid = new THREE.GridHelper(40, 80, 0x8ab9da, 0x57798f);
  grid.position.y = 0.002;
  scene.add(grid);

  const modelRoot = new THREE.Group();
  const hullRoot = new THREE.Group();
  const voxelRoot = new THREE.Group();
  scene.add(modelRoot, hullRoot, voxelRoot);

  return {
    choice,
    root,
    viewport,
    status,
    classification,
    scene,
    camera,
    controls,
    modelRoot,
    hullRoot,
    voxelRoot,
    floor,
    grid,
    model: null,
    result: null,
    fallbackUsed: false,
    hullMaterials: [],
    hullEdgeMaterials: [],
    voxelMaterials: [],
    voxelGeometry: null,
    sourceData: null,
    classificationData: null,
    runtimeMs: null,
    selectHandler: null
  };
}

function frameCard(card: PropCard): void {
  const bounds = new THREE.Box3().setFromObject(card.modelRoot);
  if (bounds.isEmpty()) {
    card.controls.target.set(0, 0.6, 0);
    card.camera.position.set(4.8, 3.4, 4.8);
    card.controls.update();
    return;
  }

  const center = bounds.getCenter(new THREE.Vector3());
  const size = bounds.getSize(new THREE.Vector3());
  const radius = Math.max(0.35, size.length() * 0.45);

  const fov = THREE.MathUtils.degToRad(card.camera.fov);
  const distance = Math.max(2.8, (radius / Math.tan(fov * 0.5)) * 1.25);

  const viewDirection = new THREE.Vector3(1, 0.7, 1).normalize();
  card.camera.position.copy(center.clone().addScaledVector(viewDirection, distance));
  card.controls.target.copy(center);
  card.controls.update();
}

function clearCardVoxelOverlay(card: PropCard): void {
  while (card.voxelRoot.children.length > 0) {
    const child = card.voxelRoot.children[0];
    if (!child) {
      break;
    }
    card.voxelRoot.remove(child);
  }

  if (card.voxelGeometry) {
    card.voxelGeometry.dispose();
    card.voxelGeometry = null;
  }

  for (const material of card.voxelMaterials) {
    material.dispose();
  }
  card.voxelMaterials.length = 0;
}

function clearCardHullOverlay(card: PropCard): void {
  while (card.hullRoot.children.length > 0) {
    const child = card.hullRoot.children[0];
    if (!child) {
      break;
    }
    child.traverse((node) => {
      if (node instanceof THREE.LineSegments || node instanceof THREE.Line) {
        node.geometry.dispose();
      }
    });
    card.hullRoot.remove(child);
  }

  for (const material of card.hullMaterials) {
    material.dispose();
  }
  card.hullMaterials.length = 0;

  for (const material of card.hullEdgeMaterials) {
    material.dispose();
  }
  card.hullEdgeMaterials.length = 0;
}

function clearCardOverlay(card: PropCard): void {
  disposeVhacdResult(card.result);
  card.result = null;
  clearCardHullOverlay(card);
  clearCardVoxelOverlay(card);
}

function clearCardModel(card: PropCard): void {
  if (!card.model) {
    card.sourceData = null;
    setCardClassification(card, null);
    return;
  }
  card.modelRoot.remove(card.model);
  disposeObjectResources(card.model);
  card.model = null;
  card.sourceData = null;
  setCardClassification(card, null);
}

function disposeCard(card: PropCard): void {
  clearCardOverlay(card);
  clearCardModel(card);
  card.controls.dispose();
  if (card.selectHandler) {
    card.root.removeEventListener("pointerdown", card.selectHandler);
    card.selectHandler = null;
  }

  card.floor.geometry.dispose();
  card.floor.material.dispose();

  card.grid.geometry.dispose();
  if (Array.isArray(card.grid.material)) {
    for (const material of card.grid.material) {
      material.dispose();
    }
  } else {
    card.grid.material.dispose();
  }

  card.root.remove();
}

function resolveDisplayedHulls(result: VhacdResult, projected: boolean): VhacdHull[] {
  if (!result.hullVariants) {
    return result.hulls;
  }
  return projected ? result.hullVariants.projected : result.hullVariants.unprojected;
}

function resolveDisplayedSignature(result: VhacdResult, projected: boolean): string {
  if (!result.signatures) {
    return result.signature;
  }
  return projected ? result.signatures.projected : result.signatures.unprojected;
}

function renderCardHullOverlay(card: PropCard, hulls: VhacdHull[], wireframe: boolean): void {
  clearCardHullOverlay(card);

  for (const hull of hulls) {
    const material = new THREE.MeshStandardMaterial({
      color: hull.color,
      roughness: 0.58,
      metalness: 0.06,
      transparent: true,
      opacity: 0.48,
      side: THREE.DoubleSide,
      depthWrite: false,
      wireframe
    });
    card.hullMaterials.push(material);

    const mesh = new THREE.Mesh(hull.geometry, material);
    mesh.castShadow = false;
    mesh.receiveShadow = false;

    const edgeGeometry = new THREE.EdgesGeometry(hull.geometry, 25);
    const edgeMaterial = new THREE.LineBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0.65
    });
    card.hullEdgeMaterials.push(edgeMaterial);
    const edges = new THREE.LineSegments(edgeGeometry, edgeMaterial);

    const part = new THREE.Group();
    part.add(mesh);
    part.add(edges);
    card.hullRoot.add(part);
  }
}

function renderCardVoxelOverlay(card: PropCard, result: VhacdResult): void {
  clearCardVoxelOverlay(card);

  if (result.voxelView.voxelSize <= 0) {
    return;
  }

  card.voxelGeometry = new THREE.BoxGeometry(
    result.voxelView.voxelSize,
    result.voxelView.voxelSize,
    result.voxelView.voxelSize
  );
  const matrix = new THREE.Matrix4();

  for (const part of result.voxelView.parts) {
    if (part.centers.length <= 0 || !card.voxelGeometry) {
      continue;
    }

    const material = new THREE.MeshStandardMaterial({
      color: part.color,
      roughness: 0.92,
      metalness: 0.01,
      transparent: true,
      opacity: 0.17,
      depthWrite: false
    });
    card.voxelMaterials.push(material);

    const mesh = new THREE.InstancedMesh(card.voxelGeometry, material, part.centers.length);
    mesh.castShadow = false;
    mesh.receiveShadow = false;

    for (let i = 0; i < part.centers.length; i += 1) {
      const center = part.centers[i];
      matrix.makeTranslation(center[0], center[1], center[2]);
      mesh.setMatrixAt(i, matrix);
    }

    mesh.instanceMatrix.needsUpdate = true;
    mesh.frustumCulled = false;
    card.voxelRoot.add(mesh);
  }
}

function renderCardStats(card: PropCard, runtimeMs: number | null, projected: boolean): string {
  const result = card.result;
  const furnitureScore =
    card.classificationData === null ? "n/a" : card.classificationData.furnitureScore.toFixed(3);
  if (!result) {
    return [
      `prop: ${card.choice.id}`,
      `furniture score: ${furnitureScore}`,
      "no segmentation result"
    ].join("\n");
  }

  const displayedHulls = resolveDisplayedHulls(result, projected);
  const displaySignature = resolveDisplayedSignature(result, projected);

  const lines = [
    `runtime: ${runtimeMs === null ? "n/a" : `${runtimeMs.toFixed(1)} ms`}`,
    `fallback mesh: ${card.fallbackUsed ? "yes" : "no"}`,
    `furniture score: ${furnitureScore}`,
    `triangles: ${result.stats.sourceTriangleCount}`,
    `voxels: ${result.stats.voxelCount}`,
    `voxel preview: ${result.stats.voxelPreviewCount}`,
    `variant: ${projected ? "projected" : "raw"}`,
    `hulls: ${displayedHulls.length}`,
    `splits: ${result.stats.splitCount}`,
    `merges: ${result.stats.mergeCount}`,
    `split eval: ${result.stats.splitEvaluationMode} (${result.stats.splitWorkerCount} workers)`,
    `planes tested: ${result.stats.candidatePlaneCount}`,
    `signature: ${displaySignature}`
  ];

  return lines.join("\n");
}

async function loadCardModel(card: PropCard, loader: GLTFLoader): Promise<void> {
  let loaded: THREE.Group | null = null;
  try {
    loaded = await loadPropModel(loader, card.choice.id);
  } catch {
    loaded = null;
  }

  clearCardOverlay(card);
  clearCardModel(card);

  const nextModel = loaded ?? createFallbackProp();
  markRenderable(nextModel);
  normalizeModel(nextModel);
  card.modelRoot.add(nextModel);
  card.model = nextModel;
  card.sourceData = extractVhacdSourceData(nextModel);
  setCardClassification(card, classifyFurniture(card.sourceData));
  card.fallbackUsed = loaded === null;
  card.runtimeMs = null;
  frameCard(card);
}

function applyVisibility(cards: PropCard[], showModel: boolean, showHulls: boolean, showVoxels: boolean): void {
  for (const card of cards) {
    if (card.model) {
      card.model.visible = showModel;
    }
    card.hullRoot.visible = showHulls;
    card.voxelRoot.visible = showVoxels;
  }
}

function applyWireframe(cards: PropCard[], wireframe: boolean): void {
  for (const card of cards) {
    for (const material of card.hullMaterials) {
      material.wireframe = wireframe;
    }
  }
}

function readOptionsFromUi(
  resolutionInput: HTMLInputElement,
  maxHullsInput: HTMLInputElement,
  concavityInput: HTMLInputElement,
  alphaInput: HTMLInputElement,
  betaInput: HTMLInputElement,
  sliverPenaltyInput: HTMLInputElement,
  planeDownsampleInput: HTMLInputElement,
  hullDownsampleInput: HTMLInputElement,
  minVoxelsInput: HTMLInputElement,
  maxHullSamplesInput: HTMLInputElement,
  projectHullMaxDistanceInput: HTMLInputElement,
  projectHullVerticesInput: HTMLInputElement,
  maxGridCellsInput: HTMLInputElement,
  voxelTriSampleInput: HTMLInputElement
): VhacdOptions {
  return {
    resolution: Math.floor(readNumberInput(resolutionInput, 128)),
    maxConvexHulls: Math.floor(readNumberInput(maxHullsInput, 24)),
    concavity: readNumberInput(concavityInput, 0.002),
    alpha: readNumberInput(alphaInput, 0.05),
    beta: readNumberInput(betaInput, 0.05),
    sliverPenalty: readNumberInput(sliverPenaltyInput, 0.35),
    planeDownsampling: Math.floor(readNumberInput(planeDownsampleInput, 1)),
    convexHullDownsampling: Math.floor(readNumberInput(hullDownsampleInput, 1)),
    minVoxelCountPerPart: Math.floor(readNumberInput(minVoxelsInput, 24)),
    maxHullPointSamples: Math.floor(readNumberInput(maxHullSamplesInput, 1800)),
    projectHullVertices: projectHullVerticesInput.checked,
    projectHullMaxDistance: readNumberInput(projectHullMaxDistanceInput, 0.18),
    precomputeBothHullVariants: true,
    maxGridCells: Math.floor(readNumberInput(maxGridCellsInput, 20_000_000)),
    voxelizationTriangleSampleCount: Math.floor(readNumberInput(voxelTriSampleInput, 12_000))
  };
}

type PendingWorkerRequest = {
  requestId: number;
  resolve: (result: VhacdResult) => void;
  reject: (error: Error) => void;
  onProgress: (progress: VhacdProgress) => void;
};

function createVhacdWorkerRunner(): {
  run: (
    sourceData: VhacdSourceData,
    options: VhacdOptions,
    onProgress: (progress: VhacdProgress) => void
  ) => Promise<VhacdResult>;
  restart: (reason?: string) => void;
  dispose: () => void;
} {
  let worker: Worker | null = null;
  let pending: PendingWorkerRequest | null = null;
  let nextRequestId = 1;

  const terminateWorker = (reason: string): void => {
    if (worker) {
      worker.terminate();
      worker = null;
    }
    if (pending) {
      const request = pending;
      pending = null;
      request.reject(new Error(reason));
    }
  };

  const ensureWorker = (): Worker => {
    if (worker) {
      return worker;
    }

    const instance = new Worker(new URL("./vhacd.worker.ts", import.meta.url), {
      type: "module"
    });

    instance.addEventListener("message", (event: MessageEvent<WorkerResponse>) => {
      const message = event.data;
      if (!pending || message.requestId !== pending.requestId) {
        return;
      }

      if (message.type === "progress") {
        pending.onProgress(message.progress);
        return;
      }

      if (message.type === "error") {
        const request = pending;
        pending = null;
        request.reject(new Error(message.error || "VHACD worker failed"));
        return;
      }

      const request = pending;
      pending = null;
      try {
        request.resolve(deserializeVhacdResult(message.result));
      } catch (error) {
        request.reject(
          error instanceof Error ? error : new Error("Failed to deserialize VHACD worker result")
        );
      }
    });

    instance.addEventListener("error", (event: ErrorEvent) => {
      const detail = event.message?.trim().length ? event.message : "unknown error";
      terminateWorker(`VHACD worker crashed: ${detail}`);
    });

    worker = instance;
    return instance;
  };

  const run = (
    sourceData: VhacdSourceData,
    options: VhacdOptions,
    onProgress: (progress: VhacdProgress) => void
  ): Promise<VhacdResult> => {
    if (pending) {
      return Promise.reject(new Error("VHACD worker is busy"));
    }

    return new Promise<VhacdResult>((resolve, reject) => {
      const requestId = nextRequestId;
      nextRequestId += 1;
      pending = {
        requestId,
        resolve,
        reject,
        onProgress
      };

      const request: WorkerRunRequest = {
        type: "run",
        requestId,
        sourceData,
        options
      };

      ensureWorker().postMessage(request);
    });
  };

  return {
    run,
    restart: (reason = "VHACD run canceled"): void => {
      terminateWorker(reason);
    },
    dispose: (): void => {
      terminateWorker("VHACD worker disposed");
    }
  };
}

const experiment: ExperimentModule = {
  id: "vhacd-unity-lab",
  title: "VHACD Unity Lab",
  tags: ["colliders", "threejs", "props", "physics", "segmentation"],
  init: async ({ mount, width, height, dpr }) => {
    mount.style.position = "relative";
    mount.style.background = "#193448";
    mount.style.overflow = "hidden";

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
    renderer.setPixelRatio(Math.min(2, dpr));
    renderer.setSize(width, height, true);
    renderer.setClearColor(0x193448, 1);
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.55;
    renderer.autoClear = false;
    renderer.domElement.style.position = "absolute";
    renderer.domElement.style.inset = "0";
    renderer.domElement.style.display = "block";
    renderer.domElement.style.pointerEvents = "none";
    mount.appendChild(renderer.domElement);

    const hud = document.createElement("div");
    hud.style.position = "absolute";
    hud.style.left = "12px";
    hud.style.top = "12px";
    hud.style.boxSizing = "border-box";
    hud.style.borderRadius = "14px";
    hud.style.padding = "12px";
    hud.style.background = "rgba(8, 14, 20, 0.88)";
    hud.style.border = "1px solid rgba(111, 177, 216, 0.45)";
    hud.style.backdropFilter = "blur(6px)";
    hud.style.color = "#d8ecfd";
    hud.style.font = '12px/1.4 "IBM Plex Sans", "Segoe UI", sans-serif';
    hud.style.zIndex = "30";
    hud.style.pointerEvents = "auto";
    hud.style.overflowY = "auto";
    mount.appendChild(hud);

    hud.innerHTML = [
      "<div style='display:flex;justify-content:space-between;align-items:center;gap:8px;margin-bottom:8px'>",
      "<div style='font-size:14px;font-weight:600;letter-spacing:0.02em'>VHACD (Unity-style) Grid Lab</div>",
      "<div style='font-size:10px;opacity:0.8'>one GL context + scissor</div>",
      "</div>",
      "<div style='font-size:11px;opacity:0.86;margin-bottom:10px'>All props are shown simultaneously in a grid; orbit pan/zoom/rotate is synchronized across cards and rendered via one WebGL renderer.</div>",
      "<div style='display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px'>",
      "<label>Resolution<input data-id='resolution' type='number' min='10' max='256' step='1' value='128' style='display:block;width:100%;margin-top:4px;min-height:34px'></label>",
      "<label>Max Hulls<input data-id='max-hulls' type='number' min='1' max='64' step='1' value='24' style='display:block;width:100%;margin-top:4px;min-height:34px'></label>",
      "<label>Concavity<input data-id='concavity' type='number' min='0' max='1' step='0.0005' value='0.002' style='display:block;width:100%;margin-top:4px;min-height:34px'></label>",
      "<label>Alpha<input data-id='alpha' type='number' min='0' max='1' step='0.01' value='0.05' style='display:block;width:100%;margin-top:4px;min-height:34px'></label>",
      "<label>Beta<input data-id='beta' type='number' min='0' max='1' step='0.01' value='0.05' style='display:block;width:100%;margin-top:4px;min-height:34px'></label>",
      "<label>Sliver Penalty<input data-id='sliver-penalty' type='number' min='0' max='3' step='0.05' value='0.35' style='display:block;width:100%;margin-top:4px;min-height:34px'></label>",
      "<label>Plane Downsample<input data-id='plane-downsample' type='number' min='1' max='12' step='1' value='1' style='display:block;width:100%;margin-top:4px;min-height:34px'></label>",
      "<label>Hull Downsample<input data-id='hull-downsample' type='number' min='1' max='12' step='1' value='1' style='display:block;width:100%;margin-top:4px;min-height:34px'></label>",
      "<label>Min Voxels/Part<input data-id='min-voxels' type='number' min='4' max='200' step='1' value='24' style='display:block;width:100%;margin-top:4px;min-height:34px'></label>",
      "<label>Max Hull Samples<input data-id='max-hull-samples' type='number' min='64' max='9000' step='1' value='1800' style='display:block;width:100%;margin-top:4px;min-height:34px'></label>",
      "<label>Project Max Distance<input data-id='project-hull-max-distance' type='number' min='0' max='2' step='0.01' value='0.18' style='display:block;width:100%;margin-top:4px;min-height:34px'></label>",
      "<label>Max Grid Cells<input data-id='max-grid-cells' type='number' min='250000' max='20000000' step='250000' value='20000000' style='display:block;width:100%;margin-top:4px;min-height:34px'></label>",
      "<label>Voxel Tri Samples<input data-id='voxel-tri-samples' type='number' min='1000' max='120000' step='1000' value='12000' style='display:block;width:100%;margin-top:4px;min-height:34px'></label>",
      "</div>",
      "<label style='display:flex;align-items:center;gap:6px;margin-top:8px;min-height:34px'><input data-id='project-hull-vertices' type='checkbox' checked>Project Hull Vertices To Source Mesh (instant toggle after compute)</label>",
      "<details style='margin-top:10px;border:1px solid rgba(111,177,216,0.3);border-radius:8px;background:rgba(10,18,26,0.55)'>",
      "<summary style='cursor:pointer;user-select:none;padding:7px 9px;font-size:11px;font-weight:600'>Parameter Guide (practical meaning)</summary>",
      "<div style='padding:2px 9px 9px;font-size:10px;opacity:0.9;line-height:1.3'>",
      "<div style='margin-top:6px'><b>Resolution</b>: higher = finer voxel detail, more runtime. lower = faster but misses thin features. sensible: 24-128 (256 = very expensive).</div>",
      "<div style='margin-top:6px'><b>Max Hulls</b>: higher = allows finer segmentation. lower = more merged/coarse parts. sensible: 6-20 (24-32 for very concave props).</div>",
      "<div style='margin-top:6px'><b>Concavity</b>: split stop threshold. higher = fewer splits. lower = more splits. sensible: 0.001-0.01.</div>",
      "<div style='margin-top:6px'><b>Alpha</b>: volume-balance weight in split cost. higher = more balanced cuts, fewer slivers. sensible: 0.02-0.12.</div>",
      "<div style='margin-top:6px'><b>Beta</b>: preferred-axis bias weight. higher = stronger axis preference. sensible: 0-0.1.</div>",
      "<div style='margin-top:6px'><b>Sliver Penalty</b>: penalizes thin/sparse child parts during split scoring. higher = fewer narrow wedge fragments, but can reduce fine-detail capture. sensible: 0.15-0.8.</div>",
      "<div style='margin-top:6px'><b>Plane Downsample</b>: coarse plane-search stride. higher = fewer tested planes, faster/lower quality. sensible: 2-6 (1 for quality).</div>",
      "<div style='margin-top:6px'><b>Hull Downsample</b>: sampling stride for split-time hull estimates. higher = faster/noisier estimates. sensible: 2-6 (1 for quality).</div>",
      "<div style='margin-top:6px'><b>Min Voxels/Part</b>: minimum child size after split. higher = less tiny noise parts, may miss thin details. sensible: 20-40 at res 40.</div>",
      "<div style='margin-top:6px'><b>Max Hull Samples</b>: point budget used to build/project each hull. higher = tighter hulls and slower runs. sensible: 1200-3000.</div>",
      "<div style='margin-top:6px'><b>Max Grid Cells</b>: upper bound for voxel grid cells. higher = better detail and higher memory/runtime.</div>",
      "<div style='margin-top:6px'><b>Voxel Tri Samples</b>: how many source triangles are sampled during voxelization. higher = better shell coverage, slower.</div>",
      "<div style='margin-top:6px'><b>Project Hull Vertices</b>: snaps hull vertices onto the source mesh. Both raw/projected variants are precomputed per run, so toggling is immediate after compute.</div>",
      "<div style='margin-top:6px'><b>Project Max Distance</b>: max allowed snap distance when projecting hull vertices. lower = prevents deep interior vertices from jumping to distant surface points. 0 disables the cap.</div>",
      "<div style='margin-top:6px'><b>Current Defaults</b>: balanced-high preset (Resolution 128 + Max Grid Cells 20M).</div>",
      "</div>",
      "</details>",
      "<div style='display:flex;gap:8px;flex-wrap:wrap;margin-top:10px'>",
      "<button data-id='run-all' style='padding:6px 10px;min-height:40px;border-radius:8px;border:1px solid rgba(111,177,216,0.5);background:#16334a;color:#d8ecfd;font-weight:600'>Recompute All</button>",
      "<button data-id='reload-all' style='padding:6px 10px;min-height:40px;border-radius:8px;border:1px solid rgba(111,177,216,0.4);background:#152434;color:#d8ecfd'>Reload + Recompute All</button>",
      "</div>",
      "<div style='display:flex;gap:12px;flex-wrap:wrap;margin-top:8px'>",
      "<label style='display:flex;align-items:center;gap:5px;min-height:34px'><input data-id='show-model' type='checkbox' checked>Model</label>",
      "<label style='display:flex;align-items:center;gap:5px;min-height:34px'><input data-id='show-hulls' type='checkbox' checked>Segments</label>",
      "<label style='display:flex;align-items:center;gap:5px;min-height:34px'><input data-id='show-voxels' type='checkbox'>Voxels</label>",
      "<label style='display:flex;align-items:center;gap:5px;min-height:34px'><input data-id='wireframe' type='checkbox'>Wireframe</label>",
      "</div>",
      "<div style='margin-top:10px;border:1px solid rgba(111,177,216,0.3);border-radius:8px;background:rgba(10,18,26,0.45);padding:8px'>",
      "<div style='display:flex;justify-content:space-between;gap:8px;font-size:10px;opacity:0.92'>",
      "<div data-id='progress-label'>Idle</div>",
      "<div data-id='progress-value'>0%</div>",
      "</div>",
      "<div style='margin-top:5px;height:8px;border-radius:999px;overflow:hidden;background:rgba(111,177,216,0.22)'>",
      "<div data-id='progress-fill' style='height:100%;width:0%;background:linear-gradient(90deg,#7fd1ff,#79f0bc);transition:width 120ms linear'></div>",
      "</div>",
      "</div>",
      "<div style='margin-top:10px;border:1px solid rgba(111,177,216,0.35);border-radius:8px;background:rgba(10,18,26,0.55);padding:8px'>",
      "<div style='font-size:11px;font-weight:600'>Selected Pane Debug</div>",
      "<div data-id='selected-prop' style='margin-top:4px;font-size:10px;opacity:0.92'>No selection</div>",
      "<pre data-id='selected-stats' style='margin:6px 0 0;max-height:180px;overflow:auto;white-space:pre-wrap;font:10px/1.3 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;color:#c7ddf0'>Click any prop pane to inspect stats.</pre>",
      "</div>",
      "<div data-id='status' style='margin-top:8px;font-size:11px;opacity:0.9'>Preparing...</div>"
    ].join("");

    const cardsHost = document.createElement("div");
    cardsHost.style.position = "absolute";
    cardsHost.style.zIndex = "20";
    cardsHost.style.pointerEvents = "auto";
    cardsHost.style.overflow = "auto";
    cardsHost.style.boxSizing = "border-box";
    cardsHost.style.padding = "12px";
    mount.appendChild(cardsHost);

    const cardsGrid = document.createElement("div");
    cardsGrid.style.display = "grid";
    cardsGrid.style.gridTemplateColumns = "repeat(auto-fill, minmax(320px, 1fr))";
    cardsGrid.style.gap = "12px";
    cardsGrid.style.alignContent = "start";
    cardsHost.appendChild(cardsGrid);

    const resolutionInput = hud.querySelector<HTMLInputElement>("[data-id='resolution']");
    const maxHullsInput = hud.querySelector<HTMLInputElement>("[data-id='max-hulls']");
    const concavityInput = hud.querySelector<HTMLInputElement>("[data-id='concavity']");
    const alphaInput = hud.querySelector<HTMLInputElement>("[data-id='alpha']");
    const betaInput = hud.querySelector<HTMLInputElement>("[data-id='beta']");
    const sliverPenaltyInput = hud.querySelector<HTMLInputElement>("[data-id='sliver-penalty']");
    const planeDownsampleInput = hud.querySelector<HTMLInputElement>("[data-id='plane-downsample']");
    const hullDownsampleInput = hud.querySelector<HTMLInputElement>("[data-id='hull-downsample']");
    const minVoxelsInput = hud.querySelector<HTMLInputElement>("[data-id='min-voxels']");
    const maxHullSamplesInput = hud.querySelector<HTMLInputElement>("[data-id='max-hull-samples']");
    const projectHullMaxDistanceInput = hud.querySelector<HTMLInputElement>(
      "[data-id='project-hull-max-distance']"
    );
    const maxGridCellsInput = hud.querySelector<HTMLInputElement>("[data-id='max-grid-cells']");
    const voxelTriSampleInput = hud.querySelector<HTMLInputElement>("[data-id='voxel-tri-samples']");
    const projectHullVerticesInput = hud.querySelector<HTMLInputElement>(
      "[data-id='project-hull-vertices']"
    );
    const runAllButton = hud.querySelector<HTMLButtonElement>("[data-id='run-all']");
    const reloadAllButton = hud.querySelector<HTMLButtonElement>("[data-id='reload-all']");
    const showModelInput = hud.querySelector<HTMLInputElement>("[data-id='show-model']");
    const showHullsInput = hud.querySelector<HTMLInputElement>("[data-id='show-hulls']");
    const showVoxelsInput = hud.querySelector<HTMLInputElement>("[data-id='show-voxels']");
    const wireframeInput = hud.querySelector<HTMLInputElement>("[data-id='wireframe']");
    const progressLabelNode = hud.querySelector<HTMLElement>("[data-id='progress-label']");
    const progressValueNode = hud.querySelector<HTMLElement>("[data-id='progress-value']");
    const progressFillNode = hud.querySelector<HTMLElement>("[data-id='progress-fill']");
    const selectedPropNode = hud.querySelector<HTMLElement>("[data-id='selected-prop']");
    const selectedStatsNode = hud.querySelector<HTMLPreElement>("[data-id='selected-stats']");
    const statusNode = hud.querySelector<HTMLElement>("[data-id='status']");

    if (
      !resolutionInput ||
      !maxHullsInput ||
      !concavityInput ||
      !alphaInput ||
      !betaInput ||
      !sliverPenaltyInput ||
      !planeDownsampleInput ||
      !hullDownsampleInput ||
      !minVoxelsInput ||
      !maxHullSamplesInput ||
      !projectHullMaxDistanceInput ||
      !maxGridCellsInput ||
      !voxelTriSampleInput ||
      !projectHullVerticesInput ||
      !runAllButton ||
      !reloadAllButton ||
      !showModelInput ||
      !showHullsInput ||
      !showVoxelsInput ||
      !wireframeInput ||
      !progressLabelNode ||
      !progressValueNode ||
      !progressFillNode ||
      !selectedPropNode ||
      !selectedStatsNode ||
      !statusNode
    ) {
      throw new Error("Failed to create VHACD grid controls.");
    }

    const loader = new GLTFLoader();
    const cards: PropCard[] = [];
    const workerRunner = createVhacdWorkerRunner();
    let selectedCard: PropCard | null = null;
    let syncingView = false;

    const syncViewFromCard = (source: PropCard): void => {
      if (syncingView || cards.length <= 1) {
        return;
      }

      syncingView = true;
      const pose = readCardViewPose(source);
      for (const card of cards) {
        if (card === source) {
          continue;
        }
        applyCardViewPose(card, pose);
      }
      syncingView = false;
    };

    const refreshSelectedPaneDebug = (): void => {
      if (!selectedCard) {
        selectedPropNode.textContent = "No selection";
        selectedStatsNode.textContent = "Click any prop pane to inspect stats.";
        return;
      }
      selectedPropNode.textContent = `${selectedCard.choice.label} (${selectedCard.choice.id})`;
      selectedStatsNode.textContent = renderCardStats(
        selectedCard,
        selectedCard.runtimeMs,
        projectHullVerticesInput.checked
      );
    };

    const setCardSelectionVisual = (card: PropCard, active: boolean): void => {
      card.root.style.border = active
        ? "1px solid rgba(187, 229, 255, 0.98)"
        : "1px solid rgba(126, 185, 220, 0.45)";
      card.root.style.boxShadow = active
        ? "0 0 0 1px rgba(187, 229, 255, 0.6), 0 8px 18px rgba(7, 15, 22, 0.35)"
        : "none";
    };

    const selectCard = (card: PropCard): void => {
      if (selectedCard === card) {
        refreshSelectedPaneDebug();
        return;
      }

      if (selectedCard) {
        setCardSelectionVisual(selectedCard, false);
      }
      selectedCard = card;
      setCardSelectionVisual(card, true);
      refreshSelectedPaneDebug();
    };

    const setStatus = (message: string): void => {
      statusNode.textContent = message;
    };

    const setRunProgress = (fraction: number, label: string): void => {
      const clamped = Math.max(0, Math.min(1, fraction));
      const percent = Math.round(clamped * 100);
      progressFillNode.style.width = `${(clamped * 100).toFixed(2)}%`;
      progressValueNode.textContent = `${percent}%`;
      progressLabelNode.textContent = label;
    };

    const updateLayout = (): void => {
      const mountWidth = Math.max(1, mount.clientWidth);
      const mountHeight = Math.max(1, mount.clientHeight);

      if (mountWidth < 980) {
        hud.style.width = "calc(100% - 24px)";
        hud.style.maxHeight = `${Math.max(180, Math.floor(mountHeight * 0.42))}px`;
        const hudHeight = Math.ceil(hud.getBoundingClientRect().height);
        cardsHost.style.inset = `${Math.max(12, 12 + hudHeight + 8)}px 0 0 0`;
      } else {
        hud.style.width = "360px";
        hud.style.maxHeight = "calc(100% - 24px)";
        cardsHost.style.inset = "0 0 0 380px";
      }
    };

    const applyVisibilityFromUi = (): void => {
      applyVisibility(
        cards,
        showModelInput.checked,
        showHullsInput.checked,
        showVoxelsInput.checked
      );
    };

    const applyWireframeFromUi = (): void => {
      applyWireframe(cards, wireframeInput.checked);
    };

    const applyDisplayedHullVariantFromUi = (): void => {
      const projected = projectHullVerticesInput.checked;
      for (const card of cards) {
        if (!card.result) {
          continue;
        }
        renderCardHullOverlay(card, resolveDisplayedHulls(card.result, projected), wireframeInput.checked);
      }
      applyVisibilityFromUi();
    };

    let runToken = 0;
    const runAll = async (reloadModels: boolean): Promise<void> => {
      const token = ++runToken;
      workerRunner.restart("VHACD run superseded by a new recompute request");

      const options = readOptionsFromUi(
        resolutionInput,
        maxHullsInput,
        concavityInput,
        alphaInput,
        betaInput,
        sliverPenaltyInput,
        planeDownsampleInput,
        hullDownsampleInput,
        minVoxelsInput,
        maxHullSamplesInput,
        projectHullMaxDistanceInput,
        projectHullVerticesInput,
        maxGridCellsInput,
        voxelTriSampleInput
      );

      const total = cards.length;
      const totalSafe = Math.max(1, total);
      setRunProgress(0, total > 0 ? `Preparing 0/${total}` : "No props");
      setStatus(`Running ${total} props...`);

      for (let index = 0; index < total; index += 1) {
        if (token !== runToken) {
          break;
        }

        const card = cards[index];
        setRunProgress(index / totalSafe, `Loading ${index + 1}/${total}: ${card.choice.id}`);
        setStatus(`Loading ${index + 1}/${total}: ${card.choice.id}`);
        card.status.textContent = reloadModels || !card.model ? "loading model..." : "queued";

        if (reloadModels || !card.model) {
          await loadCardModel(card, loader);
          if (token !== runToken) {
            break;
          }
        }

        if (!card.model) {
          clearCardOverlay(card);
          card.status.textContent = "failed";
          card.runtimeMs = null;
          setRunProgress((index + 1) / totalSafe, `Failed ${index + 1}/${total}: ${card.choice.id}`);
          setStatus(`Failed ${index + 1}/${total}: ${card.choice.id}`);
          if (selectedCard === card) {
            refreshSelectedPaneDebug();
          }
          continue;
        }

        if (!card.sourceData) {
          card.status.textContent = "no source data";
          card.runtimeMs = null;
          setRunProgress((index + 1) / totalSafe, `Failed ${index + 1}/${total}: ${card.choice.id}`);
          setStatus(`Failed ${index + 1}/${total}: ${card.choice.id} (no source data)`);
          if (selectedCard === card) {
            refreshSelectedPaneDebug();
          }
          continue;
        }

        const start = performance.now();
        let result: VhacdResult;
        try {
          result = await workerRunner.run(card.sourceData, options, (progress: VhacdProgress) => {
            if (token !== runToken) {
              return;
            }
            const overall = (index + progress.propProgress) / totalSafe;
            const phasePercent = Math.round(progress.propProgress * 100);
            card.status.textContent = `${progress.message} (${phasePercent}%)`;
            setRunProgress(overall, `${index + 1}/${total}: ${progress.message}`);
            setStatus(`Running ${index + 1}/${total}: ${card.choice.id} - ${progress.message}`);
          });
        } catch (error) {
          if (token !== runToken) {
            break;
          }
          const message =
            error instanceof Error && error.message.trim().length > 0
              ? error.message
              : "worker failed";
          card.status.textContent = "error";
          card.runtimeMs = null;
          setRunProgress((index + 1) / totalSafe, `Error ${index + 1}/${total}: ${card.choice.id}`);
          setStatus(`Error ${index + 1}/${total}: ${card.choice.id} (${message})`);
          if (selectedCard === card) {
            refreshSelectedPaneDebug();
          }
          continue;
        }
        if (token !== runToken) {
          disposeVhacdResult(result);
          break;
        }
        const elapsed = performance.now() - start;
        disposeVhacdResult(card.result);
        card.result = result;
        renderCardHullOverlay(
          card,
          resolveDisplayedHulls(result, projectHullVerticesInput.checked),
          wireframeInput.checked
        );
        renderCardVoxelOverlay(card, result);
        card.runtimeMs = elapsed;
        if (selectedCard === card) {
          refreshSelectedPaneDebug();
        }

        card.status.textContent = card.fallbackUsed ? "done (fallback mesh)" : "done";

        applyVisibilityFromUi();
        setRunProgress(
          (index + 1) / totalSafe,
          `Completed ${index + 1}/${total}: ${card.choice.id}`
        );
        setStatus(`Processed ${index + 1}/${total}: ${card.choice.id}`);

        await new Promise<void>((resolve) => {
          requestAnimationFrame(() => resolve());
        });
      }

      if (token !== runToken) {
        return;
      }

      const referenceCard = cards.find((card) => card.model !== null) ?? cards[0];
      if (referenceCard) {
        syncViewFromCard(referenceCard);
      }
      refreshSelectedPaneDebug();
      setRunProgress(1, "Done");
      setStatus(`Ready. Rendered ${total} props with one WebGL context + scissor.`);
    };

    const onRunAll = (): void => {
      void runAll(false);
    };
    const onReloadAll = (): void => {
      void runAll(true);
    };
    const onShowModel = (): void => {
      applyVisibilityFromUi();
    };
    const onShowHulls = (): void => {
      applyVisibilityFromUi();
    };
    const onShowVoxels = (): void => {
      applyVisibilityFromUi();
    };
    const onWireframe = (): void => {
      applyWireframeFromUi();
    };
    const onProjectHullVertices = (): void => {
      applyDisplayedHullVariantFromUi();
      refreshSelectedPaneDebug();
      setStatus(
        `Displaying ${projectHullVerticesInput.checked ? "projected" : "raw"} hull variant.`
      );
    };

    runAllButton.addEventListener("click", onRunAll);
    reloadAllButton.addEventListener("click", onReloadAll);
    showModelInput.addEventListener("change", onShowModel);
    showHullsInput.addEventListener("change", onShowHulls);
    showVoxelsInput.addEventListener("change", onShowVoxels);
    wireframeInput.addEventListener("change", onWireframe);
    projectHullVerticesInput.addEventListener("change", onProjectHullVertices);

    const choices = await listPropChoices();
    for (const choice of choices) {
      const card = createCard(choice, cardsGrid);
      card.controls.addEventListener("change", () => {
        syncViewFromCard(card);
      });
      card.selectHandler = () => {
        selectCard(card);
      };
      card.root.addEventListener("pointerdown", card.selectHandler);
      cards.push(card);
    }
    if (cards[0]) {
      selectCard(cards[0]);
    } else {
      refreshSelectedPaneDebug();
    }

    setStatus(`Loaded ${cards.length} props. Building scenes...`);
    updateLayout();

    applyVisibilityFromUi();

    const resizeObserver = new ResizeObserver(() => {
      const nextWidth = Math.max(1, mount.clientWidth);
      const nextHeight = Math.max(1, mount.clientHeight);
      renderer.setSize(nextWidth, nextHeight, true);
      updateLayout();
    });
    resizeObserver.observe(mount);

    let raf = 0;
    const tick = (): void => {
      const canvasRect = renderer.domElement.getBoundingClientRect();
      const canvasWidth = Math.max(1, Math.floor(canvasRect.width));
      const canvasHeight = Math.max(1, Math.floor(canvasRect.height));

      renderer.setScissorTest(false);
      renderer.setViewport(0, 0, canvasWidth, canvasHeight);
      renderer.clear(true, true, true);

      renderer.setScissorTest(true);

      for (const card of cards) {
        const rect = card.viewport.getBoundingClientRect();

        const left = Math.max(0, Math.floor(rect.left - canvasRect.left));
        const right = Math.min(canvasWidth, Math.floor(rect.right - canvasRect.left));
        const top = Math.max(0, Math.floor(rect.top - canvasRect.top));
        const bottom = Math.min(canvasHeight, Math.floor(rect.bottom - canvasRect.top));

        const widthPx = right - left;
        const heightPx = bottom - top;

        if (widthPx <= 1 || heightPx <= 1) {
          continue;
        }

        const viewportBottom = canvasHeight - bottom;

        card.camera.aspect = widthPx / heightPx;
        card.camera.updateProjectionMatrix();
        card.controls.update();

        renderer.setViewport(left, viewportBottom, widthPx, heightPx);
        renderer.setScissor(left, viewportBottom, widthPx, heightPx);
        renderer.render(card.scene, card.camera);
      }

      renderer.setScissorTest(false);
      raf = requestAnimationFrame(tick);
    };
    tick();

    await runAll(true);

    return () => {
      runToken += 1;
      workerRunner.dispose();
      cancelAnimationFrame(raf);
      resizeObserver.disconnect();

      runAllButton.removeEventListener("click", onRunAll);
      reloadAllButton.removeEventListener("click", onReloadAll);
      showModelInput.removeEventListener("change", onShowModel);
      showHullsInput.removeEventListener("change", onShowHulls);
      showVoxelsInput.removeEventListener("change", onShowVoxels);
      wireframeInput.removeEventListener("change", onWireframe);
      projectHullVerticesInput.removeEventListener("change", onProjectHullVertices);

      for (const card of cards) {
        disposeCard(card);
      }

      renderer.dispose();
      renderer.domElement.remove();
      cardsHost.remove();
      hud.remove();
    };
  }
};

export default experiment;
