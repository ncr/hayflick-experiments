import { useEffect, useRef, useImperativeHandle, forwardRef } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import type { ColliderParams } from "./processing/colliders";
import { createColliderHelper } from "./processing/colliders";
import { createBBoxHelper, createDimensionLabels, computeBBox, type BBox } from "./processing/dimensions";

export type MaterialChannelMode = "" | "baseColor" | "normal" | "roughness" | "metallic" | "ao" | "emissive";

export type Viewport3dViewState = {
  target: [number, number, number];
  distance: number;
  yaw: number;
  pitch: number;
};

export interface ViewportHandle {
  loadGlb(data: ArrayBuffer): Promise<THREE.Group>;
  setModel(group: THREE.Group | null): void;
  getModel(): THREE.Group | null;
  getViewState(): Viewport3dViewState | null;
  setViewState(state: Viewport3dViewState): void;
  setWireframe(on: boolean): void;
  setMaterialChannel(channel: MaterialChannelMode): void;
  setCollider(params: ColliderParams | null): void;
  setColliderPreviewObject(helper: THREE.Object3D | null): void;
  setModelVisible(on: boolean): void;
  setColliderVisible(on: boolean): void;
  setGridVisible(on: boolean): void;
  setAxesVisible(on: boolean): void;
  setBBoxVisible(on: boolean): void;
  getBBox(): BBox | null;
  getScene(): THREE.Scene;
  getRenderer(): THREE.WebGLRenderer;
  getCamera(): THREE.PerspectiveCamera;
}

interface ViewportProps {
  className?: string;
  onModelChange?: (model: THREE.Group | null) => void;
  onViewChange?: (state: Viewport3dViewState) => void;
}

