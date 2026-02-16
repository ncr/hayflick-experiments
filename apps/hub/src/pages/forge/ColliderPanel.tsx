import { useState, useEffect } from "react";
import type { ViewportHandle } from "./Viewport";
import {
  autoFitCollider,
  type ColliderType,
  type ColliderParams,
} from "./processing/colliders";

interface Props {
  viewport: ViewportHandle | null;
  onColliderChange: (params: ColliderParams) => void;
  hideTitle?: boolean;
  /** Increment to trigger a refit (e.g. after scale changes) */
  refitTrigger?: number;
}

export function ColliderPanel({ viewport, onColliderChange, hideTitle, refitTrigger }: Props) {
  const [type, setType] = useState<ColliderType>("box");
  const [params, setParams] = useState<ColliderParams | null>(null);
  const [padding, setPadding] = useState(1.0);

  const applyPadding = (
    base: ColliderParams,
    scale: number
  ): ColliderParams => {
    const scaledParams: Record<string, number> = {};
    for (const [key, value] of Object.entries(base.params)) {
      scaledParams[key] = value * scale;
    }
    return { ...base, params: scaledParams };
  };

  const autoFit = (colliderType: ColliderType, pad = padding) => {
    if (!viewport) return;
    const bbox = viewport.getBBox();
    if (!bbox) return;
    const fitted = autoFitCollider(colliderType, bbox);
    const scaled = applyPadding(fitted, pad);
    setParams(scaled);
    viewport.setCollider(scaled);
    onColliderChange(scaled);
  };

  useEffect(() => {
    autoFit(type);
  }, [type, viewport, refitTrigger]);

  const handlePaddingChange = (value: number) => {
    setPadding(value);
    autoFit(type, value);
  };

  return (
    <div className="forge-panel" data-testid="forge-collider">
      {!hideTitle && <h3>Collider Shape</h3>}

      <div className="forge-field">
        <label>Type</label>
        <select
          value={type}
          onChange={(e) => {
            const t = e.target.value as ColliderType;
            setType(t);
            setPadding(1.0);
          }}
          data-testid="collider-type"
        >
          <option value="box">Box</option>
          <option value="capsule">Capsule</option>
          <option value="sphere">Sphere</option>
          <option value="cylinder">Cylinder</option>
          <option value="convex-hull">Convex Hull</option>
        </select>
      </div>

      <button
        className="forge-btn"
        onClick={() => { setPadding(1.0); autoFit(type, 1.0); }}
        data-testid="collider-autofit"
        style={{ marginBottom: "0.5rem" }}
      >
        Auto-fit
      </button>

      {type !== "convex-hull" && (
        <div className="forge-field">
          <label>Padding: {Math.round(padding * 100)}%</label>
          <input
            type="range"
            min={0.8}
            max={2.0}
            step={0.05}
            value={padding}
            onChange={(e) => handlePaddingChange(Number(e.target.value))}
            data-testid="collider-padding"
          />
        </div>
      )}

      {params && type !== "convex-hull" && (
        <div className="forge-info">
          {type === "box" && `${(params.params.halfWidth * 2).toFixed(3)} x ${(params.params.halfHeight * 2).toFixed(3)} x ${(params.params.halfDepth * 2).toFixed(3)}m`}
          {type === "sphere" && `r=${params.params.radius.toFixed(3)}m`}
          {type === "capsule" && `r=${params.params.radius.toFixed(3)}m h=${(params.params.halfHeight * 2).toFixed(3)}m`}
          {type === "cylinder" && `r=${params.params.radius.toFixed(3)}m h=${(params.params.halfHeight * 2).toFixed(3)}m`}
        </div>
      )}
    </div>
  );
}
