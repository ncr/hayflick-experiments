import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef
} from "react";
import {
  PixelPerfectPane,
  PROP_PREVIEW_FRAMING,
  SharedScissorStage,
  addStandardGameLighting
} from "@common/render";
import * as THREE from "three";
import type { PixelViewportViewState } from "../forge-core/ViewportPixel";
import { useForgeScissorViewportStage } from "./ScissorViewport3d";

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

const CAMERA_BASE_YAW = THREE.MathUtils.degToRad(45);
const CLEAR_COLOR = 0x1a1a2e;

type DragState = {
  pointerId: number;
  angleKey: PixelAngle["key"];
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

function angleByKey(key: string): PixelAngle | null {
  return ANGLES.find((angle) => angle.key === key) ?? null;
}

interface Props {
  model: THREE.Group | null;
  baseViewState: PixelViewportViewState;
  onBaseViewStateChange?: (state: PixelViewportViewState) => void;
  className?: string;
  interactive?: boolean;
  viewportFramingScale?: number;
  /** Where the camera target sits vertically on screen: 0.5 = centered (default), 1/3 = lower third. */
  verticalBias?: number;
  paneIdPrefix?: string;
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
    interactive = true,
    viewportFramingScale = 1.22,
    verticalBias,
    paneIdPrefix = ""
  }: Props,
  ref
) {
  const sharedScissorStage = useForgeScissorViewportStage();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const canvasHostRef = useRef<HTMLDivElement | null>(null);
  const cellRefs = useRef<Record<PixelAngle["key"], HTMLDivElement | null>>({
    north: null,
    east: null,
    south: null,
    west: null
  });

  const stageRef = useRef<SharedScissorStage | null>(null);
  const paneRefs = useRef<Record<PixelAngle["key"], PixelPerfectPane | null>>({
    north: null,
    east: null,
    south: null,
    west: null
  });
  const sceneRef = useRef<THREE.Scene | null>(null);
  const modelRef = useRef<THREE.Group | null>(null);
  const desiredModelRef = useRef<THREE.Group | null>(null);
  const lastModelPropRef = useRef<THREE.Group | null>(null);

  const baseViewStateRef = useRef<PixelViewportViewState>(normalizeBaseState(baseViewState));
  const onBaseViewChangeRef = useRef(onBaseViewStateChange);
  onBaseViewChangeRef.current = onBaseViewStateChange;

  const dragStateRef = useRef<DragState | null>(null);
  const normalizedBase = useMemo(() => normalizeBaseState(baseViewState), [baseViewState]);

  const panePoseForAngle = (angle: PixelAngle, base: PixelViewportViewState) => ({
    targetX: base.target[0],
    targetZ: base.target[2],
    yawIndex: wrapTurns(base.yawTurns + angle.offset),
    zoom: Math.max(1, Math.round(base.zoom))
  });

  const syncPanesFromBase = (base: PixelViewportViewState): void => {
    for (const angle of ANGLES) {
      paneRefs.current[angle.key]?.setViewPose(panePoseForAngle(angle, base));
    }
  };

  const paneIdForAngle = (angleKey: PixelAngle["key"]): string => `${paneIdPrefix}${angleKey}`;

  const angleForPaneId = (paneId: string): PixelAngle | null => {
    if (!paneId.startsWith(paneIdPrefix)) {
      return null;
    }
    return angleByKey(paneId.slice(paneIdPrefix.length));
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
    clone.updateMatrixWorld(true);
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
    const prev = baseViewStateRef.current;
    const same =
      Math.abs(prev.target[0] - normalizedBase.target[0]) < 1e-6 &&
      Math.abs(prev.target[2] - normalizedBase.target[2]) < 1e-6 &&
      prev.yawTurns === normalizedBase.yawTurns &&
      prev.zoom === normalizedBase.zoom;
    if (same) return;
    baseViewStateRef.current = normalizedBase;
    syncPanesFromBase(normalizedBase);
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
    const container = containerRef.current;
    if (!host) {
      return;
    }

    for (const angle of ANGLES) {
      if (!cellRefs.current[angle.key]) {
        return;
      }
    }

    const scene = new THREE.Scene();
    sceneRef.current = scene;

    addStandardGameLighting(scene, {
      ambient: 1.0,
      keyColor: 0xffffff,
      keyDirection: [3, 5, 2],
      fillColor: 0x8899bb,
      fillIntensity: 0.8,
      fillDirection: [-2, 3, -1],
      hemisphere: false
    });

    const ownsStage = !sharedScissorStage;
    const stage =
      sharedScissorStage ??
      new SharedScissorStage({
        mount: host,
        width: Math.max(1, host.clientWidth),
        height: Math.max(1, host.clientHeight),
        antialias: false,
        clearAlpha: 0
      });
    stageRef.current = stage;
    if (ownsStage) {
      stage.canvas.style.background = "transparent";
      stage.canvas.style.touchAction = "none";
    }

    const framingScale =
      Number.isFinite(viewportFramingScale) && viewportFramingScale > 0
        ? viewportFramingScale
        : 1;

    for (const angle of ANGLES) {
      const cell = cellRefs.current[angle.key];
      if (!cell) {
        continue;
      }
      const pane = new PixelPerfectPane({
        stage,
        id: paneIdForAngle(angle.key),
        element: cell,
        scene,
        width: Math.max(1, cell.clientWidth || 1),
        height: Math.max(1, cell.clientHeight || 1),
        ...PROP_PREVIEW_FRAMING,
        baseOrthoHeight: PROP_PREVIEW_FRAMING.baseOrthoHeight * framingScale,
        cameraYaw: CAMERA_BASE_YAW,
        clearColor: CLEAR_COLOR,
        verticalBias
      });
      paneRefs.current[angle.key] = pane;
    }

    applyModelToScene(desiredModelRef.current);
    syncPanesFromBase(baseViewStateRef.current);

    const pointerTarget = ownsStage ? stage.canvas : container;
    if (interactive && !pointerTarget) {
      if (ownsStage) {
        stage.dispose();
      }
      return;
    }
    const pointerEventTarget: HTMLElement | null = interactive ? pointerTarget : null;

    const onPointerDown = (event: PointerEvent): void => {
      if (event.button !== 0) {
        return;
      }
      const hit = stage.hitTestPane(event.clientX, event.clientY);
      const angle = hit ? angleForPaneId(hit.paneId) : null;
      if (!hit || !angle) {
        return;
      }

      for (const a of ANGLES) {
        paneRefs.current[a.key]?.beginPanDrag(hit.localX, hit.localY);
      }
      dragStateRef.current = {
        pointerId: event.pointerId,
        angleKey: angle.key
      };

      try {
        pointerEventTarget?.setPointerCapture(event.pointerId);
      } catch {
        // no-op
      }
      event.preventDefault();
    };

    const onPointerMove = (event: PointerEvent): void => {
      const drag = dragStateRef.current;
      if (!drag || drag.pointerId !== event.pointerId) {
        return;
      }
      const cell = cellRefs.current[drag.angleKey];
      if (!cell) {
        return;
      }

      const rect = cell.getBoundingClientRect();
      const localX = event.clientX - rect.left;
      const localY = event.clientY - rect.top;
      let anyChanged = false;
      for (const a of ANGLES) {
        if (paneRefs.current[a.key]?.updatePanDrag(localX, localY)) {
          anyChanged = true;
        }
      }
      if (anyChanged) {
        event.preventDefault();
      }
    };

    const endPointer = (event: PointerEvent): void => {
      const drag = dragStateRef.current;
      if (!drag || drag.pointerId !== event.pointerId) {
        return;
      }
      dragStateRef.current = null;
      for (const a of ANGLES) {
        paneRefs.current[a.key]?.endPanDrag();
      }

      // Notify parent from the initiating pane (for 3D viewport sync).
      // baseViewStateRef is updated so the prop round-trip is a no-op.
      const pane = paneRefs.current[drag.angleKey];
      const dragAngle = angleByKey(drag.angleKey);
      if (pane && dragAngle) {
        const pose = pane.getViewPose();
        const next = normalizeBaseState({
          target: [pose.targetX, 0, pose.targetZ],
          yawTurns: wrapTurns(pose.yawIndex - dragAngle.offset),
          zoom: Math.max(1, Math.round(pose.zoom))
        });
        baseViewStateRef.current = next;
        onBaseViewChangeRef.current?.(next);
      }

      try {
        if (pointerEventTarget?.hasPointerCapture(event.pointerId)) {
          pointerEventTarget.releasePointerCapture(event.pointerId);
        }
      } catch {
        // no-op
      }
      event.preventDefault();
    };

    const onContextMenu = (event: MouseEvent): void => {
      event.preventDefault();
    };

    if (pointerEventTarget) {
      pointerEventTarget.addEventListener("pointerdown", onPointerDown);
      pointerEventTarget.addEventListener("pointermove", onPointerMove);
      pointerEventTarget.addEventListener("pointerup", endPointer);
      pointerEventTarget.addEventListener("pointercancel", endPointer);
      pointerEventTarget.addEventListener("contextmenu", onContextMenu);
    }

    if (ownsStage) {
      stage.start();
    }

    return () => {
      if (pointerEventTarget) {
        pointerEventTarget.removeEventListener("pointerdown", onPointerDown);
        pointerEventTarget.removeEventListener("pointermove", onPointerMove);
        pointerEventTarget.removeEventListener("pointerup", endPointer);
        pointerEventTarget.removeEventListener("pointercancel", endPointer);
        pointerEventTarget.removeEventListener("contextmenu", onContextMenu);
      }

      dragStateRef.current = null;
      for (const angle of ANGLES) {
        stage.unregisterPane(paneIdForAngle(angle.key));
      }
      if (ownsStage) {
        stage.dispose();
      }
      stageRef.current = null;

      for (const angle of ANGLES) {
        paneRefs.current[angle.key] = null;
      }

      if (modelRef.current && sceneRef.current) {
        sceneRef.current.remove(modelRef.current);
      }
      modelRef.current = null;
      sceneRef.current = null;
    };
  }, [interactive, paneIdPrefix, sharedScissorStage, viewportFramingScale]);

  return (
    <div
      ref={containerRef}
      className={`forgev2-pixel-grid${className ? ` ${className}` : ""} forgev2-pixel-quad-scissor`}
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
