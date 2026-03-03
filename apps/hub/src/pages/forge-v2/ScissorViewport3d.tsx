import {
  createContext,
  forwardRef,
  useContext,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type ReactNode
} from "react";
import { SharedScissorStage, ThreeSceneScissorPane } from "@common/render";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import type { Viewport3dViewState } from "../forge/Viewport";
import { computeBBox, type BBox } from "../forge/processing/dimensions";

type StageContextValue = {
  stage: SharedScissorStage | null;
};

const ScissorViewport3dStageContext = createContext<StageContextValue>({ stage: null });

export function useForgeScissorViewportStage(): SharedScissorStage | null {
  return useContext(ScissorViewport3dStageContext).stage;
}

export type ForgeScissorViewportHandle = {
  loadGlb(data: ArrayBuffer): Promise<THREE.Group>;
  setModel(group: THREE.Group | null): void;
  getModel(): THREE.Group | null;
  getBBox(): BBox | null;
  getViewState(): Viewport3dViewState | null;
  setViewState(state: Viewport3dViewState): void;
  setColliderPreviewObject(helper: THREE.Object3D | null): void;
  setModelVisible(on: boolean): void;
  setColliderVisible(on: boolean): void;
  setGridVisible(on: boolean): void;
  setAxesVisible(on: boolean): void;
  setBBoxVisible(on: boolean): void;
  captureScreenshot(width: number, height: number): string | null;
};

type ForgeScissorViewportStageProps = {
  className?: string;
  children: ReactNode;
  clearColor?: number;
  clearAlpha?: number;
};

type ForgeScissorViewportPaneProps = {
  paneId: string;
  className?: string;
  dataTestId?: string;
  interactive?: boolean;
  onViewChange?: (state: Viewport3dViewState) => void;
  autoOrbitSpeed?: number;
};

