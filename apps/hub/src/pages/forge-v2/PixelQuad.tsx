import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef
} from "react";
import * as THREE from "three";
import type { PixelViewportViewState } from "../forge/ViewportPixel";

type PixelAngle = {
  key: "north" | "east" | "south" | "west";
  label: string;
  offset: number;
};

const ANGLES: PixelAngle[] = [
  { key: "north", label: "North", offset: 0 },
  { key: "east", label: "East", offset: 1 },
  { key: "south", label: "South", offset: 2 },
  { key: "west", label: "West", offset: 3 }
];

const CAMERA_PITCH = THREE.MathUtils.degToRad(30);
const CAMERA_BASE_YAW = THREE.MathUtils.degToRad(45);
const CAMERA_DISTANCE = 30;
const DEFAULT_BASE_ORTHO_HEIGHT = 5.966213466261495;
const CLEAR_COLOR = 0x1a1a2e;

type PaneRect = {
  left: number;
  top: number;
  width: number;
  height: number;
};

type DragState =
  | {
      pointerId: number;
      mode: "pan";
      angleKey: PixelAngle["key"];
      prevGround: THREE.Vector3;
    }
  | {
      pointerId: number;
      mode: "rotate";
      angleKey: PixelAngle["key"];
      lastClientX: number;
      accumX: number;
    };

function wrapTurns(value: number): number {
  const rounded = Math.round(value);
  const wrapped = rounded % 4;
  return wrapped < 0 ? wrapped + 4 : wrapped;
}

function normalizeBaseState(baseViewState: PixelViewportViewState): PixelViewportViewState {
  return {
    target: [
      Number.isFinite(baseViewState.target[0]) ? baseViewState.target[0] : 0,
      0,
      Number.isFinite(baseViewState.target[2]) ? baseViewState.target[2] : 0
    ],
    yawTurns: wrapTurns(baseViewState.yawTurns),
    zoom: Math.max(1, Math.round(baseViewState.zoom))
  };
}

interface Props {
  model: THREE.Group | null;
  baseViewState: PixelViewportViewState;
  onBaseViewStateChange?: (state: PixelViewportViewState) => void;
  className?: string;
  viewportFramingScale?: number;
}

export interface PixelQuadHandle {
  setNamedObjectTransform(
    name: string,
    transform: {
      position?: [number, number, number];
      quaternion?: [number, number, number, number];
    }
  ): void;
}

