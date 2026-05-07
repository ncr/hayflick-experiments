import * as THREE from "three";
import {
  PixelPerfectPane,
  PROP_PREVIEW_FRAMING,
  SharedScissorStage,
  addStandardGameLighting
} from "@common/render";
import type { DiagHandle, DiagSceneContext, DiagSceneModule } from "../types";

function addLayeredMesh(root: THREE.Scene, mesh: THREE.Mesh, layer: number): THREE.Mesh {
  mesh.layers.set(layer);
  root.add(mesh);
  return mesh;
}

function buildConsumerPreviewScene(): THREE.Scene {
  const scene = new THREE.Scene();

  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(3.2, 3.2),
    new THREE.MeshStandardMaterial({ color: 0x556655, roughness: 0.9 })
  );
  floor.rotation.x = -Math.PI / 2;
  scene.add(floor);

  const body = new THREE.Mesh(
    new THREE.BoxGeometry(0.9, 1.4, 0.65),
    new THREE.MeshStandardMaterial({ color: 0xc46f35, roughness: 0.55 })
  );
  body.position.set(0, 0.7, 0);
  scene.add(body);

  const accent = new THREE.Mesh(
    new THREE.BoxGeometry(0.28, 0.28, 0.72),
    new THREE.MeshStandardMaterial({ color: 0x66b7d7, roughness: 0.35 })
  );
  accent.position.set(0.22, 1.2, -0.02);
  scene.add(accent);

  return scene;
}

export const consumerPropPreview: DiagSceneModule = {
  init(ctx: DiagSceneContext) {
    const scene = buildConsumerPreviewScene();

    // Tool view — uses PixelPerfectPane (configurable scale) since the
    // prop preview framing intentionally deviates from the locked iso
    // contract used by the game's IsoGameView.
    const stage = new SharedScissorStage({
      mount: ctx.mount,
      width: ctx.width,
      height: ctx.height,
      pixelRatio: Math.max(1, window.devicePixelRatio || 1),
      antialias: false,
      clearColor: 0x203047,
      clearAlpha: 1
    });

    const lighting = addStandardGameLighting(scene, {
      ambient: 1.0,
      keyColor: 0xffffff,
      keyDirection: [3, 5, 2],
      fillColor: 0x8899bb,
      fillIntensity: 0.8,
      fillDirection: [-2, 3, -1],
      hemisphere: false
    });

    const pane = new PixelPerfectPane({
      stage,
      id: "prop-preview",
      element: ctx.mount,
      scene,
      width: ctx.width,
      height: ctx.height,
      ...PROP_PREVIEW_FRAMING,
      baseOrthoHeight: PROP_PREVIEW_FRAMING.baseOrthoHeight * 1.2,
      cameraPitch: "iso-2to1",
      cameraYaw: Math.PI / 4,
      outlines: false
    });

    pane.setViewPose({ targetX: 0, targetZ: 0, yawIndex: 0, zoom: 1 });

    const handle: DiagHandle = {
      forceFrame(n = 2) {
        const now = performance.now();
        for (let i = 0; i < n; i += 1) {
          stage.drawFrame(now + i * 16, 0);
        }
      },
      getLowResSize() {
        const s = pane.getState();
        return { width: s.lowRenderWidth, height: s.lowRenderHeight };
      },
      getRenderScale() {
        return pane.getState().controllerRenderScale;
      },
      getPose() {
        return pane.getViewPose();
      }
    };

    window.__diag = handle;
    handle.forceFrame(3);
    ctx.mount.setAttribute("data-render-ready", "1");

    return () => {
      delete window.__diag;
      ctx.mount.removeAttribute("data-render-ready");
      lighting.remove();
      stage.dispose();
    };
  }
};

