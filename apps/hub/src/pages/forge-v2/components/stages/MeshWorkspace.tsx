import { useCallback, useEffect, useRef, useState } from "react";
import { useForgeState, useForgeDispatch, useForgeRefs } from "../../state/forge-context";
import { usePipelineActions } from "../../hooks/usePipelineActions";
import { OutdatedBanner } from "../shared/OutdatedBanner";
import {
  ForgeScissorViewportPane,
  ForgeScissorViewportStage,
} from "../../ScissorViewport3d";
import { PixelQuad } from "../../PixelQuad";
import * as THREE from "three";
import type { PixelViewportViewState } from "../../../forge/ViewportPixel";
import type { ForgeV2GenerationDraftProp } from "../../types";
import type { PivotPreset } from "../../../forge/processing/dimensions";

function deepCloneForThumb(group: THREE.Group): THREE.Group {
  const clone = group.clone(true);
  clone.traverse((child) => {
    if (child instanceof THREE.Mesh) {
      if (Array.isArray(child.material)) {
        child.material = child.material.map((m: THREE.Material) => m.clone());
      } else {
        child.material = child.material.clone();
      }
    }
  });
  return clone;
}

const UNIT_SCALE_METERS_PER_UNIT = 1.28;

export function MeshWorkspace() {
  const state = useForgeState();
  const dispatch = useForgeDispatch();
  const refs = useForgeRefs();
  const actions = usePipelineActions();

  const draft = state.selectedDraftId ? state.drafts.get(state.selectedDraftId) ?? null : null;
  const [pixelModel, setPixelModel] = useState<THREE.Group | null>(null);
  const [pixelBaseViewState, setPixelBaseViewState] = useState<PixelViewportViewState>({
    target: [0, 0, 0],
    yawTurns: 0,
    zoom: 1,
  });

  // Keep a ref to the latest rebuild so the effect always calls the
  // current closure (which captures the up-to-date state.drafts).
  // We intentionally exclude `actions` from the effect deps to avoid
  // an infinite loop (the rebuild dispatches UPDATE_DRAFT which
  // recreates the callback), so the ref bridges the gap.
  const rebuildRef = useRef(actions.rebuildSelectedDraftPreview);
  rebuildRef.current = actions.rebuildSelectedDraftPreview;
  const persistRef = useRef(actions.persistProcessedMesh);
  persistRef.current = actions.persistProcessedMesh;

  // Rebuild preview when draft changes.
  // The rebuild function is async (first load awaits GLB parsing) but
  // on the cached path it executes synchronously and sets
  // refs.generationPixelBaseModel.current before returning.  We read
  // that ref immediately so the state update is part of the same React
  // batch — this avoids a microtask-timing edge-case where the
  // .then() fires after React has already committed.
  useEffect(() => {
    // Clear the tab thumbnail immediately so stale models don't linger
    // while the new draft loads.  It will be repopulated below once the
    // rebuild completes.
    refs.meshTabThumb.current?.setModel(null);

    if (!draft?.rawGlb) {
      setPixelModel(null);
      return;
    }
    let active = true;
    const promise = rebuildRef.current();

    // Synchronous path: the ref was already set during the call above.
    const immediate = refs.generationPixelBaseModel.current;
    if (immediate) {
      setPixelModel(immediate);
    }

    // Async path (first load): wait for the Promise, then update.
    void promise.then(() => {
      if (!active) return;
      const model = refs.generationPixelBaseModel.current;
      if (model && model !== immediate) {
        setPixelModel(model);
      }
      // Feed the mesh tab thumbnail viewport (live 3D pane in sidebar)
      const mainModel = refs.generationViewport.current?.getModel();
      const thumb = refs.meshTabThumb.current;
      if (mainModel && thumb) {
        thumb.setModel(deepCloneForThumb(mainModel));
        thumb.setAxesVisible(false);
        // Tighten framing for thumbnail
        const vs = thumb.getViewState();
        if (vs) thumb.setViewState({ ...vs, distance: vs.distance * 0.65 });
      }
      // Auto-persist processed model for saved props
      void persistRef.current();
    });
    return () => { active = false; };
  }, [
    refs,
    draft?.tempId,
    draft?.rawGlb,
    draft?.textureResolution,
    draft?.scaleMode,
    draft?.targetDimension,
    draft?.pivot,
    draft?.meshRevision,
  ]);


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

      {/* Main area: viewport left, pixel quad right */}
      <div className="ps-viewport-pixel-split">
        <ForgeScissorViewportStage>
          <div className="ps-viewport-labeled">
            <div className="ps-viewport-label">Mesh</div>
            <ForgeScissorViewportPane
              paneId="generation-mesh"
              className="ps-viewport-host ps-viewport-host-interactive"
              ref={refs.generationViewport}
              interactive
              onViewChange={undefined}
            />
          </div>
        </ForgeScissorViewportStage>

        <ForgeScissorViewportStage>
          <PixelQuad
            model={pixelModel}
            baseViewState={pixelBaseViewState}
            onBaseViewStateChange={setPixelBaseViewState}
            className="ps-pixel-strip"
            interactive
            viewportFramingScale={1.0}
            verticalBias={1 / 3}
          />
        </ForgeScissorViewportStage>
      </div>

      {/* Mesh settings — only when mesh exists */}
      {hasMesh && draft && (
        <MeshSettings
          draft={draft}
          dispatch={dispatch}
          baseModel={refs.baseModelCache.current.get(draft.tempId) ?? null}
        />
      )}

      {/* Auto-persisted — no manual approve step needed */}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Mesh settings (texture, scale, pivot)                                      */
/* -------------------------------------------------------------------------- */

const CM_PER_UNIT = UNIT_SCALE_METERS_PER_UNIT * 100; // 128

const TEX_DOWNSAMPLE_SIZES = [1024, 512, 256, 128];

/** Extracts the first base-color texture image from a THREE group. */
function extractBaseColorImage(group: THREE.Object3D): TexImageSource | null {
  let found: TexImageSource | null = null;
  group.traverse((child) => {
    if (found) return;
    if (child instanceof THREE.Mesh) {
      const mat = Array.isArray(child.material) ? child.material[0] : child.material;
      if (mat instanceof THREE.MeshStandardMaterial && mat.map?.image) {
        found = mat.map.image as TexImageSource;
      }
    }
  });
  return found;
}

/** Canvas that renders `image` downsampled to `targetSize` without filtering. */
function TextureThumb({
  image,
  targetSize,
}: {
  image: TexImageSource;
  targetSize: number; // 0 = original
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const srcW = (image as { width: number }).width ?? 0;
  const srcH = (image as { height: number }).height ?? 0;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || srcW <= 0 || srcH <= 0) return;

    // Render at the downsampled resolution (CSS scales it up via width:100%)
    const outSize = targetSize > 0 ? Math.min(targetSize, Math.max(srcW, srcH)) : Math.max(srcW, srcH);
    const aspect = srcW / srcH;
    const w = aspect >= 1 ? outSize : Math.round(outSize * aspect);
    const h = aspect >= 1 ? Math.round(outSize / aspect) : outSize;
    canvas.width = w;
    canvas.height = h;

    const ctx = canvas.getContext("2d")!;
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(image as CanvasImageSource, 0, 0, w, h);
  }, [image, targetSize, srcW, srcH]);

  return <canvas ref={canvasRef} />;
}

