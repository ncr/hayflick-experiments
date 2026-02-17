import { useState } from "react";
import * as fsApi from "./api/fs";
import type { StyleGuide } from "./StyleGuidePanel";
import type { ColliderParams } from "./processing/colliders";
import type { PivotPreset, BBox, ScaleMode } from "./processing/dimensions";
import type { ViewportHandle } from "./Viewport";
import type { Object3D } from "three";
import type { PropPhysicsSettings } from "./types";
import {
  buildSimplifiedColliderScene,
  DEFAULT_COLLIDER_FACE_TARGET,
  type ColliderVariantsSpec,
  type CompoundColliderSpec
} from "./processing/collider-mesh";
import {
  buildPhysicsHintFromForgeSettings,
  normalizeForgePhysicsSettings,
  resolveForgeMass
} from "./processing/physics";

export interface AssetMeta {
  id: string;
  description: string;
  styleGuide: string;
  created: string;
  gen2d: {
    model: string;
    prompt: string;
    size: string;
  };
  gen3d: {
    tripoTaskId: string;
    faceLimit: number;
    pbr: boolean;
  };
  processing: {
    originalFaces: number;
    simplifiedFaces: number;
    simplificationRatio: number;
    colliderFaces: number;
    colliderFaceTarget: number;
    scale: [number, number, number];
    pivot: PivotPreset;
    pivotOffset: [number, number, number];
    bbox: { width: number; height: number; depth: number };
    targetDimension: { method: ScaleMode; value: number };
    textureResolution: number;
  };
  collider: ColliderParams;
  physics?: {
    mobility?: "fixed" | "dynamic";
    material?: "default" | "metal" | "rubber" | "glass" | "wood" | "concrete";
    mass?: number;
    friction?: number;
    restitution?: number;
    linearDamping?: number;
    angularDamping?: number;
    activationDelayMs?: number;
    massMode?: "auto" | "manual";
    massScale?: number;
    manualMass?: number;
  };
  compoundCollider?: CompoundColliderSpec;
  colliderVariants?: ColliderVariantsSpec;
}

interface Props {
  viewport: ViewportHandle | null;
  propDescription: string;
  conceptImage: string | null;
  composedPrompt: string;
  styleGuide: StyleGuide;
  rawGlb: ArrayBuffer | null;
  originalFaces: number;
  simplifiedFaces: number;
  simplificationRatio: number;
  scale: number;
  scaleMode: ScaleMode;
  targetDimension: number;
  pivot: PivotPreset;
  pivotOffset: [number, number, number];
  collider: ColliderParams | null;
  physics: PropPhysicsSettings;
  textureResolution: number;
  bbox: BBox | null;
  hideTitle?: boolean;
}

