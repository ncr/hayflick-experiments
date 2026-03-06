import { useState, useRef } from "react";
import * as THREE from "three";
import type { ViewportHandle } from "./Viewport";
import {
  computePivotOffset,
  applyPivotOffset,
  computeBBox,
  type PivotPreset,
} from "./processing/dimensions";

interface Props {
  viewport: ViewportHandle | null;
  onPivotChange: (preset: PivotPreset, offset: [number, number, number]) => void;
  hideTitle?: boolean;
  /** The pivot offset already baked into geometry (e.g. from auto-pivot on load) */
  initialOffset?: [number, number, number];
}

export function PivotPanel({ viewport, onPivotChange, hideTitle, initialOffset }: Props) {
  const [preset, setPreset] = useState<PivotPreset>("bottom-center");
  // Track cumulative geometry offset so we can undo before re-applying.
  // Initialized from the offset already applied during model load.
  const appliedOffsetRef = useRef<THREE.Vector3>(
    initialOffset
      ? new THREE.Vector3(initialOffset[0], initialOffset[1], initialOffset[2])
      : new THREE.Vector3()
  );

  const handleApplyPreset = (p: PivotPreset) => {
    setPreset(p);
    if (!viewport) return;
    const model = viewport.getModel();
    if (!model) return;

    // Undo previous offset
    const prev = appliedOffsetRef.current;
    if (prev.x !== 0 || prev.y !== 0 || prev.z !== 0) {
      applyPivotOffset(model, prev.clone().negate());
    }

    // Compute bbox in local space (temporarily reset scale)
    const savedScale = model.scale.clone();
    model.scale.set(1, 1, 1);
    model.updateMatrixWorld(true);
    const localBBox = computeBBox(model);

    const offset = computePivotOffset(localBBox, p);
    applyPivotOffset(model, offset);
    appliedOffsetRef.current = offset.clone();

    // Restore scale
    model.scale.copy(savedScale);
    model.updateMatrixWorld(true);

    viewport.setBBoxVisible(true);
    onPivotChange(p, [offset.x, offset.y, offset.z]);
  };

  return (
    <div className="forge-panel" data-testid="forge-pivot">
      {!hideTitle && <h3>Set Pivot</h3>}

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
    </div>
  );
}
