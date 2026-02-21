import { useEffect, useRef, forwardRef, useImperativeHandle } from "react";
import * as THREE from "three";
import { PixelPerfectIsoView } from "@common/render";

export type PixelViewportViewState = {
  target: [number, number, number];
  yawTurns: number;
  zoom: number;
};

export interface ViewportPixelHandle {
  setModel(group: THREE.Group | null): void;
  getViewState(): PixelViewportViewState | null;
  setViewState(state: PixelViewportViewState): void;
}

interface Props {
  className?: string;
  onViewChange?: (state: PixelViewportViewState) => void;
}

export const ViewportPixel = forwardRef<ViewportPixelHandle, Props>(
  function ViewportPixel({ className, onViewChange }, ref) {
    const containerRef = useRef<HTMLDivElement>(null);
    const viewRef = useRef<PixelPerfectIsoView | null>(null);
    const sceneRef = useRef<THREE.Scene | null>(null);
    const modelRef = useRef<THREE.Group | null>(null);
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

    useImperativeHandle(ref, () => ({
      setModel: (group: THREE.Group | null) => {
        const scene = sceneRef.current;
        if (!scene) return;

        if (modelRef.current) {
          scene.remove(modelRef.current);
        }

        modelRef.current = group;
        if (group) {
          const clone = group.clone(true);
          modelRef.current = clone;
          scene.add(clone);
        }
      },
      getViewState: () => readViewState(),
      setViewState: (state: PixelViewportViewState) => {
        const view = viewRef.current;
        if (!view) {
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

      // Match settings from existing experiments (pixel-stable-moving-mesh)
      const CAMERA_PITCH = THREE.MathUtils.degToRad(30);
      const CAMERA_YAW = THREE.MathUtils.degToRad(45);

      const view = new PixelPerfectIsoView({
        mount: container,
        width,
        height,
        scene,
        fixedRenderHeight: 270,
        baseOrthoHeight: 5.966213466261495,
        cameraDistance: 30,
        cameraPitch: CAMERA_PITCH,
        cameraYaw: CAMERA_YAW,
        basePixelZoom: 2,
        zoomMin: 1,
        zoomMax: 6,
        zoomStep: 1,
        zoomAnimationRate: 14,
        zoomAnimationBurstRate: 42,
        zoomAnimationEpsilon: 0.001,
        rotationAnimationRate: 18,
        rotationAnimationEpsilon: 0.001,
        zoomBurstIdleMs: 200,
        outputOverscanLowPixels: 2,
        clearColor: 0x1a1a2e,
      });
      viewRef.current = view;

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
