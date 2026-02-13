import { useState, useRef, useCallback, useEffect } from "react";
import { Viewport, type ViewportHandle } from "./forge/Viewport";
import { ViewportPixel, type ViewportPixelHandle } from "./forge/ViewportPixel";
import { StyleGuidePanel, type StyleGuide } from "./forge/StyleGuidePanel";
import { GenerateImagePanel } from "./forge/GenerateImagePanel";
import { Generate3DPanel } from "./forge/Generate3DPanel";
import { SimplifyPanel } from "./forge/SimplifyPanel";
import { DimensionsPanel } from "./forge/DimensionsPanel";
import { PivotPanel } from "./forge/PivotPanel";
import { ColliderPanel } from "./forge/ColliderPanel";
import { ExportPanel } from "./forge/ExportPanel";
import { PropGallery } from "./forge/PropGallery";
import * as fsApi from "./forge/api/fs";
import * as THREE from "three";
import type { ColliderParams } from "./forge/processing/colliders";
import type { PivotPreset, ScaleMode, BBox } from "./forge/processing/dimensions";
import { countTotalFaces } from "./forge/processing/simplify";

type WorkflowStep =
  | "style"
  | "image"
  | "model"
  | "simplify"
  | "dimensions"
  | "pivot"
  | "collider"
  | "export";

const STEPS: { key: WorkflowStep; label: string }[] = [
  { key: "style", label: "Style Guide" },
  { key: "image", label: "Reference Image" },
  { key: "model", label: "3D Model" },
  { key: "simplify", label: "Simplify" },
  { key: "dimensions", label: "Dimensions" },
  { key: "pivot", label: "Pivot" },
  { key: "collider", label: "Collider" },
  { key: "export", label: "Export" },
];

