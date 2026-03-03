import {
  createContext,
  useContext,
  useEffect,
  useReducer,
  useRef,
  type Dispatch,
  type ReactNode
} from "react";
import * as THREE from "three";
import type { ForgeScissorViewportHandle } from "../ScissorViewport3d";
import type { PixelQuadHandle } from "../PixelQuad";
import type { PixelViewportViewState } from "../../forge/ViewportPixel";
import type { Viewport3dViewState } from "../../forge/Viewport";
import { createVhacdWorkerRunner, type VhacdWorkerRunner } from "@common/collider-vhacd";
import {
  createInitialState,
  forgeReducer,
  type ForgeAction,
  type ForgeStoreState
} from "./forge-store";

// ---------------------------------------------------------------------------
// Runtime refs — non-serializable objects that live outside the reducer
// ---------------------------------------------------------------------------

type PhysicsPreviewScenario = "floorDrop" | "slope30Drop" | "edgeDrop";
type ScenarioRecord<T> = Record<PhysicsPreviewScenario, T>;

function makeScenarioRecord<T>(factory: () => T): ScenarioRecord<T> {
  return {
    floorDrop: factory(),
    slope30Drop: factory(),
    edgeDrop: factory(),
  };
}

export interface ForgeRuntimeRefs {
  // Generation viewports
  generationViewport: React.RefObject<ForgeScissorViewportHandle | null>;
  generationPixelBaseModel: React.MutableRefObject<THREE.Group | null>;

  // Viewport sync locks
  meshToPixelSyncLock: React.MutableRefObject<boolean>;
  pixelToMeshSyncLock: React.MutableRefObject<boolean>;
  zoomSyncScale: React.MutableRefObject<number | null>;

  // Job tokens for cancellation
  imageJobTokens: React.MutableRefObject<Map<string, number>>;
  meshJobTokens: React.MutableRefObject<Map<string, number>>;
  previewBuildToken: React.MutableRefObject<number>;

  // Model cache
  baseModelCache: React.MutableRefObject<Map<string, THREE.Group>>;

  // Physics viewports
  physicsMeshViewport: React.RefObject<ForgeScissorViewportHandle | null>;
  physicsColliderPresetViewports: React.MutableRefObject<Record<string, ForgeScissorViewportHandle | null>>;
  physicsSimMeshViewports: React.MutableRefObject<ScenarioRecord<ForgeScissorViewportHandle | null>>;
  physicsSimPixelQuads: React.MutableRefObject<ScenarioRecord<PixelQuadHandle | null>>;

  // Physics simulation
  vhacdRunner: React.MutableRefObject<VhacdWorkerRunner>;
  physicsSimSourceModel: React.MutableRefObject<THREE.Group | null>;
  physicsSimDynamicMeshes: React.MutableRefObject<ScenarioRecord<THREE.Object3D | null>>;
  physicsSimLoopRafs: React.MutableRefObject<ScenarioRecord<number>>;
  physicsSimMetrics: React.MutableRefObject<ScenarioRecord<{
    durationSeconds: number;
    maxLinearSpeed: number;
    maxAngularSpeed: number;
    settled: boolean;
  }>>;

  // Sync suppression flags
  physicsSuppressAssetViewSync: React.MutableRefObject<boolean>;
  physicsSuppressSimViewSync: React.MutableRefObject<boolean>;

  // View states stored as refs (frequently mutated, not needed for render)
  generationMeshViewState: React.MutableRefObject<Viewport3dViewState | null>;
  generationPixelBaseViewState: React.MutableRefObject<PixelViewportViewState>;
  physicsViewState: React.MutableRefObject<Viewport3dViewState | null>;
  physicsSimMeshViewState: React.MutableRefObject<Viewport3dViewState | null>;

