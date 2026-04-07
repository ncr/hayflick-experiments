import * as THREE from "three";
import {
  SharedScissorStage,
  PixelPerfectViewportCore,
  PixelPerfectScissorPane
} from "@common/render";
import { bindSharedScissorStageInput } from "@common/input";
import {
  createEditorHud,
  LEVEL_EDITOR_WORLD_UNIT
} from "@common/level-editor";
import type { ExperimentModule } from "../runtime/types";

import { clearStructures, clearGround } from "./editor-state";
import { GridRenderer } from "./grid-renderer";
import { SceneBuilder, LAYER_2D_TINT } from "./scene-builder";
import { bindPointerTools, GROUND_BRUSHES, brushPlacement } from "./pointer-tools";
import type { ToolMode } from "./pointer-tools";
import type { HoverTarget } from "./grid-renderer";
import { loadEditorState, debouncedSave } from "./persistence";
import { loadTilesetAssets } from "./tileset-loader";
import type { TilesetAssets } from "./tileset-loader";

const GRID_TILES = 20;
const CAMERA_DISTANCE = 50;
const ISO_YAW = Math.PI / 4;

function createPaneElement(parent: HTMLElement, style: Partial<CSSStyleDeclaration>): HTMLDivElement {
  const el = document.createElement("div");
  el.style.position = "absolute";
  el.style.top = "0";
  el.style.height = "100%";
  Object.assign(el.style, style);
  parent.appendChild(el);
  return el;
}

