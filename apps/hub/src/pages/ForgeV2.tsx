import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { createVhacdWorkerRunner, type VhacdProgress } from "@common/collider-vhacd";
import { StyleGuidePanel, type StyleGuide } from "./forge/StyleGuidePanel";
import type { Viewport3dViewState } from "./forge/Viewport";
import { PixelQuad, type PixelQuadHandle } from "./forge-v2/PixelQuad";
import {
  ForgeScissorViewportPane,
  ForgeScissorViewportStage,
  type ForgeScissorViewportHandle
} from "./forge-v2/ScissorViewport3d";
import { generateImage } from "./forge/api/openai";
import { generateModel } from "./forge/api/tripo";
import { countTotalFaces } from "./forge/processing/simplify";
import {
  applyPivotOffset,
  applyScale,
  computeBBox,
  computePivotOffset,
  normalizeTransforms,
  type BBox,
  type PivotPreset,
  type ScaleMode
} from "./forge/processing/dimensions";
import { downsampleMeshTextures } from "./forge/processing/textures";
import {
  buildColliderExportSceneFromParams,
  buildVhacdColliderForObject,
  type ForgeColliderGenerationMetadata
} from "./forge/processing/collider-vhacd";
import { createColliderHelper, type ColliderParams } from "./forge/processing/colliders";
import {
  DEFAULT_FORGE_PHYSICS_SETTINGS,
  normalizeForgePhysicsSettings,
  resolveForgeMass
} from "./forge/processing/physics";
import { PhysicsPanel } from "./forge/PhysicsPanel";
import type { PixelViewportViewState } from "./forge/ViewportPixel";
import {
  buildComposedPrompt,
  ensureSeedPresetFiles,
  exportObjectToGlb,
  listForgeV2PropIds,
  makePropBaseDir,
  readColliderPresetFile,
  readForgeV2PropMeta,
  readPhysicsKindPresetFile,
  readPropProcessedModelGlb,
  readPropRawConceptImage,
  readPropRawGlb,
  slugifyPropId,
  writeForgeV2PropMeta,
  writePropColliderGlb,
  writePropConceptImage,
  writePropProcessedModelGlb,
  writePropPrompt,
  writePropRawGlb
} from "./forge-v2/state/persistence";
import { createDefaultForgeV2Meta } from "./forge-v2/state/schema";
import type {
  ForgeV2ColliderPresetFile,
  ForgeV2ColliderResultEntry,
  ForgeV2GenerationDraftProp,
  ForgeV2PhysicsKindPresetFile,
  ForgeV2PropMeta
} from "./forge-v2/types";

const PIXEL_BASE_YAW = THREE.MathUtils.degToRad(45);
const QUARTER_TURN_RADIANS = Math.PI * 0.5;
const DEFAULT_FACE_LIMIT = 20_000;
const DEFAULT_PBR = true;
const UNIT_SCALE_METERS_PER_UNIT = 1.28;

type ViewMode = "generation" | "physics";
type ScaleModeV2 = ScaleMode | "depth";
type PhysicsPreviewScenario = "floorDrop" | "slope30Drop" | "edgeDrop";

type SavedPropListItem = {
  id: string;
  description: string;
  status: ForgeV2PropMeta["lifecycle"]["status"];
  conceptImage: string | null;
  generationApprovedAt?: string;
  physicsApprovedAt?: string;
};

type PhysicsSelectedState = {
  propId: string;
  meta: ForgeV2PropMeta;
  conceptImage: string | null;
  processedGlb: ArrayBuffer | null;
  rawGlb: ArrayBuffer | null;
};

type ColliderBuildUiState = {
  running: boolean;
  progressText: string;
  statusText: string;
  error: string | null;
};

type RapierLike = {
  init(): Promise<void>;
  World: new (gravity: { x: number; y: number; z: number }) => any;
  RigidBodyDesc: {
    dynamic(): any;
    fixed(): any;
  };
  ColliderDesc: {
    cuboid(hx: number, hy: number, hz: number): any;
    convexHull(vertices: Float32Array): any;
  };
};

type SimMetrics = {
  durationSeconds: number;
  maxLinearSpeed: number;
  maxAngularSpeed: number;
  settled: boolean;
};

type SimVisualSetup = {
  meshRoot: THREE.Group;
  meshDynamic: THREE.Object3D;
  pixelRoot: THREE.Group;
  spawnPosition: THREE.Vector3;
  spawnQuaternion: THREE.Quaternion;
};

const PHYSICS_SCENARIOS: PhysicsPreviewScenario[] = [
  "floorDrop",
  "slope30Drop",
  "edgeDrop"
];

const PHYSICS_SCENARIO_LABELS: Record<PhysicsPreviewScenario, string> = {
  floorDrop: "Floor Drop",
  slope30Drop: "30deg Slope",
  edgeDrop: "Edge Drop"
};

type ScenarioRecord<T> = Record<PhysicsPreviewScenario, T>;

function makeScenarioRecord<T>(factory: (scenario: PhysicsPreviewScenario) => T): ScenarioRecord<T> {
  return {
    floorDrop: factory("floorDrop"),
    slope30Drop: factory("slope30Drop"),
    edgeDrop: factory("edgeDrop")
  };
}

let rapier3dPromise: Promise<RapierLike> | null = null;

