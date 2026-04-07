import * as THREE from "three";
import {
  PixelPerfectScissorPane,
  PixelPerfectViewportCore,
  SharedScissorStage,
  type PixelView
} from "@common/render";
import type { ExperimentModule } from "../runtime/types";

// All four panes share these projection parameters so the on-screen pixel
// scale is the same — only the camera mode (and base yaw) differs per pane.
const SHARED_VIEW_CONFIG = {
  fixedRenderHeight: 240,
  baseOrthoHeight: 6,
  cameraDistance: 30,
  basePixelZoom: 1,
  zoomMin: 1,
  zoomMax: 6,
  zoomStep: 1,
  zoomAnimationRate: 14,
  zoomAnimationBurstRate: 42,
  zoomAnimationEpsilon: 0.001,
  rotationAnimationRate: 18,
  rotationAnimationEpsilon: 0.001,
  zoomBurstIdleMs: 200,
  outputOverscanLowPixels: 2
};

type PaneSpec = {
  id: string;
  label: string;
  cameraPitch: PixelView;
  cameraYaw: number;
  // Position inside the 2x2 grid (CSS percentages).
  left: string;
  top: string;
};

const PANE_SPECS: PaneSpec[] = [
  {
    id: "top-down",
    label: "Top-down",
    cameraPitch: "top-down",
    cameraYaw: 0,
    left: "0%",
    top: "0%"
  },
  {
    id: "iso-2to1",
    label: "Isometric 2:1",
    cameraPitch: "iso-2to1",
    cameraYaw: Math.PI / 4,
    left: "50%",
    top: "0%"
  },
  {
    id: "side-z",
    label: "Side · looking −Z",
    cameraPitch: "side",
    cameraYaw: 0,
    left: "0%",
    top: "50%"
  },
  {
    id: "side-x",
    label: "Side · looking −X",
    cameraPitch: "side",
    cameraYaw: Math.PI / 2,
    left: "50%",
    top: "50%"
  }
];

function buildScene(): THREE.Scene {
  const scene = new THREE.Scene();
  // No scene.background — the SharedScissorStage clears each pane with its
  // own clearColor before rendering, so a background would just be wasted fill.

  // Lighting — ambient + key + fill so all sides of the primitives read.
  scene.add(new THREE.AmbientLight(0xffffff, 0.55));
  const key = new THREE.DirectionalLight(0xffffff, 1.1);
  key.position.set(4, 6, 3);
  scene.add(key);
  const fill = new THREE.DirectionalLight(0x88aacc, 0.4);
  fill.position.set(-3, 2, -2);
  scene.add(fill);

  // Floor: a subtle dark plane plus a grid helper for spatial reference.
  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(8, 8),
    new THREE.MeshStandardMaterial({ color: 0x2a3340, roughness: 0.95, metalness: 0 })
  );
  floor.rotation.x = -Math.PI / 2;
  floor.position.y = 0;
  scene.add(floor);

  const grid = new THREE.GridHelper(8, 8, 0x4a5566, 0x303a48);
  (grid.material as THREE.Material).transparent = true;
  (grid.material as THREE.Material).opacity = 0.6;
  grid.position.y = 0.001;
  scene.add(grid);

  // Primitives — placed at the four corners of a 2-tile square so each pane
  // sees them spread out. Each primitive sits flush with the floor.
  type Primitive = {
    geometry: THREE.BufferGeometry;
    color: number;
    position: [number, number, number];
    rotationX?: number;
  };

  const primitives: Primitive[] = [
    {
      geometry: new THREE.SphereGeometry(0.6, 32, 24),
      color: 0xe06b6b,
      position: [-1.6, 0.6, -1.6]
    },
    {
      geometry: new THREE.BoxGeometry(1.1, 1.1, 1.1),
      color: 0x6bb56b,
      position: [1.6, 0.55, -1.6]
    },
    {
      geometry: new THREE.ConeGeometry(0.65, 1.4, 28),
      color: 0xe0c46b,
      position: [-1.6, 0.7, 1.6]
    },
    {
      geometry: new THREE.CylinderGeometry(0.55, 0.55, 1.3, 28),
      color: 0x6b9be0,
      position: [1.6, 0.65, 1.6]
    },
    {
      // Lay the torus flat so all panes see its ring profile.
      geometry: new THREE.TorusGeometry(0.55, 0.18, 16, 40),
      color: 0xc97be0,
      position: [0, 0.2, 0],
      rotationX: Math.PI / 2
    }
  ];

  for (const { geometry, color, position, rotationX } of primitives) {
    const mesh = new THREE.Mesh(
      geometry,
      new THREE.MeshStandardMaterial({ color, roughness: 0.45, metalness: 0.1 })
    );
    mesh.position.set(position[0], position[1], position[2]);
    if (rotationX !== undefined) {
      mesh.rotation.x = rotationX;
    }
    scene.add(mesh);
  }

  return scene;
}

