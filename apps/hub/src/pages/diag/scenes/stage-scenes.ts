import {
  PixelPerfectPane,
  SharedScissorStage,
  type PixelView as PixelViewMode
} from "@common/render";
import { buildAlignmentScene } from "../shared/alignment-scene";
import type { DiagHandle, DiagSceneContext, DiagSceneModule } from "../types";

type PaneSpec = {
  id: string;
  cameraPitch: PixelViewMode;
  cameraYaw: number;
  left: string;
  top: string;
};

const QUAD_PANES: PaneSpec[] = [
  { id: "top-left", cameraPitch: "top-down", cameraYaw: 0, left: "0%", top: "0%" },
  { id: "top-right", cameraPitch: "iso-2to1", cameraYaw: Math.PI / 4, left: "50%", top: "0%" },
  { id: "bottom-left", cameraPitch: "side", cameraYaw: 0, left: "0%", top: "50%" },
  { id: "bottom-right", cameraPitch: "side", cameraYaw: Math.PI / 2, left: "50%", top: "50%" }
];

function createPaneDiv(parent: HTMLElement, spec: PaneSpec, size: string): HTMLDivElement {
  const el = document.createElement("div");
  el.style.position = "absolute";
  el.style.left = spec.left;
  el.style.top = spec.top;
  el.style.width = size;
  el.style.height = size;
  el.style.boxSizing = "border-box";
  el.style.pointerEvents = "none";
  parent.appendChild(el);
  return el;
}

function createStageBroadcastQuad(ctx: DiagSceneContext): () => void {
  const scene = buildAlignmentScene();
  const stage = new SharedScissorStage({
    mount: ctx.mount,
    width: ctx.width,
    height: ctx.height,
    pixelRatio: Math.max(1, window.devicePixelRatio || 1),
    antialias: false,
    clearColor: 0x0b0f14,
    clearAlpha: 1
  });

  const panes: PixelPerfectPane[] = [];
  for (const spec of QUAD_PANES) {
    const el = createPaneDiv(ctx.mount, spec, "50%");
    const pane = new PixelPerfectPane({
      stage,
      id: spec.id,
      element: el,
      scene,
      width: Math.floor(ctx.width / 2),
      height: Math.floor(ctx.height / 2),
      cameraPitch: spec.cameraPitch,
      cameraYaw: spec.cameraYaw,
      baseOrthoHeight: 6,
      cameraDistance: 30,
      zoomMax: 6
    });
    panes.push(pane);
  }

  // Apply a shared pan so panes visibly disagree if broadcast sync breaks.
  for (const pane of panes) {
    pane.setViewPose({ targetX: 0, targetZ: 0, yawIndex: 0, zoom: 2 });
    pane.panByCss(24, 12);
  }

  const handle: DiagHandle = {
    forceFrame(n = 2) {
      const now = performance.now();
      for (let i = 0; i < n; i += 1) {
        stage.drawFrame(now + i * 16, 0);
      }
    },
    getLowResSize() {
      if (panes.length === 0) return null;
      const s = panes[0].getState();
      return { width: s.lowRenderWidth, height: s.lowRenderHeight };
    },
    getRenderScale() {
      if (panes.length === 0) return null;
      return panes[0].getState().controllerRenderScale;
    },
    getPose() {
      if (panes.length === 0) return null;
      return panes[0].getViewPose();
    }
  };
  window.__diag = handle;
  handle.forceFrame(3);
  ctx.mount.setAttribute("data-render-ready", "1");

  return () => {
    delete window.__diag;
    ctx.mount.removeAttribute("data-render-ready");
    stage.dispose();
  };
}

function createStagePartialOffscreen(ctx: DiagSceneContext): () => void {
  const scene = buildAlignmentScene();
  const stage = new SharedScissorStage({
    mount: ctx.mount,
    width: ctx.width,
    height: ctx.height,
    pixelRatio: Math.max(1, window.devicePixelRatio || 1),
    antialias: false,
    clearColor: 0x0b0f14,
    clearAlpha: 1
  });

  // One pane deliberately offset so its right edge extends beyond the mount.
  // The scissor clip should crop, not squeeze — content inside the clipped
  // rect must match content at the same position when the pane was on-screen.
  const paneEl = document.createElement("div");
  paneEl.style.position = "absolute";
  paneEl.style.left = `${Math.floor(ctx.width * 0.35)}px`;
  paneEl.style.top = `${Math.floor(ctx.height * 0.15)}px`;
  paneEl.style.width = `${Math.floor(ctx.width * 0.8)}px`;
  paneEl.style.height = `${Math.floor(ctx.height * 0.7)}px`;
  paneEl.style.pointerEvents = "none";
  ctx.mount.appendChild(paneEl);

  const pane = new PixelPerfectPane({
    stage,
    id: "offscreen-pane",
    element: paneEl,
    scene,
    width: Math.floor(ctx.width * 0.8),
    height: Math.floor(ctx.height * 0.7),
    cameraPitch: "iso-2to1",
    cameraYaw: Math.PI / 4,
    baseOrthoHeight: 6,
    cameraDistance: 30,
    zoomMax: 6
  });

  pane.setViewPose({ targetX: 0, targetZ: 0, yawIndex: 0, zoom: 2 });

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
    stage.dispose();
  };
}

export const stageBroadcastQuad: DiagSceneModule = {
  init: (ctx) => createStageBroadcastQuad(ctx)
};

export const stagePartialOffscreen: DiagSceneModule = {
  init: (ctx) => createStagePartialOffscreen(ctx)
};
