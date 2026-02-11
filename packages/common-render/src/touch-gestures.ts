export type TouchGestureCallbacks = {
  onPanStart?: () => void;
  onPan?: (dx: number, dy: number) => void;
  onPanEnd?: () => void;
  onPinchStart?: () => void;
  onPinch?: (scaleDelta: number, centerX: number, centerY: number) => void;
  onPinchEnd?: () => void;
  onRotate?: (direction: -1 | 1) => void;
};

interface TouchRecord {
  x: number;
  y: number;
}

const ROTATION_ANGLE_THRESHOLD = Math.PI / 6; // ~30 degrees

function getDistance(a: TouchRecord, b: TouchRecord): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return Math.sqrt(dx * dx + dy * dy);
}

function getAngle(a: TouchRecord, b: TouchRecord): number {
  return Math.atan2(b.y - a.y, b.x - a.x);
}

function getCenter(a: TouchRecord, b: TouchRecord): { x: number; y: number } {
  return { x: (a.x + b.x) * 0.5, y: (a.y + b.y) * 0.5 };
}

/**
 * Attaches multi-touch gesture recognition to an element.
 *
 * - 1-finger drag → pan
 * - 2-finger pinch → zoom (scaleDelta)
 * - 2-finger rotate → discrete 90° rotation when angle exceeds threshold
 *
 * Sets `touch-action: none` on the element to prevent browser gestures.
 * Returns a cleanup function.
 */
export function attachTouchGestures(
  element: HTMLElement,
  callbacks: TouchGestureCallbacks
): () => void {
  const pointers = new Map<number, TouchRecord>();

  let panActive = false;
  let pinchActive = false;
  let initialPinchDistance = 0;
  let initialPinchAngle = 0;
  let cumulativeAngle = 0;

  const previousStyle = element.style.touchAction;
  element.style.touchAction = "none";

  const onTouchStart = (event: TouchEvent) => {
    event.preventDefault();
    for (let i = 0; i < event.changedTouches.length; i++) {
      const t = event.changedTouches[i];
      pointers.set(t.identifier, { x: t.clientX, y: t.clientY });
    }

    if (pointers.size === 1 && !pinchActive) {
      panActive = true;
      callbacks.onPanStart?.();
    } else if (pointers.size === 2) {
      if (panActive) {
        panActive = false;
        callbacks.onPanEnd?.();
      }
      const [a, b] = [...pointers.values()];
      initialPinchDistance = getDistance(a, b);
      initialPinchAngle = getAngle(a, b);
      cumulativeAngle = 0;
      pinchActive = true;
      callbacks.onPinchStart?.();
    }
  };

  const onTouchMove = (event: TouchEvent) => {
    event.preventDefault();

    if (panActive && pointers.size === 1) {
      const t = event.changedTouches[0];
      const prev = pointers.get(t.identifier);
      if (prev) {
        const dx = t.clientX - prev.x;
        const dy = t.clientY - prev.y;
        pointers.set(t.identifier, { x: t.clientX, y: t.clientY });
        callbacks.onPan?.(dx, dy);
      }
      return;
    }

    for (let i = 0; i < event.changedTouches.length; i++) {
      const t = event.changedTouches[i];
      if (pointers.has(t.identifier)) {
        pointers.set(t.identifier, { x: t.clientX, y: t.clientY });
      }
    }

    if (pinchActive && pointers.size >= 2) {
      const entries = [...pointers.values()];
      const a = entries[0];
      const b = entries[1];
      const currentDistance = getDistance(a, b);
      const currentAngle = getAngle(a, b);
      const center = getCenter(a, b);

      if (initialPinchDistance > 0) {
        const scaleDelta = currentDistance / initialPinchDistance;
        callbacks.onPinch?.(scaleDelta, center.x, center.y);
        initialPinchDistance = currentDistance;
      }

      let angleDelta = currentAngle - initialPinchAngle;
      while (angleDelta > Math.PI) angleDelta -= 2 * Math.PI;
      while (angleDelta < -Math.PI) angleDelta += 2 * Math.PI;
      cumulativeAngle += angleDelta;
      initialPinchAngle = currentAngle;

      if (Math.abs(cumulativeAngle) >= ROTATION_ANGLE_THRESHOLD) {
        const direction: -1 | 1 = cumulativeAngle > 0 ? 1 : -1;
        callbacks.onRotate?.(direction);
        cumulativeAngle = 0;
      }
    }
  };

  const onTouchEnd = (event: TouchEvent) => {
    event.preventDefault();
    for (let i = 0; i < event.changedTouches.length; i++) {
      pointers.delete(event.changedTouches[i].identifier);
    }

    if (pointers.size < 2 && pinchActive) {
      pinchActive = false;
      callbacks.onPinchEnd?.();

      if (pointers.size === 1) {
        panActive = true;
        callbacks.onPanStart?.();
      }
    }

    if (pointers.size === 0 && panActive) {
      panActive = false;
      callbacks.onPanEnd?.();
    }
  };

  element.addEventListener("touchstart", onTouchStart, { passive: false });
  element.addEventListener("touchmove", onTouchMove, { passive: false });
  element.addEventListener("touchend", onTouchEnd, { passive: false });
  element.addEventListener("touchcancel", onTouchEnd, { passive: false });

  return () => {
    element.removeEventListener("touchstart", onTouchStart);
    element.removeEventListener("touchmove", onTouchMove);
    element.removeEventListener("touchend", onTouchEnd);
    element.removeEventListener("touchcancel", onTouchEnd);
    element.style.touchAction = previousStyle;
  };
}
