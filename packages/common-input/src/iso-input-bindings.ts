import { PixelPerfectIsoView, SharedScissorStage } from "@common/render";
import { attachTouchGestures } from "./touch-gestures";

type KeyboardTarget = Window;

export type PixelPerfectIsoViewInputBindingOptions = {
  view: PixelPerfectIsoView;
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
  syncStageFocus?: boolean;
  onFocusPaneId?: (paneId: string | null) => void;
};

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

export function bindPixelPerfectIsoViewInput(
  options: PixelPerfectIsoViewInputBindingOptions
): () => void {
  const view = options.view;
  const pointerTarget = options.pointerTarget ?? view.canvas;
  const keyboardTarget = options.keyboardTarget ?? window;
  const enableKeyboard = options.enableKeyboard ?? true;
  const enableTouch = options.enableTouch ?? true;

  let dragPointerId: number | null = null;

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
    const direction = (event.deltaY > 0 ? -1 : 1) as -1 | 1;
    view.zoomStepAtClient(direction, event.clientX, event.clientY, performance.now());
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
    if (event.code === "KeyZ") {
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
          if (Math.abs(scaleDelta - 1) < 0.02) {
            return;
          }
          view.zoomStepAtClient(scaleDelta > 1 ? 1 : -1, centerX, centerY, performance.now());
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
  const syncStageFocus = options.syncStageFocus ?? true;

  const focusFromClient = (clientX: number, clientY: number): void => {
    const hit = stage.hitTestPane(clientX, clientY);
    const paneId = hit?.paneId ?? null;
    if (paneId && syncStageFocus) {
      stage.setFocusedPaneId(paneId);
    }
    options.onFocusPaneId?.(paneId);
  };

  const onPointerDown = (event: PointerEvent): void => {
    focusFromClient(event.clientX, event.clientY);
    stage.routePointerDown(event);
  };
  const onPointerMove = (event: PointerEvent): void => {
    stage.routePointerMove(event);
  };
  const onPointerUp = (event: PointerEvent): void => {
    stage.routePointerUp(event);
  };
  const onPointerCancel = (event: PointerEvent): void => {
    stage.routePointerCancel(event);
  };
  const onAuxClick = (event: MouseEvent): void => {
    focusFromClient(event.clientX, event.clientY);
    stage.routeAuxClick(event);
  };
  const onWheel = (event: WheelEvent): void => {
    focusFromClient(event.clientX, event.clientY);
    stage.routeWheel(event);
  };
  const onKeyDown = (event: KeyboardEvent): void => {
    stage.routeKeyDown(event);
  };
  const onKeyUp = (event: KeyboardEvent): void => {
    stage.routeKeyUp(event);
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