async function ensureRapier3d(): Promise<RapierLike> {
  if (!rapier3dPromise) {
    rapier3dPromise = (async () => {
      const mod = (await import("@dimforge/rapier3d-compat")) as unknown as {
        default: RapierLike;
      };
      await mod.default.init();
      return mod.default;
    })();
  }
  return rapier3dPromise;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function wrapQuarterTurns(value: number): number {
  const rounded = Math.round(value);
  const wrapped = rounded % 4;
  return wrapped < 0 ? wrapped + 4 : wrapped;
}

function bboxToJson(bbox: BBox | null): { width: number; height: number; depth: number } | null {
  if (!bbox) return null;
  return {
    width: bbox.width,
    height: bbox.height,
    depth: bbox.depth
  };
}

function bboxJsonToBBox(
  bbox: { width: number; height: number; depth: number } | null | undefined
): BBox | null {
  if (!bbox) {
    return null;
  }
  return {
    width: bbox.width,
    height: bbox.height,
    depth: bbox.depth,
    center: new THREE.Vector3(),
    min: new THREE.Vector3(),
    max: new THREE.Vector3()
  };
}

function deepCloneWithMaterials(group: THREE.Group): THREE.Group {
  const clone = group.clone(true);
  clone.traverse((child) => {
    if (child instanceof THREE.Mesh) {
      if (Array.isArray(child.material)) {
        child.material = child.material.map((m) => m.clone());
      } else {
        child.material = child.material.clone();
      }
    }
  });
  return clone;
}

function computeScaleForDraft(bbox: BBox, mode: ScaleModeV2, targetValue: number): number {
  const safeTarget = Math.max(0.01, targetValue);
  if (mode === "depth") {
    return bbox.depth > 0 ? safeTarget / bbox.depth : 1;
  }
  switch (mode) {
    case "height":
      return bbox.height > 0 ? safeTarget / bbox.height : 1;
    case "width":
      return bbox.width > 0 ? safeTarget / bbox.width : 1;
    case "max": {
      const maxDim = Math.max(bbox.width, bbox.height, bbox.depth);
      return maxDim > 0 ? safeTarget / maxDim : 1;
    }
    case "manual":
      return safeTarget;
  }
}

function formatStatusTime(iso?: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString();
}

function quatTuple(q: THREE.Quaternion): [number, number, number, number] {
  return [q.x, q.y, q.z, q.w];
}

function vec3Tuple(v: THREE.Vector3): [number, number, number] {
  return [v.x, v.y, v.z];
}

function isNearZero3(value: [number, number, number], epsilon = 1e-6): boolean {
  return (
    Math.abs(value[0]) <= epsilon &&
    Math.abs(value[1]) <= epsilon &&
    Math.abs(value[2]) <= epsilon
  );
}

function isUntouchedDefaultPixelCamera(camera: {
  target: [number, number, number];
  yawTurns: number;
  zoomLevel: number;
}): boolean {
  return (
    isNearZero3(camera.target) &&
    Math.round(camera.yawTurns) === 0 &&
    Math.round(camera.zoomLevel) === 2
  );
}

function createDraftProp(description: string, faceLimit: number): ForgeV2GenerationDraftProp {
  const now = Date.now();
  const tempId = `draft-${now}-${Math.floor(Math.random() * 1000)}`;
  const slug = slugifyPropId(description) || `prop-${now}`;
  return {
    tempId,
    idSlug: slug,
    description,
    status: "draft",
    conceptImage: null,
    rawGlb: null,
    imageError: null,
    meshError: null,
    imageRevision: 0,
    meshRevision: 0,
    meshProgress: 0,
    meshProgressLabel: "idle",
    faceLimit,
    pbr: DEFAULT_PBR,
    textureResolution: 0,
    scaleMode: "max",
    targetDimension: 1,
    scale: 1,
    pivot: "bottom-center",
    pivotOffset: [0, 0, 0],
    originalFaces: 0,
    processedFaces: 0,
    simplificationRatio: 1,
    bboxProcessed: null,
    pixelCamera: {
      target: [0, 0, 0],
      yawTurns: 0,
      zoomLevel: 1
    }
  };
}

function buildPixelTestEnvironmentGroup(processedModel: THREE.Group): THREE.Group {
  const root = new THREE.Group();
  root.add(processedModel);

  const refs = new THREE.Group();
  refs.name = "pixel-test-environment";

  addPixelPreviewGroundEnvironment(refs);

  const unitBox = new THREE.Mesh(
    new THREE.BoxGeometry(1, 1, 1),
    new THREE.MeshStandardMaterial({
      color: 0x7ec6a2,
      roughness: 0.85,
      metalness: 0.04
    })
  );
  unitBox.position.set(2.25, 0.5, 0);
  refs.add(unitBox);

  const tallBox = new THREE.Mesh(
    new THREE.BoxGeometry(1, 2, 1),
    new THREE.MeshStandardMaterial({
      color: 0xe7b375,
      roughness: 0.84,
      metalness: 0.03
    })
  );
  tallBox.position.set(4.0, 1, 0);
  refs.add(tallBox);

  root.add(refs);
  return root;
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

  const grid = new THREE.GridHelper(gridSize, 12, brightCenterGridColor, darkGridColor);
  grid.position.y = 0.002;
  root.add(grid);
}

function createScenarioVisuals(
  baseModel: THREE.Group,
  scenario: PhysicsPreviewScenario
): SimVisualSetup {
  const sourceBBox = computeBBox(baseModel);
  const meshRoot = new THREE.Group();
  const pixelRoot = new THREE.Group();

  function addEnvironment(root: THREE.Group): void {
    addPixelPreviewGroundEnvironment(root);

    if (scenario === "slope30Drop") {
      const ramp = new THREE.Mesh(
        new THREE.BoxGeometry(3.2, 0.16, 2.2),
        new THREE.MeshStandardMaterial({
          color: 0xc29362,
          roughness: 0.88,
          metalness: 0.03
        })
      );
      ramp.position.set(0.8, 0.55, 0);
      ramp.rotation.z = -Math.PI / 6;
      root.add(ramp);
    }

    if (scenario === "edgeDrop") {
      const box = new THREE.Mesh(
        new THREE.BoxGeometry(1, 1, 1),
        new THREE.MeshStandardMaterial({
          color: 0x7ec6a2,
          roughness: 0.84,
          metalness: 0.04
        })
      );
      box.position.set(0, 0.5, 0);
      root.add(box);
    }
  }

  addEnvironment(meshRoot);
  addEnvironment(pixelRoot);

  const meshProp = deepCloneWithMaterials(baseModel);
  meshProp.name = "sim-body";
  meshRoot.add(meshProp);

  const pixelProp = deepCloneWithMaterials(baseModel);
  pixelProp.name = "sim-body";
  pixelRoot.add(pixelProp);

  const height = Math.max(0.2, sourceBBox.height);
  let spawn = new THREE.Vector3(0, Math.max(1.4, height + 1.1), 0);
  if (scenario === "slope30Drop") {
    spawn = new THREE.Vector3(-0.45, Math.max(1.5, height + 1.2), 0);
  } else if (scenario === "edgeDrop") {
    spawn = new THREE.Vector3(0.55, Math.max(1.8, height + 1.2), 0);
  }

  return {
    meshRoot,
    meshDynamic: meshProp,
    pixelRoot,
    spawnPosition: spawn,
    spawnQuaternion: new THREE.Quaternion()
  };
}

function createStaticBody(
  rapier: RapierLike,
  world: any,
  options: {
    translation: THREE.Vector3;
    halfExtents: THREE.Vector3;
    quaternion?: THREE.Quaternion;
    friction: number;
    restitution: number;
  }
): void {
  const bodyDesc = rapier.RigidBodyDesc.fixed().setTranslation(
    options.translation.x,
    options.translation.y,
    options.translation.z
  );
  if (options.quaternion) {
    bodyDesc.setRotation({
      x: options.quaternion.x,
      y: options.quaternion.y,
      z: options.quaternion.z,
      w: options.quaternion.w
    });
  }
  const body = world.createRigidBody(bodyDesc);
  const desc = rapier.ColliderDesc.cuboid(
    Math.max(0.001, options.halfExtents.x),
    Math.max(0.001, options.halfExtents.y),
    Math.max(0.001, options.halfExtents.z)
  )
    .setFriction(options.friction)
    .setRestitution(options.restitution);
  world.createCollider(desc, body);
}

function attachDynamicColliderFromParams(
  rapier: RapierLike,
  world: any,
  body: any,
  collider: ColliderParams,
  fallbackBounds: BBox,
  options: { mass: number; friction: number; restitution: number }
): number {
  let created = 0;
  if (collider.type === "compound-convex-hulls") {
    const partsRaw = Array.isArray(collider.params.parts) ? collider.params.parts : [];
    const validParts = partsRaw.filter((part): part is Record<string, unknown> => !!part && typeof part === "object");
    const perPartMass = options.mass / Math.max(1, validParts.length);
    for (const part of validParts) {
      const posRaw = part.position;
      const pointsRaw = Array.isArray(part.points) ? part.points : [];
      if (!Array.isArray(posRaw) || posRaw.length !== 3 || pointsRaw.length < 4) {
        continue;
      }
      const vertices = new Float32Array(pointsRaw.length * 3);
      let write = 0;
      for (let i = 0; i < pointsRaw.length; i += 1) {
        const point = pointsRaw[i];
        if (!Array.isArray(point) || point.length !== 3) {
          continue;
        }
        vertices[write++] = Number(point[0]) || 0;
        vertices[write++] = Number(point[1]) || 0;
        vertices[write++] = Number(point[2]) || 0;
      }
      if (write < 12) {
        continue;
      }
      const hullVertices = write === vertices.length ? vertices : vertices.slice(0, write);
      const desc = rapier.ColliderDesc.convexHull(hullVertices);
      if (!desc) {
        continue;
      }
      desc
        .setTranslation(
          Number(posRaw[0]) || 0,
          Number(posRaw[1]) || 0,
          Number(posRaw[2]) || 0
        )
        .setFriction(options.friction)
        .setRestitution(options.restitution)
        .setMass(perPartMass);
      world.createCollider(desc, body);
      created += 1;
    }
  } else if (collider.type === "box") {
    const hx = Number(collider.params.halfWidth) || fallbackBounds.width * 0.5;
    const hy = Number(collider.params.halfHeight) || fallbackBounds.height * 0.5;
    const hz = Number(collider.params.halfDepth) || fallbackBounds.depth * 0.5;
    const desc = rapier.ColliderDesc.cuboid(
      Math.max(0.001, hx),
      Math.max(0.001, hy),
      Math.max(0.001, hz)
    )
      .setFriction(options.friction)
      .setRestitution(options.restitution)
      .setMass(options.mass);
    world.createCollider(desc, body);
    created += 1;
  }

  if (created <= 0) {
    const desc = rapier.ColliderDesc.cuboid(
      Math.max(0.05, fallbackBounds.width * 0.5),
      Math.max(0.05, fallbackBounds.height * 0.5),
      Math.max(0.05, fallbackBounds.depth * 0.5)
    )
      .setFriction(options.friction)
      .setRestitution(options.restitution)
      .setMass(options.mass);
    world.createCollider(desc, body);
    created = 1;
  }
  return created;
}

function mergeColliderHelpersSideBySide(options: {
  entries: ForgeV2ColliderResultEntry[];
  sourceModel: THREE.Group;
}): { modelGroup: THREE.Group; colliderGroup: THREE.Group } {
  const modelGroup = new THREE.Group();
  const colliderGroup = new THREE.Group();

  const bbox = computeBBox(options.sourceModel);
  const spacing = Math.max(1.5, Math.max(bbox.width, bbox.depth) + 0.8);
  const cols = Math.max(1, Math.ceil(Math.sqrt(options.entries.length || 1)));

  options.entries.forEach((entry, index) => {
    const row = Math.floor(index / cols);
    const col = index % cols;
    const offsetX = (col - (cols - 1) * 0.5) * spacing;
    const offsetZ = row * spacing;

    const modelClone = deepCloneWithMaterials(options.sourceModel);
    modelClone.position.set(offsetX, 0, offsetZ);
    modelGroup.add(modelClone);

    const helper = createColliderHelper(entry.collider);
    helper.position.add(new THREE.Vector3(offsetX, 0, offsetZ));
    helper.name = `collider-preview-${entry.presetId}`;
    colliderGroup.add(helper);
  });

  return { modelGroup, colliderGroup };
}

function formatVhacdProgress(progress: VhacdProgress): string {
  return `${progress.message} (${Math.round(progress.propProgress * 100)}%)`;
}

function buildPhysicsSettingsFromKind(kind: ForgeV2PhysicsKindPresetFile["kinds"][number]) {
  return normalizeForgePhysicsSettings(
    {
      ...DEFAULT_FORGE_PHYSICS_SETTINGS,
      mobility: kind.mobility,
      material: kind.material,
      massMode: kind.massMode,
      massScale: kind.massScale,
      manualMass: kind.manualMass,
      friction: kind.friction,
      restitution: kind.restitution,
      linearDamping: kind.linearDamping,
      angularDamping: kind.angularDamping,
      activationDelayMs: kind.activationDelayMs
    },
    null
  );
}

export function ForgeV2() {
  const [viewMode, setViewMode] = useState<ViewMode>("generation");
  const [styleGuide, setStyleGuide] = useState<StyleGuide>({
    name: "",
    prompt: "",
    negativePrompt: "",
    imageSize: "1024x1024",
    referenceImages: []
  });

  const [batchText, setBatchText] = useState("");
  const [defaultFaceLimit, setDefaultFaceLimit] = useState(DEFAULT_FACE_LIMIT);
  const [drafts, setDrafts] = useState<Map<string, ForgeV2GenerationDraftProp>>(new Map());
  const [selectedDraftId, setSelectedDraftId] = useState<string | null>(null);
  const [generationBusy, setGenerationBusy] = useState<{ images: boolean; meshes: boolean }>({
    images: false,
    meshes: false
  });

  const generationViewportRef = useRef<ForgeScissorViewportHandle>(null);
  const generationPixelBaseModelRef = useRef<THREE.Group | null>(null);
  const [generationPixelModel, setGenerationPixelModel] = useState<THREE.Group | null>(null);
  const [generationMeshVisibility, setGenerationMeshVisibility] = useState({
    mesh: true,
    collider: false,
    grid: true,
    axes: true
  });
  const [generationMeshViewState, setGenerationMeshViewState] = useState<Viewport3dViewState | null>(null);
  const [generationPixelBaseViewState, setGenerationPixelBaseViewState] =
    useState<PixelViewportViewState>({
      target: [0, 0, 0],
      yawTurns: 0,
      zoom: 1
    });
  const meshToPixelSyncLockRef = useRef(false);
  const pixelToMeshSyncLockRef = useRef(false);
  const zoomSyncScaleRef = useRef<number | null>(null);

  const imageJobTokenRef = useRef(new Map<string, number>());
  const meshJobTokenRef = useRef(new Map<string, number>());
  const previewBuildTokenRef = useRef(0);
  const baseModelCacheRef = useRef(new Map<string, THREE.Group>());

  const [savedProps, setSavedProps] = useState<SavedPropListItem[]>([]);
  const [savedLoading, setSavedLoading] = useState(false);
  const [physicsSelected, setPhysicsSelected] = useState<PhysicsSelectedState | null>(null);
  const [physicsConceptImage, setPhysicsConceptImage] = useState<string | null>(null);
  const [physicsColliderPresets, setPhysicsColliderPresets] = useState<ForgeV2ColliderPresetFile | null>(null);
  const [physicsKindPresets, setPhysicsKindPresets] = useState<ForgeV2PhysicsKindPresetFile | null>(null);
  const [physicsSelectedKindId, setPhysicsSelectedKindId] = useState<string>("wood");
  const [physicsSettings, setPhysicsSettings] = useState({ ...DEFAULT_FORGE_PHYSICS_SETTINGS });
  const [physicsBBox, setPhysicsBBox] = useState<BBox | null>(null);
  const [physicsSourceModelVersion, setPhysicsSourceModelVersion] = useState(0);
  const [physicsSelectedColliderPresetId, setPhysicsSelectedColliderPresetId] = useState<string | null>(null);
  const [physicsColliderResults, setPhysicsColliderResults] = useState<ForgeV2ColliderResultEntry[]>([]);
  const [physicsColliderBuildState, setPhysicsColliderBuildState] = useState<ColliderBuildUiState>({
    running: false,
    progressText: "idle",
    statusText: "Load a generation-approved prop and compute colliders.",
    error: null
  });
  const [physicsViewState, setPhysicsViewState] = useState<Viewport3dViewState | null>(null);
  const [physicsSimMeshViewState, setPhysicsSimMeshViewState] = useState<Viewport3dViewState | null>(null);

  const physicsMeshViewportRef = useRef<ForgeScissorViewportHandle>(null);
  const physicsColliderPresetViewportRefs = useRef<Record<string, ForgeScissorViewportHandle | null>>({});
  const physicsSimMeshViewportRefs = useRef<ScenarioRecord<ForgeScissorViewportHandle | null>>(
    makeScenarioRecord(() => null)
  );
  const physicsSimPixelQuadRefs = useRef<ScenarioRecord<PixelQuadHandle | null>>(
    makeScenarioRecord(() => null)
  );
  const [physicsSimPixelModels, setPhysicsSimPixelModels] = useState<ScenarioRecord<THREE.Group | null>>(
    makeScenarioRecord(() => null)
  );
  const [physicsSimPixelBaseViewStates, setPhysicsSimPixelBaseViewStates] = useState<
    ScenarioRecord<PixelViewportViewState>
  >(
    makeScenarioRecord(() => ({
      target: [0, 0, 0],
      yawTurns: 0,
      zoom: 1
    }))
  );
  const vhacdRunnerRef = useRef(createVhacdWorkerRunner());
  const physicsSimSourceModelRef = useRef<THREE.Group | null>(null);
  const physicsSimDynamicMeshRefs = useRef<ScenarioRecord<THREE.Object3D | null>>(
    makeScenarioRecord(() => null)
  );
  const physicsSimLoopRafRefs = useRef<ScenarioRecord<number>>(makeScenarioRecord(() => 0));
  const physicsSuppressAssetViewSyncRef = useRef(false);
  const physicsSuppressSimViewSyncRef = useRef(false);
  const physicsSimMetricsRef = useRef<ScenarioRecord<SimMetrics>>(
    makeScenarioRecord(() => ({
      durationSeconds: 0,
      maxLinearSpeed: 0,
      maxAngularSpeed: 0,
      settled: false
    }))
  );
  const [physicsSimStatusByScenario, setPhysicsSimStatusByScenario] = useState<
    ScenarioRecord<string>
  >(
    makeScenarioRecord(() => "Compute a collider to start auto-replay.")
  );

  const selectedDraft = selectedDraftId ? drafts.get(selectedDraftId) ?? null : null;

  const updateDraft = useCallback((id: string, patch: Partial<ForgeV2GenerationDraftProp>) => {
    setDrafts((prev) => {
      const item = prev.get(id);
      if (!item) return prev;
      const next = new Map(prev);
      next.set(id, { ...item, ...patch });
      return next;
    });
  }, []);

  const loadSavedPropIndex = useCallback(async () => {
    setSavedLoading(true);
    try {
      const ids = await listForgeV2PropIds();
      const pairs = await Promise.all(
        ids.map(async (id) => {
          const [meta, conceptImage] = await Promise.all([
            readForgeV2PropMeta(id),
            readPropRawConceptImage(id)
          ]);
          return { meta, conceptImage };
        })
      );
      const items = pairs
        .filter((pair): pair is { meta: ForgeV2PropMeta; conceptImage: string | null } => pair.meta !== null)
        .map(({ meta, conceptImage }) => ({
          id: meta.id,
          description: meta.description,
          status: meta.lifecycle.status,
          conceptImage,
          generationApprovedAt: meta.lifecycle.generationApprovedAt,
          physicsApprovedAt: meta.lifecycle.physicsApprovedAt
        }))
        .sort((a, b) => a.id.localeCompare(b.id));
      setSavedProps(items);
    } finally {
      setSavedLoading(false);
    }
  }, []);

  const importSavedPropIntoGeneration = useCallback(async (propId: string) => {
    const [meta, conceptImage, rawGlb] = await Promise.all([
      readForgeV2PropMeta(propId),
      readPropRawConceptImage(propId),
      readPropRawGlb(propId)
    ]);
    if (!meta) {
      return;
    }
    const tempId = `saved-${propId}`;
    const scaleModeRaw = meta.processing.transform.targetDimension.method;
    const scaleMode: ScaleModeV2 =
      scaleModeRaw === "width" ||
      scaleModeRaw === "height" ||
      scaleModeRaw === "max" ||
      scaleModeRaw === "manual" ||
      scaleModeRaw === "depth"
        ? scaleModeRaw
        : "max";

    const draft: ForgeV2GenerationDraftProp = {
      tempId,
      idSlug: propId,
      description: meta.description,
      status:
        rawGlb && conceptImage
          ? meta.lifecycle.status === "generation-approved" || meta.lifecycle.status === "physics-approved"
            ? "approved-generation"
            : "mesh-ready"
          : conceptImage
            ? "image-ready"
            : "draft",
      conceptImage,
      rawGlb,
      imageError: null,
      meshError: null,
      imageRevision: Math.max(0, meta.generation.image.revision),
      meshRevision: Math.max(0, meta.generation.mesh.revision),
      meshProgress: rawGlb ? 100 : 0,
      meshProgressLabel: rawGlb ? "Imported" : "idle",
      faceLimit: Math.max(1000, meta.generation.mesh.faceLimit || DEFAULT_FACE_LIMIT),
      pbr: meta.generation.mesh.pbr !== false,
      textureResolution: meta.processing.mesh.textureResolution ?? 0,
      scaleMode,
      targetDimension: meta.processing.transform.targetDimension.value ?? 1,
      scale: meta.processing.transform.scale?.[0] ?? 1,
      pivot: meta.processing.transform.provisionalPivot.preset,
      pivotOffset: meta.processing.transform.provisionalPivot.offset,
      originalFaces: meta.processing.mesh.originalFaces ?? 0,
      processedFaces: meta.processing.mesh.processedFaces ?? 0,
      simplificationRatio: meta.processing.mesh.simplificationRatio ?? 1,
      bboxProcessed: meta.processing.mesh.bboxProcessed ?? null,
      pixelCamera: (() => {
        const savedCamera = {
          target: meta.pixelPreview.cameraSyncState.target,
          yawTurns: meta.pixelPreview.cameraSyncState.yawTurns,
          zoomLevel: meta.pixelPreview.cameraSyncState.zoomLevel
        };
        // Legacy / untouched V2 defaults are too tight for the 4-panel pixel quad.
        if (isUntouchedDefaultPixelCamera(savedCamera)) {
          return { ...savedCamera, zoomLevel: 1 };
        }
        return savedCamera;
      })(),
      generationApprovedAt: meta.lifecycle.generationApprovedAt
    };

    setDrafts((prev) => {
      const next = new Map(prev);
      next.set(tempId, draft);
      return next;
    });
    setSelectedDraftId(tempId);
    zoomSyncScaleRef.current = null;
  }, []);

  useEffect(() => {
    void (async () => {
      await ensureSeedPresetFiles();
      const [colliderPresets, kindPresets] = await Promise.all([
        readColliderPresetFile(),
        readPhysicsKindPresetFile()
      ]);
      setPhysicsColliderPresets(colliderPresets);
      setPhysicsKindPresets(kindPresets);
      const defaultKind = kindPresets.kinds.find((k) => k.id === kindPresets.defaultKindId) ?? kindPresets.kinds[0];
      if (defaultKind) {
        setPhysicsSelectedKindId(defaultKind.id);
        setPhysicsSettings(buildPhysicsSettingsFromKind(defaultKind));
      }
      await loadSavedPropIndex();
    })();
    return () => {
      vhacdRunnerRef.current.dispose();
    };
  }, [loadSavedPropIndex]);

  useEffect(() => {
    const vp = generationViewportRef.current;
    if (!vp) return;
    vp.setModelVisible(generationMeshVisibility.mesh);
    vp.setColliderVisible(generationMeshVisibility.collider);
    vp.setGridVisible(generationMeshVisibility.grid);
    vp.setAxesVisible(generationMeshVisibility.axes);
    vp.setBBoxVisible(false);
  }, [generationMeshVisibility]);

  const syncGenerationPixelFromMesh = useCallback((meshState: Viewport3dViewState) => {
    if (zoomSyncScaleRef.current === null) {
      zoomSyncScaleRef.current = meshState.distance * Math.max(1, generationPixelBaseViewState.zoom);
    }
    const zoomScale = zoomSyncScaleRef.current;
    const desiredZoom = Math.round(clamp(zoomScale / Math.max(meshState.distance, 1e-3), 1, 6));
    const desiredYawTurns = wrapQuarterTurns((meshState.yaw - PIXEL_BASE_YAW) / QUARTER_TURN_RADIANS);
    const desired: PixelViewportViewState = {
      target: [meshState.target[0], 0, meshState.target[2]],
      yawTurns: desiredYawTurns,
      zoom: desiredZoom
    };
    meshToPixelSyncLockRef.current = true;
    setGenerationPixelBaseViewState((prev) => {
      const same =
        Math.abs(prev.target[0] - desired.target[0]) <= 1e-4 &&
        Math.abs(prev.target[2] - desired.target[2]) <= 1e-4 &&
        prev.yawTurns === desired.yawTurns &&
        Math.abs(prev.zoom - desired.zoom) <= 1e-4;
      return same ? prev : desired;
    });
    setTimeout(() => {
      meshToPixelSyncLockRef.current = false;
    }, 0);
  }, [generationPixelBaseViewState.zoom]);

  const syncGenerationMeshFromPixel = useCallback((pixelState: PixelViewportViewState) => {
    const meshViewport = generationViewportRef.current;
    if (!meshViewport) return;
    const currentMeshState = meshViewport.getViewState();
    if (!currentMeshState) return;
    if (zoomSyncScaleRef.current === null) {
      zoomSyncScaleRef.current = currentMeshState.distance * Math.max(1, pixelState.zoom);
    }
    const desiredDistance = clamp(
      zoomSyncScaleRef.current / Math.max(pixelState.zoom, 1),
      0.1,
      200
    );
    const desiredYaw = PIXEL_BASE_YAW + wrapQuarterTurns(pixelState.yawTurns) * QUARTER_TURN_RADIANS;
    const desiredState: Viewport3dViewState = {
      target: [pixelState.target[0], currentMeshState.target[1], pixelState.target[2]],
      distance: desiredDistance,
      yaw: desiredYaw,
      pitch: currentMeshState.pitch
    };
    pixelToMeshSyncLockRef.current = true;
    generationViewportRef.current?.setViewState(desiredState);
    setTimeout(() => {
      pixelToMeshSyncLockRef.current = false;
    }, 0);
  }, []);

  const handleGenerationMeshViewChange = useCallback((state: Viewport3dViewState) => {
    setGenerationMeshViewState(state);
    if (pixelToMeshSyncLockRef.current) return;
    syncGenerationPixelFromMesh(state);
  }, [syncGenerationPixelFromMesh]);

  const handleGenerationPixelBaseViewChange = useCallback((state: PixelViewportViewState) => {
    setGenerationPixelBaseViewState(state);
    if (meshToPixelSyncLockRef.current) return;
    syncGenerationMeshFromPixel(state);
  }, [syncGenerationMeshFromPixel]);

  const addBatchDrafts = useCallback(() => {
    const lines = batchText
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    if (lines.length <= 0) return;
    const items = lines.map((line) => createDraftProp(line, defaultFaceLimit));
    setDrafts((prev) => {
      const next = new Map(prev);
      for (const item of items) {
        next.set(item.tempId, item);
      }
      return next;
    });
    setSelectedDraftId((prev) => prev ?? items[0]?.tempId ?? null);
    setBatchText("");
  }, [batchText, defaultFaceLimit]);

  const runImageGenerationForDraft = useCallback(async (
    draft: ForgeV2GenerationDraftProp,
    promptMode: "current-style" | "last-used"
  ) => {
    const token = (imageJobTokenRef.current.get(draft.tempId) ?? 0) + 1;
    imageJobTokenRef.current.set(draft.tempId, token);
    const composedPrompt =
      promptMode === "last-used" && draft.imageRevision > 0
        ? (draft as ForgeV2GenerationDraftProp & { lastPromptUsed?: string }).lastPromptUsed ?? buildComposedPrompt(styleGuide, draft.description)
        : buildComposedPrompt(styleGuide, draft.description);

    updateDraft(draft.tempId, {
      status: "generating-image",
      imageError: null,
      meshError: null
    });

    try {
      const result = await generateImage(composedPrompt, styleGuide.imageSize || "1024x1024");
      if (imageJobTokenRef.current.get(draft.tempId) !== token) return;
      let dataUrl: string;
      if (result.b64_json) {
        dataUrl = `data:image/png;base64,${result.b64_json}`;
      } else if (result.url) {
        const resp = await fetch(result.url);
        const blob = await resp.blob();
        dataUrl = await new Promise<string>((resolve) => {
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result as string);
          reader.readAsDataURL(blob);
        });
      } else {
        throw new Error("No image returned");
      }
      updateDraft(draft.tempId, {
        conceptImage: dataUrl,
        status: "image-ready",
        imageRevision: draft.imageRevision + 1,
        imageError: null,
        rawGlb: null,
        meshRevision: 0,
        meshProgress: 0,
        meshProgressLabel: "idle"
      } as Partial<ForgeV2GenerationDraftProp>);
      setDrafts((prev) => {
        const item = prev.get(draft.tempId);
        if (!item) return prev;
        const next = new Map(prev);
        next.set(draft.tempId, {
          ...item,
          // Store snapshot prompt for explicit "regen without updating prompt"
          // without coupling to V2 persisted schema at draft stage.
          ...( { lastPromptUsed: composedPrompt } as unknown as Partial<ForgeV2GenerationDraftProp>)
        });
        return next;
      });
    } catch (err) {
      if (imageJobTokenRef.current.get(draft.tempId) !== token) return;
      updateDraft(draft.tempId, {
        status: draft.rawGlb ? "mesh-ready" : "draft",
        imageError: err instanceof Error ? err.message : "Image generation failed"
      });
    }
  }, [styleGuide, updateDraft]);

  const runMeshGenerationForDraft = useCallback(async (draft: ForgeV2GenerationDraftProp) => {
    if (!draft.conceptImage) return;
    const token = (meshJobTokenRef.current.get(draft.tempId) ?? 0) + 1;
    meshJobTokenRef.current.set(draft.tempId, token);
    baseModelCacheRef.current.delete(draft.tempId);

    updateDraft(draft.tempId, {
      status: "generating-mesh",
      meshError: null,
      meshProgress: 0,
      meshProgressLabel: "Starting..."
    });

    try {
      const resp = await fetch(draft.conceptImage);
      const blob = await resp.blob();
      const glb = await generateModel(blob, { faceLimit: draft.faceLimit, pbr: draft.pbr }, (progress, status) => {
        if (meshJobTokenRef.current.get(draft.tempId) !== token) return;
        updateDraft(draft.tempId, {
          meshProgress: Math.round(progress),
          meshProgressLabel: status
        });
      });
      if (meshJobTokenRef.current.get(draft.tempId) !== token) return;
      updateDraft(draft.tempId, {
        rawGlb: glb,
        status: "mesh-ready",
        meshRevision: draft.meshRevision + 1,
        meshProgress: 100,
        meshProgressLabel: "Done"
      });
    } catch (err) {
      if (meshJobTokenRef.current.get(draft.tempId) !== token) return;
      updateDraft(draft.tempId, {
        status: draft.conceptImage ? "image-ready" : "draft",
        meshError: err instanceof Error ? err.message : "3D generation failed"
      });
    }
  }, [updateDraft]);

  const runLimitedConcurrency = useCallback(async (
    tasks: Array<() => Promise<void>>,
    concurrency: number
  ) => {
    let nextIndex = 0;
    async function worker() {
      while (nextIndex < tasks.length) {
        const current = nextIndex;
        nextIndex += 1;
        await tasks[current]();
      }
    }
    await Promise.all(
      Array.from({ length: Math.min(concurrency, Math.max(1, tasks.length)) }, () => worker())
    );
  }, []);

  const handleGenerateAllImages = useCallback(async () => {
    const queue = Array.from(drafts.values()).filter((item) => item.status === "draft" || item.status === "image-ready");
    if (queue.length <= 0) return;
    setGenerationBusy((prev) => ({ ...prev, images: true }));
    try {
      await runLimitedConcurrency(queue.map((item) => () => runImageGenerationForDraft(item, "current-style")), 4);
    } finally {
      setGenerationBusy((prev) => ({ ...prev, images: false }));
    }
  }, [drafts, runImageGenerationForDraft, runLimitedConcurrency]);

  const handleGenerateAllMeshes = useCallback(async () => {
    const queue = Array.from(drafts.values()).filter((item) => item.conceptImage && (item.status === "image-ready" || item.status === "mesh-ready"));
    if (queue.length <= 0) return;
    setGenerationBusy((prev) => ({ ...prev, meshes: true }));
    try {
      await runLimitedConcurrency(queue.map((item) => () => runMeshGenerationForDraft(item)), 3);
    } finally {
      setGenerationBusy((prev) => ({ ...prev, meshes: false }));
    }
  }, [drafts, runLimitedConcurrency, runMeshGenerationForDraft]);

  const rebuildSelectedDraftPreview = useCallback(async () => {
    const draft = selectedDraftId ? drafts.get(selectedDraftId) ?? null : null;
    const viewport = generationViewportRef.current;
    if (!draft || !viewport || !draft.rawGlb) {
      generationPixelBaseModelRef.current = null;
      setGenerationPixelModel(null);
      viewport?.setModel(null);
      return;
    }

    const token = ++previewBuildTokenRef.current;
    let base = baseModelCacheRef.current.get(draft.tempId) ?? null;
    if (!base) {
      const parsed = await viewport.loadGlb(draft.rawGlb);
      normalizeTransforms(parsed);
      base = parsed;
      baseModelCacheRef.current.set(draft.tempId, parsed);
    }
    if (token !== previewBuildTokenRef.current) return;

    const model = deepCloneWithMaterials(base);
    if (draft.textureResolution > 0) {
      downsampleMeshTextures(model, draft.textureResolution);
    }
    const unitBBox = computeBBox(model);
    const pivotOffset = computePivotOffset(model ? unitBBox : unitBBox, draft.pivot);
    applyPivotOffset(model, pivotOffset);
    const postPivotBBox = computeBBox(model);
    const scale = computeScaleForDraft(postPivotBBox, draft.scaleMode, draft.targetDimension);
    applyScale(model, scale);
    const finalBBox = computeBBox(model);

    const originalFaces = countTotalFaces(base);
    const processedFaces = countTotalFaces(model);

    viewport.setModel(model);
    setGenerationMeshViewState(viewport.getViewState());

    const pixelGroup = buildPixelTestEnvironmentGroup(deepCloneWithMaterials(model));
    generationPixelBaseModelRef.current = pixelGroup;
    setGenerationPixelModel(pixelGroup);

    const nextPivotOffset: [number, number, number] = [pivotOffset.x, pivotOffset.y, pivotOffset.z];
    const nextBBox = bboxToJson(finalBBox);
    const nextRatio = originalFaces > 0 ? processedFaces / originalFaces : 1;
    const bboxSame =
      !!draft.bboxProcessed &&
      !!nextBBox &&
      Math.abs(draft.bboxProcessed.width - nextBBox.width) <= 1e-6 &&
      Math.abs(draft.bboxProcessed.height - nextBBox.height) <= 1e-6 &&
      Math.abs(draft.bboxProcessed.depth - nextBBox.depth) <= 1e-6;
    const pivotSame =
      Math.abs(draft.pivotOffset[0] - nextPivotOffset[0]) <= 1e-6 &&
      Math.abs(draft.pivotOffset[1] - nextPivotOffset[1]) <= 1e-6 &&
      Math.abs(draft.pivotOffset[2] - nextPivotOffset[2]) <= 1e-6;
    const sameDerived =
      pivotSame &&
      Math.abs(draft.scale - scale) <= 1e-6 &&
      draft.originalFaces === originalFaces &&
      draft.processedFaces === processedFaces &&
      Math.abs(draft.simplificationRatio - nextRatio) <= 1e-6 &&
      bboxSame &&
      (draft.status === "approved-generation" || draft.status === "mesh-ready");

    if (!sameDerived) {
      updateDraft(draft.tempId, {
        status: draft.status === "approved-generation" ? "approved-generation" : "mesh-ready",
        pivotOffset: nextPivotOffset,
        scale,
        originalFaces,
        processedFaces,
        simplificationRatio: nextRatio,
        bboxProcessed: nextBBox
      });
    }
  }, [drafts, selectedDraftId, updateDraft]);

  useEffect(() => {
    const draft = selectedDraft;
    void rebuildSelectedDraftPreview();
    return () => {
      if (!draft) return;
    };
  }, [
    rebuildSelectedDraftPreview,
    selectedDraft?.tempId,
    selectedDraft?.rawGlb,
    selectedDraft?.textureResolution,
    selectedDraft?.scaleMode,
    selectedDraft?.targetDimension,
    selectedDraft?.pivot,
    selectedDraft?.meshRevision
  ]);

  useEffect(() => {
    if (!selectedDraft) return;
    setGenerationPixelBaseViewState({
      target: selectedDraft.pixelCamera.target,
      yawTurns: selectedDraft.pixelCamera.yawTurns,
      zoom: selectedDraft.pixelCamera.zoomLevel
    });
  }, [selectedDraft?.tempId]);

  useEffect(() => {
    if (!selectedDraft) return;
    updateDraft(selectedDraft.tempId, {
      pixelCamera: {
        target: generationPixelBaseViewState.target,
        yawTurns: generationPixelBaseViewState.yawTurns,
        zoomLevel: Math.round(generationPixelBaseViewState.zoom)
      }
    });
  }, [generationPixelBaseViewState, selectedDraft?.tempId, updateDraft]);

  const approveSelectedDraftGeneration = useCallback(async () => {
    const draft = selectedDraft;
    const viewport = generationViewportRef.current;
    if (!draft || !viewport) return;
    const model = viewport.getModel();
    if (!model || !draft.rawGlb || !draft.conceptImage) {
      return;
    }
    const composedPrompt =
      (draft as ForgeV2GenerationDraftProp & { lastPromptUsed?: string }).lastPromptUsed ??
      buildComposedPrompt(styleGuide, draft.description);

    const meta = createDefaultForgeV2Meta({
      id: draft.idSlug,
      description: draft.description,
      styleGuide,
      composedPrompt,
      faceLimit: draft.faceLimit,
      pbr: draft.pbr
    });
    meta.lifecycle.status = "generation-approved";
    meta.lifecycle.generationApprovedAt = new Date().toISOString();
    meta.generation.image.revision = draft.imageRevision;
    meta.generation.image.generatedAt = draft.imageRevision > 0 ? new Date().toISOString() : undefined;
    meta.generation.mesh.faceLimit = draft.faceLimit;
    meta.generation.mesh.pbr = draft.pbr;
    meta.generation.mesh.revision = draft.meshRevision;
    meta.generation.mesh.generatedAt = draft.meshRevision > 0 ? new Date().toISOString() : undefined;
    meta.processing.mesh.originalFaces = draft.originalFaces;
    meta.processing.mesh.processedFaces = draft.processedFaces;
    meta.processing.mesh.simplificationRatio = draft.simplificationRatio;
    meta.processing.mesh.textureResolution = draft.textureResolution;
    meta.processing.mesh.bboxProcessed = draft.bboxProcessed ?? undefined;
    meta.processing.transform.unitScaleMetersPerUnit = UNIT_SCALE_METERS_PER_UNIT;
    meta.processing.transform.targetDimension = {
      method: draft.scaleMode,
      value: draft.targetDimension
    } as ForgeV2PropMeta["processing"]["transform"]["targetDimension"];
    meta.processing.transform.scale = [draft.scale, draft.scale, draft.scale];
    meta.processing.transform.provisionalPivot = {
      preset: draft.pivot,
      offset: draft.pivotOffset,
      basis: "mesh"
    };
    meta.pixelPreview.cameraSyncState = {
      target: generationPixelBaseViewState.target,
      yawTurns: generationPixelBaseViewState.yawTurns,
      zoomLevel: Math.round(generationPixelBaseViewState.zoom)
    };

    await writePropConceptImage(draft.idSlug, draft.conceptImage);
    await writePropPrompt(draft.idSlug, composedPrompt);
    await writePropRawGlb(draft.idSlug, draft.rawGlb);
    const processedGlb = await exportObjectToGlb(model);
    await writePropProcessedModelGlb(draft.idSlug, processedGlb);
    await writeForgeV2PropMeta(meta);

    updateDraft(draft.tempId, {
      status: "approved-generation",
      generationApprovedAt: meta.lifecycle.generationApprovedAt
    });
    await loadSavedPropIndex();
  }, [
    generationPixelBaseViewState,
    loadSavedPropIndex,
    selectedDraft,
    styleGuide,
    updateDraft
  ]);

  const loadPhysicsProp = useCallback(async (propId: string) => {
    const meta = await readForgeV2PropMeta(propId);
    if (!meta) return;
    const [conceptImage, processedGlb, rawGlb] = await Promise.all([
      readPropRawConceptImage(propId),
      readPropProcessedModelGlb(propId),
      readPropRawGlb(propId)
    ]);
    setPhysicsSelected({
      propId,
      meta,
      conceptImage,
      processedGlb,
      rawGlb
    });
    setPhysicsViewState(null);
    setPhysicsSimMeshViewState(null);
    setPhysicsConceptImage(conceptImage);
    setPhysicsColliderResults(meta.colliders?.presets ?? []);
    setPhysicsSelectedColliderPresetId(
      meta.colliders?.selectedPresetId ?? meta.colliders?.presets[0]?.presetId ?? null
    );
    if (physicsKindPresets) {
      const kind =
        physicsKindPresets.kinds.find((entry) => entry.id === meta.physics?.kind) ??
        physicsKindPresets.kinds.find((entry) => entry.id === physicsKindPresets.defaultKindId) ??
        physicsKindPresets.kinds[0];
      if (kind) {
        setPhysicsSelectedKindId(kind.id);
        setPhysicsSettings(meta.physics?.resolved ?? buildPhysicsSettingsFromKind(kind));
      }
    } else {
      setPhysicsSettings(meta.physics?.resolved ?? { ...DEFAULT_FORGE_PHYSICS_SETTINGS });
    }
  }, [physicsKindPresets]);

  useEffect(() => {
    const viewport = physicsMeshViewportRef.current;
    if (!viewport || !physicsSelected) {
      viewport?.setModel(null);
      physicsSimSourceModelRef.current = null;
      setPhysicsSourceModelVersion((v) => v + 1);
      setPhysicsSimPixelModels(makeScenarioRecord(() => null));
      return;
    }
    const glb = physicsSelected.processedGlb ?? physicsSelected.rawGlb;
    if (!glb) {
      viewport.setModel(null);
      physicsSimSourceModelRef.current = null;
      setPhysicsSourceModelVersion((v) => v + 1);
      setPhysicsSimPixelModels(makeScenarioRecord(() => null));
      return;
    }
    let active = true;
    void (async () => {
      const group = await viewport.loadGlb(glb);
      if (!active) return;
      // Processed model should already be normalized; raw fallback needs normalization.
      if (!physicsSelected.processedGlb) {
        normalizeTransforms(group);
      }
      viewport.setModel(group);
      const bbox = viewport.getBBox();
      setPhysicsBBox(bbox);
      physicsSimSourceModelRef.current = deepCloneWithMaterials(group);
      setPhysicsSourceModelVersion((v) => v + 1);
      setPhysicsSimPixelModels(makeScenarioRecord(() => null));
      setPhysicsSimStatusByScenario(
        makeScenarioRecord(() => "Compute/select a collider preset to run auto-replay.")
      );
      setPhysicsColliderBuildState((prev) => ({
        ...prev,
        statusText: "Loaded prop. Choose collider presets and compute.",
        error: null
      }));
    })();
    return () => {
      active = false;
    };
  }, [physicsSelected?.propId, physicsSelected?.processedGlb, physicsSelected?.rawGlb]);

  useEffect(() => {
    const sourceModel = physicsSimSourceModelRef.current;
    const viewports = physicsColliderPresetViewportRefs.current;
    const entryById = new Map(physicsColliderResults.map((entry) => [entry.presetId, entry]));

    for (const [presetId, viewport] of Object.entries(viewports)) {
      if (!viewport) {
        continue;
      }
      if (!sourceModel) {
        viewport.setModel(null);
        viewport.setColliderPreviewObject(null);
        continue;
      }
      const entry = entryById.get(presetId);
      if (!entry) {
        viewport.setModel(null);
        viewport.setColliderPreviewObject(null);
        continue;
      }
      // Show collider geometry only in these panes (no source mesh overlay).
      const colliderOnly = new THREE.Group();
      colliderOnly.add(createColliderHelper(entry.collider));
      physicsSuppressAssetViewSyncRef.current = true;
      viewport.setModel(colliderOnly);
      if (physicsViewState) {
        viewport.setViewState(physicsViewState);
      }
      physicsSuppressAssetViewSyncRef.current = false;
    }
  }, [physicsColliderResults, physicsSelected?.propId, physicsSourceModelVersion]);

  useEffect(() => {
    for (const scenario of PHYSICS_SCENARIOS) {
      cancelAnimationFrame(physicsSimLoopRafRefs.current[scenario]);
      physicsSimLoopRafRefs.current[scenario] = 0;
    }

    const sourceModel = physicsSimSourceModelRef.current;
    const selectedCollider =
      physicsColliderResults.find((entry) => entry.presetId === physicsSelectedColliderPresetId) ??
      physicsColliderResults[0] ??
      null;

    if (!physicsSelected || !sourceModel) {
      setPhysicsSimStatusByScenario(makeScenarioRecord(() => "Load a prop to preview physics scenarios."));
      return;
    }
    if (!selectedCollider) {
      setPhysicsSimStatusByScenario(
        makeScenarioRecord(() => "Compute/select a collider preset to run the drop tests.")
      );
      return;
    }

    let disposed = false;
    const worldsForCleanup: any[] = [];

    void (async () => {
      try {
        const rapier = await ensureRapier3d();
        if (disposed) {
          return;
        }
        const fallbackBounds = computeBBox(sourceModel);
        const mass = resolveForgeMass(physicsSettings, physicsBBox);
        const friction = clamp(physicsSettings.friction, 0, 2);
        const restitution = clamp(physicsSettings.restitution, 0, 1);
        const seededSimViewState =
          physicsMeshViewportRef.current?.getViewState() ?? physicsViewState ?? physicsSimMeshViewState;

        for (const scenario of PHYSICS_SCENARIOS) {
          const simVisual = createScenarioVisuals(deepCloneWithMaterials(sourceModel), scenario);
          physicsSimDynamicMeshRefs.current[scenario] = simVisual.meshDynamic;
          physicsSuppressSimViewSyncRef.current = true;
          physicsSimMeshViewportRefs.current[scenario]?.setModel(simVisual.meshRoot);
          if (seededSimViewState) {
            physicsSimMeshViewportRefs.current[scenario]?.setViewState(seededSimViewState);
          }
          physicsSuppressSimViewSyncRef.current = false;
          setPhysicsSimPixelModels((prev) => ({ ...prev, [scenario]: simVisual.pixelRoot }));

          const world = new rapier.World({ x: 0, y: -9.81, z: 0 });
          worldsForCleanup.push(world);

          createStaticBody(rapier, world, {
            translation: new THREE.Vector3(0, -0.05, 0),
            halfExtents: new THREE.Vector3(7, 0.05, 7),
            friction,
            restitution
          });

          if (scenario === "slope30Drop") {
            createStaticBody(rapier, world, {
              translation: new THREE.Vector3(0.8, 0.55, 0),
              halfExtents: new THREE.Vector3(1.6, 0.08, 1.1),
              quaternion: new THREE.Quaternion().setFromEuler(new THREE.Euler(0, 0, -Math.PI / 6)),
              friction,
              restitution
            });
          } else if (scenario === "edgeDrop") {
            createStaticBody(rapier, world, {
              translation: new THREE.Vector3(0, 0.5, 0),
              halfExtents: new THREE.Vector3(0.5, 0.5, 0.5),
              friction,
              restitution
            });
          }

          const bodyDesc = rapier.RigidBodyDesc.dynamic().setTranslation(
            simVisual.spawnPosition.x,
            simVisual.spawnPosition.y,
            simVisual.spawnPosition.z
          );
          bodyDesc.setRotation({
            x: simVisual.spawnQuaternion.x,
            y: simVisual.spawnQuaternion.y,
            z: simVisual.spawnQuaternion.z,
            w: simVisual.spawnQuaternion.w
          });
          const body = world.createRigidBody(bodyDesc);
          body.setLinearDamping(physicsSettings.linearDamping);
          body.setAngularDamping(physicsSettings.angularDamping);
          body.enableCcd(true);

          attachDynamicColliderFromParams(rapier, world, body, selectedCollider.collider, fallbackBounds, {
            mass,
            friction,
            restitution
          });

          let accumulator = 0;
          let lastTime = performance.now();
          let elapsed = 0;
          let maxLinearSpeed = 0;
          let maxAngularSpeed = 0;
          let settledFor = 0;
          let autoReplayCount = 0;

          const setScenarioStatus = (text: string) => {
            setPhysicsSimStatusByScenario((prev) =>
              prev[scenario] === text ? prev : { ...prev, [scenario]: text }
            );
          };

          const resetBody = (reason: string) => {
            body.setTranslation(
              {
                x: simVisual.spawnPosition.x,
                y: simVisual.spawnPosition.y,
                z: simVisual.spawnPosition.z
              },
              true
            );
            body.setRotation(
              {
                x: simVisual.spawnQuaternion.x,
                y: simVisual.spawnQuaternion.y,
                z: simVisual.spawnQuaternion.z,
                w: simVisual.spawnQuaternion.w
              },
              true
            );
            body.setLinvel({ x: 0, y: 0, z: 0 }, true);
            body.setAngvel({ x: 0, y: 0, z: 0 }, true);
            body.resetForces(true);
            body.resetTorques(true);

            physicsSimMetricsRef.current[scenario] = {
              durationSeconds: elapsed,
              maxLinearSpeed,
              maxAngularSpeed,
              settled: settledFor > 0.4
            };

            elapsed = 0;
            maxLinearSpeed = 0;
            maxAngularSpeed = 0;
            settledFor = 0;
            autoReplayCount += 1;
            setScenarioStatus(
              `${PHYSICS_SCENARIO_LABELS[scenario]} auto-replay #${autoReplayCount} (${reason}) · collider: ${selectedCollider.presetName}`
            );
          };

          const updateVisuals = () => {
            const t = body.translation();
            const r = body.rotation();
            physicsSimDynamicMeshRefs.current[scenario]?.position.set(t.x, t.y, t.z);
            physicsSimDynamicMeshRefs.current[scenario]?.quaternion.set(r.x, r.y, r.z, r.w);
            physicsSimDynamicMeshRefs.current[scenario]?.updateMatrixWorld(true);
            physicsSimPixelQuadRefs.current[scenario]?.setNamedObjectTransform("sim-body", {
              position: [t.x, t.y, t.z],
              quaternion: [r.x, r.y, r.z, r.w]
            });
          };

          updateVisuals();
          setScenarioStatus(
            `${PHYSICS_SCENARIO_LABELS[scenario]} running · auto-replay enabled · collider: ${selectedCollider.presetName}`
          );

          const FIXED_DT = 1 / 60;
          const MAX_STEPS = 8;
          const AUTO_REPLAY_SECONDS = 3.2;

          const frame = (now: number) => {
            if (disposed) {
              return;
            }
            let dt = (now - lastTime) / 1000;
            lastTime = now;
            if (!Number.isFinite(dt) || dt < 0) dt = 0;
            dt = Math.min(dt, 0.1);
            accumulator += dt;

            let steps = 0;
            while (accumulator >= FIXED_DT && steps < MAX_STEPS) {
              world.step();
              accumulator -= FIXED_DT;
              elapsed += FIXED_DT;
              steps += 1;

              const lv = body.linvel();
              const av = body.angvel();
              const linSpeed = Math.hypot(lv.x, lv.y, lv.z);
              const angSpeed = Math.hypot(av.x, av.y, av.z);
              if (linSpeed > maxLinearSpeed) maxLinearSpeed = linSpeed;
              if (angSpeed > maxAngularSpeed) maxAngularSpeed = angSpeed;

              if (linSpeed < 0.05 && angSpeed < 0.08 && elapsed > 0.4) {
                settledFor += FIXED_DT;
              } else {
                settledFor = 0;
              }
            }

            updateVisuals();

            const t = body.translation();
            const shouldReplay = elapsed >= AUTO_REPLAY_SECONDS || settledFor >= 0.5 || t.y < -3;
            if (shouldReplay) {
              resetBody(t.y < -3 ? "fell below floor" : settledFor >= 0.5 ? "settled" : "timeout");
              updateVisuals();
            }

            physicsSimLoopRafRefs.current[scenario] = requestAnimationFrame(frame);
          };

          physicsSimLoopRafRefs.current[scenario] = requestAnimationFrame(frame);
        }
      } catch (err) {
        if (!disposed) {
          const message = `Physics preview failed: ${err instanceof Error ? err.message : "unknown error"}`;
          setPhysicsSimStatusByScenario(makeScenarioRecord(() => message));
        }
      }
    })();

    return () => {
      disposed = true;
      for (const scenario of PHYSICS_SCENARIOS) {
        cancelAnimationFrame(physicsSimLoopRafRefs.current[scenario]);
        physicsSimLoopRafRefs.current[scenario] = 0;
        physicsSimDynamicMeshRefs.current[scenario] = null;
      }
      for (const world of worldsForCleanup) {
        if (world && typeof world.free === "function") {
          world.free();
        }
      }
    };
  }, [
    physicsBBox,
    physicsColliderResults,
    physicsSelected?.propId,
    physicsSelectedColliderPresetId,
    physicsSettings
  ]);

  const handlePhysicsAssetViewChange = useCallback((state: Viewport3dViewState) => {
    if (physicsSuppressAssetViewSyncRef.current) {
      return;
    }
    setPhysicsViewState(state);
    physicsMeshViewportRef.current?.setViewState(state);
    for (const viewport of Object.values(physicsColliderPresetViewportRefs.current)) {
      viewport?.setViewState(state);
    }
    physicsSuppressSimViewSyncRef.current = true;
    setPhysicsSimMeshViewState(state);
    for (const scenario of PHYSICS_SCENARIOS) {
      physicsSimMeshViewportRefs.current[scenario]?.setViewState(state);
    }
    physicsSuppressSimViewSyncRef.current = false;
  }, []);

  const computeSelectedPhysicsColliders = useCallback(async () => {
    if (!physicsSelected || !physicsColliderPresets) {
      return;
    }
    const sourceViewport = physicsMeshViewportRef.current;
    const sourceModel = sourceViewport?.getModel();
    if (!sourceViewport || !sourceModel) {
      setPhysicsColliderBuildState({
        running: false,
        progressText: "idle",
        statusText: "Load a prop mesh first.",
        error: "No source model loaded"
      });
      return;
    }

    const enabledPresets = physicsColliderPresets.presets.filter((preset) => preset.enabledByDefault !== false);
    if (enabledPresets.length <= 0) {
      setPhysicsColliderBuildState((prev) => ({ ...prev, error: "No collider presets enabled." }));
      return;
    }

    vhacdRunnerRef.current.restart("Forge V2 collider recompute");
    setPhysicsColliderBuildState({
      running: true,
      progressText: "starting...",
      statusText: `Running ${enabledPresets.length} collider preset(s)...`,
      error: null
    });

    const entries: ForgeV2ColliderResultEntry[] = [];
    try {
      for (let i = 0; i < enabledPresets.length; i += 1) {
        const preset = enabledPresets[i];
        setPhysicsColliderBuildState((prev) => ({
          ...prev,
          statusText: `Running ${preset.name} (${i + 1}/${enabledPresets.length})...`
        }));
        const clone = sourceModel.clone(true);
        const built = await buildVhacdColliderForObject({
          sourceModel: clone,
          presetName: preset.name,
          inputOptions: preset.options,
          runner: vhacdRunnerRef.current,
          onProgress: (progress) => {
            setPhysicsColliderBuildState((prev) => ({
              ...prev,
              progressText: `${preset.name}: ${formatVhacdProgress(progress)}`
            }));
          }
        });
        entries.push({
          presetId: preset.id,
          presetName: preset.name,
          enabled: true,
          file: `${makePropBaseDir(physicsSelected.propId)}/processed/colliders/${preset.id}.glb`,
          collider: built.collider,
          generation: built.metadata
        });
      }

      setPhysicsColliderResults(entries);
      setPhysicsSelectedColliderPresetId((prev) => prev ?? entries[0]?.presetId ?? null);

      setPhysicsColliderBuildState({
        running: false,
        progressText: "done",
        statusText: `Computed ${entries.length} collider preset(s).`,
        error: null
      });
    } catch (err) {
      setPhysicsColliderBuildState({
        running: false,
        progressText: "failed",
        statusText: "Collider generation failed.",
        error: err instanceof Error ? err.message : "VHACD failed"
      });
    }
  }, [physicsColliderPresets, physicsSelected]);

  const applyPhysicsKind = useCallback((kindId: string) => {
    if (!physicsKindPresets) return;
    const kind = physicsKindPresets.kinds.find((entry) => entry.id === kindId);
    if (!kind) return;
    setPhysicsSelectedKindId(kindId);
    setPhysicsSettings(buildPhysicsSettingsFromKind(kind));
  }, [physicsKindPresets]);

  const approvePhysicsSetup = useCallback(async () => {
    if (!physicsSelected) return;
    const baseMeta = await readForgeV2PropMeta(physicsSelected.propId);
    if (!baseMeta) return;
    const selectedCollider =
      physicsColliderResults.find((entry) => entry.presetId === physicsSelectedColliderPresetId) ??
      physicsColliderResults[0] ??
      null;
    if (!selectedCollider) {
      setPhysicsColliderBuildState((prev) => ({
        ...prev,
        error: "Compute and select a collider preset before approving physics."
      }));
      return;
    }

    // Persist collider glbs for all computed presets.
    for (const entry of physicsColliderResults) {
      const scene = buildColliderExportSceneFromParams(entry.collider);
      const buffer = await exportObjectToGlb(scene);
      const rel = await writePropColliderGlb(physicsSelected.propId, entry.presetId, buffer);
      entry.file = rel;
    }

    const colliderHelper = createColliderHelper(selectedCollider.collider);
    const colliderBBox = computeBBox(colliderHelper);
    const finalPivotOffset = computePivotOffset(colliderBBox, "bottom-center");

    const resolvedPhysics = normalizeForgePhysicsSettings(physicsSettings, physicsBBox);
    const previousResolved = baseMeta.physics?.resolved ?? null;
    const overrides: Partial<typeof resolvedPhysics> = {};
    if (previousResolved) {
      (Object.keys(resolvedPhysics) as Array<keyof typeof resolvedPhysics>).forEach((key) => {
        if (resolvedPhysics[key] !== previousResolved[key]) {
          (overrides as Record<string, unknown>)[key] = resolvedPhysics[key];
        }
      });
    }

    baseMeta.colliders = {
      selectedPresetId: selectedCollider.presetId,
      presets: physicsColliderResults
    };
    baseMeta.physics = {
      kind: physicsSelectedKindId,
      overrides,
      resolved: resolvedPhysics,
      simulationChecks: {
        floorDrop: {
          scenario: "floorDrop",
          ...physicsSimMetricsRef.current.floorDrop
        },
        slope30Drop: {
          scenario: "slope30Drop",
          ...physicsSimMetricsRef.current.slope30Drop
        },
        edgeDrop: {
          scenario: "edgeDrop",
          ...physicsSimMetricsRef.current.edgeDrop
        }
      }
    };
    baseMeta.processing.transform.finalPivot = {
      preset: "bottom-center",
      offset: [finalPivotOffset.x, finalPivotOffset.y, finalPivotOffset.z],
      basis: "collider",
      colliderPresetId: selectedCollider.presetId
    };
    baseMeta.lifecycle.status = "physics-approved";
    baseMeta.lifecycle.physicsApprovedAt = new Date().toISOString();

    await writeForgeV2PropMeta(baseMeta);
    setPhysicsSelected((prev) =>
      prev
        ? {
            ...prev,
            meta: baseMeta
          }
        : prev
    );
    await loadSavedPropIndex();
    setPhysicsColliderBuildState((prev) => ({
      ...prev,
      statusText: `Saved physics setup (${selectedCollider.presetName}); mass ${resolveForgeMass(resolvedPhysics, physicsBBox).toFixed(3)}.`
    }));
  }, [
    loadSavedPropIndex,
    physicsBBox,
    physicsColliderResults,
    physicsSelected,
    physicsSelectedColliderPresetId,
    physicsSelectedKindId,
    physicsSettings
  ]);

  const generationDrafts = useMemo(() => Array.from(drafts.values()), [drafts]);
  const generationDraftCount = generationDrafts.length;
  const draftImageReadyCount = generationDrafts.filter((d) => d.conceptImage).length;
  const draftMeshReadyCount = generationDrafts.filter((d) => d.rawGlb).length;
  return (
    <div className="forgev2-shell" data-testid="forge-v2-page">
      <header className="forgev2-header">
        <div>
          <h1>Asset Forge V2</h1>
          <p>Two-stage workflow: batch generation approval, then per-prop collider/physics setup.</p>
        </div>
        <div className="forgev2-tabbar">
          <button
            className={`forgev2-tab ${viewMode === "generation" ? "forgev2-tab-active" : ""}`}
            onClick={() => setViewMode("generation")}
          >
            1. Multi Prop Generation
          </button>
          <button
            className={`forgev2-tab ${viewMode === "physics" ? "forgev2-tab-active" : ""}`}
            onClick={() => setViewMode("physics")}
          >
            2. Physics Setup
          </button>
        </div>
      </header>

      {viewMode === "generation" ? (
        <div className="forgev2-view-mode-shell">
          <div className="forgev2-top-selector forge-panel">
            <div className="forgev2-top-selector-header">
              <h3>Props ({savedProps.length})</h3>
              <div className="forgev2-row">
                <button className="forge-btn" onClick={() => void loadSavedPropIndex()}>
                  Refresh
                </button>
                {savedLoading && <span className="forge-muted">Loading...</span>}
                <span className="forge-muted">Hover a ref to see the prop name. Click to import/select.</span>
              </div>
            </div>
            <div className="forgev2-prop-thumb-strip">
              {savedProps.map((item) => (
                <button
                  key={`gen-top-${item.id}`}
                  className={`forgev2-prop-thumb-btn ${selectedDraft?.idSlug === item.id ? "forgev2-prop-thumb-btn-active" : ""}`}
                  onClick={() => void importSavedPropIntoGeneration(item.id)}
                  title={item.description}
                >
                  <div className="forgev2-prop-thumb-image">
                    {item.conceptImage ? (
                      <img src={item.conceptImage} alt={item.description} />
                    ) : (
                      <div className="forgev2-saved-card-placeholder" />
                    )}
                  </div>
                  <div className="forgev2-prop-thumb-overlay">
                    <strong>{item.description}</strong>
                    <span>{item.status}</span>
                  </div>
                </button>
              ))}
              {savedProps.length <= 0 && (
                <div className="forge-muted">No V2 props yet. Generate or migrate refs first.</div>
              )}
            </div>
          </div>

          <div className="forgev2-layout">
          <aside className="forgev2-pane forgev2-pane-left">
            <div className="forgev2-section">
              <StyleGuidePanel value={styleGuide} onChange={setStyleGuide} />
            </div>

            <div className="forgev2-section forge-panel">
              <h3>Batch Prop Descriptions</h3>
              <div className="forge-field">
                <label>Enter prop descriptions (one per line)</label>
                <textarea
                  className="forge-batch-textarea"
                  rows={5}
                  value={batchText}
                  onChange={(e) => setBatchText(e.target.value)}
                  placeholder={"wooden chair\nstone well\niron lantern"}
                />
              </div>
              <div className="forge-field">
                <label>Mesh target polygons (Tripo face limit)</label>
                <input
                  type="number"
                  min={1000}
                  max={100000}
                  step={1000}
                  value={defaultFaceLimit}
                  onChange={(e) => setDefaultFaceLimit(Math.max(1000, Number(e.target.value) || DEFAULT_FACE_LIMIT))}
                />
                <div className="forge-muted">Default = current Forge default ({DEFAULT_FACE_LIMIT})</div>
              </div>
              <div className="forgev2-row">
                <button className="forge-btn" onClick={addBatchDrafts} disabled={!batchText.trim()}>
                  Add To Queue
                </button>
                <button
                  className="forge-btn forge-btn-primary"
                  onClick={() => void handleGenerateAllImages()}
                  disabled={generationBusy.images || generationDraftCount <= 0}
                >
                  {generationBusy.images ? "Generating Images..." : `Generate Images (${generationDraftCount})`}
                </button>
              </div>
              <div className="forgev2-row" style={{ marginTop: 8 }}>
                <button
                  className="forge-btn forge-btn-primary"
                  onClick={() => void handleGenerateAllMeshes()}
                  disabled={generationBusy.meshes || draftImageReadyCount <= 0}
                >
                  {generationBusy.meshes ? "Generating Meshes..." : `Generate Meshes (${draftImageReadyCount})`}
                </button>
                <span className="forge-muted">Mesh-ready: {draftMeshReadyCount}</span>
              </div>
            </div>

            <div className="forgev2-section forge-panel">
              <h3>Queue ({generationDraftCount})</h3>
              <div className="forgev2-draft-grid">
                {generationDrafts.map((draft) => (
                  <button
                    key={draft.tempId}
                    className={`forgev2-draft-card ${selectedDraftId === draft.tempId ? "forgev2-draft-card-active" : ""}`}
                    onClick={() => {
                      setSelectedDraftId(draft.tempId);
                      zoomSyncScaleRef.current = null;
                    }}
                    title={draft.description}
                  >
                    <div className="forgev2-draft-thumb">
                      {draft.conceptImage ? (
                        <img src={draft.conceptImage} alt={draft.description} />
                      ) : (
                        <div className="forgev2-draft-thumb-placeholder">{draft.description}</div>
                      )}
                    </div>
                    <div className="forgev2-draft-meta">
                      <div className="forgev2-draft-title">{draft.description}</div>
                      <div className="forgev2-draft-status">{draft.status}</div>
                      {draft.status === "generating-mesh" && (
                        <div className="forgev2-draft-progress">{draft.meshProgress}% · {draft.meshProgressLabel}</div>
                      )}
                      {draft.imageError && <div className="forge-error">{draft.imageError}</div>}
                      {draft.meshError && <div className="forge-error">{draft.meshError}</div>}
                    </div>
                  </button>
                ))}
                {generationDrafts.length <= 0 && <div className="forge-muted">No props in queue yet.</div>}
              </div>
            </div>

            <div className="forgev2-section forge-panel">
              <h3>Saved V2 Props ({savedProps.length})</h3>
              <div className="forgev2-row" style={{ marginBottom: 8 }}>
                <button className="forge-btn" onClick={() => void loadSavedPropIndex()}>
                  Refresh
                </button>
                <span className="forge-muted">Import a prop to review it in View 1</span>
              </div>
              <div className="forgev2-saved-gallery">
                {savedProps.map((item) => (
                  <button
                    key={`gen-${item.id}`}
                    className="forgev2-saved-card"
                    onClick={() => void importSavedPropIntoGeneration(item.id)}
                    title={`${item.description} (${item.status})`}
                  >
                    <div className="forgev2-saved-card-thumb">
                      {item.conceptImage ? (
                        <img src={item.conceptImage} alt={item.description} />
                      ) : (
                        <div className="forgev2-saved-card-placeholder" />
                      )}
                    </div>
                    <div className="forgev2-saved-card-text">
                      <span>{item.description}</span>
                      <small>{item.status}</small>
                    </div>
                  </button>
                ))}
                {savedProps.length <= 0 && <div className="forge-muted">No V2 props yet.</div>}
              </div>
            </div>
          </aside>

          <section className="forgev2-pane forgev2-pane-center">
            <ForgeScissorViewportStage className="forgev2-view-stack">
              <div className="forgev2-viewport-card">
                <div className="forgev2-viewport-card-header">
                  <strong>Mesh View</strong>
                  <div className="forge-viewport-toolbar">
                    <label className="forge-viewport-toggle">
                      <input
                        type="checkbox"
                        checked={generationMeshVisibility.mesh}
                        onChange={(e) => setGenerationMeshVisibility((prev) => ({ ...prev, mesh: e.target.checked }))}
                      /> Mesh
                    </label>
                    <label className="forge-viewport-toggle">
                      <input
                        type="checkbox"
                        checked={generationMeshVisibility.grid}
                        onChange={(e) => setGenerationMeshVisibility((prev) => ({ ...prev, grid: e.target.checked }))}
                      /> Grid
                    </label>
                    <label className="forge-viewport-toggle">
                      <input
                        type="checkbox"
                        checked={generationMeshVisibility.axes}
                        onChange={(e) => setGenerationMeshVisibility((prev) => ({ ...prev, axes: e.target.checked }))}
                      /> Axes
                    </label>
                  </div>
                </div>
                <ForgeScissorViewportPane
                  paneId="generation-mesh"
                  className="forgev2-viewport-host forgev2-scissor-3d-pane-host forgev2-scissor-3d-pane-host-interactive"
                  ref={generationViewportRef}
                  interactive
                  onViewChange={handleGenerationMeshViewChange}
                />
              </div>

              <div className="forgev2-viewport-card">
                <div className="forgev2-viewport-card-header">
                  <strong>Pixel Test Views (4 angles)</strong>
                  <span className="forge-muted">Includes 1u grid, 1u box, and 2u box refs. 1u = 1.28m</span>
                </div>
                <PixelQuad
                  model={generationPixelModel}
                  baseViewState={generationPixelBaseViewState}
                  onBaseViewStateChange={handleGenerationPixelBaseViewChange}
                  className="forgev2-pixel-strip"
                  interactive={false}
                  viewportFramingScale={1.28}
                />
              </div>
            </ForgeScissorViewportStage>
          </section>

          <aside className="forgev2-pane forgev2-pane-right">
            <div className="forgev2-section forge-panel">
              <h3>Selected Prop</h3>
              {!selectedDraft ? (
                <p className="forge-muted">Select a queued prop to review and process it.</p>
              ) : (
                <>
                  <div className="forgev2-detail-title">{selectedDraft.description}</div>
                  <div className="forgev2-detail-grid">
                    <div>
                      <span>Status</span>
                      <strong>{selectedDraft.status}</strong>
                    </div>
                    <div>
                      <span>Asset ID</span>
                      <strong>{selectedDraft.idSlug}</strong>
                    </div>
                    <div>
                      <span>Faces</span>
                      <strong>{selectedDraft.processedFaces || selectedDraft.originalFaces || 0}</strong>
                    </div>
                    <div>
                      <span>Scale</span>
                      <strong>{selectedDraft.scale.toFixed(3)}</strong>
                    </div>
                  </div>

                  {selectedDraft.conceptImage && (
                    <div className="forge-concept-preview" style={{ marginBottom: "0.5rem" }}>
                      <img src={selectedDraft.conceptImage} alt={selectedDraft.description} />
                    </div>
                  )}

                  <div className="forge-field">
                    <label>Mesh target polygons (face limit)</label>
                    <input
                      type="number"
                      min={1000}
                      max={100000}
                      step={1000}
                      value={selectedDraft.faceLimit}
                      onChange={(e) => updateDraft(selectedDraft.tempId, { faceLimit: Math.max(1000, Number(e.target.value) || DEFAULT_FACE_LIMIT) })}
                    />
                  </div>

                  <div className="forge-field">
                    <label>Texture size (downscale original textures)</label>
                    <select
                      value={selectedDraft.textureResolution}
                      onChange={(e) => updateDraft(selectedDraft.tempId, { textureResolution: Number(e.target.value) })}
                    >
                      <option value={0}>Original</option>
                      <option value={1024}>1024px</option>
                      <option value={512}>512px</option>
                      <option value={256}>256px</option>
                      <option value={128}>128px</option>
                    </select>
                  </div>

                  <div className="forge-field">
                    <label>Size target mode</label>
                    <select
                      value={selectedDraft.scaleMode}
                      onChange={(e) => updateDraft(selectedDraft.tempId, { scaleMode: e.target.value as ScaleModeV2 })}
                    >
                      <option value="height">Height</option>
                      <option value="width">Width</option>
                      <option value="depth">Depth</option>
                      <option value="max">Max Dimension</option>
                      <option value="manual">Manual Uniform Scale</option>
                    </select>
                  </div>

                  <div className="forge-field">
                    <label>{selectedDraft.scaleMode === "manual" ? "Scale Factor" : "Target Size (world units)"}</label>
                    <input
                      type="number"
                      min={0.01}
                      step={0.01}
                      value={selectedDraft.targetDimension}
                      onChange={(e) => updateDraft(selectedDraft.tempId, { targetDimension: Math.max(0.01, Number(e.target.value) || 1) })}
                    />
                    <div className="forge-muted">1u = {UNIT_SCALE_METERS_PER_UNIT.toFixed(2)}m</div>
                  </div>

                  {selectedDraft.bboxProcessed && (
                    <div className="forge-bbox-info">
                      <div>W: <strong>{selectedDraft.bboxProcessed.width.toFixed(3)}u</strong></div>
                      <div>H: <strong>{selectedDraft.bboxProcessed.height.toFixed(3)}u</strong></div>
                      <div>D: <strong>{selectedDraft.bboxProcessed.depth.toFixed(3)}u</strong></div>
                    </div>
                  )}

                  <div className="forge-field">
                    <label>Provisional Pivot (mesh basis)</label>
                    <div className="forge-btn-group">
                      {(["bottom-center", "center", "bottom-front-center"] as PivotPreset[]).map((preset) => (
                        <button
                          key={preset}
                          className={`forge-btn ${selectedDraft.pivot === preset ? "forge-btn-active" : ""}`}
                          onClick={() => updateDraft(selectedDraft.tempId, { pivot: preset })}
                        >
                          {preset}
                        </button>
                      ))}
                    </div>
                  </div>

                  <div className="forgev2-row forgev2-wrap">
                    <button
                      className="forge-btn"
                      onClick={() => void runImageGenerationForDraft(selectedDraft, "last-used")}
                      disabled={selectedDraft.status === "generating-image"}
                    >
                      Regen Image (saved prompt)
                    </button>
                    <button
                      className="forge-btn"
                      onClick={() => void runImageGenerationForDraft(selectedDraft, "current-style")}
                      disabled={selectedDraft.status === "generating-image"}
                    >
                      Regen Image (current guide)
                    </button>
                  </div>

                  <div className="forgev2-row" style={{ marginTop: 8 }}>
                    <button
                      className="forge-btn"
                      onClick={() => void runMeshGenerationForDraft(selectedDraft)}
                      disabled={!selectedDraft.conceptImage || selectedDraft.status === "generating-mesh"}
                    >
                      {selectedDraft.status === "generating-mesh" ? "Generating Mesh..." : "Generate / Regenerate Mesh"}
                    </button>
                    <button
                      className="forge-btn forge-btn-primary"
                      onClick={() => void approveSelectedDraftGeneration()}
                      disabled={!selectedDraft.rawGlb || !selectedDraft.conceptImage}
                    >
                      Approve Generation
                    </button>
                  </div>

                  {selectedDraft.generationApprovedAt && (
                    <div className="forge-success" style={{ marginTop: 8 }}>
                      Generation approved and persisted ({formatStatusTime(selectedDraft.generationApprovedAt)})
                    </div>
                  )}
                </>
              )}
            </div>
          </aside>
          </div>
        </div>
      ) : (
        <div className="forgev2-view-mode-shell">
          <div className="forgev2-top-selector forge-panel">
            <div className="forgev2-top-selector-header">
              <h3>Props ({savedProps.length})</h3>
              <div className="forgev2-row">
                <button className="forge-btn" onClick={() => void loadSavedPropIndex()}>
                  Refresh
                </button>
                {savedLoading && <span className="forge-muted">Loading...</span>}
              </div>
            </div>
            <div className="forgev2-prop-thumb-strip">
              {savedProps.map((item) => (
                <button
                  key={`physics-top-${item.id}`}
                  className={`forgev2-prop-thumb-btn ${physicsSelected?.propId === item.id ? "forgev2-prop-thumb-btn-active" : ""}`}
                  onClick={() => void loadPhysicsProp(item.id)}
                  title={item.description}
                >
                  <div className="forgev2-prop-thumb-image">
                    {item.conceptImage ? (
                      <img src={item.conceptImage} alt={item.description} />
                    ) : (
                      <div className="forgev2-saved-card-placeholder" />
                    )}
                  </div>
                  <div className="forgev2-prop-thumb-overlay">
                    <strong>{item.description}</strong>
                    <span>{item.status}</span>
                  </div>
                </button>
              ))}
              {savedProps.length <= 0 && (
                <div className="forge-muted">No V2 props yet. Generate or migrate refs first.</div>
              )}
            </div>
          </div>

          <div className="forgev2-layout-physics-body">
            <section className="forgev2-pane forgev2-pane-center">
              <ForgeScissorViewportStage className="forgev2-physics-views">
                <div className="forgev2-viewport-row-scroll">
                  <div className="forgev2-viewport-card forgev2-physics-top-card">
                    <div className="forgev2-viewport-card-header"><strong>Original Mesh</strong></div>
                    <ForgeScissorViewportPane
                      paneId="physics-source-mesh"
                      className="forgev2-viewport-host forgev2-viewport-host-sm forgev2-scissor-3d-pane-host forgev2-scissor-3d-pane-host-interactive"
                      ref={physicsMeshViewportRef}
                      interactive
                      onViewChange={handlePhysicsAssetViewChange}
                    />
                  </div>
                  {physicsColliderResults.map((entry) => (
                    <button
                      key={`collider-pane-${entry.presetId}`}
                      type="button"
                      className={`forgev2-viewport-card forgev2-physics-top-card forgev2-collider-preview-btn ${
                        physicsSelectedColliderPresetId === entry.presetId ? "forgev2-viewport-card-active" : ""
                      }`}
                      onClick={() => setPhysicsSelectedColliderPresetId(entry.presetId)}
                      title={`Use ${entry.presetName} collider for physics sim`}
                    >
                      <div className="forgev2-viewport-card-header">
                        <strong>{entry.presetName}</strong>
                        <span className="forge-muted">
                          {entry.generation.hullCount} hulls
                          {physicsSelectedColliderPresetId === entry.presetId ? " · active" : ""}
                        </span>
                      </div>
                      <ForgeScissorViewportPane
                        paneId={`collider-${entry.presetId}`}
                        className="forgev2-viewport-host forgev2-viewport-host-sm forgev2-scissor-3d-pane-host"
                        ref={(handle) => {
                          physicsColliderPresetViewportRefs.current[entry.presetId] = handle;
                        }}
                      />
                    </button>
                  ))}
                  {physicsSelected && physicsColliderResults.length <= 0 && (
                    <div className="forgev2-viewport-card forgev2-physics-top-card forgev2-placeholder-card">
                      <div className="forgev2-viewport-card-header"><strong>Collider Presets</strong></div>
                      <div className="forgev2-placeholder-card-body">
                        Compute collider presets to populate separate preview panes.
                      </div>
                    </div>
                  )}
                </div>

                <div className="forgev2-physics-sim-rows">
                  {PHYSICS_SCENARIOS.map((scenario) => (
                    <div key={`sim-row-${scenario}`} className="forgev2-viewport-card">
                      <div className="forgev2-viewport-card-header">
                        <strong>{PHYSICS_SCENARIO_LABELS[scenario]}</strong>
                        <span className="forge-muted">{physicsSimStatusByScenario[scenario]}</span>
                      </div>
                      <div className="forgev2-sim-row-grid">
                        <div className="forgev2-viewport-host forgev2-viewport-host-sm">
                          <ForgeScissorViewportPane
                            paneId={`sim-${scenario}`}
                            className="forgev2-viewport-host forgev2-viewport-host-sm forgev2-scissor-3d-pane-host"
                            ref={(handle) => {
                              physicsSimMeshViewportRefs.current[scenario] = handle;
                            }}
                          />
                        </div>
                        <PixelQuad
                          ref={(handle) => {
                            physicsSimPixelQuadRefs.current[scenario] = handle;
                          }}
                          model={physicsSimPixelModels[scenario]}
                          baseViewState={physicsSimPixelBaseViewStates[scenario]}
                          onBaseViewStateChange={(state) => {
                            setPhysicsSimPixelBaseViewStates((prev) => ({
                              ...prev,
                              [scenario]: state
                            }));
                          }}
                          className="forgev2-pixel-strip"
                          interactive={false}
                          viewportFramingScale={1.28}
                          paneIdPrefix={`physics-pixel-${scenario}-`}
                        />
                      </div>
                    </div>
                  ))}
                </div>
              </ForgeScissorViewportStage>
            </section>

            <aside className="forgev2-pane forgev2-pane-right">
              <div className="forgev2-section forge-panel">
                <h3>Collider Presets</h3>
                {physicsColliderPresets ? (
                  <div className="forgev2-checkbox-list">
                    {physicsColliderPresets.presets.map((preset) => (
                      <label key={preset.id}>
                        <input
                          type="checkbox"
                          checked={preset.enabledByDefault !== false}
                          onChange={(e) => {
                            setPhysicsColliderPresets((prev) => {
                              if (!prev) return prev;
                              return {
                                ...prev,
                                presets: prev.presets.map((entry) =>
                                  entry.id === preset.id
                                    ? { ...entry, enabledByDefault: e.target.checked }
                                    : entry
                                )
                              };
                            });
                          }}
                        />
                        {preset.name}
                      </label>
                    ))}
                  </div>
                ) : (
                  <div className="forge-muted">Loading collider presets...</div>
                )}
                <div className="forgev2-row" style={{ marginTop: 8 }}>
                  <button
                    className="forge-btn forge-btn-primary"
                    onClick={() => void computeSelectedPhysicsColliders()}
                    disabled={!physicsSelected || physicsColliderBuildState.running}
                  >
                    {physicsColliderBuildState.running ? "Computing..." : "Recompute Colliders"}
                  </button>
                </div>
                <div className="forge-info" style={{ marginTop: 8 }}>
                  <div>Status: {physicsColliderBuildState.statusText}</div>
                  <div>Progress: {physicsColliderBuildState.progressText}</div>
                  {physicsColliderBuildState.error && (
                    <div className="forge-error">{physicsColliderBuildState.error}</div>
                  )}
                </div>
              </div>

              <div className="forgev2-section forge-panel">
                <h3>Physics Setup</h3>
                {!physicsSelected ? (
                  <p className="forge-muted">Select a generation-approved V2 prop to configure colliders and physics.</p>
                ) : (
                  <>
                    <div className="forgev2-detail-title">{physicsSelected.meta.description}</div>
                    {physicsConceptImage && (
                      <div className="forge-concept-preview" style={{ marginBottom: "0.5rem" }}>
                        <img src={physicsConceptImage} alt={physicsSelected.meta.description} />
                      </div>
                    )}
                    <div className="forge-field">
                      <label>Physics Kind (preset)</label>
                      <select
                        value={physicsSelectedKindId}
                        onChange={(e) => applyPhysicsKind(e.target.value)}
                      >
                        {(physicsKindPresets?.kinds ?? []).map((kind) => (
                          <option key={kind.id} value={kind.id}>{kind.name}</option>
                        ))}
                      </select>
                    </div>

                    <div className="forge-field">
                      <label>Active Collider Preset</label>
                      <select
                        value={physicsSelectedColliderPresetId ?? ""}
                        onChange={(e) => setPhysicsSelectedColliderPresetId(e.target.value || null)}
                      >
                        <option value="">-- Select --</option>
                        {physicsColliderResults.map((entry) => (
                          <option key={entry.presetId} value={entry.presetId}>
                            {entry.presetName} ({entry.generation.hullCount} hulls)
                          </option>
                        ))}
                      </select>
                    </div>

                    {physicsColliderResults.length > 0 && (
                      <div className="forge-info">
                        {physicsColliderResults.map((entry) => (
                          <div key={entry.presetId}>
                            {entry.presetName}: {entry.generation.hullCount} hulls, {entry.generation.stats.voxelCount} voxels
                          </div>
                        ))}
                      </div>
                    )}

                    <PhysicsPanel
                      value={physicsSettings}
                      bbox={physicsBBox}
                      onChange={setPhysicsSettings}
                      hideTitle
                    />

                    <div className="forge-info">
                      <div>Estimated Mass: {resolveForgeMass(physicsSettings, physicsBBox).toFixed(3)}</div>
                      <div>
                        Final pivot will be recomputed from the selected collider on approve (bottom-center, collider basis).
                      </div>
                    </div>

                    <button
                      className="forge-btn forge-btn-primary"
                      onClick={() => void approvePhysicsSetup()}
                      disabled={!physicsSelectedColliderPresetId || physicsColliderResults.length <= 0}
                    >
                      Approve Physics Setup
                    </button>

                    {physicsSelected.meta.lifecycle.physicsApprovedAt && (
                      <div className="forge-success" style={{ marginTop: 8 }}>
                        Physics approved: {formatStatusTime(physicsSelected.meta.lifecycle.physicsApprovedAt)}
                      </div>
                    )}
                  </>
                )}
              </div>
            </aside>
          </div>
        </div>
      )}
    </div>
  );
}
