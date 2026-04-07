import * as THREE from "three";
import {
  SharedScissorStage,
  PixelPerfectViewportCore,
  PixelPerfectScissorPane
} from "@common/render";
import { bindSharedScissorStageInput } from "@common/input";
import { LEVEL_EDITOR_WORLD_UNIT } from "@common/level-editor";
import type { ExperimentModule } from "../runtime/types";

import { clearAll, createUndoManager } from "./editor-state";
import { GridRenderer } from "./grid-renderer";
import { SceneBuilder, LAYER_2D_TINT } from "./scene-builder";
import { bindPointerTools, ERASER_BRUSH } from "./pointer-tools";
import type { HoverTarget } from "./grid-renderer";
import { loadEditorState, debouncedSave } from "./persistence";
import { loadTilesetAssets } from "./tileset-loader";
import { createEditorToolbar, TOOLBAR_HEIGHT } from "./editor-toolbar";

const GRID_TILES = 20;
const CAMERA_DISTANCE = 50;
const ISO_YAW = Math.PI / 4;

function createPaneElement(parent: HTMLElement, style: Partial<CSSStyleDeclaration>): HTMLDivElement {
  const el = document.createElement("div");
  el.style.position = "absolute";
  el.style.top = `${TOOLBAR_HEIGHT}px`;
  el.style.height = `calc(100% - ${TOOLBAR_HEIGHT}px)`;
  Object.assign(el.style, style);
  parent.appendChild(el);
  return el;
}

const SHARED_VIEW_CONFIG = {
  fixedRenderHeight: 360,
  baseOrthoHeight: GRID_TILES * LEVEL_EDITOR_WORLD_UNIT * 0.8,
  cameraDistance: CAMERA_DISTANCE,
  basePixelZoom: 1,
  zoomMin: 1,
  zoomMax: 6,
  zoomStep: 0.5,
  zoomAnimationRate: 12,
  zoomAnimationBurstRate: 24,
  zoomAnimationEpsilon: 0.01,
  rotationAnimationRate: 12,
  rotationAnimationEpsilon: 0.005,
  zoomBurstIdleMs: 300,
  outputOverscanLowPixels: 2
};

/** Human-friendly label for a tile name */
function tileLabel(name: string): string {
  return name.replace(/_/g, " ");
}

