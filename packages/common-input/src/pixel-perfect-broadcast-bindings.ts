import type { PixelPerfectPane, SharedScissorStage } from "@common/render";
import { attachTouchGestures } from "./touch-gestures";

/**
 * Options for {@link bindPixelPerfectPaneBroadcast}.
 *
 * Use this when you want *every* pane under a `SharedScissorStage` to react
 * to every input event (e.g. the primitive-views demo that keeps four cameras
 * in lockstep). For *focus-based* routing — each pointer event targets only
 * the pane under the cursor — use `bindSharedScissorStageInput` instead.
 */
export type PixelPerfectPaneBroadcastOptions = {
  stage: SharedScissorStage;
  panes: readonly PixelPerfectPane[];
  /** Where to attach pointer + wheel listeners. Defaults to `stage.canvas`. */
  pointerTarget?: HTMLElement;
  /** Where to attach keyboard listeners. Defaults to `window`. */
  keyboardTarget?: Window;
  /** Default: `true`. */
  enableKeyboard?: boolean;
  /** Default: `true`. */
  enableTouch?: boolean;
};

const TRACKPAD_ZOOM_STEP_THRESHOLD = 30;
const TRACKPAD_ZOOM_IDLE_RESET_MS = 300;
const TOUCH_PINCH_LOG2_THRESHOLD = 0.4;

function isLikelyTrackpadWheel(
  event: Pick<WheelEvent, "deltaMode" | "deltaX" | "deltaY">
): boolean {
  if (event.deltaMode !== WheelEvent.DOM_DELTA_PIXEL) return false;
  if (Math.abs(event.deltaX) > 0.01) return true;
  return Math.abs(event.deltaY) < 24;
}

function isTypingTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el) return false;
  const tag = el.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  return !!el.isContentEditable;
}

function drainZoomAccumulator(
  accum: number,
  threshold: number,
  fire: (direction: -1 | 1) => void
): number {
  while (Math.abs(accum) >= threshold) {
    const dir: -1 | 1 = accum > 0 ? -1 : 1;
    fire(dir);
    accum += dir * threshold;
  }
  return accum;
}

/**
 * Attach pan/zoom/rotate input to a {@link SharedScissorStage} such that
 * every pane receives every event. Handy for quad-view demos where all
 * cameras share the same pose.
 *
 * Returns a cleanup function that removes all listeners.
 */
