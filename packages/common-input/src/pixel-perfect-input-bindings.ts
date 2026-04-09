import type { PixelPerfectScissorPane } from "@common/render";
import { PixelPerfectView, SharedScissorStage } from "@common/render";
import { attachTouchGestures } from "./touch-gestures";

type KeyboardTarget = Window;

export type PixelPerfectViewInputBindingOptions = {
  view: PixelPerfectView;
  pointerTarget?: HTMLElement;
  keyboardTarget?: KeyboardTarget;
  enableTouch?: boolean;
  enableKeyboard?: boolean;
};

export type SharedScissorStageInputBindingOptions = {
  stage: SharedScissorStage;
  pointerTarget?: HTMLElement;
  keyboardTarget?: KeyboardTarget;
  enableKeyboard?: boolean;
  onFocusPaneId?: (paneId: string | null) => void;
  getFocusedPaneId?: () => string | null;
  setFocusedPaneId?: (paneId: string | null) => void;
  getPaneInputTarget: (paneId: string) => SharedScissorStagePaneInputTarget | null | undefined;
};

type SharedScissorStagePaneInputTarget = Pick<
  PixelPerfectScissorPane,
  | "element"
  | "beginPanDrag"
  | "updatePanDrag"
  | "endPanDrag"
  | "panByCss"
  | "stepCameraZoomAtLocalCss"
  | "rotateQuarterTurns"
  | "toggleZoomMode"
>;

function isLikelyTrackpadWheel(event: Pick<WheelEvent, "deltaMode" | "deltaX" | "deltaY">): boolean {
  if (event.deltaMode !== WheelEvent.DOM_DELTA_PIXEL) {
    return false;
  }
  if (Math.abs(event.deltaX) > 0.01) {
    return true;
  }
  return Math.abs(event.deltaY) < 24;
}

function isTypingTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el) return false;
  const tag = el.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  return !!el.isContentEditable;
}

/** Accumulated device-pixel delta required per zoom step for trackpad pinch. */
const TRACKPAD_ZOOM_STEP_THRESHOLD = 30;
/** Reset trackpad accumulator after this many ms of inactivity. */
const TRACKPAD_ZOOM_IDLE_RESET_MS = 300;
/** Log2 pinch ratio required per zoom step for touch gestures (~32% size change). */
const TOUCH_PINCH_LOG2_THRESHOLD = 0.4;

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