const SHARED_VIEW_CONFIG = {
  fixedRenderHeight: 360,
  baseOrthoHeight: GRID_TILES * LEVEL_EDITOR_WORLD_UNIT * 0.8,
  cameraDistance: CAMERA_DISTANCE,
  basePixelZoom: 1,
  zoomMin: 0.5,
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

/** Build tile brush buttons from the kit manifest — one row, all tiles */
function buildTileBrushes(
  assets: TilesetAssets,
  hud: ReturnType<typeof createEditorHud>,
  onSelect: (tileName: string) => void
): Map<string, HTMLButtonElement> {
  const buttons = new Map<string, HTMLButtonElement>();
  const row = hud.createRow("Tiles");

  for (const [name] of assets.tiles) {
    const btn = hud.createButton(tileLabel(name), () => onSelect(name));
    buttons.set(name, btn);
    row.append(btn);
  }

  return buttons;
}

const experiment: ExperimentModule = {
  id: "map-editor-2d",
  title: "2D Map Editor",
  tags: ["editor", "level-design", "top-down"],

  async init(ctx) {
    const { mount, width, height } = ctx;
    mount.style.position = "relative";

    // Load editor state
    const state = loadEditorState();
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
      if (GROUND_BRUSHES.has(brush)) {
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
    const pointerBinding = bindPointerTools(
      stage.canvas,
      (lx, ly, out) => {
        const canvasRect = stage.canvas.getBoundingClientRect();
        const clientX = canvasRect.left + lx;
        const clientY = canvasRect.top + ly;
        const hit = stage.hitTestPane(clientX, clientY);
        if (!hit || hit.paneId !== "editor-2d") return false;
        return leftPane.worldAtLocalCss(hit.localX, hit.localY, out);
      },
      state,
      assets,
      (target) => {
        gridRenderer.setHover(target);
        lastHoverTarget = target;
        updatePreview();
      }
    );

    // --- HUD (built dynamically from kit manifest) ---
    const hud = createEditorHud({
      mount,
      title: "Map Editor",
      description: "LMB: paint  |  Middle-mouse: pan  |  Scroll: zoom",
      hints: "",
      focusTarget: stage.canvas
    });

    // Active brush tracking
    let activeBrush = pointerBinding.toolState.brush;
    const allBrushButtons = new Map<string, HTMLButtonElement>();

    function setActiveBrush(brush: string): void {
      activeBrush = brush;
      pointerBinding.toolState.brush = brush;
      for (const [key, btn] of allBrushButtons) {
        hud.setButtonActive(btn, key === brush);
      }
    }

    function setActiveToolMode(mode: ToolMode): void {
      pointerBinding.toolState.toolMode = mode;
      hud.setButtonActive(drawBtn, mode === "draw");
      hud.setButtonActive(eraseBtn, mode === "erase");
    }

    // Tool mode row
    const toolRow = hud.createRow("Tool");
    const drawBtn = hud.createButton("Draw (D)", () => setActiveToolMode("draw"));
    const eraseBtn = hud.createButton("Erase (X)", () => setActiveToolMode("erase"));
    toolRow.append(drawBtn, eraseBtn);

    // Structure brushes from kit manifest
    const tileBrushButtons = buildTileBrushes(assets, hud, setActiveBrush);
    for (const [name, btn] of tileBrushButtons) {
      allBrushButtons.set(name, btn);
    }

    // Ground brushes (static)
    const groundRow = hud.createRow("Ground");
    for (const ground of GROUND_BRUSHES) {
      const btn = hud.createButton(ground, () => setActiveBrush(ground));
      allBrushButtons.set(ground, btn);
      groundRow.append(btn);
    }

    // Camera controls
    const cameraRow = hud.createRow("Camera");
    const rotLeftBtn = hud.createButton("Rotate -90 (Q)", () => {
      if (focusedPaneId === "editor-2d") leftPane.rotateQuarterTurns(-1);
      else if (focusedPaneId === "preview-3d") rightPane.rotateQuarterTurns(-1);
    });
    const rotRightBtn = hud.createButton("Rotate +90 (E)", () => {
      if (focusedPaneId === "editor-2d") leftPane.rotateQuarterTurns(1);
      else if (focusedPaneId === "preview-3d") rightPane.rotateQuarterTurns(1);
    });
    const resetBtn = hud.createButton("Reset View", () => {
      leftCore.reset();
      rightCore.reset();
    });
    cameraRow.append(rotLeftBtn, rotRightBtn, resetBtn);

    // Utility
    const utilRow = hud.createRow("Scene");
    const clearWallsBtn = hud.createButton("Clear Walls (C)", () => clearStructures(state));
    const clearGroundBtn = hud.createButton("Clear Ground (V)", () => clearGround(state));
    utilRow.append(clearWallsBtn, clearGroundBtn);

    // Set initial active states
    hud.setButtonActive(drawBtn, true);
    setActiveBrush(activeBrush);

    // Keyboard shortcuts — number keys map to brush buttons in order
    const orderedBrushKeys = [...allBrushButtons.keys()];

    const onKeyDown = (event: KeyboardEvent): void => {
      const el = event.target as HTMLElement | null;
      if (el?.tagName === "INPUT" || el?.tagName === "TEXTAREA") return;

      switch (event.code) {
        case "KeyD": setActiveToolMode("draw"); break;
        case "KeyX": setActiveToolMode("erase"); break;
        case "KeyR": {
          pointerBinding.toolState.vertexRotation = (pointerBinding.toolState.vertexRotation + 1) & 3;
          sceneBuilder.invalidatePreview();
          updatePreview();
          hud.status.textContent = `Rotation: ${pointerBinding.toolState.vertexRotation * 90}°`;
          break;
        }
        case "KeyC": clearStructures(state); break;
        case "KeyV": clearGround(state); break;
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

    // Stats
    const updateStats = (): void => {
      hud.stats.textContent = [
        `Grid: ${state.grid.tiles}×${state.grid.tiles}`,
        `Edges: ${state.edgeStructures.size}`,
        `Cells: ${state.cellStructures.size}`,
        `Vertices: ${state.vertexStructures.size}`,
        `Terrain: ${state.terrainOverrides.size}`
      ].join("\n");
    };

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
      updateStats();
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
      pointerBinding.unbind();
      unbindStageInput();
      hud.destroy();
      gridRenderer.dispose();
      sceneBuilder.dispose();
      stage.dispose();
      leftPaneEl.remove();
      rightPaneEl.remove();
    };
  }
};

export default experiment;
