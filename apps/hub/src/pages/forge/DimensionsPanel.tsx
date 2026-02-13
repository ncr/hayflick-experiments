import { useState, useEffect } from "react";
import type { ViewportHandle } from "./Viewport";
import {
  computeScaleForTarget,
  applyScale,
  type ScaleMode,
  type BBox,
} from "./processing/dimensions";

interface Props {
  viewport: ViewportHandle | null;
  onDimensionsChange: (info: {
    scale: number;
    mode: ScaleMode;
    targetValue: number;
    bbox: BBox;
  }) => void;
}

export function DimensionsPanel({ viewport, onDimensionsChange }: Props) {
  const [mode, setMode] = useState<ScaleMode>("height");
  const [targetValue, setTargetValue] = useState(0.85);
  const [currentBBox, setCurrentBBox] = useState<BBox | null>(null);
  const [appliedScale, setAppliedScale] = useState(1);

  const refreshBBox = () => {
    const bbox = viewport?.getBBox();
    if (bbox) setCurrentBBox(bbox);
  };

  useEffect(() => {
    refreshBBox();
  }, [viewport]);

  const handleApply = () => {
    if (!viewport || !currentBBox) return;
    const model = viewport.getModel();
    if (!model) return;

    const scale = computeScaleForTarget(currentBBox, mode, targetValue);
    applyScale(model, scale);
    setAppliedScale(scale);

    // Refresh bbox display
    const newBBox = viewport.getBBox();
    if (newBBox) {
      setCurrentBBox(newBBox);
      viewport.setBBoxVisible(true);
      onDimensionsChange({
        scale,
        mode,
        targetValue,
        bbox: newBBox,
      });
    }
  };

  return (
    <div className="forge-panel" data-testid="forge-dimensions">
      <h3>Scale & Dimensions</h3>

      {currentBBox && (
        <div className="forge-bbox-info" data-testid="bbox-info">
          <div>
            W: <strong>{currentBBox.width.toFixed(3)}m</strong>
          </div>
          <div>
            H: <strong>{currentBBox.height.toFixed(3)}m</strong>
          </div>
          <div>
            D: <strong>{currentBBox.depth.toFixed(3)}m</strong>
          </div>
        </div>
      )}

      <div className="forge-field">
        <label>Scaling mode</label>
        <select
          value={mode}
          onChange={(e) => setMode(e.target.value as ScaleMode)}
          data-testid="scale-mode"
        >
          <option value="height">Fit height</option>
          <option value="width">Fit width</option>
          <option value="max">Fit max dimension</option>
          <option value="manual">Manual uniform scale</option>
        </select>
      </div>

      <div className="forge-field">
        <label>
          {mode === "manual" ? "Scale factor" : "Target dimension (meters)"}
        </label>
        <input
          type="number"
          value={targetValue}
          onChange={(e) => setTargetValue(Number(e.target.value))}
          step={0.01}
          min={0.01}
          data-testid="target-dimension"
        />
      </div>

      <button
        className="forge-btn forge-btn-primary"
        onClick={handleApply}
        disabled={!currentBBox}
        data-testid="apply-scale-btn"
      >
        Apply Scale
      </button>

      {appliedScale !== 1 && (
        <div className="forge-info">
          Applied scale: {appliedScale.toFixed(4)}
        </div>
      )}
    </div>
  );
}
