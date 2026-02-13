import { useState } from "react";
import * as THREE from "three";
import type { ViewportHandle } from "./Viewport";
import {
  computePivotOffset,
  applyPivotOffset,
  type PivotPreset,
} from "./processing/dimensions";

interface Props {
  viewport: ViewportHandle | null;
  onPivotChange: (preset: PivotPreset, offset: [number, number, number]) => void;
}

export function PivotPanel({ viewport, onPivotChange }: Props) {
  const [preset, setPreset] = useState<PivotPreset>("bottom-center");
  const [customOffset, setCustomOffset] = useState<[number, number, number]>([
    0, 0, 0,
  ]);

  const handleApplyPreset = (p: PivotPreset) => {
    setPreset(p);
    if (!viewport) return;
    const model = viewport.getModel();
    const bbox = viewport.getBBox();
    if (!model || !bbox) return;

    const offset = computePivotOffset(bbox, p);
    applyPivotOffset(model, offset);
    viewport.setBBoxVisible(true);
    onPivotChange(p, [offset.x, offset.y, offset.z]);
  };

  const handleApplyCustom = () => {
    if (!viewport) return;
    const model = viewport.getModel();
    if (!model) return;
    const offset = new THREE.Vector3(...customOffset);
    applyPivotOffset(model, offset);
    viewport.setBBoxVisible(true);
    onPivotChange(preset, customOffset);
  };

  return (
    <div className="forge-panel" data-testid="forge-pivot">
      <h3>Set Pivot</h3>

      <div className="forge-field">
        <label>Preset</label>
        <div className="forge-btn-group">
          {(
            ["bottom-center", "center", "bottom-front-center"] as PivotPreset[]
          ).map((p) => (
            <button
              key={p}
              className={`forge-btn ${preset === p ? "forge-btn-active" : ""}`}
              onClick={() => handleApplyPreset(p)}
              data-testid={`pivot-${p}`}
            >
              {p}
            </button>
          ))}
        </div>
      </div>

      <div className="forge-field">
        <label>Custom offset (x, y, z)</label>
        <div className="forge-vec3">
          {(["x", "y", "z"] as const).map((axis, i) => (
            <input
              key={axis}
              type="number"
              step={0.01}
              value={customOffset[i]}
              onChange={(e) => {
                const next = [...customOffset] as [number, number, number];
                next[i] = Number(e.target.value);
                setCustomOffset(next);
              }}
              placeholder={axis}
            />
          ))}
        </div>
        <button className="forge-btn" onClick={handleApplyCustom}>
          Apply Custom
        </button>
      </div>
    </div>
  );
}