export function ExportPanel({
  viewport,
  propDescription,
  conceptImage,
  composedPrompt,
  styleGuide,
  rawGlb,
  originalFaces,
  simplifiedFaces,
  simplificationRatio,
  scale,
  scaleMode,
  targetDimension,
  pivot,
  pivotOffset,
  collider,
  physics,
  textureResolution,
  bbox,
  hideTitle,
}: Props) {
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const propId = propDescription
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

  const handleSave = async () => {
    if (!propId || !viewport) return;
    setSaving(true);
    setError(null);
    setSaved(false);

    try {
      const basePath = `props/${propId}`;
      let colliderFaces = 0;
      let colliderFaceTarget = 0;
      let compoundCollider: CompoundColliderSpec | undefined;
      let colliderVariants: ColliderVariantsSpec | undefined;

      // Save concept image
      if (conceptImage) {
        const blob = await fetch(conceptImage).then((r) => r.blob());
        await fsApi.writeBinary(`${basePath}/raw/concept.png`, blob);
      }

      // Save prompt
      await fsApi.writeText(`${basePath}/raw/prompt.txt`, composedPrompt);

      // Save raw GLB
      if (rawGlb) {
        await fsApi.writeBinary(`${basePath}/raw/tripo-output.glb`, rawGlb);
      }

      // Export processed GLB from current viewport model
      const model = viewport.getModel();
      if (model) {
        const { GLTFExporter } = await import(
          "three/examples/jsm/exporters/GLTFExporter.js"
        );
        const exporter = new GLTFExporter();

        const exportBinary = async (
          object: Object3D | Object3D[]
        ): Promise<ArrayBuffer> =>
          new Promise<ArrayBuffer>((resolve, reject) => {
            exporter.parse(
              object,
              (result) => resolve(result as ArrayBuffer),
              reject,
              { binary: true }
            );
          });

        const glbBuffer = await exportBinary(model);
        await fsApi.writeBinary(`${basePath}/processed/model.glb`, glbBuffer);

        const collider = await buildSimplifiedColliderScene(
          model,
          DEFAULT_COLLIDER_FACE_TARGET
        );
        const colliderBuffer = await exportBinary(collider.scene);
        await fsApi.writeBinary(`${basePath}/processed/collider.glb`, colliderBuffer);
        colliderFaces = collider.colliderFaces;
        colliderFaceTarget = collider.targetFaces;
        compoundCollider = collider.compoundCollider;
        colliderVariants = collider.colliderVariants;
      }

      // Save meta.json
      const normalizedPhysics = normalizeForgePhysicsSettings(physics, bbox);
      const physicsHint = buildPhysicsHintFromForgeSettings(normalizedPhysics, bbox);
      const meta: AssetMeta = {
        id: propId,
        description: propDescription,
        styleGuide: styleGuide.name,
        created: new Date().toISOString(),
        gen2d: {
          model: "gpt-image-1",
          prompt: composedPrompt,
          size: "1024x1024",
        },
        gen3d: {
          tripoTaskId: "",
          faceLimit: 20000,
          pbr: true,
        },
        processing: {
          originalFaces,
          simplifiedFaces,
          simplificationRatio,
          colliderFaces,
          colliderFaceTarget,
          scale: [scale, scale, scale],
          pivot,
          pivotOffset,
          bbox: bbox
            ? {
                width: bbox.width,
                height: bbox.height,
                depth: bbox.depth,
              }
            : { width: 0, height: 0, depth: 0 },
          targetDimension: { method: scaleMode, value: targetDimension },
          textureResolution,
        },
        collider: collider || {
          type: "box",
          position: [0, 0, 0],
          params: {},
        },
        physics: physicsHint,
        compoundCollider,
        colliderVariants,
      };

      await fsApi.writeJson(`${basePath}/meta.json`, meta);
      setSaved(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Save failed");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="forge-panel" data-testid="forge-export">
      {!hideTitle && <h3>Export</h3>}

      <div className="forge-field">
        <label>
          Asset ID: <strong>{propId || "(enter prop description)"}</strong>
        </label>
      </div>

      <div className="forge-export-summary">
        <div>Faces: {simplifiedFaces} (from {originalFaces})</div>
        <div>Scale: {scale.toFixed(4)}</div>
        <div>Pivot: {pivot}</div>
        {collider && <div>Collider: {collider.type}</div>}
        <div>
          Physics: {physics.material} /{" "}
          {physics.mobility === "auto" ? "auto mobility" : physics.mobility} / mass{" "}
          {resolveForgeMass(normalizeForgePhysicsSettings(physics, bbox), bbox).toFixed(3)}
        </div>
        <div>
          Export Colliders: Box + Convex Hull + Compound ({Math.max(1, Math.floor(DEFAULT_COLLIDER_FACE_TARGET / 12))} boxes max)
        </div>
        {bbox && (
          <div>
            Size: {bbox.width.toFixed(3)} x {bbox.height.toFixed(3)} x{" "}
            {bbox.depth.toFixed(3)}m
          </div>
        )}
      </div>

      <button
        className="forge-btn forge-btn-primary"
        onClick={handleSave}
        disabled={saving || !propId}
        data-testid="save-asset-btn"
      >
        {saving ? "Saving..." : "Save Asset"}
      </button>

      {saved && (
        <div className="forge-success" data-testid="save-success">
          Asset saved to assets/forge/props/{propId}/
        </div>
      )}
      {error && <div className="forge-error">{error}</div>}
    </div>
  );
}