export const Viewport = forwardRef<ViewportHandle, ViewportProps>(
  function Viewport({ className, onModelChange, onViewChange }, ref) {
    const containerRef = useRef<HTMLDivElement>(null);
    const onModelChangeRef = useRef(onModelChange);
    const onViewChangeRef = useRef(onViewChange);
    const applyingExternalViewRef = useRef(false);
    onModelChangeRef.current = onModelChange;
    onViewChangeRef.current = onViewChange;
    const stateRef = useRef<{
      scene: THREE.Scene;
      camera: THREE.PerspectiveCamera;
      renderer: THREE.WebGLRenderer;
      controls: OrbitControls;
      model: THREE.Group | null;
      bboxHelper: THREE.Box3Helper | null;
      dimLabels: THREE.Group | null;
      colliderHelper: THREE.Object3D | null;
      bboxVisible: boolean;
      raf: number;
      grid: THREE.GridHelper;
      axesHelper: THREE.AxesHelper;
      savedMaterials: Map<THREE.Mesh, THREE.Material | THREE.Material[]>;
      activeChannel: MaterialChannelMode;
      modelVisible: boolean;
      colliderVisible: boolean;
      gridVisible: boolean;
      axesVisible: boolean;
    } | null>(null);

    const disposeObject = (object: THREE.Object3D | null): void => {
      if (!object) {
        return;
      }
      object.traverse((node) => {
        if (
          !(
            node instanceof THREE.Mesh ||
            node instanceof THREE.LineSegments ||
            node instanceof THREE.Line
          )
        ) {
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
    };

    const markColliderHelperRoot = (object: THREE.Object3D): void => {
      object.userData.__forgeColliderHelperRoot = true;
    };

    const clearColliderHelpers = (state: {
      scene: THREE.Scene;
      colliderHelper: THREE.Object3D | null;
    }): void => {
      const helperRoots = new Set<THREE.Object3D>();
      if (state.colliderHelper) {
        helperRoots.add(state.colliderHelper);
      }

      state.scene.traverse((node) => {
        if (node === state.scene) {
          return;
        }
        const isHelperNode =
          node.userData.__forgeColliderHelperRoot === true ||
          node.name === "collider-helper" ||
          node.name.startsWith("collider-preview");
        if (!isHelperNode) {
          return;
        }
        let root: THREE.Object3D = node;
        while (root.parent && root.parent !== state.scene) {
          root = root.parent;
        }
        if (root.parent === state.scene) {
          helperRoots.add(root);
        }
      });

      for (const helper of helperRoots) {
        state.scene.remove(helper);
        disposeObject(helper);
      }
      state.colliderHelper = null;
    };

    const readCurrentViewState = (state: {
      controls: OrbitControls;
    }): Viewport3dViewState => ({
      target: [
        state.controls.target.x,
        state.controls.target.y,
        state.controls.target.z
      ],
      distance: state.controls.getDistance(),
      yaw: state.controls.getAzimuthalAngle(),
      pitch: state.controls.getPolarAngle()
    });

    const clamp = (value: number, min: number, max: number): number =>
      Math.min(max, Math.max(min, value));

    useImperativeHandle(ref, () => ({
      loadGlb: async (data: ArrayBuffer) => {
        const loader = new GLTFLoader();
        const gltf = await new Promise<{ scene: THREE.Group }>((resolve, reject) => {
          loader.parse(data, "", (result) => resolve(result as unknown as { scene: THREE.Group }), reject);
        });
        return gltf.scene;
      },

      setModel: (group: THREE.Group | null) => {
        const s = stateRef.current;
        if (!s) return;

        // Remove old model + helpers
        if (s.model) s.scene.remove(s.model);
        if (s.bboxHelper) { s.scene.remove(s.bboxHelper); s.bboxHelper = null; }
        if (s.dimLabels) { s.scene.remove(s.dimLabels); s.dimLabels = null; }
        clearColliderHelpers(s);

        s.model = group;
        if (group) {
          group.visible = s.modelVisible;
          s.scene.add(group);

          // Fit camera
          const bbox = computeBBox(group);
          const maxDim = Math.max(bbox.width, bbox.height, bbox.depth);
          const dist = maxDim * 2;
          s.camera.position.set(dist, dist * 0.7, dist);
          s.camera.lookAt(bbox.center);
          s.controls.target.copy(bbox.center);
          s.controls.update();
          onViewChangeRef.current?.(readCurrentViewState(s));

          // BBox
          if (s.bboxVisible) {
            s.bboxHelper = createBBoxHelper(bbox);
            s.scene.add(s.bboxHelper);
            s.dimLabels = createDimensionLabels(bbox);
            s.scene.add(s.dimLabels);
          }
        }
        onModelChangeRef.current?.(group);
      },

      getModel: () => stateRef.current?.model ?? null,

      getViewState: () => {
        const s = stateRef.current;
        if (!s) {
          return null;
        }
        return readCurrentViewState(s);
      },

      setViewState: (viewState: Viewport3dViewState) => {
        const s = stateRef.current;
        if (!s) {
          return;
        }
        const nextTarget = viewState.target;
        const targetX = Number.isFinite(nextTarget[0]) ? nextTarget[0] : s.controls.target.x;
        const targetY = Number.isFinite(nextTarget[1]) ? nextTarget[1] : s.controls.target.y;
        const targetZ = Number.isFinite(nextTarget[2]) ? nextTarget[2] : s.controls.target.z;
        const distance = Math.max(
          0.001,
          Number.isFinite(viewState.distance) ? viewState.distance : s.controls.getDistance()
        );
        const yaw = Number.isFinite(viewState.yaw)
          ? viewState.yaw
          : s.controls.getAzimuthalAngle();
        const pitch = clamp(
          Number.isFinite(viewState.pitch) ? viewState.pitch : s.controls.getPolarAngle(),
          1e-3,
          Math.PI - 1e-3
        );

        const offset = new THREE.Vector3().setFromSpherical(
          new THREE.Spherical(distance, pitch, yaw)
        );

        applyingExternalViewRef.current = true;
        s.controls.target.set(targetX, targetY, targetZ);
        s.camera.position.copy(s.controls.target).add(offset);
        s.camera.lookAt(s.controls.target);
        s.controls.update();
        applyingExternalViewRef.current = false;
      },

      setWireframe: (on: boolean) => {
        const s = stateRef.current;
        if (!s?.model) return;
        s.model.traverse((child) => {
          if (child instanceof THREE.Mesh) {
            const mats = Array.isArray(child.material)
              ? child.material
              : [child.material];
            for (const m of mats) m.wireframe = on;
          }
        });
      },

      setMaterialChannel: (channel: MaterialChannelMode) => {
        const s = stateRef.current;
        if (!s?.model) return;

        // Restore saved materials first
        if (s.activeChannel !== "" && s.savedMaterials.size > 0) {
          s.model.traverse((child) => {
            if (child instanceof THREE.Mesh && s.savedMaterials.has(child)) {
              child.material = s.savedMaterials.get(child)!;
            }
          });
          s.savedMaterials.clear();
        }

        s.activeChannel = channel;
        if (channel === "") return;

        // Save current materials and replace with channel-only view
        s.model.traverse((child) => {
          if (!(child instanceof THREE.Mesh)) return;
          const mat = child.material;
          if (!(mat instanceof THREE.MeshStandardMaterial)) return;

          s.savedMaterials.set(child, mat);

          const texMap: Record<string, THREE.Texture | null> = {
            baseColor: mat.map,
            normal: mat.normalMap,
            roughness: mat.roughnessMap,
            metallic: mat.metalnessMap,
            ao: mat.aoMap,
            emissive: mat.emissiveMap,
          };

          const tex = texMap[channel] ?? null;
          if (tex) {
            const preview = new THREE.MeshBasicMaterial({ map: tex });
            child.material = preview;
          } else {
            child.material = new THREE.MeshBasicMaterial({ color: 0x333333 });
          }
        });
      },

      setCollider: (params: ColliderParams | null) => {
        const s = stateRef.current;
        if (!s) return;
        clearColliderHelpers(s);
        if (params) {
          s.colliderHelper = createColliderHelper(params);
          markColliderHelperRoot(s.colliderHelper);
          s.colliderHelper.visible = s.colliderVisible;
          s.scene.add(s.colliderHelper);
        }
      },

      setColliderPreviewObject: (helper: THREE.Object3D | null) => {
        const s = stateRef.current;
        if (!s) return;
        clearColliderHelpers(s);
        if (!helper) {
          return;
        }
        s.colliderHelper = helper;
        markColliderHelperRoot(s.colliderHelper);
        s.colliderHelper.visible = s.colliderVisible;
        s.scene.add(helper);
      },

      setModelVisible: (on: boolean) => {
        const s = stateRef.current;
        if (!s) return;
        s.modelVisible = on;
        if (s.model) {
          s.model.visible = on;
        }
      },

      setColliderVisible: (on: boolean) => {
        const s = stateRef.current;
        if (!s) return;
        s.colliderVisible = on;
        if (s.colliderHelper) {
          s.colliderHelper.visible = on;
        }
      },

      setGridVisible: (on: boolean) => {
        const s = stateRef.current;
        if (!s) return;
        s.gridVisible = on;
        s.grid.visible = on;
      },

      setAxesVisible: (on: boolean) => {
        const s = stateRef.current;
        if (!s) return;
        s.axesVisible = on;
        s.axesHelper.visible = on;
      },

      setBBoxVisible: (on: boolean) => {
        const s = stateRef.current;
        if (!s) return;
        s.bboxVisible = on;
        if (s.bboxHelper) { s.scene.remove(s.bboxHelper); s.bboxHelper = null; }
        if (s.dimLabels) { s.scene.remove(s.dimLabels); s.dimLabels = null; }
        if (on && s.model) {
          const bbox = computeBBox(s.model);
          s.bboxHelper = createBBoxHelper(bbox);
          s.scene.add(s.bboxHelper);
          s.dimLabels = createDimensionLabels(bbox);
          s.scene.add(s.dimLabels);
        }
      },

      getBBox: () => {
        const s = stateRef.current;
        if (!s?.model) return null;
        return computeBBox(s.model);
      },

      getScene: () => stateRef.current!.scene,
      getRenderer: () => stateRef.current!.renderer,
      getCamera: () => stateRef.current!.camera,
    }));

    useEffect(() => {
      const container = containerRef.current;
      if (!container) return;

      const rect = container.getBoundingClientRect();
      const width = Math.floor(rect.width) || 800;
      const height = Math.floor(rect.height) || 600;

      // Scene
      const scene = new THREE.Scene();
      scene.background = new THREE.Color(0x1a1a2e);

      // Camera
      const camera = new THREE.PerspectiveCamera(45, width / height, 0.01, 100);
      camera.position.set(2, 1.5, 2);

      // Renderer
      const renderer = new THREE.WebGLRenderer({ antialias: true });
      renderer.setSize(width, height);
      renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
      renderer.toneMapping = THREE.ACESFilmicToneMapping;
      renderer.toneMappingExposure = 1.0;
      container.appendChild(renderer.domElement);

      // Controls
      const controls = new OrbitControls(camera, renderer.domElement);
      controls.enableDamping = true;
      controls.dampingFactor = 0.08;

      // Lighting — studio setup
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

      // Grid
      const grid = new THREE.GridHelper(10, 10, 0x444466, 0x333355);
      scene.add(grid);

      // Pivot gizmo at origin
      const axesHelper = new THREE.AxesHelper(0.2);
      scene.add(axesHelper);

      const state = {
        scene,
        camera,
        renderer,
        controls,
        model: null as THREE.Group | null,
        bboxHelper: null as THREE.Box3Helper | null,
        dimLabels: null as THREE.Group | null,
        colliderHelper: null as THREE.Object3D | null,
        bboxVisible: true,
        raf: 0,
        grid,
        axesHelper,
        savedMaterials: new Map(),
        activeChannel: "" as MaterialChannelMode,
        modelVisible: true,
        colliderVisible: true,
        gridVisible: true,
        axesVisible: true,
      };
      stateRef.current = state;

      const handleControlsChange = () => {
        if (applyingExternalViewRef.current) {
          return;
        }
        onViewChangeRef.current?.(readCurrentViewState(state));
      };
      controls.addEventListener("change", handleControlsChange);

      // Resize observer
      const ro = new ResizeObserver((entries) => {
        const entry = entries[0];
        if (!entry) return;
        const w = Math.floor(entry.contentRect.width);
        const h = Math.floor(entry.contentRect.height);
        if (w > 0 && h > 0) {
          camera.aspect = w / h;
          camera.updateProjectionMatrix();
          renderer.setSize(w, h);
        }
      });
      ro.observe(container);

      // Render loop
      function animate() {
        state.raf = requestAnimationFrame(animate);
        controls.update();
        renderer.render(scene, camera);
      }
      animate();

      return () => {
        cancelAnimationFrame(state.raf);
        ro.disconnect();
        controls.removeEventListener("change", handleControlsChange);
        controls.dispose();
        clearColliderHelpers(state);
        renderer.dispose();
        renderer.domElement.remove();
        stateRef.current = null;
      };
    }, []);

    return (
      <div
        ref={containerRef}
        className={className}
        style={{ width: "100%", height: "100%", minHeight: 0 }}
        data-testid="forge-viewport"
      />
    );
  }
);