function createPaneElement(parent: HTMLElement, spec: PaneSpec): HTMLDivElement {
  const el = document.createElement("div");
  el.style.position = "absolute";
  el.style.left = spec.left;
  el.style.top = spec.top;
  el.style.width = "50%";
  el.style.height = "50%";
  el.style.boxSizing = "border-box";
  el.style.borderRight = spec.left === "0%" ? "1px solid #2c333d" : "none";
  el.style.borderBottom = spec.top === "0%" ? "1px solid #2c333d" : "none";
  el.style.pointerEvents = "none";
  parent.appendChild(el);

  const label = document.createElement("div");
  label.textContent = spec.label;
  label.style.position = "absolute";
  label.style.top = "8px";
  label.style.left = "10px";
  label.style.font = "11px ui-monospace, SFMono-Regular, Menlo, monospace";
  label.style.color = "#cfd8e6";
  label.style.background = "rgba(11, 15, 20, 0.55)";
  label.style.padding = "2px 6px";
  label.style.borderRadius = "3px";
  label.style.pointerEvents = "none";
  el.appendChild(label);

  return el;
}

function createHud(mount: HTMLElement): HTMLDivElement {
  const hud = document.createElement("div");
  hud.textContent = "Drag (middle mouse) to pan · Scroll to zoom · Q / E to rotate — all panes move in unison";
  hud.style.position = "absolute";
  hud.style.bottom = "10px";
  hud.style.left = "50%";
  hud.style.transform = "translateX(-50%)";
  hud.style.font = "11px ui-monospace, SFMono-Regular, Menlo, monospace";
  hud.style.color = "#cfd8e6";
  hud.style.background = "rgba(11, 15, 20, 0.7)";
  hud.style.padding = "5px 10px";
  hud.style.borderRadius = "4px";
  hud.style.pointerEvents = "none";
  mount.appendChild(hud);
  return hud;
}

