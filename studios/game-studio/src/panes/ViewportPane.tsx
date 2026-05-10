import { useEffect, useRef } from "react";
import * as THREE from "three";
import {
  KeyboardTracker,
  World,
  frame,
  type DebugSink,
  type GameInstance,
  type GameModule,
  type KnobRegistry
} from "@common/gameplay";
import { IsoGameView } from "@common/render";
import { startRafLoop } from "../runtime/tick";

type Props = {
  game: GameModule<THREE.Object3D>;
  knobs: KnobRegistry;
  debug: DebugSink;
  onWorld?: (world: World) => void;
};

export function ViewportPane({ game, knobs, debug, onWorld }: Props) {
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
      shadows: false,
      outlines: false,
      lighting: true
    });
    cleanups.push(() => view.dispose());

    const resizeObserver = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const { width: w, height: h } = entry.contentRect;
        if (w > 0 && h > 0) view.resize(w, h);
      }
    });
    resizeObserver.observe(mount);
    cleanups.push(() => resizeObserver.disconnect());

    const world = new World();
    onWorld?.(world);

    const rootNode = new THREE.Group();
    scene.add(rootNode);

    const keyboard = new KeyboardTracker(window);
    cleanups.push(() => keyboard.dispose(window));

    let instanceRef: GameInstance | null = null;

    Promise.resolve(
      game.create({
        rootNode,
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
  }, [game, knobs, debug, onWorld]);

  return <div className="game-studio-viewport-mount" ref={mountRef} />;
}
