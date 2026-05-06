import { useAppDispatch, useAppState } from "../state/context";
import { useSceneRef } from "../engine/scene-context";
import { DEFAULT_GLASS_PARAMS } from "../state/reducer";
import { Slider } from "./Slider";

export function GlassControls() {
  const { authoring } = useAppState();
  const dispatch = useAppDispatch();
  const sceneRef = useSceneRef();

  const active = authoring?.activeRole ?? null;
  const state = active ? authoring?.surfaceStates[active] : null;
  if (!authoring || !active || !state || state.surface.kind !== "synthetic") return null;

  const params = state.glassParams ?? DEFAULT_GLASS_PARAMS;

  const update = (patch: Partial<typeof params>) => {
    const next = { ...params, ...patch };
    dispatch({ type: "AUTHORING_GLASS_SET", role: active, params: patch });
    sceneRef.current?.applyGlass(active, next);
  };

  return (
    <div className="ms-prompt-panel">
      <div className="ms-panel-label">Glass · {active}</div>
      <div className="ms-hint">
        Synthetic glass is shader-driven (no AI). Tune tint / roughness / IOR / alpha to taste.
      </div>
      <label className="ms-field">
        <span>Tint</span>
        <input
          type="color"
          value={params.tint}
          onChange={(e) => update({ tint: e.target.value })}
          className="ms-color"
        />
      </label>
      <Slider label="Roughness" value={params.roughness} min={0} max={0.5} step={0.01} onChange={(v) => update({ roughness: v })} />
      <Slider label="IOR" value={params.ior} min={1} max={2.5} step={0.01} onChange={(v) => update({ ior: v })} />
      <Slider label="Opacity" value={params.alpha} min={0.05} max={1} step={0.01} onChange={(v) => update({ alpha: v })} />
    </div>
  );
}