export const consumerMixedStage: DiagSceneModule = {
  init(ctx: DiagSceneContext) {
    const scene = new THREE.Scene();
    const leftEl = document.createElement("div");
    leftEl.style.cssText = "position:absolute;left:0;top:0;width:50%;height:100%;pointer-events:none;";
    ctx.mount.appendChild(leftEl);

    const rightEl = document.createElement("div");
    rightEl.style.cssText = "position:absolute;right:0;top:0;width:50%;height:100%;pointer-events:none;";
    ctx.mount.appendChild(rightEl);

    const stage = new SharedScissorStage({
      mount: ctx.mount,
      width: ctx.width,
      height: ctx.height,
      pixelRatio: Math.max(1, window.devicePixelRatio || 1),
      antialias: false,
      clearColor: 0x111820,
      clearAlpha: 1,
      shadows: true
    });
    stage.renderer.outputColorSpace = THREE.SRGBColorSpace;

    const floor = new THREE.Mesh(
      new THREE.PlaneGeometry(7, 7),
      new THREE.MeshBasicMaterial({ color: 0x263342 })
    );
    floor.rotation.x = -Math.PI / 2;
    scene.add(floor);

    addLayeredMesh(
      scene,
      new THREE.Mesh(
        new THREE.BoxGeometry(1.0, 0.18, 1.0),
        new THREE.MeshBasicMaterial({ color: 0x2da77a })
      ),
      1
    ).position.set(-0.9, 0.09, 0);

    const previewBlock = addLayeredMesh(
      scene,
      new THREE.Mesh(
        new THREE.BoxGeometry(1.1, 1.1, 1.1),
        new THREE.MeshStandardMaterial({ color: 0xb65c44, roughness: 0.6 })
      ),
      2
    );
    previewBlock.position.set(0.8, 0.55, 0);
    previewBlock.castShadow = true;
    previewBlock.receiveShadow = true;

    const editorLight = new THREE.AmbientLight(0xffffff, 1.8);
    editorLight.layers.set(1);
    scene.add(editorLight);

    const previewAmbient = new THREE.AmbientLight(0xffffff, 0.35);
    previewAmbient.layers.set(2);
    scene.add(previewAmbient);
    const previewKey = new THREE.DirectionalLight(0xfff1d6, 1.9);
    previewKey.position.set(3, 5, 2);
    previewKey.layers.set(2);
    scene.add(previewKey);

    const leftPane = new PixelPerfectPane({
      stage,
      id: "consumer-editor",
      element: leftEl,
      scene,
      width: Math.floor(ctx.width / 2),
      height: ctx.height,
      fixedRenderHeight: 240,
      baseOrthoHeight: 5,
      cameraDistance: 30,
      cameraPitch: "top-down",
      cameraYaw: 0,
      basePixelZoom: 2,
      clearColor: 0x16212a,
      layers: [1],
      toneMapping: "none"
    });

    const rightPane = new PixelPerfectPane({
      stage,
      id: "consumer-preview",
      element: rightEl,
      scene,
      width: Math.floor(ctx.width / 2),
      height: ctx.height,
      fixedRenderHeight: 240,
      baseOrthoHeight: 5,
      cameraDistance: 30,
      cameraPitch: "iso-2to1",
      cameraYaw: Math.PI / 4,
      basePixelZoom: 2,
      clearColor: 0x14181e,
      lowTargetSamples: 0,
      layers: [2],
      toneMapping: "aces",
      shadows: true,
      outlines: true,
      outlineGroups: { default: "preview" }
    });

    leftPane.setViewPose({ targetX: 0, targetZ: 0, yawIndex: 0, zoom: 2 });
    rightPane.setViewPose({ targetX: 0, targetZ: 0, yawIndex: 0, zoom: 2 });

    const handle: DiagHandle = {
      forceFrame(n = 2) {
        const now = performance.now();
        for (let i = 0; i < n; i += 1) {
          stage.drawFrame(now + i * 16, 0);
        }
      },
      getLowResSize() {
        const s = rightPane.getState();
        return { width: s.lowRenderWidth, height: s.lowRenderHeight };
      },
      getRenderScale() {
        return rightPane.getState().controllerRenderScale;
      },
      getPose() {
        return rightPane.getViewPose();
      }
    };

    window.__diag = handle;
    handle.forceFrame(3);
    ctx.mount.setAttribute("data-render-ready", "1");

    return () => {
      delete window.__diag;
      ctx.mount.removeAttribute("data-render-ready");
      stage.dispose();
      leftEl.remove();
      rightEl.remove();
    };
  }
};
