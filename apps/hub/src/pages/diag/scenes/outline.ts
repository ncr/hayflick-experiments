import { IsoGameView } from "@common/render";
import type { EdgeDetectionDebugMode } from "@common/render";
import { buildOutlineScene } from "../shared/outline-scene";
import type { DiagHandle, DiagSceneContext, DiagSceneModule } from "../types";

type OutlineVariant = {
  slug: string;
  groupAssignments: "same" | "cross";
  debugMode: EdgeDetectionDebugMode;
};

const VARIANTS: Record<string, OutlineVariant> = {
  "outline-same-group": { slug: "outline-same-group", groupAssignments: "same", debugMode: "final" },
  "outline-cross-group": { slug: "outline-cross-group", groupAssignments: "cross", debugMode: "final" },
  "outline-debug-edges": { slug: "outline-debug-edges", groupAssignments: "cross", debugMode: "edges" },
  "outline-debug-depth": { slug: "outline-debug-depth", groupAssignments: "cross", debugMode: "depth" },
  "outline-debug-normals": { slug: "outline-debug-normals", groupAssignments: "cross", debugMode: "normals" },
  "outline-debug-ids": { slug: "outline-debug-ids", groupAssignments: "cross", debugMode: "ids" },
  "outline-debug-final": { slug: "outline-debug-final", groupAssignments: "cross", debugMode: "final" }
};

function createOutlineModule(defaultSlug: string): DiagSceneModule {
  return {
    init(ctx: DiagSceneContext) {
      const variant = VARIANTS[ctx.slug] ?? VARIANTS[defaultSlug];
      const { scene, wallLeft, wallRight, wallFar } = buildOutlineScene();

      const view = new IsoGameView({
        mount: ctx.mount,
        width: ctx.width,
        height: ctx.height,
        scene,
        clearColor: 0x0b0f14,
        outlines: true
      });
      const outline = view.outline!;
      outline.setDebugMode(variant.debugMode);

      if (variant.groupAssignments === "same") {
        outline.assignOutlineGroup(wallLeft, "wall");
        outline.assignOutlineGroup(wallRight, "wall");
        outline.assignOutlineGroup(wallFar, "wall");
      } else {
        outline.assignOutlineGroup(wallLeft, "wall");
        outline.assignOutlineGroup(wallRight, "wall");
        outline.assignOutlineGroup(wallFar, "accent");
      }

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
        },
        setPose(pose) {
          const current = view.getViewPose();
          view.setViewPose({
            targetX: pose.targetX ?? current.targetX,
            targetZ: pose.targetZ ?? current.targetZ,
            yawIndex: pose.yawIndex ?? current.yawIndex,
            zoom: pose.zoom ?? current.zoom
          });
        },
        setOutlineDebugMode(mode: string) {
          outline.setDebugMode(mode as EdgeDetectionDebugMode);
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

export const outlineSameGroup = createOutlineModule("outline-same-group");
export const outlineCrossGroup = createOutlineModule("outline-cross-group");
export const outlineDebugEdges = createOutlineModule("outline-debug-edges");
export const outlineDebugDepth = createOutlineModule("outline-debug-depth");
export const outlineDebugNormals = createOutlineModule("outline-debug-normals");
export const outlineDebugIds = createOutlineModule("outline-debug-ids");
export const outlineDebugFinal = createOutlineModule("outline-debug-final");
