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
}

export function ColliderPanel({ viewport, onColliderChange }: Props) {
  const [type, setType] = useState<ColliderType>("box");
  const [params, setParams] = useState<ColliderParams | null>(null);

  const autoFit = (colliderType: ColliderType) => {
    if (!viewport) return;
    const bbox = viewport.getBBox();
    if (!bbox) return;
    const fitted = autoFitCollider(colliderType, bbox);
    setParams(fitted);
    viewport.setCollider(fitted);
    onColliderChange(fitted);
  };

  useEffect(() => {
    autoFit(type);
  }, [type, viewport]);

  const updateParam = (key: string, value: number) => {
    if (!params) return;
    const updated: ColliderParams = {
      ...params,
      params: { ...params.params, [key]: value },
    };
    setParams(updated);
    viewport?.setCollider(updated);
    onColliderChange(updated);
  };

  const updatePosition = (axis: number, value: number) => {
    if (!params) return;
    const pos = [...params.position] as [number, number, number];
    pos[axis] = value;
    const updated: ColliderParams = { ...params, position: pos };
    setParams(updated);
    viewport?.setCollider(updated);
    onColliderChange(updated);
  };

  return (
    <div className="forge-panel" data-testid="forge-collider">
      <h3>Collider Shape</h3>

      <div className="forge-field">
        <label>Type</label>
        <select
          value={type}
          onChange={(e) => {
            const t = e.target.value as ColliderType;
            setType(t);
            autoFit(t);
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
        onClick={() => autoFit(type)}
        data-testid="collider-autofit"
      >
        Auto-fit to mesh
      </button>

      {params && (
        <>
          <div className="forge-field">
            <label>Position offset</label>
            <div className="forge-vec3">
              {(["x", "y", "z"] as const).map((axis, i) => (
                <input
                  key={axis}
                  type="number"
                  step={0.01}
                  value={params.position[i]}
                  onChange={(e) => updatePosition(i, Number(e.target.value))}
                  placeholder={axis}
                />
              ))}
            </div>
          </div>

          {Object.entries(params.params).length > 0 && (
            <div className="forge-field">
              <label>Shape parameters</label>
              {Object.entries(params.params).map(([key, value]) => (
                <div key={key} className="forge-param-row">
                  <span>{key}</span>
                  <input
                    type="number"
                    step={0.01}
                    value={value}
                    onChange={(e) => updateParam(key, Number(e.target.value))}
                  />
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}
