import type { ExperimentModule } from "../runtime/types";
import { createSceneKit, resizeSceneKit } from "./view/scene-setup";
import { createPreviewController } from "./view/preview-controller";
import { buildPieceMesh, disposePieceGroup } from "./view/piece-builder";
import { createPreviewMaterial, updatePreviewMaterialUniforms, materialKindChanged } from "./view/texture-baker";
import { buildControlPanel } from "./ui/control-panel";
import { wallGenReducer, initialState, stateToConfig } from "./ui/state";
import type { WallGenState, WallGenAction } from "./ui/state";
import { hasOpening } from "./model/piece-catalog";
import { PHASE1_PIECES } from "./model/piece-catalog";
import { exportCurrentPiece, exportTileset } from "./export/batch-runner";
import type { TilesetConfig } from "./model/types";
import * as THREE from "three";

const experiment: ExperimentModule = {
  id: "wall-generator",
  title: "Wall Generator",
  tags: ["threejs", "procedural", "csg", "shader", "export"],
  init: ({ mount, width, height, dpr }) => {
    // Scene
    const kit = createSceneKit(width, height, dpr);
    mount.appendChild(kit.renderer.domElement);
    kit.renderer.domElement.style.display = "block";

    // Preview controller
    const preview = createPreviewController(kit);

    // State
    let state = initialState();
    let currentGroup: THREE.Group | null = null;
    let currentMaterial: THREE.ShaderMaterial | null = null;

    // Track what changed for caching
    let lastGeometryKey = "";

    function geometryKey(s: WallGenState): string {
      return `${s.kind}|${s.dimensions.width}|${s.dimensions.height}|${s.dimensions.thickness}|${s.opening.width}|${s.opening.height}|${s.opening.offsetX}|${s.opening.offsetY}|${s.trim.enabled}|${s.trim.depth}|${s.trim.width}|${s.trim.topEnabled}|${s.trim.bottomEnabled}|${s.trim.openingEnabled}`;
    }

    function rebuildMesh() {
      // Remove old
      if (currentGroup) {
        kit.scene.remove(currentGroup);
        disposePieceGroup(currentGroup);
      }

      const config = stateToConfig(state);

      // Create or update material
      if (!currentMaterial || materialKindChanged(currentMaterial, state.material.kind)) {
        currentMaterial?.dispose();
        currentMaterial = createPreviewMaterial(
          state.material,
          state.dimensions,
          state.textureResolution,
        );
      } else {
        updatePreviewMaterialUniforms(
          currentMaterial,
          state.material,
          state.dimensions,
          state.textureResolution,
        );
      }

      // Build mesh
      currentGroup = buildPieceMesh(config, currentMaterial);
      kit.scene.add(currentGroup);
      lastGeometryKey = geometryKey(state);
    }

    function handleStateChange(newState: WallGenState) {
      const prevState = state;
      state = newState;

      // Check if geometry needs rebuild
      const newGeoKey = geometryKey(state);
      const geoChanged = newGeoKey !== lastGeometryKey;

      if (geoChanged) {
        rebuildMesh();
      } else {
        // Only material params changed — update uniforms
        if (currentMaterial) {
          if (materialKindChanged(currentMaterial, state.material.kind)) {
            rebuildMesh();
          } else {
            updatePreviewMaterialUniforms(
              currentMaterial,
              state.material,
              state.dimensions,
              state.textureResolution,
            );
          }
        }
      }

      // Update preview mode
      if (prevState.previewMode !== state.previewMode) {
        preview.setMode(state.previewMode);
      }

      // Update control panel
      panelController.update(state);
    }

    function dispatch(action: WallGenAction) {
      const newState = wallGenReducer(state, action);
      handleStateChange(newState);
    }

    // Control panel
    const panelController = buildControlPanel(mount, state, dispatch, {
      onExportPiece: async () => {
        dispatch({ type: "SET_EXPORTING", value: true });
        try {
          await exportCurrentPiece(stateToConfig(state), kit.renderer);
        } catch (e) {
          console.error("Export failed:", e);
        }
        dispatch({ type: "SET_EXPORTING", value: false });
      },
      onExportTileset: async () => {
        dispatch({ type: "SET_EXPORTING", value: true });
        try {
          const tilesetConfig: TilesetConfig = {
            pieces: PHASE1_PIECES,
            dimensions: state.dimensions,
            material: state.material,
            opening: state.opening,
            trim: state.trim,
            textureResolution: state.textureResolution,
          };
          await exportTileset(tilesetConfig, kit.renderer, (current, total) => {
            dispatch({ type: "SET_EXPORT_PROGRESS", value: current / total });
          });
        } catch (e) {
          console.error("Tileset export failed:", e);
        }
        dispatch({ type: "SET_EXPORTING", value: false });
      },
    });

    // Initial build
    rebuildMesh();

    // Resize
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const { width: w, height: h } = entry.contentRect;
        if (w > 0 && h > 0) {
          resizeSceneKit(kit, w, h);
        }
      }
    });
    observer.observe(mount);

    // Render loop
    let raf = 0;
    const render = () => {
      preview.update();
      kit.renderer.render(kit.scene, preview.getActiveCamera());
      raf = requestAnimationFrame(render);
    };
    render();

    // Cleanup
    return () => {
      cancelAnimationFrame(raf);
      observer.disconnect();
      preview.dispose();
      if (currentGroup) {
        kit.scene.remove(currentGroup);
        disposePieceGroup(currentGroup);
      }
      currentMaterial?.dispose();
      panelController.panel.remove();
      kit.dispose();
    };
  },
};

export default experiment;
