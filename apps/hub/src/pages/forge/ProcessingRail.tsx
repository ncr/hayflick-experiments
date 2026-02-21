import { useState } from "react";
import type { ViewportHandle } from "./Viewport";
import type { PropItem } from "./types";
import { SimplifyPanel } from "./SimplifyPanel";
import { DimensionsPanel } from "./DimensionsPanel";
import { PivotPanel } from "./PivotPanel";
import { ColliderPanel } from "./ColliderPanel";
import { PhysicsPanel } from "./PhysicsPanel";
import { ExportPanel } from "./ExportPanel";
import type { StyleGuide } from "./StyleGuidePanel";
import type * as THREE from "three";
import type { PivotPreset, ScaleMode, BBox } from "./processing/dimensions";
import type { ColliderParams } from "./processing/colliders";
import type { PropPhysicsSettings } from "./types";
import type { ForgeColliderGenerationMetadata } from "./processing/collider-vhacd";
import { composePrompt } from "./batch";

interface Props {
  viewport: ViewportHandle | null;
  prop: PropItem | null;
  originalModel: THREE.Group | null;
  styleGuide: StyleGuide;
  updateProp: (id: string, patch: Partial<PropItem>) => void;
  onModelChanged: () => void;
  modelVersion: number;
}

export function ProcessingRail({
  viewport,
  prop,
  originalModel,
  styleGuide,
  updateProp,
  onModelChanged,
  modelVersion
}: Props) {
  const [colliderRefitTrigger, setColliderRefitTrigger] = useState(0);

  if (!prop) {
    return (
      <div className="forge-no-selection">
        Select a prop from the queue to configure processing settings.
      </div>
    );
  }

  const id = prop.id;

  const handleSimplifiedModel = () => {
    updateProp(id, { colliderGeneration: null });
    onModelChanged();
    setColliderRefitTrigger((v) => v + 1);
  };

  const handleDimensionsChange = (info: {
    scale: number;
    mode: ScaleMode;
    targetValue: number;
    bbox: BBox;
  }) => {
    updateProp(id, {
      scale: info.scale,
      scaleMode: info.mode,
      targetDimension: info.targetValue,
      bbox: info.bbox,
      colliderGeneration: null
    });
    onModelChanged();
    setColliderRefitTrigger((v) => v + 1);
  };

  const handlePivotChange = (
    preset: PivotPreset,
    offset: [number, number, number]
  ) => {
    updateProp(id, { pivot: preset, pivotOffset: offset, colliderGeneration: null });
    const b = viewport?.getBBox();
    if (b) updateProp(id, { bbox: b });
    onModelChanged();
    setColliderRefitTrigger((v) => v + 1);
  };

  const handleColliderChange = (params: ColliderParams) => {
    updateProp(id, { collider: params });
  };

  const handleColliderGenerationChange = (
    metadata: ForgeColliderGenerationMetadata | null
  ) => {
    updateProp(id, { colliderGeneration: metadata });
  };

  const handlePhysicsChange = (next: PropPhysicsSettings) => {
    updateProp(id, { physics: next });
  };

  const colliderRebuildTrigger = colliderRefitTrigger + modelVersion;

  return (
    <>
      <details open>
        <summary>Mesh / Texture</summary>
        <SimplifyPanel
          viewport={viewport}
          originalModel={originalModel}
          onSimplifiedModel={handleSimplifiedModel}
          hideTitle
        />
      </details>
      <details open>
        <summary>Dimensions</summary>
        <DimensionsPanel
          viewport={viewport}
          onDimensionsChange={handleDimensionsChange}
          hideTitle
        />
      </details>
      <details open>
        <summary>Pivot</summary>
        <PivotPanel
          key={id}
          viewport={viewport}
          onPivotChange={handlePivotChange}
          hideTitle
          initialOffset={prop.pivotOffset}
        />
      </details>
      <details open>
        <summary>Collider</summary>
        <ColliderPanel
          viewport={viewport}
          onColliderChange={handleColliderChange}
          onColliderGenerationChange={handleColliderGenerationChange}
          currentCollider={prop.collider}
          currentColliderGeneration={prop.colliderGeneration}
          refitTrigger={colliderRebuildTrigger}
          hideTitle
        />
      </details>
      <details open>
        <summary>Physics</summary>
        <PhysicsPanel
          value={prop.physics}
          bbox={prop.bbox}
          onChange={handlePhysicsChange}
          hideTitle
        />
      </details>
      <details open>
        <summary>Export</summary>
        <ExportPanel
          viewport={viewport}
          propDescription={prop.description}
          conceptImage={prop.conceptImage}
          composedPrompt={composePrompt(styleGuide, prop.description)}
          styleGuide={styleGuide}
          rawGlb={prop.rawGlb}
          originalFaces={prop.originalFaces}
          simplifiedFaces={prop.simplifiedFaces}
          simplificationRatio={prop.simplificationRatio}
          scale={prop.scale}
          scaleMode={prop.scaleMode}
          targetDimension={prop.targetDimension}
          pivot={prop.pivot}
          pivotOffset={prop.pivotOffset}
          collider={prop.collider}
          colliderGeneration={prop.colliderGeneration}
          physics={prop.physics}
          textureResolution={prop.textureResolution}
          bbox={prop.bbox}
          hideTitle
        />
      </details>
    </>
  );
}