export function bindPixelPerfectPaneBroadcast(
  options: PixelPerfectPaneBroadcastOptions
): () => void {
  const stage = options.stage;
  const panes = options.panes;
  const pointerTarget = options.pointerTarget ?? stage.canvas;
  const keyboardTarget = options.keyboardTarget ?? window;
  const enableKeyboard = options.enableKeyboard ?? true;
  const enableTouch = options.enableTouch ?? true;

  let dragPointerId: number | null = null;
  let wheelZoomAccum = 0;
  let wheelZoomLastMs = 0;
  let pinchLog2Accum = 0;

  const broadcastPan = (dx: number, dy: number): void => {
    for (const p of panes) p.panByCss(dx, dy);
  };
  const broadcastZoom = (
    direction: -1 | 1,
    localX: number,
    localY: number,
    now: number
  ): void => {
    for (const p of panes) p.stepCameraZoomAtLocalCss(direction, localX, localY, now);
  };
  const broadcastRotate = (delta: -1 | 1): void => {
    for (const p of panes) p.rotateQuarterTurns(delta);
  };

  const beginDrag = (paneId: string, localX: number, localY: number): boolean => {
    const pane = panes.find((p) => p.id === paneId);
    if (!pane) return false;
    pane.beginPanDrag(localX, localY);
    return true;
  };

  const onPointerDown = (event: PointerEvent): void => {
    if (event.button !== 1) return;
    const hit = stage.hitTestPane(event.clientX, event.clientY);
    if (!hit) return;
    if (!beginDrag(hit.paneId, hit.localX, hit.localY)) return;
    dragPointerId = event.pointerId;
    try {
      pointerTarget.setPointerCapture(event.pointerId);
    } catch {
      // no-op
    }
    event.preventDefault();
  };

  const onPointerMove = (event: PointerEvent): void => {
    if (dragPointerId == null || event.pointerId !== dragPointerId) return;
    const hit = stage.hitTestPane(event.clientX, event.clientY);
    if (!hit) return;
    const anchor = panes.find((p) => p.id === hit.paneId);
    if (!anchor) return;
    // Drive the drag pane's delta; broadcast the resulting CSS delta to peers.
    const prevX = (anchor as unknown as { lastClientX?: number }).lastClientX ?? hit.localX;
    const prevY = (anchor as unknown as { lastClientY?: number }).lastClientY ?? hit.localY;
    const didUpdate = anchor.updatePanDrag(hit.localX, hit.localY);
    if (didUpdate) {
      const dx = hit.localX - prevX;
      const dy = hit.localY - prevY;
      for (const p of panes) {
        if (p === anchor) continue;
        p.panByCss(dx, dy);
      }
      event.preventDefault();
    }
  };

  const onPointerUp = (event: PointerEvent): void => {
    if (dragPointerId == null || event.pointerId !== dragPointerId) return;
    dragPointerId = null;
    let consumed = false;
    for (const p of panes) {
      consumed = p.endPanDrag() || consumed;
    }
    if (pointerTarget.hasPointerCapture(event.pointerId)) {
      try {
        pointerTarget.releasePointerCapture(event.pointerId);
      } catch {
        // no-op
      }
    }
    if (consumed) event.preventDefault();
  };

  const onAuxClick = (event: MouseEvent): void => {
    if (event.button === 1) event.preventDefault();
  };

  const onWheel = (event: WheelEvent): void => {
    const hit = stage.hitTestPane(event.clientX, event.clientY);
    if (!hit) return;

    const scale = event.deltaMode === WheelEvent.DOM_DELTA_LINE ? 16 : 1;
    const trackpad = isLikelyTrackpadWheel(event);
    const zoomIntent = event.ctrlKey || event.metaKey || !trackpad;

    if (!zoomIntent) {
      const panX = -(event.deltaX + (event.shiftKey ? event.deltaY : 0)) * scale;
      const panY = -event.deltaY * scale;
      broadcastPan(panX, panY);
      event.preventDefault();
      return;
    }

    if (event.deltaY === 0) return;

    if (!trackpad) {
      const direction = (event.deltaY > 0 ? -1 : 1) as -1 | 1;
      broadcastZoom(direction, hit.localX, hit.localY, performance.now());
    } else {
      const now = performance.now();
      if (now - wheelZoomLastMs > TRACKPAD_ZOOM_IDLE_RESET_MS) {
        wheelZoomAccum = 0;
      }
      wheelZoomLastMs = now;
      wheelZoomAccum += event.deltaY * scale;
      const lx = hit.localX;
      const ly = hit.localY;
      wheelZoomAccum = drainZoomAccumulator(
        wheelZoomAccum,
        TRACKPAD_ZOOM_STEP_THRESHOLD,
        (dir) => broadcastZoom(dir, lx, ly, now)
      );
    }
    event.preventDefault();
  };

  const onKeyDown = (event: KeyboardEvent): void => {
    if (isTypingTarget(event.target)) return;
    if (event.code === "KeyQ") {
      broadcastRotate(-1);
      event.preventDefault();
      return;
    }
    if (event.code === "KeyE") {
      broadcastRotate(1);
      event.preventDefault();
      return;
    }
    if (event.code === "KeyZ" && !event.ctrlKey && !event.metaKey && !event.shiftKey) {
      for (const p of panes) p.toggleZoomMode();
      event.preventDefault();
    }
  };

  pointerTarget.addEventListener("pointerdown", onPointerDown);
  pointerTarget.addEventListener("pointermove", onPointerMove);
  pointerTarget.addEventListener("pointerup", onPointerUp);
  pointerTarget.addEventListener("pointercancel", onPointerUp);
  pointerTarget.addEventListener("auxclick", onAuxClick);
  pointerTarget.addEventListener("wheel", onWheel, { passive: false });

  if (enableKeyboard) {
    keyboardTarget.addEventListener("keydown", onKeyDown);
  }

  const detachTouch = enableTouch
    ? attachTouchGestures(pointerTarget, {
        onPan: (dx, dy) => broadcastPan(dx, dy),
        onPinch: (scaleDelta, centerX, centerY) => {
          if (Math.abs(scaleDelta - 1) < 0.005) return;
          pinchLog2Accum += Math.log2(scaleDelta);
          const hit = stage.hitTestPane(centerX, centerY);
          const now = performance.now();
          const localX = hit?.localX ?? centerX;
          const localY = hit?.localY ?? centerY;
          while (pinchLog2Accum >= TOUCH_PINCH_LOG2_THRESHOLD) {
            broadcastZoom(1, localX, localY, now);
            pinchLog2Accum -= TOUCH_PINCH_LOG2_THRESHOLD;
          }
          while (pinchLog2Accum <= -TOUCH_PINCH_LOG2_THRESHOLD) {
            broadcastZoom(-1, localX, localY, now);
            pinchLog2Accum += TOUCH_PINCH_LOG2_THRESHOLD;
          }
        },
        onPinchEnd: () => {
          pinchLog2Accum = 0;
        },
        onRotate: (direction) => broadcastRotate(direction)
      })
    : () => {};

  return () => {
    detachTouch();
    pointerTarget.removeEventListener("pointerdown", onPointerDown);
    pointerTarget.removeEventListener("pointermove", onPointerMove);
    pointerTarget.removeEventListener("pointerup", onPointerUp);
    pointerTarget.removeEventListener("pointercancel", onPointerUp);
    pointerTarget.removeEventListener("auxclick", onAuxClick);
    pointerTarget.removeEventListener("wheel", onWheel);
    if (enableKeyboard) {
      keyboardTarget.removeEventListener("keydown", onKeyDown);
    }
  };
}
