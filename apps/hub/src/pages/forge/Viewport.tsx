import { useEffect, useRef, useImperativeHandle, forwardRef } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import type { ColliderParams } from "./processing/colliders";
import { createColliderHelper } from "./processing/colliders";
import { createBBoxHelper, createDimensionLabels, computeBBox, type BBox } from "./processing/dimensions";

export type MaterialChannelMode = "" | "baseColor" | "normal" | "roughness" | "metallic" | "ao" | "emissive";

export interface ViewportHandle {
  loadGlb(data: ArrayBuffer): Promise<THREE.Group>;
  setModel(group: THREE.Group | null): void;
  getModel(): THREE.Group | null;
  setWireframe(on: boolean): void;
  setMaterialChannel(channel: MaterialChannelMode): void;
  setCollider(params: ColliderParams | null): void;
  setColliderPreviewObject(helper: THREE.Object3D | null): void;
  setBBoxVisible(on: boolean): void;
  getBBox(): BBox | null;
  getScene(): THREE.Scene;
  getRenderer(): THREE.WebGLRenderer;
  getCamera(): THREE.PerspectiveCamera;
}

interface ViewportProps {
  className?: string;
  onModelChange?: (model: THREE.Group | null) => void;
}

export const Viewport = forwardRef<ViewportHandle, ViewportProps>(
  function Viewport({ className, onModelChange }, ref) {
    const containerRef = useRef<HTMLDivElement>(null);
    const onModelChangeRef = useRef(onModelChange);
    onModelChangeRef.current = onModelChange;
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
      savedMaterials: Map<THREE.Mesh, THREE.Material | THREE.Material[]>;
      activeChannel: MaterialChannelMode;
    } | null>(null);

    const disposeObject = (object: THREE.Object3D | null): void => {
      if (!object) {
        return;
      }
      object.traverse((node) => {
        if (!(node instanceof THREE.Mesh)) {
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
        if (s.colliderHelper) {
          s.scene.remove(s.colliderHelper);
          disposeObject(s.colliderHelper);
          s.colliderHelper = null;
        }

        s.model = group;
        if (group) {
          s.scene.add(group);

          // Fit camera
          const bbox = computeBBox(group);
          const maxDim = Math.max(bbox.width, bbox.height, bbox.depth);
          const dist = maxDim * 2;
          s.camera.position.set(dist, dist * 0.7, dist);
          s.camera.lookAt(bbox.center);
          s.controls.target.copy(bbox.center);
          s.controls.update();

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
        if (s.colliderHelper) {
          s.scene.remove(s.colliderHelper);
          disposeObject(s.colliderHelper);
          s.colliderHelper = null;
        }
        if (params) {
          s.colliderHelper = createColliderHelper(params);
          s.scene.add(s.colliderHelper);
        }
      },

      setColliderPreviewObject: (helper: THREE.Object3D | null) => {
        const s = stateRef.current;
        if (!s) return;
        if (s.colliderHelper) {
          s.scene.remove(s.colliderHelper);
          disposeObject(s.colliderHelper);
          s.colliderHelper = null;
        }
        if (!helper) {
          return;
        }
        s.colliderHelper = helper;
        s.scene.add(helper);
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
        savedMaterials: new Map(),
        activeChannel: "" as MaterialChannelMode,
      };
      stateRef.current = state;

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
        controls.dispose();
        if (state.colliderHelper) {
          disposeObject(state.colliderHelper);
          state.colliderHelper = null;
        }
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
