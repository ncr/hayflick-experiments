import { useState, useRef } from "react";
import type { ViewportHandle, MaterialChannelMode } from "./Viewport";
import { countTotalFaces, simplifyScene } from "./processing/simplify";
import { downsampleMeshTextures } from "./processing/textures";
import * as THREE from "three";

/** Clone a group with independent material copies so texture mutations don't leak. */
function deepCloneWithMaterials(group: THREE.Group): THREE.Group {
  const clone = group.clone(true);
  clone.traverse((child) => {
    if (child instanceof THREE.Mesh) {
      if (Array.isArray(child.material)) {
        child.material = child.material.map((m) => m.clone());
      } else {
        child.material = child.material.clone();
      }
    }
  });
  return clone;
}

interface Props {
  viewport: ViewportHandle | null;
  originalModel: THREE.Group | null;
  onSimplifiedModel: (model: THREE.Group) => void;
  hideTitle?: boolean;
}

export function SimplifyPanel({
  viewport,
  originalModel,
  onSimplifiedModel,
  hideTitle,
}: Props) {
  const [ratio, setRatio] = useState(1.0);
  const [simplifying, setSimplifying] = useState(false);
  const [wireframe, setWireframe] = useState(false);
  const [showOriginal, setShowOriginal] = useState(false);
  const [textureRes, setTextureRes] = useState<number>(0);
  const [viewChannel, setViewChannel] = useState<MaterialChannelMode>("");
  const [originalFaces, setOriginalFaces] = useState(0);
  const [currentFaces, setCurrentFaces] = useState(0);

  // Keep a ref to the last simplified model so we can swap back to it
  const simplifiedRef = useRef<THREE.Group | null>(null);

  // Initial face count
  if (originalModel && originalFaces === 0) {
    const count = countTotalFaces(originalModel);
    setOriginalFaces(count);
    setCurrentFaces(count);
  }

  /** Clone from source, apply current texture res, and push to viewport. */
  const applyToViewport = (source: THREE.Group) => {
    if (!viewport) return;
    const clone = deepCloneWithMaterials(source);
    if (textureRes > 0) {
      downsampleMeshTextures(clone, textureRes);
    }
    viewport.setModel(clone);
    return clone;
  };

  const handleSimplify = async () => {
    if (!originalModel || !viewport) return;
    setSimplifying(true);
    try {
      const simplified = await simplifyScene(originalModel, ratio);
      simplifiedRef.current = simplified;
      applyToViewport(simplified);
      const faces = countTotalFaces(simplified);
      setCurrentFaces(faces);
      setShowOriginal(false);
      onSimplifiedModel(simplified);
    } catch (err) {
      console.error("Simplification failed:", err);
    } finally {
      setSimplifying(false);
    }
  };

  const handleToggleOriginal = () => {
    if (!viewport || !originalModel) return;
    const next = !showOriginal;
    setShowOriginal(next);
    if (next) {
      applyToViewport(originalModel);
      setCurrentFaces(originalFaces);
    } else {
      const model = simplifiedRef.current ?? originalModel;
      applyToViewport(model);
      setCurrentFaces(countTotalFaces(model));
    }
  };

  const handleWireframeToggle = () => {
    const next = !wireframe;
    setWireframe(next);
    viewport?.setWireframe(next);
  };

  const handleTextureResize = (size: number) => {
    setTextureRes(size);
    if (!viewport || !originalModel) return;

    const source = showOriginal
      ? originalModel
      : simplifiedRef.current ?? originalModel;
    const clone = deepCloneWithMaterials(source);
    if (size > 0) {
      downsampleMeshTextures(clone, size);
    }
    viewport.setModel(clone);
  };

  const handleChannelChange = (channel: MaterialChannelMode) => {
    setViewChannel(channel);
    viewport?.setMaterialChannel(channel);
  };

  return (
    <div className="forge-panel" data-testid="forge-simplify">
      {!hideTitle && <h3>Inspect & Simplify</h3>}

      <div className="forge-field">
        <label>
          Face count: <strong data-testid="face-count">{currentFaces}</strong>
          {originalFaces > 0 && originalFaces !== currentFaces && (
            <span className="forge-face-orig"> (original: {originalFaces})</span>
          )}
        </label>
      </div>

      <div className="forge-field">
        <label>
          Simplify ratio: {Math.round(ratio * 100)}%
        </label>
        <input
          type="range"
          min={0.01}
          max={1}
          step={0.01}
          value={ratio}
          onChange={(e) => setRatio(Number(e.target.value))}
          data-testid="simplify-slider"
        />
        <button
          className="forge-btn"
          onClick={handleSimplify}
          disabled={simplifying || !originalModel}
          data-testid="simplify-btn"
        >
          {simplifying ? "Simplifying..." : "Apply"}
        </button>
      </div>

      <div className="forge-field forge-toggles">
        <label>
          <input
            type="checkbox"
            checked={wireframe}
            onChange={handleWireframeToggle}
            data-testid="wireframe-toggle"
          />
          Wireframe
        </label>
        <label>
          <input
            type="checkbox"
            checked={showOriginal}
            onChange={handleToggleOriginal}
          />
          Show original
        </label>
      </div>

      <div className="forge-field">
        <label>Texture resolution</label>
        <select
          value={textureRes}
          onChange={(e) => handleTextureResize(Number(e.target.value))}
          data-testid="texture-res"
        >
          <option value={0}>Original</option>
          <option value={512}>512px</option>
          <option value={256}>256px</option>
          <option value={128}>128px</option>
        </select>
      </div>

      <div className="forge-field">
        <label>Material channel</label>
        <select
          value={viewChannel}
          onChange={(e) => handleChannelChange(e.target.value as MaterialChannelMode)}
        >
          <option value="">Normal render</option>
          <option value="baseColor">Base Color</option>
          <option value="normal">Normal</option>
          <option value="roughness">Roughness</option>
          <option value="metallic">Metallic</option>
          <option value="ao">Ambient Occlusion</option>
          <option value="emissive">Emissive</option>
        </select>
      </div>
    </div>
  );
}
