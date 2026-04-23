import { IsoGameView } from "@common/render";
import { buildAlignmentScene } from "../shared/alignment-scene";
import type { DiagHandle, DiagSceneContext, DiagSceneModule } from "../types";

type PoseVariant = {
  slug: string;
  yawIndex: number;
  zoom: number;
  setup?: (view: IsoGameView, ctx: DiagSceneContext) => void;
};

const VARIANTS: Record<string, PoseVariant> = {
  "rotate-0": { slug: "rotate-0", yawIndex: 0, zoom: 2 },
  "rotate-90": { slug: "rotate-90", yawIndex: 1, zoom: 2 },
  "rotate-180": { slug: "rotate-180", yawIndex: 2, zoom: 2 },
  "rotate-270": { slug: "rotate-270", yawIndex: 3, zoom: 2 },
  "pan-baseline": {
    slug: "pan-baseline",
    yawIndex: 0,
    zoom: 2
  },
  "pan-remainder-carry": {
    slug: "pan-remainder-carry",
    yawIndex: 0,
    zoom: 2,
    setup: (view) => {
      // Three sub-pixel pans that sum to exactly 1 CSS pixel. With the carry
      // remainder invariant the final camera position must equal a single
      // 1-pixel pan (see pan-carry-match pair).
      view.panByCss(0.3, 0);
      view.panByCss(0.3, 0);
      view.panByCss(0.4, 0);
    }
  },
  "pan-carry-match": {
    slug: "pan-carry-match",
    yawIndex: 0,
    zoom: 2,
    setup: (view) => {
      view.panByCss(1.0, 0);
    }
  },
  "cursor-zoom-roundtrip": {
    slug: "cursor-zoom-roundtrip",
    yawIndex: 0,
    zoom: 2,
    setup: (view, ctx) => {
      // Zoom at a non-center cursor, then zoom back out. The pose-preserving
      // invariant says the final output should match the initial pose-at-zoom-2
      // baseline (pixel-identical).
      const cx = Math.floor(ctx.width * 0.5) + 37;
      const cy = Math.floor(ctx.height * 0.5) + 23;
      const now = performance.now();
      view.zoomStepAtClient(1, cx, cy, now);
      view.zoomStepAtClient(1, cx, cy, now + 16);
      view.zoomStepAtClient(-1, cx, cy, now + 32);
      view.zoomStepAtClient(-1, cx, cy, now + 48);
    }
  }
};

function createModule(defaultSlug: string): DiagSceneModule {
  return {
    init(ctx: DiagSceneContext) {
      const variant = VARIANTS[ctx.slug] ?? VARIANTS[defaultSlug];
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

      view.setViewPose({ targetX: 0, targetZ: 0, yawIndex: variant.yawIndex, zoom: variant.zoom });

      // Drive setup after pose is established so pan-carry / cursor-zoom test
      // operates from the known baseline.
      variant.setup?.(view, ctx);

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

      // Tick enough frames to consume any pending animations (yaw snaps, zoom
      // snaps, carried pan remainder).
      const now = performance.now();
      for (let i = 0; i < 8; i += 1) {
        view.frame(now + i * 16, 0.016);
      }
      // One final zero-dt frame to freeze on the settled state.
      view.frame(now + 200, 0);
      ctx.mount.setAttribute("data-render-ready", "1");

      return () => {
        delete window.__diag;
        ctx.mount.removeAttribute("data-render-ready");
        view.dispose();
      };
    }
  };
}

export const rotate0 = createModule("rotate-0");
export const rotate90 = createModule("rotate-90");
export const rotate180 = createModule("rotate-180");
export const rotate270 = createModule("rotate-270");
export const panBaseline = createModule("pan-baseline");
export const panRemainderCarry = createModule("pan-remainder-carry");
export const panCarryMatch = createModule("pan-carry-match");
export const cursorZoomRoundtrip = createModule("cursor-zoom-roundtrip");