function disposeObject(object: THREE.Object3D | null): void {
  if (!object) {
    return;
  }
  object.traverse((node) => {
    if (!(node instanceof THREE.Mesh || node instanceof THREE.Line || node instanceof THREE.LineSegments)) {
      return;
    }
    node.geometry?.dispose();
    if (Array.isArray(node.material)) {
      for (const material of node.material) {
        material.dispose();
      }
      return;
    }
    node.material?.dispose();
  });
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function copyViewState(state: Viewport3dViewState): Viewport3dViewState {
  return {
    target: [state.target[0], state.target[1], state.target[2]],
    distance: state.distance,
    yaw: state.yaw,
    pitch: state.pitch
  };
}

export function ForgeScissorViewportStage({
  className,
  children,
  clearColor: clearColorProp,
  clearAlpha: clearAlphaProp,
}: ForgeScissorViewportStageProps) {
  const canvasHostRef = useRef<HTMLDivElement | null>(null);
  const [stage, setStage] = useState<SharedScissorStage | null>(null);

  useEffect(() => {
    const host = canvasHostRef.current;
    if (!host) {
      return;
    }
    const nextStage = new SharedScissorStage({
      mount: host,
      width: Math.max(1, host.clientWidth),
      height: Math.max(1, host.clientHeight),
      antialias: true,
      clearColor: clearColorProp ?? 0x121212,
      clearAlpha: clearAlphaProp ?? 1,
    });
    nextStage.canvas.style.pointerEvents = "none";
    nextStage.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    nextStage.renderer.toneMappingExposure = 1.0;
    nextStage.start();
    setStage(nextStage);

    return () => {
      setStage(null);
      nextStage.dispose();
    };
  }, []);

  const contextValue = useMemo<StageContextValue>(() => ({ stage }), [stage]);

  return (
    <div className={`${className ?? ""} forgev2-scissor-3d-stage`.trim()}>
      <div ref={canvasHostRef} className="forgev2-scissor-3d-canvas-host" />
      <ScissorViewport3dStageContext.Provider value={contextValue}>
        {children}
      </ScissorViewport3dStageContext.Provider>
    </div>
  );
}

export const ForgeScissorViewportPane = forwardRef<ForgeScissorViewportHandle, ForgeScissorViewportPaneProps>(
  function ForgeScissorViewportPane(
    { paneId, className, dataTestId, interactive = false, onViewChange, autoOrbitSpeed },
    ref
  ) {
    const { stage } = useContext(ScissorViewport3dStageContext);
    const hostRef = useRef<HTMLDivElement | null>(null);
    const sceneRef = useRef<THREE.Scene | null>(null);
    const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
    const paneRef = useRef<ThreeSceneScissorPane | null>(null);
    const controlsRef = useRef<OrbitControls | null>(null);
    const modelRef = useRef<THREE.Group | null>(null);
    const colliderPreviewRef = useRef<THREE.Object3D | null>(null);
    const pendingModelRef = useRef<THREE.Group | null>(null);
    const pendingViewStateRef = useRef<Viewport3dViewState | null>(null);
    const pendingColliderPreviewRef = useRef<THREE.Object3D | null>(null);
    const viewStateRef = useRef<Viewport3dViewState | null>(null);
    const gridRef = useRef<THREE.GridHelper | null>(null);
    const axesRef = useRef<THREE.AxesHelper | null>(null);
    const applyingExternalViewRef = useRef(false);
    const onViewChangeRef = useRef(onViewChange);
    onViewChangeRef.current = onViewChange;
    const stageRef = useRef(stage);
    stageRef.current = stage;
    const autoOrbitSpeedRef = useRef(autoOrbitSpeed);
    autoOrbitSpeedRef.current = autoOrbitSpeed;
    const modelVisibleRef = useRef(true);
    const colliderVisibleRef = useRef(true);
    const gridVisibleRef = useRef(true);
    const axesVisibleRef = useRef(true);

    const tmpTargetRef = useRef(new THREE.Vector3());
    const tmpOffsetRef = useRef(new THREE.Vector3());
    const tmpBoxRef = useRef(new THREE.Box3());
    const tmpCenterRef = useRef(new THREE.Vector3());
    const tmpSizeRef = useRef(new THREE.Vector3());
    const tmpSphericalRef = useRef(new THREE.Spherical());
    const tmpVectorRef = useRef(new THREE.Vector3());

    const readCurrentViewState = (): Viewport3dViewState | null => {
      const controls = controlsRef.current;
      if (controls) {
        return {
          target: [controls.target.x, controls.target.y, controls.target.z],
          distance: controls.getDistance(),
          yaw: controls.getAzimuthalAngle(),
          pitch: controls.getPolarAngle()
        };
      }
      return viewStateRef.current ? copyViewState(viewStateRef.current) : null;
    };

    const emitViewChange = (): void => {
      const state = readCurrentViewState();
      if (!state) {
        return;
      }
      viewStateRef.current = state;
      if (!applyingExternalViewRef.current) {
        onViewChangeRef.current?.(copyViewState(state));
      }
    };

    const applyViewState = (state: Viewport3dViewState): void => {
      const camera = cameraRef.current;
      if (!camera) {
        pendingViewStateRef.current = copyViewState(state);
        return;
      }
      const current = readCurrentViewState();
      const target = state.target;
      const targetX = Number.isFinite(target[0]) ? target[0] : (current?.target[0] ?? 0);
      const targetY = Number.isFinite(target[1]) ? target[1] : (current?.target[1] ?? 0);
      const targetZ = Number.isFinite(target[2]) ? target[2] : (current?.target[2] ?? 0);
      const distance = Math.max(0.001, Number.isFinite(state.distance) ? state.distance : (current?.distance ?? 4));
      const yaw = Number.isFinite(state.yaw) ? state.yaw : (current?.yaw ?? Math.PI * 0.25);
      const pitch = clamp(
        Number.isFinite(state.pitch) ? state.pitch : (current?.pitch ?? 1.0),
        1e-3,
        Math.PI - 1e-3
      );

      tmpTargetRef.current.set(targetX, targetY, targetZ);
      tmpOffsetRef.current.setFromSpherical(tmpSphericalRef.current.set(distance, pitch, yaw));

      const controls = controlsRef.current;
      if (controls) {
        applyingExternalViewRef.current = true;
        controls.target.copy(tmpTargetRef.current);
        camera.position.copy(tmpTargetRef.current).add(tmpOffsetRef.current);
        camera.lookAt(tmpTargetRef.current);
        camera.updateMatrixWorld(true);
        controls.update();
        applyingExternalViewRef.current = false;
      } else {
        camera.position.copy(tmpTargetRef.current).add(tmpOffsetRef.current);
        camera.lookAt(tmpTargetRef.current);
        camera.updateMatrixWorld(true);
      }

      viewStateRef.current = {
        target: [targetX, targetY, targetZ],
        distance,
        yaw,
        pitch
      };
      pendingViewStateRef.current = null;
    };

    const fitCameraToObject = (object: THREE.Object3D): void => {
      const box = tmpBoxRef.current;
      box.setFromObject(object);
      if (box.isEmpty()) {
        return;
      }
      const center = box.getCenter(tmpCenterRef.current);
      const size = box.getSize(tmpSizeRef.current);
      const maxDim = Math.max(0.05, size.x, size.y, size.z);
      const dist = maxDim * 2;
      const offset = tmpVectorRef.current.set(dist, dist * 0.7, dist);
      const distance = offset.length();
      const spherical = tmpSphericalRef.current.setFromVector3(offset);
      applyViewState({
        target: [center.x, center.y, center.z],
        distance,
        yaw: spherical.theta,
        pitch: spherical.phi
      });
      emitViewChange();
    };

    const applyModel = (group: THREE.Group | null): void => {
      pendingModelRef.current = group;
      const scene = sceneRef.current;
      if (!scene) {
        return;
      }
      if (modelRef.current) {
        scene.remove(modelRef.current);
        modelRef.current = null;
      }
      if (!group) {
        return;
      }
      modelRef.current = group;
      group.visible = modelVisibleRef.current;
      scene.add(group);
      group.updateMatrixWorld(true);
      fitCameraToObject(group);
    };

    const applyColliderPreviewObject = (helper: THREE.Object3D | null): void => {
      pendingColliderPreviewRef.current = helper;
      const scene = sceneRef.current;
      if (!scene) {
        return;
      }
      if (colliderPreviewRef.current) {
        scene.remove(colliderPreviewRef.current);
        colliderPreviewRef.current = null;
      }
      if (!helper) {
        return;
      }
      colliderPreviewRef.current = helper;
      helper.visible = colliderVisibleRef.current;
      scene.add(helper);
      helper.updateMatrixWorld(true);
    };

    useImperativeHandle(
      ref,
      (): ForgeScissorViewportHandle => ({
        loadGlb: async (data: ArrayBuffer) => {
          const loader = new GLTFLoader();
          const gltf = await new Promise<{ scene: THREE.Group }>((resolve, reject) => {
            loader.parse(
              data,
              "",
              (result) => resolve(result as unknown as { scene: THREE.Group }),
              reject
            );
          });
          return gltf.scene;
        },
        setModel: (group) => {
          applyModel(group);
        },
        getModel: () => modelRef.current,
        getBBox: () => (modelRef.current ? computeBBox(modelRef.current) : null),
        getViewState: () => readCurrentViewState(),
        setViewState: (state) => {
          applyViewState(state);
        },
        setColliderPreviewObject: (helper) => {
          applyColliderPreviewObject(helper);
        },
        setModelVisible: (on) => {
          modelVisibleRef.current = on;
          if (modelRef.current) {
            modelRef.current.visible = on;
          }
        },
        setColliderVisible: (on) => {
          colliderVisibleRef.current = on;
          if (colliderPreviewRef.current) {
            colliderPreviewRef.current.visible = on;
          }
        },
        setGridVisible: (on) => {
          gridVisibleRef.current = on;
          if (gridRef.current) {
            gridRef.current.visible = on;
          }
        },
        setAxesVisible: (on) => {
          axesVisibleRef.current = on;
          if (axesRef.current) {
            axesRef.current.visible = on;
          }
        },
        setBBoxVisible: (_on) => {
          // Intentionally unsupported here: Forge V2 scissor view keeps bbox helpers out of the scene.
        },
        captureScreenshot: (width, height) => {
          const currentStage = stageRef.current;
          const scene = sceneRef.current;
          const camera = cameraRef.current;
          if (!currentStage || !scene || !camera) return null;

          const renderer = currentStage.getRenderer();
          const rt = new THREE.WebGLRenderTarget(width, height);
          const prevRT = renderer.getRenderTarget();
          const prevScissor = renderer.getScissorTest();
          const prevAspect = camera.aspect;

          // --- thumbnail scene overrides (brighter for small icons) ---
          const boostLight = new THREE.AmbientLight(0xffffff, 0.8);
          scene.add(boostLight);

          const grid = gridRef.current;
          const savedGridVis = grid?.visible;
          if (grid) grid.visible = true;
          const gridMats = grid
            ? (Array.isArray(grid.material) ? grid.material : [grid.material]) as THREE.LineBasicMaterial[]
            : [];
          const savedGridColors = gridMats.map((m) => m.color.clone());
          if (gridMats.length >= 2) {
            gridMats[0].color.set(0x7777bb);
            gridMats[1].color.set(0x555599);
          } else if (gridMats.length === 1) {
            gridMats[0].color.set(0x6666aa);
          }
          // --- end overrides ---

          renderer.setScissorTest(false);
          renderer.setRenderTarget(rt);
          camera.aspect = width / height;
          camera.updateProjectionMatrix();
          renderer.setClearColor(0x1a1a2e, 1);
          renderer.clear(true, true, true);
          renderer.render(scene, camera);

          // --- restore scene ---
          scene.remove(boostLight);
          boostLight.dispose();
          if (grid && savedGridVis !== undefined) grid.visible = savedGridVis;
          gridMats.forEach((m, i) => {
            if (savedGridColors[i]) m.color.copy(savedGridColors[i]);
          });
          // --- end restore ---

          const buf = new Uint8Array(width * height * 4);
          renderer.readRenderTargetPixels(rt, 0, 0, width, height, buf);

          camera.aspect = prevAspect;
          camera.updateProjectionMatrix();
          renderer.setRenderTarget(prevRT);
          renderer.setScissorTest(prevScissor);
          rt.dispose();

          const cvs = document.createElement("canvas");
          cvs.width = width;
          cvs.height = height;
          const ctx = cvs.getContext("2d");
          if (!ctx) return null;
          const imgData = ctx.createImageData(width, height);
          for (let y = 0; y < height; y++) {
            const src = (height - 1 - y) * width * 4;
            const dst = y * width * 4;
            imgData.data.set(buf.subarray(src, src + width * 4), dst);
          }
          ctx.putImageData(imgData, 0, 0);
          return cvs.toDataURL("image/png");
        }
      }),
      []
    );

    useEffect(() => {
      const host = hostRef.current;
      if (!host || !stage) {
        return;
      }

      const rect = host.getBoundingClientRect();
      const scene = new THREE.Scene();
      sceneRef.current = scene;

      const camera = new THREE.PerspectiveCamera(
        45,
        Math.max(1, rect.width) / Math.max(1, rect.height),
        0.01,
        100
      );
      camera.position.set(2, 1.5, 2);
      camera.lookAt(0, 0, 0);
      camera.updateMatrixWorld(true);
      cameraRef.current = camera;
      viewStateRef.current = {
        target: [0, 0, 0],
        distance: Math.hypot(2, 1.5, 2),
        yaw: Math.atan2(2, 2),
        pitch: new THREE.Spherical().setFromVector3(new THREE.Vector3(2, 1.5, 2)).phi
      };

      let controls: OrbitControls | null = null;
      const handleControlsChange = () => {
        emitViewChange();
      };
      if (interactive) {
        controls = new OrbitControls(camera, host);
        controls.enableDamping = true;
        controls.dampingFactor = 0.08;
        controlsRef.current = controls;
        controls.addEventListener("change", handleControlsChange);
      }

      const ambientLight = new THREE.AmbientLight(0xffffff, 0.4);
      scene.add(ambientLight);
      const keyLight = new THREE.DirectionalLight(0xffffff, 1.2);
      keyLight.position.set(3, 4, 2);
      scene.add(keyLight);
      const fillLight = new THREE.DirectionalLight(0x8899bb, 0.6);
      fillLight.position.set(-2, 2, -1);
      scene.add(fillLight);
      const rimLight = new THREE.DirectionalLight(0xffffff, 0.3);
      rimLight.position.set(0, 1, -3);
      scene.add(rimLight);

      const grid = new THREE.GridHelper(10, 10, 0x444466, 0x333355);
      gridRef.current = grid;
      grid.visible = gridVisibleRef.current;
      scene.add(grid);
      const axes = new THREE.AxesHelper(0.2);
      axesRef.current = axes;
      axes.visible = axesVisibleRef.current;
      scene.add(axes);

      const pane = new ThreeSceneScissorPane({
        id: paneId,
        element: host,
        scene,
        camera,
        clearColor: 0x1a1a2e,
        clearAlpha: 1,
        autoResizePerspectiveCamera: true,
        beforeRender: (frame) => {
          controlsRef.current?.update();
          const speed = autoOrbitSpeedRef.current;
          if (speed && viewStateRef.current && !controlsRef.current) {
            viewStateRef.current.yaw += speed * frame.deltaSeconds;
            applyViewState(viewStateRef.current);
          }
        }
      });
      paneRef.current = pane;
      stage.registerPane(pane);

      applyModel(pendingModelRef.current);
      applyColliderPreviewObject(pendingColliderPreviewRef.current);
      if (pendingViewStateRef.current) {
        applyViewState(pendingViewStateRef.current);
      } else {
        emitViewChange();
      }

      return () => {
        stage.unregisterPane(paneId);
        paneRef.current = null;

        if (controls) {
          controls.removeEventListener("change", handleControlsChange);
          controls.dispose();
        }
        controlsRef.current = null;

        if (colliderPreviewRef.current && sceneRef.current) {
          sceneRef.current.remove(colliderPreviewRef.current);
        }
        colliderPreviewRef.current = null;

        if (modelRef.current && sceneRef.current) {
          sceneRef.current.remove(modelRef.current);
        }
        modelRef.current = null;

        disposeObject(gridRef.current);
        disposeObject(axesRef.current);
        gridRef.current = null;
        axesRef.current = null;

        sceneRef.current = null;
        cameraRef.current = null;
        viewStateRef.current = null;
      };
    }, [interactive, paneId, stage]);

    return (
      <div
        ref={hostRef}
        className={className}
        style={{ minHeight: 0 }}
        data-testid={dataTestId}
      />
    );
  }
);
