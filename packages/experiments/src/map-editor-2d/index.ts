import * as THREE from "three";
import {
  SharedScissorStage,
  PixelPerfectViewportCore,
  PixelPerfectScissorPane
} from "@common/render";
import { bindSharedScissorStageInput } from "@common/input";
import { LEVEL_EDITOR_WORLD_UNIT, levelBuilderEdgeKey } from "@common/level-editor";
import type { ExperimentModule } from "../runtime/types";

import { clearAll, createUndoManager } from "./editor-state";
import { GridRenderer } from "./grid-renderer";
import { SceneBuilder, LAYER_2D_TINT, LAYER_3D_ONLY } from "./scene-builder";
import { bindPointerTools, brushPlacement, ERASER_BRUSH, SELECT_BRUSH } from "./pointer-tools";
import {
  removeEdgeStructure,
  removeCellStructure,
  removeVertexStructure,
  setEdgeStructure,
  setVertexStructure
} from "./editor-state";
import type { HoverTarget } from "./grid-renderer";
import { loadEditorState, debouncedSave } from "./persistence";
import { loadTilesetAssets } from "./tileset-loader";
import { createEditorToolbar, TOOLBAR_HEIGHT } from "./editor-toolbar";
import { createTilePalette, TILE_PALETTE_WIDTH } from "./tile-palette";

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
  baseOrthoHeight: GRID_TILES * LEVEL_EDITOR_WORLD_UNIT * 0.4,
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
    const sceneBuilder = new SceneBuilder(assets, state.grid.tileSize);
    scene.add(sceneBuilder.root);
    scene.add(sceneBuilder.preview);
    scene.add(sceneBuilder.selectionHighlight);

    // --- Dual-pane layout ---
    // Left pane is anchored to both edges so the tile palette (between the
    // two panes) gets a fixed-width gutter while the 3D preview keeps its 45%.
    const leftPaneEl = createPaneElement(mount, {
      left: "0",
      right: `calc(45% + ${TILE_PALETTE_WIDTH}px)`
    });
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
      zoomMin: 0.25,
      width: leftPaneEl.clientWidth || Math.max(1, width * 0.55 - TILE_PALETTE_WIDTH),
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
    rightCore.camera.layers.enable(LAYER_3D_ONLY);

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
      if (brush === ERASER_BRUSH || brush === SELECT_BRUSH) {
        sceneBuilder.clearPreview();
        // In select mode, show direction arrow on hovered edges
        if (brush === SELECT_BRUSH && target.kind === "edge") {
          const key = levelBuilderEdgeKey(target.ax, target.az, target.bx, target.bz);
          const edge = state.edgeStructures.get(key);
          if (edge && !pointerBinding.toolState.selection) {
            const wx = state.grid.origin + ((target.ax + target.bx) / 2) * state.grid.tileSize;
            const wz = state.grid.origin + ((target.az + target.bz) / 2) * state.grid.tileSize;
            const isVertical = target.ax === target.bx;
            const yaw = (isVertical ? Math.PI / 2 : 0) + (edge.flipped ? Math.PI : 0);
            sceneBuilder.setSelection("edge", wx, wz, yaw);
          }
        } else if (brush === SELECT_BRUSH && !pointerBinding.toolState.selection) {
          sceneBuilder.setSelection(null);
        }
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
        const baseYaw = target.ax === target.bx ? Math.PI / 2 : 0;
        yaw = baseYaw + (pointerBinding.toolState.edgeFlipped ? Math.PI : 0);
      } else {
        sceneBuilder.clearPreview();
        return;
      }
      const isEdgeBrush = brushPlacement(brush, assets) === "edge";
      sceneBuilder.setPreview(brush, wx, wz, yaw, isEdgeBrush);
    }

    function updateSelectionHighlight(sel: import("./pointer-tools").Selection): void {
      if (!sel) {
        sceneBuilder.setSelection(null);
        return;
      }
      const g = state.grid;
      if (sel.kind === "edge") {
        const edge = state.edgeStructures.get(sel.key);
        const wx = g.origin + ((sel.ax + sel.bx) / 2) * g.tileSize;
        const wz = g.origin + ((sel.az + sel.bz) / 2) * g.tileSize;
        const isVertical = sel.ax === sel.bx;
        const yaw = (isVertical ? Math.PI / 2 : 0) + (edge?.flipped ? Math.PI : 0);
        sceneBuilder.setSelection("edge", wx, wz, yaw);
      } else if (sel.kind === "cell") {
        const wx = g.origin + (sel.x + 0.5) * g.tileSize;
        const wz = g.origin + (sel.z + 0.5) * g.tileSize;
        sceneBuilder.setSelection("cell", wx, wz);
      } else if (sel.kind === "vertex") {
        const wx = g.origin + sel.x * g.tileSize;
        const wz = g.origin + sel.z * g.tileSize;
        sceneBuilder.setSelection("vertex", wx, wz);
      }
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
      },
      onSelectionChange: (sel) => {
        updateSelectionHighlight(sel);
      }
    });

    // --- Toolbar (commands only — brushes live in the side palette) ---
    const toolbar = createEditorToolbar({ mount, focusTarget: stage.canvas });

    // Undo / Redo / Clear All group
    const actionGroup = toolbar.createGroup("");
    const undoBtn = toolbar.createButton("Undo", () => undoManager.undo(state));
    const redoBtn = toolbar.createButton("Redo", () => undoManager.redo(state));
    const clearAllBtn = toolbar.createButton("Clear All", () => {
      undoManager.checkpoint(state);
      clearAll(state);
    });
    actionGroup.append(undoBtn, toolbar.createSeparator(), redoBtn, toolbar.createSeparator(), clearAllBtn);

    // Reload kits — fetches manifests + GLBs again. Brutal page reload
    // (kit data is loaded once at init); structures survive via localStorage
    // and the URL hash brings us back to this experiment.
    const fileGroup = toolbar.createGroup("");
    const reloadBtn = toolbar.createButton("Reload Kits", () => {
      location.reload();
    });
    fileGroup.append(reloadBtn);

    // --- Tile palette (right of the 2D pane) ---
    const palette = createTilePalette({
      mount,
      tilesets: assets.tilesets,
      topOffset: TOOLBAR_HEIGHT,
      focusTarget: stage.canvas,
      onSelect: (key) => setActiveBrush(key)
    });

    // Active brush tracking
    let activeBrush = pointerBinding.toolState.brush;

    function setActiveBrush(brush: string): void {
      activeBrush = brush;
      pointerBinding.toolState.brush = brush;
      palette.setActiveBrush(brush);
      if (brush !== SELECT_BRUSH) {
        pointerBinding.toolState.selection = null;
        sceneBuilder.setSelection(null);
      }
    }

    // Set initial active brush
    setActiveBrush(activeBrush);

    // Keyboard shortcuts (Digit1..Digit9 → palette brushes in display order)
    const orderedBrushKeys = palette.orderedBrushKeys;

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
          const sel = pointerBinding.toolState.selection;
          if (pointerBinding.toolState.brush === SELECT_BRUSH && sel) {
            // Rotate the selected placed tile
            undoManager.checkpoint(state);
            if (sel.kind === "edge") {
              const edge = state.edgeStructures.get(sel.key);
              if (edge) {
                setEdgeStructure(state, edge.ax, edge.az, edge.bx, edge.bz, edge.tileName, !edge.flipped);
                updateSelectionHighlight(sel);
              }
            } else if (sel.kind === "vertex") {
              const vtx = state.vertexStructures.get(sel.key);
              if (vtx) {
                setVertexStructure(state, vtx.x, vtx.z, vtx.tileName, (vtx.rotation + 3) & 3);
              }
            }
          } else {
            const placement = brushPlacement(pointerBinding.toolState.brush, assets);
            if (placement === "edge") {
              pointerBinding.toolState.edgeFlipped = !pointerBinding.toolState.edgeFlipped;
            } else {
              pointerBinding.toolState.vertexRotation = (pointerBinding.toolState.vertexRotation + 3) & 3;
            }
            sceneBuilder.invalidatePreview();
            updatePreview();
            toolbar.setRotation(pointerBinding.toolState.vertexRotation * 90);
          }
          break;
        }
        case "Backspace":
        case "Delete": {
          const sel = pointerBinding.toolState.selection;
          if (pointerBinding.toolState.brush === SELECT_BRUSH && sel) {
            undoManager.checkpoint(state);
            if (sel.kind === "edge") {
              removeEdgeStructure(state, sel.ax, sel.az, sel.bx, sel.bz);
            } else if (sel.kind === "cell") {
              removeCellStructure(state, sel.x, sel.z);
            } else if (sel.kind === "vertex") {
              removeVertexStructure(state, sel.x, sel.z);
            }
            pointerBinding.toolState.selection = null;
            sceneBuilder.setSelection(null);
          }
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
      palette.destroy();
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
