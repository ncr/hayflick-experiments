import { IsoGameView } from "@common/render";
import { buildAlignmentScene } from "../shared/alignment-scene";
import type { DiagHandle, DiagSceneContext, DiagSceneModule } from "../types";

/**
 * A single-scene diag route used by the `internal-state.spec.ts` suite.
 * It does not try to produce a pixel-exact golden — instead, each spec loads
 * this route at a forced viewport size, then asserts on `window.__diag`:
 *
 *  - low-res RT dims are always even (invariant from `pixel-perfect.ts:59-60`)
 *  - render scale = round(zoom · dpr) at integer steps
 */
export const invariants: DiagSceneModule = {
  init(ctx: DiagSceneContext) {
    const scene = buildAlignmentScene();
    const view = new IsoGameView({
      mount: ctx.mount,
      width: ctx.width,
      height: ctx.height,
      scene,
      clearColor: 0x0b0f14,
      zoomMax: 16,
      outlines: false
    });

    view.setViewPose({ targetX: 0, targetZ: 0, yawIndex: 0, zoom: 1 });

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
      },
      setPose(pose) {
        const current = view.getViewPose();
        view.setViewPose({
          targetX: pose.targetX ?? current.targetX,
          targetZ: pose.targetZ ?? current.targetZ,
          yawIndex: pose.yawIndex ?? current.yawIndex,
          zoom: pose.zoom ?? current.zoom
        });
        view.frame(performance.now(), 0);
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