  // Stage tab thumbnail viewports (live 3D panes in the sidebar tabs)
  meshTabThumb: React.RefObject<ForgeScissorViewportHandle | null>;
  physicsTabThumb: React.RefObject<ForgeScissorViewportHandle | null>;
}

// ---------------------------------------------------------------------------
// Contexts
// ---------------------------------------------------------------------------

const ForgeStateContext = createContext<ForgeStoreState>(null!);
const ForgeDispatchContext = createContext<Dispatch<ForgeAction>>(null!);
const ForgeRefsContext = createContext<ForgeRuntimeRefs>(null!);

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export function ForgeProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(forgeReducer, undefined, createInitialState);

  // Individual useRef() calls are stable across renders, but the wrapper
  // object literal would be a new identity each render. Effects that list
  // `refs` in their dependency arrays would re-run every render, causing
  // camera resets (snap-back) and simulation restarts (shimmer).
  // Capture the first render's container via useRef — safe because the
  // inner useRef values are the same stable objects on every render.
  const refsInner: ForgeRuntimeRefs = {
    generationViewport: useRef<ForgeScissorViewportHandle | null>(null),
    generationPixelBaseModel: useRef<THREE.Group | null>(null),
    meshToPixelSyncLock: useRef(false),
    pixelToMeshSyncLock: useRef(false),
    zoomSyncScale: useRef<number | null>(null),
    imageJobTokens: useRef(new Map()),
    meshJobTokens: useRef(new Map()),
    previewBuildToken: useRef(0),
    baseModelCache: useRef(new Map()),
    physicsMeshViewport: useRef<ForgeScissorViewportHandle | null>(null),
    physicsColliderPresetViewports: useRef({}),
    physicsSimMeshViewports: useRef(makeScenarioRecord(() => null)),
    physicsSimPixelQuads: useRef(makeScenarioRecord(() => null)),
    vhacdRunner: useRef(createVhacdWorkerRunner()),
    physicsSimSourceModel: useRef(null),
    physicsSimDynamicMeshes: useRef(makeScenarioRecord(() => null)),
    physicsSimLoopRafs: useRef(makeScenarioRecord(() => 0)),
    physicsSimMetrics: useRef(makeScenarioRecord(() => ({
      durationSeconds: 0,
      maxLinearSpeed: 0,
      maxAngularSpeed: 0,
      settled: false,
    }))),
    physicsSuppressAssetViewSync: useRef(false),
    physicsSuppressSimViewSync: useRef(false),
    generationMeshViewState: useRef(null),
    generationPixelBaseViewState: useRef({
      target: [0, 0, 0],
      yawTurns: 0,
      zoom: 1,
    }),
    physicsViewState: useRef(null),
    physicsSimMeshViewState: useRef(null),
    meshTabThumb: useRef<ForgeScissorViewportHandle | null>(null),
    physicsTabThumb: useRef<ForgeScissorViewportHandle | null>(null),
  };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const refs = useRef(refsInner).current;

  // Expose dispatch and refs for e2e tests
  useEffect(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const w = window as any;
    w.__forgeDispatch = dispatch;
    w.__forgeRefs = refs;
    return () => { delete w.__forgeDispatch; delete w.__forgeRefs; };
  }, [dispatch, refs]);

  return (
    <ForgeStateContext.Provider value={state}>
      <ForgeDispatchContext.Provider value={dispatch}>
        <ForgeRefsContext.Provider value={refs}>
          {children}
        </ForgeRefsContext.Provider>
      </ForgeDispatchContext.Provider>
    </ForgeStateContext.Provider>
  );
}

// ---------------------------------------------------------------------------
// Hooks
// ---------------------------------------------------------------------------

export function useForgeState(): ForgeStoreState {
  return useContext(ForgeStateContext);
}

export function useForgeDispatch(): Dispatch<ForgeAction> {
  return useContext(ForgeDispatchContext);
}

export function useForgeRefs(): ForgeRuntimeRefs {
  return useContext(ForgeRefsContext);
}
