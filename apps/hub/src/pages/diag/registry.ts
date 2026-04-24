import type { DiagSceneModule } from "./types";

type Loader = () => Promise<DiagSceneModule>;

const LOADERS: Record<string, Loader> = {
  "align-zoom-1": () => import("./scenes/align-zoom").then((m) => m.alignZoom1),
  "align-zoom-2": () => import("./scenes/align-zoom").then((m) => m.alignZoom2),
  "align-zoom-3": () => import("./scenes/align-zoom").then((m) => m.alignZoom3),
  "align-zoom-4": () => import("./scenes/align-zoom").then((m) => m.alignZoom4),
  "align-zoom-8": () => import("./scenes/align-zoom").then((m) => m.alignZoom8),
  "align-zoom-fractional": () =>
    import("./scenes/align-zoom").then((m) => m.alignZoomFractional),

  "rotate-0": () => import("./scenes/camera-pose").then((m) => m.rotate0),
  "rotate-90": () => import("./scenes/camera-pose").then((m) => m.rotate90),
  "rotate-180": () => import("./scenes/camera-pose").then((m) => m.rotate180),
  "rotate-270": () => import("./scenes/camera-pose").then((m) => m.rotate270),
  "pan-baseline": () => import("./scenes/camera-pose").then((m) => m.panBaseline),
  "pan-remainder-carry": () =>
    import("./scenes/camera-pose").then((m) => m.panRemainderCarry),
  "pan-carry-match": () => import("./scenes/camera-pose").then((m) => m.panCarryMatch),
  "cursor-zoom-roundtrip": () =>
    import("./scenes/camera-pose").then((m) => m.cursorZoomRoundtrip),

  "outline-same-group": () =>
    import("./scenes/outline").then((m) => m.outlineSameGroup),
  "outline-cross-group": () =>
    import("./scenes/outline").then((m) => m.outlineCrossGroup),
  "outline-debug-edges": () =>
    import("./scenes/outline").then((m) => m.outlineDebugEdges),
  "outline-debug-depth": () =>
    import("./scenes/outline").then((m) => m.outlineDebugDepth),
  "outline-debug-normals": () =>
    import("./scenes/outline").then((m) => m.outlineDebugNormals),
  "outline-debug-ids": () => import("./scenes/outline").then((m) => m.outlineDebugIds),
  "outline-debug-final": () =>
    import("./scenes/outline").then((m) => m.outlineDebugFinal),

  "stage-broadcast-quad": () =>
    import("./scenes/stage-scenes").then((m) => m.stageBroadcastQuad),
  "stage-partial-offscreen": () =>
    import("./scenes/stage-scenes").then((m) => m.stagePartialOffscreen),

  "default-game-view-outlined": () =>
    import("./scenes/default-game-view").then((m) => m.defaultGameViewOutlined),
  "default-game-view-plain": () =>
    import("./scenes/default-game-view").then((m) => m.defaultGameViewPlain),

  "consumer-prop-preview": () =>
    import("./scenes/consumer-surfaces").then((m) => m.consumerPropPreview),
  "consumer-mixed-stage": () =>
    import("./scenes/consumer-surfaces").then((m) => m.consumerMixedStage),

  invariants: () => import("./scenes/internal-state").then((m) => m.invariants)
};

export const diagSceneSlugs: readonly string[] = Object.freeze(Object.keys(LOADERS));

export async function loadDiagScene(slug: string): Promise<DiagSceneModule | null> {
  const loader = LOADERS[slug];
  if (!loader) return null;
  return loader();
}