export function bindPixelPerfectViewInput(
  options: PixelPerfectViewInputBindingOptions
): () => void {
  const view = options.view;
  const pointerTarget = options.pointerTarget ?? view.canvas;
  const keyboardTarget = options.keyboardTarget ?? window;
  const enableKeyboard = options.enableKeyboard ?? true;
  const enableTouch = options.enableTouch ?? true;

  let dragPointerId: number | null = null;
  let wheelZoomAccum = 0;
  let wheelZoomLastMs = 0;
  let pinchLog2Accum = 0;

  const onPointerDown = (event: PointerEvent): void => {
    if (event.button !== 1) return;
    if (!view.beginPanDrag(event.clientX, event.clientY)) return;
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
    if (view.updatePanDrag(event.clientX, event.clientY)) {
      event.preventDefault();
    }
  };

  const onPointerUp = (event: PointerEvent): void => {
    if (dragPointerId == null || event.pointerId !== dragPointerId) return;
    dragPointerId = null;
    const consumed = view.endPanDrag();
    if (pointerTarget.hasPointerCapture(event.pointerId)) {
      try {
        pointerTarget.releasePointerCapture(event.pointerId);
      } catch {
        // no-op
      }
    }
    if (consumed) {
      event.preventDefault();
    }
  };

  const onAuxClick = (event: MouseEvent): void => {
    if (event.button === 1) {
      event.preventDefault();
    }
  };

  const onWheel = (event: WheelEvent): void => {
    const scale = event.deltaMode === WheelEvent.DOM_DELTA_LINE ? 16 : 1;
    const trackpad = isLikelyTrackpadWheel(event);
    const zoomIntent = event.ctrlKey || event.metaKey || !trackpad;

    if (!zoomIntent) {
      const panX = -(event.deltaX + (event.shiftKey ? event.deltaY : 0)) * scale;
      const panY = -event.deltaY * scale;
      view.panByCss(panX, panY);
      event.preventDefault();
      return;
    }

    if (event.deltaY === 0) {
      return;
    }

    if (!trackpad) {
      // Discrete mouse wheel: one step per notch
      const direction = (event.deltaY > 0 ? -1 : 1) as -1 | 1;
      view.zoomStepAtClient(direction, event.clientX, event.clientY, performance.now());
    } else {
      // Trackpad pinch: accumulate deltas so zoom doesn't race
      const now = performance.now();
      if (now - wheelZoomLastMs > TRACKPAD_ZOOM_IDLE_RESET_MS) {
        wheelZoomAccum = 0;
      }
      wheelZoomLastMs = now;
      wheelZoomAccum += event.deltaY * scale;
      const cx = event.clientX;
      const cy = event.clientY;
      wheelZoomAccum = drainZoomAccumulator(
        wheelZoomAccum,
        TRACKPAD_ZOOM_STEP_THRESHOLD,
        (dir) => view.zoomStepAtClient(dir, cx, cy, now)
      );
    }
    event.preventDefault();
  };

  const onKeyDown = (event: KeyboardEvent): void => {
    if (isTypingTarget(event.target)) return;
    if (event.code === "KeyQ") {
      view.rotateQuarterTurns(-1);
      event.preventDefault();
      return;
    }
    if (event.code === "KeyE") {
      view.rotateQuarterTurns(1);
      event.preventDefault();
      return;
    }
    if (event.code === "KeyZ" && !event.ctrlKey && !event.metaKey && !event.shiftKey) {
      view.toggleZoomMode();
      event.preventDefault();
    }
  };

  const onKeyUp = (_event: KeyboardEvent): void => {
    // reserved for future bindings parity
  };

  pointerTarget.addEventListener("pointerdown", onPointerDown);
  pointerTarget.addEventListener("pointermove", onPointerMove);
  pointerTarget.addEventListener("pointerup", onPointerUp);
  pointerTarget.addEventListener("pointercancel", onPointerUp);
  pointerTarget.addEventListener("auxclick", onAuxClick);
  pointerTarget.addEventListener("wheel", onWheel, { passive: false });

  if (enableKeyboard) {
    keyboardTarget.addEventListener("keydown", onKeyDown);
    keyboardTarget.addEventListener("keyup", onKeyUp);
  }

  const detachTouch = enableTouch
    ? attachTouchGestures(pointerTarget, {
        onPan: (dx, dy) => view.panByCss(dx, dy),
        onPinch: (scaleDelta, centerX, centerY) => {
          if (Math.abs(scaleDelta - 1) < 0.005) {
            return;
          }
          pinchLog2Accum += Math.log2(scaleDelta);
          const now = performance.now();
          while (pinchLog2Accum >= TOUCH_PINCH_LOG2_THRESHOLD) {
            view.zoomStepAtClient(1, centerX, centerY, now);
            pinchLog2Accum -= TOUCH_PINCH_LOG2_THRESHOLD;
          }
          while (pinchLog2Accum <= -TOUCH_PINCH_LOG2_THRESHOLD) {
            view.zoomStepAtClient(-1, centerX, centerY, now);
            pinchLog2Accum += TOUCH_PINCH_LOG2_THRESHOLD;
          }
        },
        onPinchEnd: () => {
          pinchLog2Accum = 0;
        },
        onRotate: (direction) => view.rotateQuarterTurns(direction)
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
      keyboardTarget.removeEventListener("keyup", onKeyUp);
    }
  };
}

