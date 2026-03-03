import type { Viewport3dViewState } from "../forge/Viewport";
import type { ForgeScissorViewportHandle } from "./ScissorViewport3d";

type ViewportSyncHandle = Pick<ForgeScissorViewportHandle, "setViewState"> | null | undefined;

export function syncViewStateToViewports(
  state: Viewport3dViewState,
  viewports: Iterable<ViewportSyncHandle>
): void {
  for (const viewport of viewports) {
    viewport?.setViewState(state);
  }
}

