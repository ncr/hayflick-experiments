import * as THREE from "three";
import { IsoGameView, addStandardGameLighting } from "@common/render";
import type { DiagHandle, DiagSceneContext, DiagSceneModule } from "../types";

/**
 * Regression-locks the canonical one-liner: `new IsoGameView({...})` with
 * outlines default-on, lit by `addStandardGameLighting`. Any drift in the
 * preset's default numbers or in the IsoGameView defaults will fail this
 * golden image with zero pixel tolerance.
 *
 * Two slugs:
 *   default-game-view-outlined — outlines default ON (the real default)
 *   default-game-view-plain    — outlines: false (baseline for diffing)
 */
type Variant = "outlined" | "plain";

function buildScene(): THREE.Scene {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x1d2029);

  addStandardGameLighting(scene);

  // Textured floor — a low-frequency checker keeps edges sharp at integer upscale.
  const floorMat = new THREE.MeshStandardMaterial({ color: 0x4a5260, roughness: 0.85 });
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(8, 8), floorMat);
  floor.rotation.x = -Math.PI / 2;
  scene.add(floor);

  // Three colored cubes at canonical world positions — the kinds of silhouettes
  // the outline pipeline is tuned to carve. Colors are distinct across
  // luminance so normal/depth/id passes all have signal.
  const cubeGeom = new THREE.BoxGeometry(1.28, 1.28, 1.28);

  const red = new THREE.Mesh(
    cubeGeom,
    new THREE.MeshStandardMaterial({ color: 0xc0584c, roughness: 0.5 })
  );
  red.position.set(-1.28, 0.64, 0);
  scene.add(red);

  const green = new THREE.Mesh(
    cubeGeom,
    new THREE.MeshStandardMaterial({ color: 0x6fa85c, roughness: 0.5 })
  );
  green.position.set(0, 0.64, 0);
  scene.add(green);

  const blue = new THREE.Mesh(
    cubeGeom,
    new THREE.MeshStandardMaterial({ color: 0x4a78c0, roughness: 0.5 })
  );
  blue.position.set(1.28, 0.64, 0);
  scene.add(blue);

  return scene;
}

function createModule(variant: Variant): DiagSceneModule {
  return {
    init(ctx: DiagSceneContext) {
      const scene = buildScene();

      const view = new IsoGameView({
        mount: ctx.mount,
        width: ctx.width,
        height: ctx.height,
        scene,
        clearColor: 0x1d2029,
        outlines: variant === "plain" ? false : undefined
      });

      view.setViewPose({ targetX: 0, targetZ: 0, yawIndex: 0, zoom: 2 });

      const handle: DiagHandle = {
        forceFrame(n = 2) {
          const now = performance.now();
          for (let i = 0; i < n; i += 1) {
            view.frame(now + i * 16, 0);
          }
        },
        getLowResSize() {
          const s = view.getState();
          return { width: s.lowRenderWidth, height: s.lowRenderHeight };
        },
        getRenderScale() {
          return view.getState().controllerRenderScale;
        },
        getPose() {
          return view.getViewPose();
        }
      };

      window.__diag = handle;
      handle.forceFrame(3);
      ctx.mount.setAttribute("data-render-ready", "1");

      return () => {
        delete window.__diag;
        ctx.mount.removeAttribute("data-render-ready");
        view.dispose();
      };
    }
  };
}

export const defaultGameViewOutlined = createModule("outlined");
export const defaultGameViewPlain = createModule("plain");
