import * as THREE from "three";
import {
  SharedScissorStage,
  PixelPerfectIsoViewportCore,
  PixelPerfectIsoScissorPane
} from "@common/render";
import { bindSharedScissorStageInput } from "@common/input";
import {
  createEditorHud,
  createPromotedEditorControls,
  bakeLevelForEcs,
  serializeBakedLevel,
  LEVEL_EDITOR_WORLD_UNIT
} from "@common/level-editor";
import type { ExperimentModule } from "../runtime/types";

import { toBakeInput, clearStructures, clearGround, setDefaultGround } from "./editor-state";
import { GridRenderer } from "./grid-renderer";
import { SceneBuilder, LAYER_2D_TINT } from "./scene-builder";
import { bindPointerTools } from "./pointer-tools";
import { loadEditorState, debouncedSave } from "./persistence";
import { loadTilesetAssets } from "./tileset-loader";

const GRID_TILES = 20;
const CAMERA_DISTANCE = 50;
const TOP_DOWN_PITCH = Math.PI / 2 - 0.001;
const ISO_PITCH = Math.asin(1 / Math.sqrt(3));
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
    const leftCore = new PixelPerfectIsoViewportCore({
      ...SHARED_VIEW_CONFIG,
      width: leftPaneEl.clientWidth || width * 0.55,
      height: leftPaneEl.clientHeight || height,
      scene,
      cameraPitch: TOP_DOWN_PITCH,
      cameraYaw: 0,
      clearColor: 0x1a1e24,
      maxBackingWidth: stage.maxBackingWidth,
      maxBackingHeight: stage.maxBackingHeight,
      devicePixelRatio: stage.getDevicePixelRatio()
    });
    // 2D camera sees layer 0 (grid/terrain/3D originals) + layer 2 (tinted overlays)
    leftCore.camera.layers.enable(LAYER_2D_TINT);

    const leftPane = new PixelPerfectIsoScissorPane({
      id: "editor-2d",
      element: leftPaneEl,
      core: leftCore,
      devicePixelRatio: stage.getDevicePixelRatio()
    });
    stage.registerPane(leftPane);

    // Right pane: isometric 3D preview
    const rightCore = new PixelPerfectIsoViewportCore({
      ...SHARED_VIEW_CONFIG,
      width: rightPaneEl.clientWidth || width * 0.45,
      height: rightPaneEl.clientHeight || height,
      scene,
      cameraPitch: ISO_PITCH,
      cameraYaw: ISO_YAW,
      clearColor: 0x14181e,
      maxBackingWidth: stage.maxBackingWidth,
      maxBackingHeight: stage.maxBackingHeight,
      devicePixelRatio: stage.getDevicePixelRatio()
    });
    // 3D camera sees only layer 0 (default) — grid, terrain, and original structures

    const rightPane = new PixelPerfectIsoScissorPane({
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

    // Pane divs must not capture pointer events — let them fall through to the canvas
    leftPaneEl.style.pointerEvents = "none";
    rightPaneEl.style.pointerEvents = "none";

    // Pointer tools: LMB painting (left pane only, via canvas hit-testing)
    const pointerBinding = bindPointerTools(
      stage.canvas,
      (lx, ly, out) => {
        // Only paint when pointer is over the left (editor) pane
        const canvasRect = stage.canvas.getBoundingClientRect();
        const clientX = canvasRect.left + lx;
        const clientY = canvasRect.top + ly;
        const hit = stage.hitTestPane(clientX, clientY);
        if (!hit || hit.paneId !== "editor-2d") return false;
        return leftPane.worldAtLocalCss(hit.localX, hit.localY, out);
      },
      state,
      (target) => gridRenderer.setHover(target)
    );

    // --- HUD ---
    const hud = createEditorHud({
      mount,
      title: "Map Editor",
      description: "LMB: paint  |  Middle-mouse: pan  |  Scroll: zoom  |  Both panes navigate independently",
      hints: "",
      focusTarget: stage.canvas
    });

    const controls = createPromotedEditorControls({
      hud,
      initialSeed: 1337,
      onTool(mode) {
        pointerBinding.toolState.toolMode = mode;
        controls.toolButtons.forEach((btn, key) => hud.setButtonActive(btn, key === mode));
      },
      onBrush(brush) {
        pointerBinding.toolState.brush = brush;
        controls.brushButtons.forEach((btn, key) => hud.setButtonActive(btn, key === brush));
      },
      onRectTool() {},
      onDefaultGround(base) {
        setDefaultGround(state, base);
        controls.defaultGroundButtons.forEach((btn, key) => hud.setButtonActive(btn, key === base));
      },
      onSeed() {},
      onRotate(delta) {
        // Rotate the focused pane
        if (focusedPaneId === "editor-2d") leftPane.rotateQuarterTurns(delta);
        else if (focusedPaneId === "preview-3d") rightPane.rotateQuarterTurns(delta);
      },
      onResetView() {
        leftCore.reset();
        rightCore.reset();
      },
      onClearStructures() {
        clearStructures(state);
      },
      onClearGround() {
        clearGround(state);
      },
      onBake() {
        const input = toBakeInput(state);
        const baked = bakeLevelForEcs(input);
        const json = serializeBakedLevel(baked);
        console.log("[map-editor-2d] Baked level:", json);
        try {
          navigator.clipboard.writeText(json);
          hud.status.textContent = "Baked! JSON copied to clipboard.";
        } catch {
          hud.status.textContent = "Baked! Check console for JSON.";
        }
      }
    });

    // Set initial active states
    hud.setButtonActive(controls.toolButtons.get("draw")!, true);
    hud.setButtonActive(controls.brushButtons.get("wall")!, true);
    const defaultGroundBtn = controls.defaultGroundButtons.get(state.defaultGround as "floor" | "grass");
    if (defaultGroundBtn) hud.setButtonActive(defaultGroundBtn, true);

    // Keyboard shortcuts
    const onKeyDown = (event: KeyboardEvent): void => {
      const el = event.target as HTMLElement | null;
      if (el?.tagName === "INPUT" || el?.tagName === "TEXTAREA") return;

      switch (event.code) {
        case "KeyD": controls.toolButtons.get("draw")?.click(); break;
        case "KeyX": controls.toolButtons.get("erase")?.click(); break;
        case "Digit1": controls.brushButtons.get("wall")?.click(); break;
        case "Digit2": controls.brushButtons.get("window")?.click(); break;
        case "Digit3": controls.brushButtons.get("door-closed")?.click(); break;
        case "Digit4": controls.brushButtons.get("floor")?.click(); break;
        case "Digit5": controls.brushButtons.get("grass")?.click(); break;
        case "Digit6": controls.brushButtons.get("door-open")?.click(); break;
        case "Digit7": controls.brushButtons.get("road")?.click(); break;
        case "Digit8": controls.brushButtons.get("sidewalk")?.click(); break;
        case "KeyC": clearStructures(state); break;
        case "KeyV": clearGround(state); break;
        case "KeyB": controls.bakeButton.click(); break;
        default: return;
      }
      event.preventDefault();
    };
    window.addEventListener("keydown", onKeyDown);

    // Stats
    const updateStats = (): void => {
      hud.stats.textContent = [
        `Grid: ${state.grid.tiles}×${state.grid.tiles}`,
        `Structures: ${state.structures.size}`,
        `Terrain overrides: ${state.terrainOverrides.size}`
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
