import { useEffect, useRef, forwardRef, useImperativeHandle } from "react";
import * as THREE from "three";
import { PixelPerfectView } from "@common/render";

export type PixelViewportViewState = {
  target: [number, number, number];
  yawTurns: number;
  zoom: number;
};

export interface ViewportPixelHandle {
  setModel(group: THREE.Group | null): void;
  getViewState(): PixelViewportViewState | null;
  setViewState(state: PixelViewportViewState): void;
  setNamedObjectTransform(
    name: string,
    transform: {
      position?: [number, number, number];
      quaternion?: [number, number, number, number];
    }
  ): void;
}

interface Props {
  className?: string;
  onViewChange?: (state: PixelViewportViewState) => void;
  framingScale?: number;
}

export const ViewportPixel = forwardRef<ViewportPixelHandle, Props>(
  function ViewportPixel({ className, onViewChange, framingScale = 1 }, ref) {
    const containerRef = useRef<HTMLDivElement>(null);
    const viewRef = useRef<PixelPerfectView | null>(null);
    const sceneRef = useRef<THREE.Scene | null>(null);
    const modelRef = useRef<THREE.Group | null>(null);
    const desiredModelRef = useRef<THREE.Group | null>(null);
    const pendingViewStateRef = useRef<PixelViewportViewState | null>(null);
    const onViewChangeRef = useRef(onViewChange);
    const lastViewSignatureRef = useRef<string>("");
    onViewChangeRef.current = onViewChange;

    const readViewState = (): PixelViewportViewState | null => {
      const view = viewRef.current;
      if (!view) {
        return null;
      }
      const pose = view.getViewPose();
      return {
        target: [pose.targetX, 0, pose.targetZ],
        yawTurns: pose.yawIndex,
        zoom: pose.zoom
      };
    };

    const applyModelToScene = (group: THREE.Group | null): void => {
      const scene = sceneRef.current;
      if (!scene) {
        return;
      }

      if (modelRef.current) {
        scene.remove(modelRef.current);
      }

      modelRef.current = null;
      if (group) {
        const clone = group.clone(true);
        modelRef.current = clone;
        scene.add(clone);
      }
    };

    const applyViewState = (state: PixelViewportViewState): void => {
      const view = viewRef.current;
      if (!view) {
        pendingViewStateRef.current = state;
        return;
      }
      const target = state.target;
      const zoom = Math.round(
        THREE.MathUtils.clamp(
          Number.isFinite(state.zoom) ? state.zoom : view.getState().cameraZoomTarget,
          1,
          6
        )
      );
      view.setViewPose({
        targetX: Number.isFinite(target[0]) ? target[0] : view.cameraTarget.x,
        targetZ: Number.isFinite(target[2]) ? target[2] : view.cameraTarget.z,
        yawIndex: Number.isFinite(state.yawTurns)
          ? ((Math.round(state.yawTurns) % 4) + 4) % 4
          : ((view.getYawIndex() % 4) + 4) % 4,
        zoom
      });
      pendingViewStateRef.current = null;
    };

    useImperativeHandle(ref, () => ({
      setModel: (group: THREE.Group | null) => {
        desiredModelRef.current = group;
        applyModelToScene(group);
      },
      getViewState: () => readViewState(),
      setViewState: (state: PixelViewportViewState) => {
        applyViewState(state);
      },
      setNamedObjectTransform: (
        name: string,
        transform: {
          position?: [number, number, number];
          quaternion?: [number, number, number, number];
        }
      ) => {
        const root = modelRef.current;
        if (!root || !name) {
          return;
        }
        const target = root.getObjectByName(name);
        if (!target) {
          return;
        }
        const pos = transform.position;
        if (pos) {
          target.position.set(pos[0], pos[1], pos[2]);
        }
        const quat = transform.quaternion;
        if (quat) {
          target.quaternion.set(quat[0], quat[1], quat[2], quat[3]);
        }
        target.updateMatrixWorld(true);
      }
    }));

    useEffect(() => {
      const container = containerRef.current;
      if (!container) return;

      const rect = container.getBoundingClientRect();
      const width = Math.floor(rect.width) || 400;
      const height = Math.floor(rect.height) || 300;

      // Create scene with lighting
      const scene = new THREE.Scene();
      sceneRef.current = scene;

      // Lighting — bright enough for pixel preview
      const ambient = new THREE.AmbientLight(0xffffff, 1.0);
      scene.add(ambient);
      const keyLight = new THREE.DirectionalLight(0xffffff, 1.8);
      keyLight.position.set(3, 5, 2);
      scene.add(keyLight);
      const fillLight = new THREE.DirectionalLight(0x8899bb, 0.8);
      fillLight.position.set(-2, 3, -1);
      scene.add(fillLight);

      // Ground plane
      const groundGeo = new THREE.PlaneGeometry(20, 20);
      const groundMat = new THREE.MeshStandardMaterial({
        color: 0x556655,
        roughness: 0.9,
      });
      const ground = new THREE.Mesh(groundGeo, groundMat);
      ground.rotation.x = -Math.PI / 2;
      ground.position.y = 0;
      ground.receiveShadow = true;
      scene.add(ground);

      const effectiveFramingScale =
        Number.isFinite(framingScale) && framingScale > 0 ? framingScale : 1;

      const view = new PixelPerfectView({
        mount: container,
        width,
        height,
        scene,
        fixedRenderHeight: 270,
        // Wider framing helps multi-panel quad previews fit tall props at zoom=1.
        baseOrthoHeight: 5.966213466261495 * effectiveFramingScale,
        cameraDistance: 30,
        basePixelZoom: 2,
        zoomMax: 6,
        zoomAnimationRate: 14,
        zoomAnimationBurstRate: 42,
        zoomAnimationEpsilon: 0.001,
        rotationAnimationRate: 18,
        rotationAnimationEpsilon: 0.001,
        zoomBurstIdleMs: 200,
        clearColor: 0x1a1a2e
      });
      viewRef.current = view;

      // Apply any imperative updates that arrived before the internal renderer finished mounting.
      applyModelToScene(desiredModelRef.current);
      if (pendingViewStateRef.current) {
        applyViewState(pendingViewStateRef.current);
      }

      // Render loop
      let raf = 0;
      let lastTime = performance.now();
      function animate() {
        raf = requestAnimationFrame(animate);
        const now = performance.now();
        const dt = (now - lastTime) / 1000;
        lastTime = now;
        view.frame(now, dt);

        const current = readViewState();
        if (current) {
          const signature = `${current.target[0].toFixed(4)}|${current.target[2].toFixed(4)}|${current.yawTurns}|${current.zoom.toFixed(4)}`;
          if (signature !== lastViewSignatureRef.current) {
            lastViewSignatureRef.current = signature;
            onViewChangeRef.current?.(current);
          }
        }
      }
      animate();

      return () => {
        cancelAnimationFrame(raf);
        view.dispose();
        viewRef.current = null;
        sceneRef.current = null;
      };
    }, []);

    return (
      <div
        ref={containerRef}
        className={className}
        style={{ width: "100%", height: "100%", minHeight: 0 }}
        data-testid="forge-viewport-pixel"
      />
    );
  }
);
