import { useState, useRef, useCallback, useEffect } from "react";
import { Viewport, type ViewportHandle } from "./forge/Viewport";
import { ViewportPixel, type ViewportPixelHandle } from "./forge/ViewportPixel";
import { StyleGuidePanel, type StyleGuide } from "./forge/StyleGuidePanel";
import { BatchPromptPanel } from "./forge/BatchPromptPanel";
import { BatchImageGallery } from "./forge/BatchImageGallery";
import { ProcessingRail } from "./forge/ProcessingRail";
import { PropGallery } from "./forge/PropGallery";
import * as fsApi from "./forge/api/fs";
import * as THREE from "three";
import type { PropItem } from "./forge/types";
import type { ColliderParams } from "./forge/processing/colliders";
import type { PivotPreset, ScaleMode } from "./forge/processing/dimensions";
import { normalizeAndPivot } from "./forge/processing/dimensions";
import { countTotalFaces } from "./forge/processing/simplify";
import {
  normalizeForgePhysicsSettings,
  parseForgePhysicsSettingsFromMeta
} from "./forge/processing/physics";

export function Forge() {
  const viewportRef = useRef<ViewportHandle>(null);
  const pixelViewportRef = useRef<ViewportPixelHandle>(null);

  // Style guide
  const [styleGuide, setStyleGuide] = useState<StyleGuide>({
    name: "",
    prompt: "",
    negativePrompt: "",
    imageSize: "1024x1024",
    referenceImages: [],
  });

  // Batch prop state (the queue)
  const [props, setProps] = useState<Map<string, PropItem>>(new Map());
  const [selectedPropId, setSelectedPropId] = useState<string | null>(null);

  // Loaded-from-disk prop (separate from queue)
  const [loadedProp, setLoadedProp] = useState<PropItem | null>(null);

  // Model version counter — triggers pixel viewport sync
  const [modelVersion, setModelVersion] = useState(0);

  // Original model for simplify panel (per-selection)
  const [originalModel, setOriginalModel] = useState<THREE.Group | null>(null);

  // The active prop shown in the right rail: loaded prop takes priority over queue selection
  const activeProp = loadedProp ?? (selectedPropId ? props.get(selectedPropId) ?? null : null);

  const updateProp = useCallback(
    (id: string, patch: Partial<PropItem>) => {
      // Update loaded prop if it matches
      setLoadedProp((prev) => {
        if (prev && prev.id === id) return { ...prev, ...patch };
        return prev;
      });
      // Update queue prop if it matches
      setProps((prev) => {
        const existing = prev.get(id);
        if (!existing) return prev;
        const next = new Map(prev);
        next.set(id, { ...existing, ...patch });
        return next;
      });
    },
    []
  );

  const handleAddProps = useCallback((items: PropItem[]) => {
    setProps((prev) => {
      const next = new Map(prev);
      for (const item of items) {
        next.set(item.id, item);
      }
      return next;
    });
  }, []);

  const handleRemoveProp = useCallback(
    (id: string) => {
      setProps((prev) => {
        const next = new Map(prev);
        next.delete(id);
        return next;
      });
      if (selectedPropId === id) {
        setSelectedPropId(null);
        setOriginalModel(null);
        viewportRef.current?.setModel(null);
      }
    },
    [selectedPropId]
  );

  // Select a prop from the batch queue — load its GLB into viewport
  const handleSelectQueueProp = useCallback(
    async (id: string) => {
      setSelectedPropId(id);
      setLoadedProp(null); // clear loaded prop so queue selection takes priority
      const prop = props.get(id);
      if (!prop) return;

      const vp = viewportRef.current;
      if (!vp) return;

      if (prop.rawGlb) {
        const group = await vp.loadGlb(prop.rawGlb);

        // Normalize transforms and auto-pivot to bottom-center
        const pivotOff = normalizeAndPivot(group);
        updateProp(id, { pivot: "bottom-center", pivotOffset: pivotOff });

        if (prop.scale !== 1) {
          group.scale.set(prop.scale, prop.scale, prop.scale);
          group.updateMatrixWorld(true);
        }

        vp.setModel(group);
        setOriginalModel(group.clone(true));

        const faces = countTotalFaces(group);
        updateProp(id, { originalFaces: faces, simplifiedFaces: faces });

        if (prop.collider) {
          vp.setCollider(prop.collider);
        }
      } else {
        vp.setModel(null);
        setOriginalModel(null);
      }
    },
    [props, updateProp]
  );

  // Load a saved prop from disk — does NOT add to batch queue
  const handleSelectSavedProp = async (propId: string) => {
    try {
      const meta = await fsApi.readJson<{
        description: string;
        styleGuide: string;
        processing: {
          originalFaces: number;
          simplifiedFaces: number;
          simplificationRatio: number;
          scale: [number, number, number];
          pivot: PivotPreset;
          pivotOffset: [number, number, number];
          bbox: { width: number; height: number; depth: number };
          targetDimension: { method: ScaleMode; value: number };
          textureResolution: number;
        };
        collider: ColliderParams;
        physics?: Record<string, unknown>;
      }>(`props/${propId}/meta.json`);

      let glb: ArrayBuffer;
      try {
        glb = await fsApi.readBinary(`props/${propId}/raw/tripo-output.glb`);
      } catch {
        glb = await fsApi.readBinary(`props/${propId}/processed/model.glb`);
      }

      let conceptImage: string | null = null;
      try {
        const res = await fsApi.readFile(`props/${propId}/raw/concept.png`);
        const blob = await res.blob();
        conceptImage = await new Promise<string>((resolve) => {
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result as string);
          reader.readAsDataURL(blob);
        });
      } catch {
        // No concept image
      }

      const item: PropItem = {
        id: `saved-${propId}`,
        description: meta.description,
        status: "3d-ready",
        conceptImage,
        imageError: null,
        rawGlb: glb,
        modelProgress: 100,
        modelError: null,
        originalFaces: meta.processing.originalFaces,
        simplifiedFaces: meta.processing.simplifiedFaces,
        simplificationRatio: meta.processing.simplificationRatio,
        scale: meta.processing.scale[0],
        scaleMode: meta.processing.targetDimension.method,
        targetDimension: meta.processing.targetDimension.value,
        pivot: meta.processing.pivot,
        pivotOffset: meta.processing.pivotOffset,
        collider: meta.collider,
        physics: parseForgePhysicsSettingsFromMeta(meta.physics, {
          width: meta.processing.bbox.width,
          height: meta.processing.bbox.height,
          depth: meta.processing.bbox.depth,
          center: new THREE.Vector3(),
          min: new THREE.Vector3(),
          max: new THREE.Vector3()
        }),
        textureResolution: meta.processing.textureResolution,
        bbox: {
          width: meta.processing.bbox.width,
          height: meta.processing.bbox.height,
          depth: meta.processing.bbox.depth,
          center: new THREE.Vector3(),
          min: new THREE.Vector3(),
          max: new THREE.Vector3(),
        },
      };

      // Set as loaded prop (NOT in queue), clear queue selection
      setLoadedProp(item);
      setSelectedPropId(null);

      // Load into viewport
      const vp = viewportRef.current;
      if (vp) {
        const group = await vp.loadGlb(glb);

        // Normalize transforms and auto-pivot to bottom-center
        const pivotOff = normalizeAndPivot(group);
        setLoadedProp((prev) => prev ? { ...prev, pivot: "bottom-center", pivotOffset: pivotOff } : prev);

        if (meta.processing.scale[0] !== 1) {
          group.scale.set(
            meta.processing.scale[0],
            meta.processing.scale[1],
            meta.processing.scale[2]
          );
          group.updateMatrixWorld(true);
        }

        vp.setModel(group);
        setOriginalModel(group.clone(true));

        if (meta.collider) {
          vp.setCollider(meta.collider);
        }

        const actualBBox = vp.getBBox();
        if (actualBBox) {
          setLoadedProp((prev) =>
            prev
              ? {
                  ...prev,
                  bbox: actualBBox,
                  physics: normalizeForgePhysicsSettings(prev.physics, actualBBox)
                }
              : prev
          );
        }
      }
    } catch {
      // Prop not fully saved
    }
  };

  // Sync model from normal viewport to pixel viewport unconditionally
  useEffect(() => {
    const raf = requestAnimationFrame(() => {
      const model = viewportRef.current?.getModel();
      if (model) {
        pixelViewportRef.current?.setModel(model);
      }
    });
    return () => cancelAnimationFrame(raf);
  }, [modelVersion]);

  return (
    <div className="forge-shell" data-testid="forge-page">
      {/* LEFT RAIL */}
      <div className="forge-left-rail">
        <div className="forge-left-rail-header">
          <h2>Asset Forge</h2>
        </div>

        <div className="forge-panel-area">
          {/* Style Guide */}
          <div className="forge-section">
            <StyleGuidePanel value={styleGuide} onChange={setStyleGuide} />
          </div>

          {/* Batch Prompts */}
          <BatchPromptPanel
            styleGuide={styleGuide}
            props={props}
            updateProp={updateProp}
            onAddProps={handleAddProps}
          />

          {/* Image Gallery / Queue */}
          <BatchImageGallery
            props={props}
            selectedPropId={loadedProp ? null : selectedPropId}
            onSelectProp={handleSelectQueueProp}
            updateProp={updateProp}
            onRemoveProp={handleRemoveProp}
          />

          {/* Saved Props */}
          <PropGallery
            onSelectProp={handleSelectSavedProp}
            selectedProp={loadedProp?.id.replace("saved-", "") ?? ""}
          />
        </div>
      </div>

      {/* CENTER — Dual Viewports */}
      <div className="forge-center">
        <div className="forge-viewports">
          <div className="forge-viewport-pane">
            <span className="forge-viewport-label">3D View</span>
            <Viewport
              ref={viewportRef}
              onModelChange={() => setModelVersion((v) => v + 1)}
            />
          </div>
          <div className="forge-viewport-pane">
            <span className="forge-viewport-label">Pixel View</span>
            <ViewportPixel ref={pixelViewportRef} />
          </div>
        </div>
      </div>

      {/* RIGHT RAIL */}
      <div className="forge-right-rail" data-testid="forge-right-rail">
        <div className="forge-right-rail-header">
          <h2>Processing</h2>
        </div>
        <ProcessingRail
          viewport={viewportRef.current}
          prop={activeProp}
          originalModel={originalModel}
          styleGuide={styleGuide}
          updateProp={updateProp}
          onModelChanged={() => setModelVersion((v) => v + 1)}
          modelVersion={modelVersion}
        />
      </div>
    </div>
  );
}
