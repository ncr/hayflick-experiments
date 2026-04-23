import { IsoGameView } from "@common/render";
import { buildAlignmentScene } from "../shared/alignment-scene";
import type { DiagHandle, DiagSceneContext, DiagSceneModule } from "../types";

/**
 * Zoom slug → target camera zoom. "fractional" tests the integer render-scale
 * quantization: `round(zoom * dpr)` with dpr=1 gives render-scale=2 for zoom
 * 1.5. The rendered output should therefore match zoom=2's pixel content at
 * the shared bounds.
 */
const ZOOM_BY_SLUG: Record<string, number> = {
  "align-zoom-1": 1,
  "align-zoom-2": 2,
  "align-zoom-3": 3,
  "align-zoom-4": 4,
  "align-zoom-8": 8,
  "align-zoom-fractional": 1.5
};

function createModule(defaultSlug: string): DiagSceneModule {
  return {
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

      const slug = ctx.slug in ZOOM_BY_SLUG ? ctx.slug : defaultSlug;
      view.setViewPose({
        targetX: 0,
        targetZ: 0,
        yawIndex: 0,
        zoom: ZOOM_BY_SLUG[slug] ?? 1
      });

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

export const alignZoom1: DiagSceneModule = createModule("align-zoom-1");
export const alignZoom2: DiagSceneModule = createModule("align-zoom-2");
export const alignZoom3: DiagSceneModule = createModule("align-zoom-3");
export const alignZoom4: DiagSceneModule = createModule("align-zoom-4");
export const alignZoom8: DiagSceneModule = createModule("align-zoom-8");
export const alignZoomFractional: DiagSceneModule = createModule("align-zoom-fractional");
