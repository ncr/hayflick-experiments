import { useEffect, useRef } from "react";
import * as THREE from "three";
import {
  KeyboardTracker,
  World,
  frame,
  type DebugSink,
  type GameInstance,
  type GameModule,
  type KnobRegistry,
  type Scene
} from "@common/gameplay";
import {
  IsoGameView,
  createThreeScene,
  isoCleanGeometryValidator
} from "@common/render";
import { startRafLoop } from "../runtime/tick";

export type ZoomLadderEntry = { zoom: number; texelMm: number };

export type SnapBasis = {
  centerX: number;
  centerZ: number;
  ux: number;
  uz: number;
  vx: number;
  vz: number;
};

export type ViewportController = {
  getLadder(): readonly ZoomLadderEntry[];
  getCurrentZoom(): number;
  setZoom(zoom: number): void;
  subscribe(listener: () => void): () => void;
  /**
   * Snap basis on the ground plane. Test/diagnostic surface. Returns null
   * if the camera has no valid ground basis (e.g. side mode).
   */
  getSnapBasis(): SnapBasis | null;
  /** Convert a world XZ point to (a, b) snap-cell coords. Null if no basis. */
  worldToScreenPixelCoords(x: number, z: number): { a: number; b: number } | null;
  /**
   * Project a world (x, y, z) point to canvas CSS pixel coords (relative
   * to the viewport mount). Returns null if the point is outside the
   * camera frustum.
   */
  projectWorldToCanvasPixel(
    x: number,
    y: number,
    z: number
  ): { x: number; y: number } | null;
  /** DPR multiplier used by the renderer for canvas-px ↔ device-px. */
  getDevicePixelRatio(): number;
};

type Props = {
  game: GameModule;
  knobs: KnobRegistry;
  debug: DebugSink;
  onWorld?: (world: World) => void;
  onScene?: (scene: Scene | null) => void;
  onController?: (controller: ViewportController | null) => void;
};

const DEFAULT_TEXEL_MM = 1;