const experiment: ExperimentModule = {
  id: "primitive-views",
  title: "Primitive Views",
  tags: ["threejs", "pixel-perfect", "renderer", "demo"],

  init: ({ mount, width, height }) => {
    mount.style.position = "relative";
    mount.style.background = "#0b0f14";

    const scene = buildScene();

    const stage = new SharedScissorStage({
      mount,
      width,
      height,
      pixelRatio: Math.max(1, window.devicePixelRatio || 1),
      antialias: false,
      clearColor: 0x14181e,
      clearAlpha: 1
    });

    type PaneEntry = {
      spec: PaneSpec;
      element: HTMLDivElement;
      core: PixelPerfectViewportCore;
      pane: PixelPerfectScissorPane;
    };

    const panes: PaneEntry[] = PANE_SPECS.map((spec) => {
      const element = createPaneElement(mount, spec);
      const core = new PixelPerfectViewportCore({
        ...SHARED_VIEW_CONFIG,
        width: element.clientWidth || width / 2,
        height: element.clientHeight || height / 2,
        scene,
        cameraPitch: spec.cameraPitch,
        cameraYaw: spec.cameraYaw,
        clearColor: 0x14181e,
        // Pixel-perfect 2:1 stairs are crisp without MSAA — keep AA off so the
        // grid lines and primitive silhouettes show their true pixel pattern.
        lowTargetSamples: 0,
        maxBackingWidth: stage.maxBackingWidth,
        maxBackingHeight: stage.maxBackingHeight,
        devicePixelRatio: stage.getDevicePixelRatio()
      });
      const pane = new PixelPerfectScissorPane({
        id: spec.id,
        element,
        core,
        devicePixelRatio: stage.getDevicePixelRatio()
      });
      stage.registerPane(pane);
      return { spec, element, core, pane };
    });

    createHud(mount);

    // ------------------------------------------------------------------
    // Unison input — pointer events on any pane drive ALL panes at once.
    // We hit-test against the stage to find which pane the cursor is over,
    // then broadcast the same local pointer coordinates to every pane (as
    // PixelQuad does for the four iso angles).
    // ------------------------------------------------------------------

    let dragPointerId: number | null = null;

    const broadcastBeginDrag = (localX: number, localY: number): void => {
      for (const entry of panes) {
        entry.pane.beginPanDrag(localX, localY);
      }
    };

    const broadcastUpdateDrag = (localX: number, localY: number): void => {
      for (const entry of panes) {
        entry.pane.updatePanDrag(localX, localY);
      }
    };

    const broadcastEndDrag = (): void => {
      for (const entry of panes) {
        entry.pane.endPanDrag();
      }
    };

    const broadcastZoom = (
      direction: -1 | 1,
      localX: number,
      localY: number,
      nowMs: number
    ): void => {
      for (const entry of panes) {
        entry.pane.stepCameraZoomAtLocalCss(direction, localX, localY, nowMs);
      }
    };

    const broadcastRotate = (delta: -1 | 1): void => {
      for (const entry of panes) {
        entry.pane.rotateQuarterTurns(delta);
      }
    };

    const onPointerDown = (event: PointerEvent): void => {
      // Middle mouse pans, matching the convention in the rest of the project.
      if (event.button !== 1) return;
      const hit = stage.hitTestPane(event.clientX, event.clientY);
      if (!hit) return;
      broadcastBeginDrag(hit.localX, hit.localY);
      dragPointerId = event.pointerId;
      try {
        stage.canvas.setPointerCapture(event.pointerId);
      } catch {
        // no-op
      }
      event.preventDefault();
    };

    const onPointerMove = (event: PointerEvent): void => {
      if (dragPointerId == null || event.pointerId !== dragPointerId) return;
      const hit = stage.hitTestPane(event.clientX, event.clientY);
      if (!hit) return;
      broadcastUpdateDrag(hit.localX, hit.localY);
      event.preventDefault();
    };

    const onPointerUp = (event: PointerEvent): void => {
      if (dragPointerId == null || event.pointerId !== dragPointerId) return;
      dragPointerId = null;
      broadcastEndDrag();
      try {
        if (stage.canvas.hasPointerCapture(event.pointerId)) {
          stage.canvas.releasePointerCapture(event.pointerId);
        }
      } catch {
        // no-op
      }
      event.preventDefault();
    };

    const onAuxClick = (event: MouseEvent): void => {
      // Suppress the autoscroll affordance browsers attach to middle mouse.
      if (event.button === 1) {
        event.preventDefault();
      }
    };

    const onWheel = (event: WheelEvent): void => {
      const hit = stage.hitTestPane(event.clientX, event.clientY);
      if (!hit) return;
      if (event.deltaY === 0) return;
      const direction = (event.deltaY > 0 ? -1 : 1) as -1 | 1;
      broadcastZoom(direction, hit.localX, hit.localY, performance.now());
      event.preventDefault();
    };

    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.code === "KeyQ") {
        broadcastRotate(-1);
        event.preventDefault();
      } else if (event.code === "KeyE") {
        broadcastRotate(1);
        event.preventDefault();
      }
    };

    stage.canvas.addEventListener("pointerdown", onPointerDown);
    stage.canvas.addEventListener("pointermove", onPointerMove);
    stage.canvas.addEventListener("pointerup", onPointerUp);
    stage.canvas.addEventListener("pointercancel", onPointerUp);
    stage.canvas.addEventListener("auxclick", onAuxClick);
    stage.canvas.addEventListener("wheel", onWheel, { passive: false });
    window.addEventListener("keydown", onKeyDown);

    stage.start();

    return () => {
      stage.canvas.removeEventListener("pointerdown", onPointerDown);
      stage.canvas.removeEventListener("pointermove", onPointerMove);
      stage.canvas.removeEventListener("pointerup", onPointerUp);
      stage.canvas.removeEventListener("pointercancel", onPointerUp);
      stage.canvas.removeEventListener("auxclick", onAuxClick);
      stage.canvas.removeEventListener("wheel", onWheel);
      window.removeEventListener("keydown", onKeyDown);
      for (const entry of panes) {
        stage.unregisterPane(entry.spec.id);
        entry.element.remove();
      }
      stage.dispose();
      // Tear down scene resources.
      scene.traverse((obj) => {
        if (obj instanceof THREE.Mesh) {
          obj.geometry.dispose();
          const mat = obj.material;
          if (Array.isArray(mat)) {
            for (const m of mat) m.dispose();
          } else {
            mat.dispose();
          }
        }
      });
    };
  }
};

export default experiment;