const experiment: ExperimentModule = {
  id: "map-editor-2d",
  title: "2D Map Editor",
  tags: ["editor", "level-design", "top-down"],

  async init(ctx) {
    const { mount, width, height } = ctx;
    mount.style.position = "relative";

    // Load editor state + undo manager
    const state = loadEditorState();
    const undoManager = createUndoManager(50);
    let lastSavedRevision = state.revision;

    // Scene (shared by both panes)
    const scene = new THREE.Scene();

    // Lighting (for 3D pane; MeshBasicMaterial ignores it)
    const ambient = new THREE.AmbientLight(0xffffff, 0.7);
    scene.add(ambient);
    const dirLight = new THREE.DirectionalLight(0xffffff, 0.9);
    dirLight.position.set(5, 10, 7);
    scene.add(dirLight);

    // Grid renderer (grid lines + terrain cells + hover)
    const gridRenderer = new GridRenderer(state.grid);
    scene.add(gridRenderer.root);

    // Load tileset assets and create scene builder
    const assets = await loadTilesetAssets();
    const sceneBuilder = new SceneBuilder(assets);
    scene.add(sceneBuilder.root);
    scene.add(sceneBuilder.preview);

    // --- Dual-pane layout ---
    const leftPaneEl = createPaneElement(mount, { left: "0", width: "55%" });
    const rightPaneEl = createPaneElement(mount, { right: "0", width: "45%" });

    const stage = new SharedScissorStage({
      mount,
      width,
      height,
      pixelRatio: Math.max(1, window.devicePixelRatio || 1),
      antialias: false,
      clearColor: 0x1a1e24,
      clearAlpha: 1
    });

    // Left pane: top-down 2D editor
    const leftCore = new PixelPerfectViewportCore({
      ...SHARED_VIEW_CONFIG,
      width: leftPaneEl.clientWidth || width * 0.55,
      height: leftPaneEl.clientHeight || height,
      scene,
      cameraPitch: "top-down",
      cameraYaw: 0,
      clearColor: 0x1a1e24,
      maxBackingWidth: stage.maxBackingWidth,
      maxBackingHeight: stage.maxBackingHeight,
      devicePixelRatio: stage.getDevicePixelRatio()
    });
    leftCore.camera.layers.enable(LAYER_2D_TINT);

    const leftPane = new PixelPerfectScissorPane({
      id: "editor-2d",
      element: leftPaneEl,
      core: leftCore,
      devicePixelRatio: stage.getDevicePixelRatio()
    });
    stage.registerPane(leftPane);

    // Right pane: isometric 3D preview
    const rightCore = new PixelPerfectViewportCore({
      ...SHARED_VIEW_CONFIG,
      width: rightPaneEl.clientWidth || width * 0.45,
      height: rightPaneEl.clientHeight || height,
      scene,
      cameraPitch: "iso-2to1",
      cameraYaw: ISO_YAW,
      clearColor: 0x14181e,
      maxBackingWidth: stage.maxBackingWidth,
      maxBackingHeight: stage.maxBackingHeight,
      devicePixelRatio: stage.getDevicePixelRatio(),
      lowTargetSamples: 0
    });

    const rightPane = new PixelPerfectScissorPane({
      id: "preview-3d",
      element: rightPaneEl,
      core: rightCore,
      devicePixelRatio: stage.getDevicePixelRatio()
    });
    stage.registerPane(rightPane);

    // --- Input ---
    let focusedPaneId: string | null = "editor-2d";

    const unbindStageInput = bindSharedScissorStageInput({
      stage,
      getFocusedPaneId: () => focusedPaneId,
      setFocusedPaneId: (id) => { focusedPaneId = id; },
      getPaneInputTarget: (id) => {
        if (id === "editor-2d") return leftPane;
        if (id === "preview-3d") return rightPane;
        return null;
      }
    });

    // Hover-based pane focus (Q/E works on whichever pane the mouse is over)
    const onHoverFocus = (event: PointerEvent): void => {
      const hit = stage.hitTestPane(event.clientX, event.clientY);
      if (hit) focusedPaneId = hit.paneId;
    };
    stage.canvas.addEventListener("pointermove", onHoverFocus);

    leftPaneEl.style.pointerEvents = "none";
    rightPaneEl.style.pointerEvents = "none";

    // Preview ghost — shared state so R key can trigger re-render
    let lastHoverTarget: HoverTarget = null;

    function updatePreview(): void {
      const target = lastHoverTarget;
      if (!target) {
        sceneBuilder.clearPreview();
        return;
      }
      const brush = pointerBinding.toolState.brush;
      if (brush === ERASER_BRUSH) {
        sceneBuilder.clearPreview();
        return;
      }

      let wx: number, wz: number, yaw: number;
      if (target.kind === "vertex") {
        wx = state.grid.origin + target.x * state.grid.tileSize;
        wz = state.grid.origin + target.z * state.grid.tileSize;
        yaw = (pointerBinding.toolState.vertexRotation & 3) * (Math.PI / 2);
      } else if (target.kind === "cell") {
        wx = state.grid.origin + (target.x + 0.5) * state.grid.tileSize;
        wz = state.grid.origin + (target.z + 0.5) * state.grid.tileSize;
        yaw = 0;
      } else if (target.kind === "edge") {
        wx = state.grid.origin + ((target.ax + target.bx) / 2) * state.grid.tileSize;
        wz = state.grid.origin + ((target.az + target.bz) / 2) * state.grid.tileSize;
        yaw = target.ax === target.bx ? Math.PI / 2 : 0;
      } else {
        sceneBuilder.clearPreview();
        return;
      }
      sceneBuilder.setPreview(brush, wx, wz, yaw);
    }

    // Pointer tools
    const pointerBinding = bindPointerTools({
      element: stage.canvas,
      worldAtLocal: (lx, ly, out) => {
        const canvasRect = stage.canvas.getBoundingClientRect();
        const clientX = canvasRect.left + lx;
        const clientY = canvasRect.top + ly;
        const hit = stage.hitTestPane(clientX, clientY);
        if (!hit || hit.paneId !== "editor-2d") return false;
        return leftPane.worldAtLocalCss(hit.localX, hit.localY, out);
      },
      state,
      assets,
      onHover: (target) => {
        gridRenderer.setHover(target);
        lastHoverTarget = target;
        updatePreview();
      },
      onBeforeDrag: () => {
        undoManager.checkpoint(state);
      }
    });

    // --- Toolbar ---
    const toolbar = createEditorToolbar({ mount, focusTarget: stage.canvas });

    // Active brush tracking
    let activeBrush = pointerBinding.toolState.brush;
    const allBrushButtons = new Map<string, HTMLButtonElement>();

    function setActiveBrush(brush: string): void {
      activeBrush = brush;
      pointerBinding.toolState.brush = brush;
      for (const [key, btn] of allBrushButtons) {
        toolbar.setButtonActive(btn, key === brush);
      }
    }

    // Undo / Redo / Clear All group
    const actionGroup = toolbar.createGroup("");
    const undoBtn = toolbar.createButton("Undo", () => undoManager.undo(state));
    const redoBtn = toolbar.createButton("Redo", () => undoManager.redo(state));
    const clearAllBtn = toolbar.createButton("Clear All", () => {
      undoManager.checkpoint(state);
      clearAll(state);
    });
    actionGroup.append(undoBtn, toolbar.createSeparator(), redoBtn, toolbar.createSeparator(), clearAllBtn);

    // Tileset tile brushes (grouped by tileset name)
    const tilesetGroup = toolbar.createGroup(tileLabel(assets.manifest.name));
    for (const [name] of assets.tiles) {
      const btn = toolbar.createButton(tileLabel(name), () => setActiveBrush(name));
      allBrushButtons.set(name, btn);
      tilesetGroup.append(btn);
    }

    // Eraser
    const eraserGroup = toolbar.createGroup("");
    const eraserBtn = toolbar.createButton("Eraser", () => setActiveBrush(ERASER_BRUSH));
    allBrushButtons.set(ERASER_BRUSH, eraserBtn);
    eraserGroup.append(eraserBtn);

    // Set initial active brush
    setActiveBrush(activeBrush);

    // Keyboard shortcuts
    const orderedBrushKeys = [...allBrushButtons.keys()];

    const onKeyDown = (event: KeyboardEvent): void => {
      const el = event.target as HTMLElement | null;
      if (el?.tagName === "INPUT" || el?.tagName === "TEXTAREA") return;

      // Undo: Ctrl+Z / Cmd+Z
      if (event.code === "KeyZ" && (event.ctrlKey || event.metaKey) && !event.shiftKey) {
        undoManager.undo(state);
        event.preventDefault();
        return;
      }
      // Redo: Ctrl+Shift+Z / Cmd+Shift+Z
      if (event.code === "KeyZ" && (event.ctrlKey || event.metaKey) && event.shiftKey) {
        undoManager.redo(state);
        event.preventDefault();
        return;
      }
      // Redo: Ctrl+Y / Cmd+Y
      if (event.code === "KeyY" && (event.ctrlKey || event.metaKey)) {
        undoManager.redo(state);
        event.preventDefault();
        return;
      }

      switch (event.code) {
        case "KeyR": {
          pointerBinding.toolState.vertexRotation = (pointerBinding.toolState.vertexRotation + 1) & 3;
          sceneBuilder.invalidatePreview();
          updatePreview();
          toolbar.setRotation(pointerBinding.toolState.vertexRotation * 90);
          break;
        }
        default: {
          // Digit1-Digit9 → select brush by index
          const match = event.code.match(/^Digit(\d)$/);
          if (match) {
            const idx = parseInt(match[1], 10) - 1;
            if (idx >= 0 && idx < orderedBrushKeys.length) {
              setActiveBrush(orderedBrushKeys[idx]);
              event.preventDefault();
            }
          }
          return;
        }
      }
      event.preventDefault();
    };
    window.addEventListener("keydown", onKeyDown);

    // Resize
    const resizeObserver = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const { width: w, height: h } = entry.contentRect;
        if (w > 0 && h > 0) {
          stage.resize(w, h, Math.max(1, window.devicePixelRatio || 1));
        }
      }
    });
    resizeObserver.observe(mount);

    // Animation loop
    let lastTime = performance.now();
    let animId = 0;

    const frame = (now: number): void => {
      animId = requestAnimationFrame(frame);
      const dt = Math.min((now - lastTime) / 1000, 0.1);
      lastTime = now;

      gridRenderer.update(state);
      sceneBuilder.update(state);

      toolbar.setStats(
        `${state.grid.tiles}\u00d7${state.grid.tiles} | E:${state.edgeStructures.size} C:${state.cellStructures.size} V:${state.vertexStructures.size}`
      );
      toolbar.setUndoRedoEnabled(undoManager.canUndo(), undoManager.canRedo());

      stage.drawFrame(now, dt);

      if (state.revision !== lastSavedRevision) {
        lastSavedRevision = state.revision;
        debouncedSave(state);
      }
    };
    animId = requestAnimationFrame(frame);

    // Cleanup
    return () => {
      cancelAnimationFrame(animId);
      resizeObserver.disconnect();
      window.removeEventListener("keydown", onKeyDown);
      stage.canvas.removeEventListener("pointermove", onHoverFocus);
      pointerBinding.unbind();
      unbindStageInput();
      toolbar.destroy();
      gridRenderer.dispose();
      sceneBuilder.dispose();
      stage.dispose();
      leftPaneEl.remove();
      rightPaneEl.remove();
    };
  }
};

export default experiment;