export function ViewportPane({
  game,
  knobs,
  debug,
  onWorld,
  onScene,
  onController
}: Props) {
  const mountRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;

    let disposed = false;
    const cleanups: Array<() => void> = [];

    const rect = mount.getBoundingClientRect();
    const initialW = Math.max(1, Math.floor(rect.width));
    const initialH = Math.max(1, Math.floor(rect.height));

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x121419);

    const view = new IsoGameView({
      mount,
      width: initialW,
      height: initialH,
      scene,
      cameraDistance: 30,
      clearColor: 0x121419,
      shadows: true,
      outlines: true,
      lighting: true
    });
    cleanups.push(() => view.dispose());

    let currentZoom = view.pickClosestZoomForTexelMm(DEFAULT_TEXEL_MM);
    view.setZoom(currentZoom);

    let ladderCache: readonly ZoomLadderEntry[] = view
      .getZoomLadder()
      .map((zoom) => ({ zoom, texelMm: view.getTexelMmForZoom(zoom) }));

    const listeners = new Set<() => void>();
    const notify = () => {
      // Rebuild the ladder snapshot under one new identity so React's
      // useSyncExternalStore sees a stable reference between notifications.
      ladderCache = view
        .getZoomLadder()
        .map((zoom) => ({ zoom, texelMm: view.getTexelMmForZoom(zoom) }));
      for (const fn of listeners) fn();
    };

    const controller: ViewportController = {
      getLadder: () => ladderCache,
      getCurrentZoom: () => currentZoom,
      setZoom: (zoom) => {
        currentZoom = zoom;
        view.setZoom(zoom);
        notify();
      },
      subscribe: (listener) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
      getSnapBasis: () => view.getSnapBasis(),
      worldToScreenPixelCoords: (x, z) => {
        const basis = view.getSnapBasis();
        if (!basis) return null;
        const wx = x - basis.centerX;
        const wz = z - basis.centerZ;
        const det = basis.ux * basis.vz - basis.uz * basis.vx;
        if (Math.abs(det) < 1e-8) return null;
        return {
          a: (wx * basis.vz - wz * basis.vx) / det,
          b: (wz * basis.ux - wx * basis.uz) / det
        };
      },
      projectWorldToCanvasPixel: (x, y, z) => {
        const v3 = new THREE.Vector3(x, y, z);
        const out = new THREE.Vector2();
        if (!view.projectWorldToLocalCss(v3, out)) return null;
        return { x: out.x, y: out.y };
      },
      getDevicePixelRatio: () => Math.max(1, window.devicePixelRatio || 1)
    };

    onController?.(controller);
    cleanups.push(() => onController?.(null));

    const resizeObserver = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const { width: w, height: h } = entry.contentRect;
        if (w > 0 && h > 0) {
          view.resize(w, h);
          // baseRenderScale depends on canvas size, so texel-mm labels
          // shift on resize — re-emit so the radio updates.
          notify();
        }
      }
    });
    resizeObserver.observe(mount);
    cleanups.push(() => resizeObserver.disconnect());

    const world = new World();
    onWorld?.(world);

    const rootNode = new THREE.Group();
    scene.add(rootNode);

    // Pixel-stable rendering: every SceneObject.setPosition is routed
    // through the iso view's ground-plane snap. Without this, a moving
    // box's edges land on different low-res texels each frame ("texel
    // shimmer"). The vertical (y) component is preserved — only x/z are
    // quantized onto the screen pixel grid on the ground plane.
    //
    // The same view also exposes the (a, b) lattice basis the gameplay
    // input system needs to express motion in screen-pixels/sec along
    // the iso 2:1 staircase — see `createPlayerInputSystem`.
    const snapIn = new THREE.Vector3();
    const snapOut = new THREE.Vector3();
    const gameScene = createThreeScene(rootNode, {
      snapWorldToScreenPixel: (x, y, z) => {
        snapIn.set(x, y, z);
        if (view.snapWorldPointOnGround(snapIn, snapOut, "nearest")) {
          return { x: snapOut.x, y, z: snapOut.z };
        }
        return null;
      },
      getScreenPixelBasis: () => view.getSnapBasis(),
      // Renderer-side guard: every spawn-time XZ dimension must align to
      // the iso 2:1 stair grid (multiples of 0.0625 wu = 2 H + 1 V px).
      // Misaligned sizes produce visible irregular silhouette outlines
      // even though the pixel snap keeps them frame-to-frame identical.
      // Throws at construction so the bad call site is in the stack trace.
      validateGeometry: isoCleanGeometryValidator
    });
    onScene?.(gameScene);
    cleanups.push(() => onScene?.(null));

    const keyboard = new KeyboardTracker(window);
    cleanups.push(() => keyboard.dispose(window));

    let instanceRef: GameInstance | null = null;

    Promise.resolve(
      game.create({
        scene: gameScene,
        world,
        keyboard,
        debug,
        knobs,
        width: initialW,
        height: initialH
      })
    )
      .then((instance) => {
        if (disposed) {
          instance.dispose();
          return;
        }
        instanceRef = instance;

        const stop = startRafLoop((dt) => {
          frame(world, dt, instance.systems);
          instance.step?.(dt);
          view.frame(performance.now(), dt);
        });

        cleanups.push(stop);
        cleanups.push(() => instance.dispose());
      })
      .catch((cause) => {
        debug.push({
          frame: 0,
          message: `Game create failed: ${cause instanceof Error ? cause.message : String(cause)}`
        });
      });

    return () => {
      disposed = true;
      while (cleanups.length > 0) {
        const fn = cleanups.pop()!;
        try {
          fn();
        } catch {
          // Continue cleaning up remaining handles even if one throws.
        }
      }
      instanceRef = null;
    };
  }, [game, knobs, debug, onWorld, onScene, onController]);

  return <div className="game-studio-viewport-mount" ref={mountRef} />;
}