export const PixelQuad = forwardRef<PixelQuadHandle, Props>(function PixelQuad(
  {
    model,
    baseViewState,
    onBaseViewStateChange,
    className,
    viewportFramingScale = 1.22
  }: Props,
  ref
) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const canvasHostRef = useRef<HTMLDivElement | null>(null);
  const cellRefs = useRef<Record<PixelAngle["key"], HTMLDivElement | null>>({
    north: null,
    east: null,
    south: null,
    west: null
  });

  const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
  const sceneRef = useRef<THREE.Scene | null>(null);
  const cameraRef = useRef<THREE.OrthographicCamera | null>(null);
  const modelRef = useRef<THREE.Group | null>(null);
  const desiredModelRef = useRef<THREE.Group | null>(null);
  const lastModelPropRef = useRef<THREE.Group | null>(null);
  const rafRef = useRef<number>(0);
  const resizeObserverRef = useRef<ResizeObserver | null>(null);

  const baseViewStateRef = useRef<PixelViewportViewState>(normalizeBaseState(baseViewState));
  const onBaseViewChangeRef = useRef(onBaseViewStateChange);
  onBaseViewChangeRef.current = onBaseViewStateChange;

  const raycasterRef = useRef(new THREE.Raycaster());
  const pointerNdcRef = useRef(new THREE.Vector2());
  const groundPlaneRef = useRef(new THREE.Plane(new THREE.Vector3(0, 1, 0), 0));
  const tmpIntersectionRef = useRef(new THREE.Vector3());
  const tmpPrevRef = useRef(new THREE.Vector3());
  const dragStateRef = useRef<DragState | null>(null);

  const normalizedBase = useMemo(() => normalizeBaseState(baseViewState), [baseViewState]);

  const emitBaseState = (next: PixelViewportViewState): void => {
    const normalized = normalizeBaseState(next);
    const prev = baseViewStateRef.current;
    const same =
      Math.abs(prev.target[0] - normalized.target[0]) < 1e-6 &&
      Math.abs(prev.target[2] - normalized.target[2]) < 1e-6 &&
      prev.yawTurns === normalized.yawTurns &&
      prev.zoom === normalized.zoom;
    if (same) {
      return;
    }
    baseViewStateRef.current = normalized;
    onBaseViewChangeRef.current?.(normalized);
  };

  const applyModelToScene = (group: THREE.Group | null): void => {
    desiredModelRef.current = group;
    const scene = sceneRef.current;
    if (!scene) {
      return;
    }
    if (modelRef.current) {
      scene.remove(modelRef.current);
      modelRef.current = null;
    }
    if (!group) {
      return;
    }
    const clone = group.clone(true);
    modelRef.current = clone;
    scene.add(clone);
  };

  const getPaneRects = (): Record<PixelAngle["key"], PaneRect> | null => {
    const container = containerRef.current;
    if (!container) return null;
    const containerRect = container.getBoundingClientRect();
    if (containerRect.width <= 0 || containerRect.height <= 0) {
      return null;
    }

    const result = {} as Record<PixelAngle["key"], PaneRect>;
    for (const angle of ANGLES) {
      const cell = cellRefs.current[angle.key];
      if (!cell) {
        return null;
      }
      const rect = cell.getBoundingClientRect();
      result[angle.key] = {
        left: rect.left - containerRect.left,
        top: rect.top - containerRect.top,
        width: rect.width,
        height: rect.height
      };
    }
    return result;
  };

  const getAngleState = (angle: PixelAngle): PixelViewportViewState => {
    const base = baseViewStateRef.current;
    return {
      target: [base.target[0], 0, base.target[2]],
      yawTurns: wrapTurns(base.yawTurns + angle.offset),
      zoom: Math.max(1, Math.round(base.zoom))
    };
  };

  const configureCameraForPane = (
    angleState: PixelViewportViewState,
    paneWidth: number,
    paneHeight: number
  ): THREE.OrthographicCamera | null => {
    const camera = cameraRef.current;
    if (!camera) {
      return null;
    }
    const w = Math.max(1, paneWidth);
    const h = Math.max(1, paneHeight);
    const aspect = w / h;
    const framingScale = Number.isFinite(viewportFramingScale) && viewportFramingScale > 0
      ? viewportFramingScale
      : 1;
    const viewHeight = (DEFAULT_BASE_ORTHO_HEIGHT * framingScale) / Math.max(1, angleState.zoom);
    camera.left = -0.5 * viewHeight * aspect;
    camera.right = 0.5 * viewHeight * aspect;
    camera.top = 0.5 * viewHeight;
    camera.bottom = -0.5 * viewHeight;
    camera.near = 0.1;
    camera.far = 200;

    const yaw = CAMERA_BASE_YAW + angleState.yawTurns * (Math.PI / 2);
    const target = new THREE.Vector3(angleState.target[0], 0, angleState.target[2]);
    const offset = new THREE.Vector3().setFromSpherical(
      new THREE.Spherical(CAMERA_DISTANCE, CAMERA_PITCH, yaw)
    );
    camera.position.copy(target).add(offset);
    camera.up.set(0, 1, 0);
    camera.lookAt(target);
    camera.updateProjectionMatrix();
    camera.updateMatrixWorld(true);
    return camera;
  };

  const findPaneAtClientPoint = (clientX: number, clientY: number): PixelAngle | null => {
    const panes = getPaneRects();
    if (!panes) {
      return null;
    }
    for (const angle of ANGLES) {
      const pane = panes[angle.key];
      if (
        clientX >= pane.left + (containerRef.current?.getBoundingClientRect().left ?? 0) &&
        clientX <= pane.left + pane.width + (containerRef.current?.getBoundingClientRect().left ?? 0) &&
        clientY >= pane.top + (containerRef.current?.getBoundingClientRect().top ?? 0) &&
        clientY <= pane.top + pane.height + (containerRef.current?.getBoundingClientRect().top ?? 0)
      ) {
        return angle;
      }
    }
    return null;
  };

  const intersectGroundAtClientPoint = (
    angle: PixelAngle,
    clientX: number,
    clientY: number,
    out: THREE.Vector3
  ): boolean => {
    const container = containerRef.current;
    const panes = getPaneRects();
    if (!container || !panes) {
      return false;
    }
    const containerRect = container.getBoundingClientRect();
    const pane = panes[angle.key];
    if (!pane || pane.width <= 1 || pane.height <= 1) {
      return false;
    }

    const localX = clientX - (containerRect.left + pane.left);
    const localY = clientY - (containerRect.top + pane.top);
    const ndcX = (localX / pane.width) * 2 - 1;
    const ndcY = -((localY / pane.height) * 2 - 1);

    const camera = configureCameraForPane(getAngleState(angle), pane.width, pane.height);
    if (!camera) {
      return false;
    }

    const raycaster = raycasterRef.current;
    const pointerNdc = pointerNdcRef.current;
    pointerNdc.set(ndcX, ndcY);
    raycaster.setFromCamera(pointerNdc, camera);
    return raycaster.ray.intersectPlane(groundPlaneRef.current, out) !== null;
  };

  const renderFrame = (): void => {
    const renderer = rendererRef.current;
    const scene = sceneRef.current;
    const container = containerRef.current;
    if (!renderer || !scene || !container) {
      return;
    }

    const width = Math.max(1, Math.floor(container.clientWidth));
    const height = Math.max(1, Math.floor(container.clientHeight));
    const canvas = renderer.domElement;
    if (canvas.width !== width || canvas.height !== height) {
      renderer.setSize(width, height, false);
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
    }

    const panes = getPaneRects();
    if (!panes) {
      return;
    }

    renderer.setScissorTest(false);
    renderer.setViewport(0, 0, width, height);
    renderer.setClearColor(0x000000, 0);
    renderer.clear(true, true, true);
    renderer.setScissorTest(true);

    for (const angle of ANGLES) {
      const pane = panes[angle.key];
      const left = Math.max(0, Math.floor(pane.left));
      const top = Math.max(0, Math.floor(pane.top));
      const right = Math.min(width, Math.floor(pane.left + pane.width));
      const bottom = Math.min(height, Math.floor(pane.top + pane.height));
      const paneWidth = right - left;
      const paneHeight = bottom - top;
      if (paneWidth <= 1 || paneHeight <= 1) {
        continue;
      }
      const viewportBottom = height - bottom;
      const camera = configureCameraForPane(getAngleState(angle), paneWidth, paneHeight);
      if (!camera) {
        continue;
      }
      renderer.setViewport(left, viewportBottom, paneWidth, paneHeight);
      renderer.setScissor(left, viewportBottom, paneWidth, paneHeight);
      renderer.setClearColor(CLEAR_COLOR, 1);
      renderer.clear(true, true, true);
      renderer.render(scene, camera);
    }

    renderer.setScissorTest(false);
  };

  useImperativeHandle(
    ref,
    () => ({
      setNamedObjectTransform: (name, transform) => {
        const root = modelRef.current;
        if (!root || !name) {
          return;
        }
        const target = root.getObjectByName(name);
        if (!target) {
          return;
        }
        const pos = transform.position;
        if (pos) {
          target.position.set(pos[0], pos[1], pos[2]);
        }
        const quat = transform.quaternion;
        if (quat) {
          target.quaternion.set(quat[0], quat[1], quat[2], quat[3]);
        }
        target.updateMatrixWorld(true);
      }
    }),
    []
  );

  useEffect(() => {
    baseViewStateRef.current = normalizedBase;
  }, [normalizedBase]);

  useEffect(() => {
    if (lastModelPropRef.current === model) {
      return;
    }
    lastModelPropRef.current = model;
    applyModelToScene(model);
  }, [model]);

  useEffect(() => {
    const host = canvasHostRef.current;
    if (!host) {
      return;
    }

    const renderer = new THREE.WebGLRenderer({ antialias: false, alpha: true });
    rendererRef.current = renderer;
    renderer.autoClear = false;
    renderer.setPixelRatio(1);
    renderer.setSize(Math.max(1, host.clientWidth), Math.max(1, host.clientHeight), false);
    renderer.domElement.style.display = "block";
    renderer.domElement.style.width = "100%";
    renderer.domElement.style.height = "100%";
    renderer.domElement.style.imageRendering = "pixelated";
    renderer.domElement.style.background = "transparent";
    renderer.domElement.style.touchAction = "none";
    host.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    sceneRef.current = scene;

    const ambient = new THREE.AmbientLight(0xffffff, 1.0);
    scene.add(ambient);
    const keyLight = new THREE.DirectionalLight(0xffffff, 1.8);
    keyLight.position.set(3, 5, 2);
    scene.add(keyLight);
    const fillLight = new THREE.DirectionalLight(0x8899bb, 0.8);
    fillLight.position.set(-2, 3, -1);
    scene.add(fillLight);

    const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 200);
    cameraRef.current = camera;

    applyModelToScene(desiredModelRef.current);

    const tick = (): void => {
      renderFrame();
      rafRef.current = requestAnimationFrame(tick);
    };
    tick();

    const resizeObserver = new ResizeObserver(() => {
      renderFrame();
    });
    resizeObserver.observe(host);
    resizeObserverRef.current = resizeObserver;

    const onPointerDown = (event: PointerEvent): void => {
      if (event.button !== 0 && event.button !== 2) {
        return;
      }
      const angle = findPaneAtClientPoint(event.clientX, event.clientY);
      if (!angle) {
        return;
      }
      if (event.button === 2) {
        dragStateRef.current = {
          pointerId: event.pointerId,
          mode: "rotate",
          angleKey: angle.key,
          lastClientX: event.clientX,
          accumX: 0
        };
      } else {
        const hit = tmpIntersectionRef.current;
        if (!intersectGroundAtClientPoint(angle, event.clientX, event.clientY, hit)) {
          return;
        }
        dragStateRef.current = {
          pointerId: event.pointerId,
          mode: "pan",
          angleKey: angle.key,
          prevGround: hit.clone()
        };
      }
      (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
      event.preventDefault();
    };

    const onPointerMove = (event: PointerEvent): void => {
      const drag = dragStateRef.current;
      if (!drag || drag.pointerId !== event.pointerId) {
        return;
      }
      const angle = ANGLES.find((entry) => entry.key === drag.angleKey);
      if (!angle) {
        return;
      }
      if (drag.mode === "rotate") {
        const dx = event.clientX - drag.lastClientX;
        drag.lastClientX = event.clientX;
        drag.accumX += dx;
        const threshold = 36;
        while (Math.abs(drag.accumX) >= threshold) {
          const direction = drag.accumX > 0 ? 1 : -1;
          drag.accumX -= threshold * direction;
          const base = baseViewStateRef.current;
          emitBaseState({
            ...base,
            yawTurns: wrapTurns(base.yawTurns + direction)
          });
        }
        event.preventDefault();
        return;
      }

      const hit = tmpPrevRef.current;
      if (!intersectGroundAtClientPoint(angle, event.clientX, event.clientY, hit)) {
        return;
      }
      const deltaX = drag.prevGround.x - hit.x;
      const deltaZ = drag.prevGround.z - hit.z;
      drag.prevGround.copy(hit);
      const base = baseViewStateRef.current;
      emitBaseState({
        ...base,
        target: [base.target[0] + deltaX, 0, base.target[2] + deltaZ]
      });
      event.preventDefault();
    };

    const endPointer = (event: PointerEvent): void => {
      const drag = dragStateRef.current;
      if (!drag || drag.pointerId !== event.pointerId) {
        return;
      }
      dragStateRef.current = null;
      try {
        (event.currentTarget as HTMLElement).releasePointerCapture(event.pointerId);
      } catch {
        // no-op
      }
      event.preventDefault();
    };

    const onWheel = (event: WheelEvent): void => {
      const angle = findPaneAtClientPoint(event.clientX, event.clientY);
      if (!angle) {
        return;
      }
      const base = baseViewStateRef.current;
      if (event.shiftKey) {
        const direction = event.deltaY > 0 ? 1 : -1;
        emitBaseState({
          ...base,
          yawTurns: wrapTurns(base.yawTurns + direction)
        });
      } else {
        const delta = event.deltaY > 0 ? -1 : 1;
        emitBaseState({
          ...base,
          zoom: THREE.MathUtils.clamp(base.zoom + delta, 1, 6)
        });
      }
      event.preventDefault();
    };

    const onContextMenu = (event: MouseEvent): void => {
      event.preventDefault();
    };

    host.addEventListener("pointerdown", onPointerDown);
    host.addEventListener("pointermove", onPointerMove);
    host.addEventListener("pointerup", endPointer);
    host.addEventListener("pointercancel", endPointer);
    host.addEventListener("wheel", onWheel, { passive: false });
    host.addEventListener("contextmenu", onContextMenu);

    return () => {
      host.removeEventListener("pointerdown", onPointerDown);
      host.removeEventListener("pointermove", onPointerMove);
      host.removeEventListener("pointerup", endPointer);
      host.removeEventListener("pointercancel", endPointer);
      host.removeEventListener("wheel", onWheel);
      host.removeEventListener("contextmenu", onContextMenu);

      dragStateRef.current = null;
      cancelAnimationFrame(rafRef.current);
      rafRef.current = 0;
      resizeObserver.disconnect();
      resizeObserverRef.current = null;

      if (modelRef.current && sceneRef.current) {
        sceneRef.current.remove(modelRef.current);
        modelRef.current = null;
      }
      sceneRef.current = null;
      cameraRef.current = null;

      if (renderer.domElement.parentElement === host) {
        host.removeChild(renderer.domElement);
      }
      renderer.dispose();
      rendererRef.current = null;
    };
  }, [viewportFramingScale]);

  return (
    <div
      ref={containerRef}
      className={`${className ?? "forgev2-pixel-grid"} forgev2-pixel-quad-scissor`}
      data-testid="forgev2-pixel-quad"
    >
      <div ref={canvasHostRef} className="forgev2-pixel-quad-canvas-host" />
      {ANGLES.map((angle) => (
        <div
          key={angle.key}
          ref={(el) => {
            cellRefs.current[angle.key] = el;
          }}
          className="forgev2-pixel-cell"
        >
          <div className="forgev2-pixel-cell-label">{angle.label}</div>
        </div>
      ))}
    </div>
  );
});