export function bindSharedScissorStageInput(
  options: SharedScissorStageInputBindingOptions
): () => void {
  const stage = options.stage;
  const pointerTarget = options.pointerTarget ?? stage.canvas;
  const keyboardTarget = options.keyboardTarget ?? window;
  const enableKeyboard = options.enableKeyboard ?? true;
  let stageWheelZoomAccum = 0;
  let stageWheelZoomLastMs = 0;
  let drag:
    | {
        pointerId: number;
        paneId: string;
      }
    | null = null;

  const focusFromClient = (clientX: number, clientY: number) => {
    const hit = stage.hitTestPane(clientX, clientY);
    const paneId = hit?.paneId ?? null;
    options.setFocusedPaneId?.(paneId);
    options.onFocusPaneId?.(paneId);
    return hit;
  };

  const getPaneLocalFromClient = (paneId: string, clientX: number, clientY: number) => {
    const pane = options.getPaneInputTarget(paneId);
    if (!pane) {
      return null;
    }
    const rect = pane.element.getBoundingClientRect();
    return {
      pane,
      localX: clientX - rect.left,
      localY: clientY - rect.top
    };
  };

  const onPointerDown = (event: PointerEvent): void => {
    const hit = focusFromClient(event.clientX, event.clientY);
    if (event.button !== 1 || !hit) {
      return;
    }
    const pane = options.getPaneInputTarget(hit.paneId);
    if (!pane) {
      return;
    }
    pane.beginPanDrag(hit.localX, hit.localY);
    drag = { pointerId: event.pointerId, paneId: hit.paneId };
    try {
      pointerTarget.setPointerCapture(event.pointerId);
    } catch {
      // no-op
    }
    event.preventDefault();
  };

  const onPointerMove = (event: PointerEvent): void => {
    if (!drag || drag.pointerId !== event.pointerId) {
      return;
    }
    const local = getPaneLocalFromClient(drag.paneId, event.clientX, event.clientY);
    if (!local) {
      return;
    }
    if (local.pane.updatePanDrag(local.localX, local.localY)) {
      event.preventDefault();
    }
  };

  const onPointerUp = (event: PointerEvent): void => {
    if (!drag || drag.pointerId !== event.pointerId) {
      return;
    }
    const local = getPaneLocalFromClient(drag.paneId, event.clientX, event.clientY);
    const pane = local?.pane ?? options.getPaneInputTarget(drag.paneId);
    drag = null;
    const consumed = pane?.endPanDrag() ?? false;
    if (pointerTarget.hasPointerCapture(event.pointerId)) {
      try {
        pointerTarget.releasePointerCapture(event.pointerId);
      } catch {
        // no-op
      }
    }
    if (consumed) {
      event.preventDefault();
    }
  };

  const onPointerCancel = (event: PointerEvent): void => {
    onPointerUp(event);
  };

  const onAuxClick = (event: MouseEvent): void => {
    focusFromClient(event.clientX, event.clientY);
    if (event.button === 1) {
      event.preventDefault();
    }
  };

  const onWheel = (event: WheelEvent): void => {
    const hit = focusFromClient(event.clientX, event.clientY);
    if (!hit) {
      return;
    }
    const pane = options.getPaneInputTarget(hit.paneId);
    if (!pane) {
      return;
    }

    const scale = event.deltaMode === WheelEvent.DOM_DELTA_LINE ? 16 : 1;
    const trackpad = isLikelyTrackpadWheel(event);
    const zoomIntent = event.ctrlKey || event.metaKey || !trackpad;

    if (!zoomIntent) {
      const panX = -(event.deltaX + (event.shiftKey ? event.deltaY : 0)) * scale;
      const panY = -event.deltaY * scale;
      pane.panByCss(panX, panY);
      event.preventDefault();
      return;
    }

    if (event.deltaY === 0) {
      return;
    }

    if (!trackpad) {
      const direction = (event.deltaY > 0 ? -1 : 1) as -1 | 1;
      pane.stepCameraZoomAtLocalCss(direction, hit.localX, hit.localY, performance.now());
    } else {
      const now = performance.now();
      if (now - stageWheelZoomLastMs > TRACKPAD_ZOOM_IDLE_RESET_MS) {
        stageWheelZoomAccum = 0;
      }
      stageWheelZoomLastMs = now;
      stageWheelZoomAccum += event.deltaY * scale;
      const lx = hit.localX;
      const ly = hit.localY;
      stageWheelZoomAccum = drainZoomAccumulator(
        stageWheelZoomAccum,
        TRACKPAD_ZOOM_STEP_THRESHOLD,
        (dir) => pane.stepCameraZoomAtLocalCss(dir, lx, ly, now)
      );
    }
    event.preventDefault();
  };

  const onKeyDown = (event: KeyboardEvent): void => {
    if (isTypingTarget(event.target)) return;
    const paneId = options.getFocusedPaneId?.() ?? null;
    if (!paneId) {
      return;
    }
    const pane = options.getPaneInputTarget(paneId);
    if (!pane) {
      return;
    }
    if (event.code === "KeyQ") {
      pane.rotateQuarterTurns(-1);
      event.preventDefault();
      return;
    }
    if (event.code === "KeyE") {
      pane.rotateQuarterTurns(1);
      event.preventDefault();
      return;
    }
    if (event.code === "KeyZ" && !event.ctrlKey && !event.metaKey && !event.shiftKey) {
      pane.toggleZoomMode();
      event.preventDefault();
    }
  };

  const onKeyUp = (_event: KeyboardEvent): void => {
    // reserved for future bindings parity
  };

  pointerTarget.addEventListener("pointerdown", onPointerDown);
  pointerTarget.addEventListener("pointermove", onPointerMove);
  pointerTarget.addEventListener("pointerup", onPointerUp);
  pointerTarget.addEventListener("pointercancel", onPointerCancel);
  pointerTarget.addEventListener("auxclick", onAuxClick);
  pointerTarget.addEventListener("wheel", onWheel, { passive: false });

  if (enableKeyboard) {
    keyboardTarget.addEventListener("keydown", onKeyDown);
    keyboardTarget.addEventListener("keyup", onKeyUp);
  }

  return () => {
    drag = null;
    pointerTarget.removeEventListener("pointerdown", onPointerDown);
    pointerTarget.removeEventListener("pointermove", onPointerMove);
    pointerTarget.removeEventListener("pointerup", onPointerUp);
    pointerTarget.removeEventListener("pointercancel", onPointerCancel);
    pointerTarget.removeEventListener("auxclick", onAuxClick);
    pointerTarget.removeEventListener("wheel", onWheel);
    if (enableKeyboard) {
      keyboardTarget.removeEventListener("keydown", onKeyDown);
      keyboardTarget.removeEventListener("keyup", onKeyUp);
    }
  };
}
