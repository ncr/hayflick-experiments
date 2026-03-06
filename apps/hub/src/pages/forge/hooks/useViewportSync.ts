import { useCallback } from "react";
import type { Viewport3dViewState } from "../../forge-core/Viewport";
import type { PixelViewportViewState } from "../../forge-core/ViewportPixel";
import { useForgeRefs } from "../state/forge-context";

const PIXEL_BASE_YAW = Math.PI / 4; // 45deg
const QUARTER_TURN_RADIANS = Math.PI * 0.5;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function wrapQuarterTurns(value: number): number {
  const rounded = Math.round(value);
  const wrapped = rounded % 4;
  return wrapped < 0 ? wrapped + 4 : wrapped;
}

export function useViewportSync() {
  const refs = useForgeRefs();

  const syncPixelFromMesh = useCallback((meshState: Viewport3dViewState) => {
    const currentPixel = refs.generationPixelBaseViewState.current;
    if (refs.zoomSyncScale.current === null) {
      refs.zoomSyncScale.current = meshState.distance * Math.max(1, currentPixel.zoom);
    }
    const zoomScale = refs.zoomSyncScale.current;
    const desiredZoom = Math.round(clamp(zoomScale / Math.max(meshState.distance, 1e-3), 1, 6));
    const desiredYawTurns = wrapQuarterTurns((meshState.yaw - PIXEL_BASE_YAW) / QUARTER_TURN_RADIANS);
    const desired: PixelViewportViewState = {
      target: [meshState.target[0], 0, meshState.target[2]],
      yawTurns: desiredYawTurns,
      zoom: desiredZoom,
    };
    refs.meshToPixelSyncLock.current = true;
    refs.generationPixelBaseViewState.current = desired;
    setTimeout(() => {
      refs.meshToPixelSyncLock.current = false;
    }, 0);
    return desired;
  }, [refs]);

  const syncMeshFromPixel = useCallback((pixelState: PixelViewportViewState) => {
    const meshViewport = refs.generationViewport.current;
    if (!meshViewport) return;
    const currentMeshState = meshViewport.getViewState();
    if (!currentMeshState) return;
    if (refs.zoomSyncScale.current === null) {
      refs.zoomSyncScale.current = currentMeshState.distance * Math.max(1, pixelState.zoom);
    }
    const desiredDistance = clamp(
      refs.zoomSyncScale.current / Math.max(pixelState.zoom, 1),
      0.1,
      200
    );
    const desiredYaw = PIXEL_BASE_YAW + wrapQuarterTurns(pixelState.yawTurns) * QUARTER_TURN_RADIANS;
    const desiredState: Viewport3dViewState = {
      target: [pixelState.target[0], currentMeshState.target[1], pixelState.target[2]],
      distance: desiredDistance,
      yaw: desiredYaw,
      pitch: currentMeshState.pitch,
    };
    refs.pixelToMeshSyncLock.current = true;
    meshViewport.setViewState(desiredState);
    setTimeout(() => {
      refs.pixelToMeshSyncLock.current = false;
    }, 0);
  }, [refs]);

  const handleMeshViewChange = useCallback((state: Viewport3dViewState) => {
    refs.generationMeshViewState.current = state;
    if (refs.pixelToMeshSyncLock.current) return;
    return syncPixelFromMesh(state);
  }, [refs, syncPixelFromMesh]);

  const handlePixelBaseViewChange = useCallback((state: PixelViewportViewState) => {
    refs.generationPixelBaseViewState.current = state;
    if (refs.meshToPixelSyncLock.current) return;
    syncMeshFromPixel(state);
  }, [refs, syncMeshFromPixel]);

  return {
    syncPixelFromMesh,
    syncMeshFromPixel,
    handleMeshViewChange,
    handlePixelBaseViewChange,
  };
}