function MeshSettings({
  draft,
  dispatch,
  baseModel,
}: {
  draft: ForgeV2GenerationDraftProp;
  dispatch: ReturnType<typeof useForgeDispatch>;
  baseModel: THREE.Group | null;
}) {
  const texImage = baseModel ? extractBaseColorImage(baseModel) : null;
  const texNativeSize = texImage
    ? Math.max((texImage as { width: number }).width ?? 0, (texImage as { height: number }).height ?? 0)
    : 0;

  // Build texture options: native size first, then downsample sizes smaller than native
  const texOptions: { value: number; label: string }[] = [
    { value: 0, label: texNativeSize > 0 ? `${texNativeSize} px` : "Original" },
    ...TEX_DOWNSAMPLE_SIZES
      .filter((s) => texNativeSize <= 0 || s < texNativeSize)
      .map((s) => ({ value: s, label: `${s} px` })),
  ];

  const bbox = draft.bboxProcessed;
  const wCm = bbox ? Math.round(bbox.width * CM_PER_UNIT) : 0;
  const hCm = bbox ? Math.round(bbox.height * CM_PER_UNIT) : 0;
  const dCm = bbox ? Math.round(bbox.depth * CM_PER_UNIT) : 0;

  // Slider: 10cm..1000cm (10m), step 1cm
  const sliderMin = 10;
  const sliderMax = 1000;
  const sliderValueCm = Math.round(draft.targetDimension * CM_PER_UNIT);

  const handleSlider = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const cm = Number(e.target.value);
      dispatch({
        type: "UPDATE_DRAFT",
        id: draft.tempId,
        patch: { scaleMode: "max" as const, targetDimension: Math.max(0.01, cm / CM_PER_UNIT) },
      });
    },
    [dispatch, draft.tempId]
  );

  return (
    <div className="ps-mesh-settings-panel">
      {/* Texture resolution — visual radio cards */}
      <div className="ps-field">
        <label className="ps-label">Texture</label>
        <div className="ps-tex-cards" style={{ gridTemplateColumns: `repeat(${texOptions.length}, 1fr)` }}>
          {texOptions.map((opt) => (
            <button
              key={opt.value}
              type="button"
              className={`ps-tex-card ${draft.textureResolution === opt.value ? "ps-tex-card-active" : ""}`}
              onClick={() =>
                dispatch({
                  type: "UPDATE_DRAFT",
                  id: draft.tempId,
                  patch: { textureResolution: opt.value },
                })
              }
            >
              {texImage ? (
                <TextureThumb image={texImage} targetSize={opt.value} />
              ) : (
                <div style={{ aspectRatio: "1", background: "#222", borderRadius: 3 }} />
              )}
              <span className="ps-tex-card-label">{opt.label}</span>
            </button>
          ))}
        </div>
      </div>

      {/* Size — slider with live dimensions */}
      <div className="ps-size-slider-row">
        <div className="ps-size-slider-header">
          <label className="ps-label" style={{ margin: 0 }}>Size</label>
          {bbox && (
            <div className="ps-size-slider-dims">
              {wCm}<span> W</span> &times; {hCm}<span> H</span> &times; {dCm}<span> D</span> cm
            </div>
          )}
        </div>
        <input
          type="range"
          className="ps-size-slider"
          min={sliderMin}
          max={sliderMax}
          step={1}
          value={sliderValueCm}
          onChange={handleSlider}
        />
      </div>

      {/* Pivot */}
      <div className="ps-field ps-field-inline">
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
