import { useEffect, useState } from "react";
import { useForgeState, useForgeDispatch, useForgeRefs } from "../../state/forge-context";
import { useViewportSync } from "../../hooks/useViewportSync";
import { usePipelineActions } from "../../hooks/usePipelineActions";
import { OutdatedBanner } from "../shared/OutdatedBanner";
import {
  ForgeScissorViewportPane,
  ForgeScissorViewportStage,
} from "../../ScissorViewport3d";
import { PixelQuad } from "../../PixelQuad";
import type * as THREE from "three";
import type { PixelViewportViewState } from "../../../forge/ViewportPixel";
import type { ForgeV2GenerationDraftProp } from "../../types";
import type { PivotPreset, ScaleMode } from "../../../forge/processing/dimensions";

type ScaleModeV2 = ScaleMode | "depth";
const UNIT_SCALE_METERS_PER_UNIT = 1.28;

export function MeshWorkspace() {
  const state = useForgeState();
  const dispatch = useForgeDispatch();
  const refs = useForgeRefs();
  const viewportSync = useViewportSync();
  const actions = usePipelineActions();

  const draft = state.selectedDraftId ? state.drafts.get(state.selectedDraftId) ?? null : null;
  const [pixelModel, setPixelModel] = useState<THREE.Group | null>(null);
  const [pixelBaseViewState, setPixelBaseViewState] = useState<PixelViewportViewState>({
    target: [0, 0, 0],
    yawTurns: 0,
    zoom: 1,
  });

  // Rebuild preview when draft changes
  useEffect(() => {
    if (!draft?.rawGlb) {
      setPixelModel(null);
      return;
    }
    void actions.rebuildSelectedDraftPreview().then((result) => {
      if (result?.pixelModel) {
        setPixelModel(result.pixelModel);
      }
    });
  }, [
    draft?.tempId,
    draft?.rawGlb,
    draft?.textureResolution,
    draft?.scaleMode,
    draft?.targetDimension,
    draft?.pivot,
    draft?.meshRevision,
  ]);

  // Sync pixel camera from draft
  useEffect(() => {
    if (!draft) return;
    setPixelBaseViewState({
      target: draft.pixelCamera.target,
      yawTurns: draft.pixelCamera.yawTurns,
      zoom: draft.pixelCamera.zoomLevel,
    });
  }, [draft?.tempId]);

  // Set default visibility
  useEffect(() => {
    const vp = refs.generationViewport.current;
    if (!vp) return;
    vp.setModelVisible(true);
    vp.setColliderVisible(false);
    vp.setGridVisible(true);
    vp.setAxesVisible(true);
    vp.setBBoxVisible(false);
  }, [refs.generationViewport]);

  const generating = draft?.status === "generating-mesh";
  const hasMesh = !!draft?.rawGlb;

  return (
    <div className="ps-mesh-workspace">
      {/* Top bar: face limit + generate */}
      {draft && state.mesh.status === "OUTDATED" && (
        <OutdatedBanner message="Reference image changed. Regenerate mesh to update." />
      )}
      {draft && (
        <div className="ps-mesh-prompt-row">
          <label className="ps-label">Faces</label>
          <input
            type="number"
            className="ps-input ps-input-sm"
            min={1000}
            max={100000}
            step={1000}
            value={draft.faceLimit}
            onChange={(e) =>
              dispatch({
                type: "UPDATE_DRAFT",
                id: draft.tempId,
                patch: { faceLimit: Math.max(1000, Number(e.target.value) || 5000) },
              })
            }
            disabled={generating}
          />
          <button
            className="forge-btn forge-btn-primary"
            onClick={() => void actions.runMeshGenerationForDraft(draft)}
            disabled={!draft.conceptImage || generating}
          >
            {generating ? "Generating..." : hasMesh ? "Regen Mesh" : "Generate Mesh"}
          </button>
          {draft.meshProgressLabel && generating && (
            <span className="ps-text-muted">{draft.meshProgressLabel}</span>
          )}
        </div>
      )}

      {/* Main area: viewport left, options right */}
      <div className="ps-mesh-split">
        {/* Left: 3D viewport */}
        <ForgeScissorViewportStage className="ps-mesh-viewport-col">
          <div className="ps-viewport-labeled">
            <div className="ps-viewport-label">Mesh</div>
            <ForgeScissorViewportPane
              paneId="generation-mesh"
              className="ps-viewport-host ps-viewport-host-interactive"
              ref={refs.generationViewport}
              interactive
              onViewChange={viewportSync.handleMeshViewChange}
            />
          </div>
        </ForgeScissorViewportStage>

        {/* Right: options panel */}
        <div className="ps-mesh-options-col">
          {/* Pixel quad */}
          <ForgeScissorViewportStage className="ps-mesh-pixel-stage">
            <PixelQuad
              model={pixelModel}
              baseViewState={pixelBaseViewState}
              onBaseViewStateChange={(newState) => {
                setPixelBaseViewState(newState);
                viewportSync.handlePixelBaseViewChange(newState);
              }}
              className="ps-pixel-strip"
              interactive={false}
              viewportFramingScale={1.28}
            />
          </ForgeScissorViewportStage>

          {/* Mesh settings — only when mesh exists */}
          {hasMesh && draft && (
            <MeshSettings draft={draft} dispatch={dispatch} />
          )}

          {/* Approve generation */}
          {hasMesh && draft && (
            <div className="ps-mesh-approve">
              <button
                className="forge-btn forge-btn-primary"
                onClick={() => void actions.approveSelectedDraftGeneration()}
                disabled={!draft.rawGlb || !draft.conceptImage}
              >
                {draft.generationApprovedAt ? "Re-Approve Generation" : "Approve Generation"}
              </button>
              {draft.generationApprovedAt && (
                <span className="ps-text-success">
                  Approved {new Date(draft.generationApprovedAt).toLocaleString()}
                </span>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Mesh settings (texture, scale, pivot)                                      */
/* -------------------------------------------------------------------------- */

function MeshSettings({
  draft,
  dispatch,
}: {
  draft: ForgeV2GenerationDraftProp;
  dispatch: ReturnType<typeof useForgeDispatch>;
}) {
  return (
    <div className="ps-mesh-settings-panel">
      {draft.bboxProcessed && (
        <div className="ps-text-muted" style={{ marginBottom: 8 }}>
          {draft.processedFaces || draft.originalFaces || 0} faces ·{" "}
          {draft.bboxProcessed.width.toFixed(2)}×{draft.bboxProcessed.height.toFixed(2)}×{draft.bboxProcessed.depth.toFixed(2)}u ·{" "}
          scale {draft.scale.toFixed(3)}
        </div>
      )}
      <div className="ps-field">
        <label className="ps-label">Texture</label>
        <select
          className="ps-select ps-select-sm"
          value={draft.textureResolution}
          onChange={(e) =>
            dispatch({
              type: "UPDATE_DRAFT",
              id: draft.tempId,
              patch: { textureResolution: Number(e.target.value) },
            })
          }
        >
          <option value={0}>Original</option>
          <option value={1024}>1024px</option>
          <option value={512}>512px</option>
          <option value={256}>256px</option>
          <option value={128}>128px</option>
        </select>
      </div>
      <div className="ps-field">
        <label className="ps-label">Scale</label>
        <select
          className="ps-select ps-select-sm"
          value={draft.scaleMode}
          onChange={(e) =>
            dispatch({
              type: "UPDATE_DRAFT",
              id: draft.tempId,
              patch: { scaleMode: e.target.value as ScaleModeV2 },
            })
          }
        >
          <option value="height">Height</option>
          <option value="width">Width</option>
          <option value="depth">Depth</option>
          <option value="max">Max Dim</option>
          <option value="manual">Manual</option>
        </select>
      </div>
      <div className="ps-field">
        <label className="ps-label">{draft.scaleMode === "manual" ? "Factor" : "Target"}</label>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <input
            type="number"
            className="ps-input ps-input-sm"
            min={0.01}
            step={0.01}
            value={draft.targetDimension}
            onChange={(e) =>
              dispatch({
                type: "UPDATE_DRAFT",
                id: draft.tempId,
                patch: { targetDimension: Math.max(0.01, Number(e.target.value) || 1) },
              })
            }
          />
          <span className="ps-text-muted">1u = {UNIT_SCALE_METERS_PER_UNIT}m</span>
        </div>
      </div>
      <div className="ps-field">
        <label className="ps-label">Pivot</label>
        <div className="ps-btn-group">
          {(["bottom-center", "center", "bottom-front-center"] as PivotPreset[]).map((preset) => (
            <button
              key={preset}
              className={`forge-btn forge-btn-xs ${draft.pivot === preset ? "forge-btn-active" : ""}`}
              onClick={() =>
                dispatch({
                  type: "UPDATE_DRAFT",
                  id: draft.tempId,
                  patch: { pivot: preset },
                })
              }
            >
              {preset.replace(/-/g, " ")}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