export function Forge() {
  const viewportRef = useRef<ViewportHandle>(null);
  const pixelViewportRef = useRef<ViewportPixelHandle>(null);

  // Workflow state
  const [step, setStep] = useState<WorkflowStep>("style");
  const [viewMode, setViewMode] = useState<"normal" | "pixel">("normal");

  // Style guide
  const [styleGuide, setStyleGuide] = useState<StyleGuide>({
    name: "",
    prompt: "",
    negativePrompt: "",
    imageSize: "1024x1024",
    referenceImages: [],
  });

  // Image generation
  const [propDescription, setPropDescription] = useState("");
  const [conceptImage, setConceptImage] = useState<string | null>(null);

  // 3D model
  const [rawGlb, setRawGlb] = useState<ArrayBuffer | null>(null);
  const [originalModel, setOriginalModel] = useState<THREE.Group | null>(null);

  // Processing state
  const [originalFaces, setOriginalFaces] = useState(0);
  const [simplifiedFaces, setSimplifiedFaces] = useState(0);
  const [simplificationRatio, setSimplificationRatio] = useState(1);
  const [scale, setScale] = useState(1);
  const [scaleMode, setScaleMode] = useState<ScaleMode>("height");
  const [targetDimension, setTargetDimension] = useState(0.85);
  const [pivot, setPivot] = useState<PivotPreset>("bottom-center");
  const [pivotOffset, setPivotOffset] = useState<[number, number, number]>([0, 0, 0]);
  const [collider, setCollider] = useState<ColliderParams | null>(null);
  const [textureResolution, setTextureResolution] = useState(0);
  const [bbox, setBBox] = useState<BBox | null>(null);

  // Model version counter — increments every time the normal viewport's model changes
  const [modelVersion, setModelVersion] = useState(0);

  // Gallery
  const [selectedProp, setSelectedProp] = useState("");

  const composePrompt = () => {
    return [
      styleGuide.prompt,
      propDescription,
      "3/4 view, product shot, centered object, plain mid-gray background.",
    ]
      .filter(Boolean)
      .join(" ");
  };

  const handleAcceptImage = () => {
    setStep("model");
  };

  const handleModelGenerated = useCallback(
    async (glb: ArrayBuffer) => {
      setRawGlb(glb);
      const vp = viewportRef.current;
      if (!vp) return;
      const group = await vp.loadGlb(glb);
      vp.setModel(group);
      setOriginalModel(group.clone(true));
      const faces = countTotalFaces(group);
      setOriginalFaces(faces);
      setSimplifiedFaces(faces);
      setStep("simplify");
    },
    []
  );

  const handleSimplifiedModel = (model: THREE.Group) => {
    const faces = countTotalFaces(model);
    setSimplifiedFaces(faces);
    setSimplificationRatio(originalFaces > 0 ? faces / originalFaces : 1);
  };

  const handleDimensionsChange = (info: {
    scale: number;
    mode: ScaleMode;
    targetValue: number;
    bbox: BBox;
  }) => {
    setScale(info.scale);
    setScaleMode(info.mode);
    setTargetDimension(info.targetValue);
    setBBox(info.bbox);
  };

  const handlePivotChange = (
    preset: PivotPreset,
    offset: [number, number, number]
  ) => {
    setPivot(preset);
    setPivotOffset(offset);
    // Refresh bbox
    const b = viewportRef.current?.getBBox();
    if (b) setBBox(b);
  };

  const handleColliderChange = (params: ColliderParams) => {
    setCollider(params);
  };

  const handleSelectProp = async (propId: string) => {
    setSelectedProp(propId);
    try {
      // Load meta.json
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
      }>(`props/${propId}/meta.json`);

      // Restore all state from meta
      setPropDescription(meta.description);
      setOriginalFaces(meta.processing.originalFaces);
      setSimplifiedFaces(meta.processing.simplifiedFaces);
      setSimplificationRatio(meta.processing.simplificationRatio);
      setScale(meta.processing.scale[0]);
      setScaleMode(meta.processing.targetDimension.method);
      setTargetDimension(meta.processing.targetDimension.value);
      setPivot(meta.processing.pivot);
      setPivotOffset(meta.processing.pivotOffset);
      setCollider(meta.collider);
      setTextureResolution(meta.processing.textureResolution);
      setBBox({
        width: meta.processing.bbox.width,
        height: meta.processing.bbox.height,
        depth: meta.processing.bbox.depth,
        center: new THREE.Vector3(),
        min: new THREE.Vector3(),
        max: new THREE.Vector3(),
      });

      // Try to load raw model first, fall back to processed
      let glb: ArrayBuffer;
      try {
        glb = await fsApi.readBinary(`props/${propId}/raw/tripo-output.glb`);
        setRawGlb(glb);
      } catch {
        glb = await fsApi.readBinary(`props/${propId}/processed/model.glb`);
      }
      const vp = viewportRef.current;
      if (vp) {
        const group = await vp.loadGlb(glb);

        // Re-apply processing: scale, pivot
        if (meta.processing.scale[0] !== 1) {
          group.scale.set(
            meta.processing.scale[0],
            meta.processing.scale[1],
            meta.processing.scale[2]
          );
          group.updateMatrixWorld(true);
        }
        if (meta.processing.pivotOffset) {
          const off = meta.processing.pivotOffset;
          if (off[0] !== 0 || off[1] !== 0 || off[2] !== 0) {
            group.traverse((child) => {
              if (child instanceof THREE.Mesh && child.geometry) {
                child.geometry.translate(off[0], off[1], off[2]);
              }
            });
          }
        }

        vp.setModel(group);
        setOriginalModel(group.clone(true));
        const faces = countTotalFaces(group);
        setOriginalFaces(faces);
        setSimplifiedFaces(meta.processing.simplifiedFaces || faces);

        // Re-apply collider visual
        if (meta.collider) {
          vp.setCollider(meta.collider);
        }

        // Update bbox from actual model
        const actualBBox = vp.getBBox();
        if (actualBBox) setBBox(actualBBox);
      }

      setStep("simplify");
    } catch {
      // Prop not fully saved
    }
  };

  // Sync model from normal viewport → pixel viewport whenever model changes or pixel view becomes active.
  // requestAnimationFrame ensures the pixel viewport's scene is fully initialized before we set the model.
  useEffect(() => {
    if (viewMode !== "pixel") return;
    const raf = requestAnimationFrame(() => {
      const model = viewportRef.current?.getModel();
      if (model) {
        pixelViewportRef.current?.setModel(model);
      }
    });
    return () => cancelAnimationFrame(raf);
  }, [viewMode, modelVersion]);

  const stepIndex = STEPS.findIndex((s) => s.key === step);

  return (
    <div className="forge-shell" data-testid="forge-page">
      <div className="forge-sidebar">
        <div className="forge-sidebar-header">
          <h2>Asset Forge</h2>
        </div>

        {/* Workflow steps */}
        <nav className="forge-steps">
          {STEPS.map((s, i) => (
            <button
              key={s.key}
              className={`forge-step ${step === s.key ? "forge-step-active" : ""} ${i <= stepIndex ? "forge-step-done" : ""}`}
              onClick={() => setStep(s.key)}
            >
              <span className="forge-step-num">{i + 1}</span>
              <span>{s.label}</span>
            </button>
          ))}
        </nav>

        {/* Active panel */}
        <div className="forge-panel-area">
          {step === "style" && (
            <StyleGuidePanel value={styleGuide} onChange={setStyleGuide} />
          )}
          {step === "image" && (
            <GenerateImagePanel
              styleGuide={styleGuide}
              conceptImage={conceptImage}
              onConceptImage={setConceptImage}
              propDescription={propDescription}
              onPropDescription={setPropDescription}
              onAccept={handleAcceptImage}
            />
          )}
          {step === "model" && (
            <Generate3DPanel
              conceptImage={conceptImage}
              onModelGenerated={handleModelGenerated}
            />
          )}
          {step === "simplify" && (
            <SimplifyPanel
              viewport={viewportRef.current}
              originalModel={originalModel}
              onSimplifiedModel={handleSimplifiedModel}
            />
          )}
          {step === "dimensions" && (
            <DimensionsPanel
              viewport={viewportRef.current}
              onDimensionsChange={handleDimensionsChange}
            />
          )}
          {step === "pivot" && (
            <PivotPanel
              viewport={viewportRef.current}
              onPivotChange={handlePivotChange}
            />
          )}
          {step === "collider" && (
            <ColliderPanel
              viewport={viewportRef.current}
              onColliderChange={handleColliderChange}
            />
          )}
          {step === "export" && (
            <ExportPanel
              viewport={viewportRef.current}
              propDescription={propDescription}
              conceptImage={conceptImage}
              composedPrompt={composePrompt()}
              styleGuide={styleGuide}
              rawGlb={rawGlb}
              originalFaces={originalFaces}
              simplifiedFaces={simplifiedFaces}
              simplificationRatio={simplificationRatio}
              scale={scale}
              scaleMode={scaleMode}
              targetDimension={targetDimension}
              pivot={pivot}
              pivotOffset={pivotOffset}
              collider={collider}
              textureResolution={textureResolution}
              bbox={bbox}
            />
          )}
        </div>

        {/* Navigation */}
        <div className="forge-nav">
          {stepIndex > 0 && (
            <button
              className="forge-btn"
              onClick={() => setStep(STEPS[stepIndex - 1].key)}
            >
              Back
            </button>
          )}
          {stepIndex < STEPS.length - 1 && (
            <button
              className="forge-btn forge-btn-primary"
              onClick={() => setStep(STEPS[stepIndex + 1].key)}
            >
              Next
            </button>
          )}
        </div>

        {/* Gallery */}
        <PropGallery
          onSelectProp={handleSelectProp}
          selectedProp={selectedProp}
        />
      </div>

      <div className="forge-viewport-area">
        <div className="forge-viewport-header">
          <div className="forge-view-toggle">
            <button
              className={`forge-btn ${viewMode === "normal" ? "forge-btn-active" : ""}`}
              onClick={() => setViewMode("normal")}
            >
              3D View
            </button>
            <button
              className={`forge-btn ${viewMode === "pixel" ? "forge-btn-active" : ""}`}
              onClick={() => setViewMode("pixel")}
            >
              Pixel View
            </button>
          </div>
        </div>
        <div className="forge-viewport-container">
          <div style={{ display: viewMode === "normal" ? "block" : "none", width: "100%", height: "100%" }}>
            <Viewport
              ref={viewportRef}
              onModelChange={() => {
                setModelVersion((v) => v + 1);
              }}
            />
          </div>
          {viewMode === "pixel" && (
            <div style={{ width: "100%", height: "100%" }}>
              <ViewportPixel ref={pixelViewportRef} />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
