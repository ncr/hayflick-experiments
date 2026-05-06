import { useAppDispatch, useAppState } from "../state/context";
import { useSceneRef } from "../engine/scene-context";
import { DEFAULT_PBR_TWEAK } from "../types";
import { Slider } from "./Slider";

export function PbrControls() {
  const { authoring } = useAppState();
  const dispatch = useAppDispatch();
  const sceneRef = useSceneRef();

  const active = authoring?.activeRole ?? null;
  const state = active ? authoring?.surfaceStates[active] : null;
  if (!authoring || !active || !state || state.surface.kind !== "pbr") return null;

  const params = state.pbrTweak ?? DEFAULT_PBR_TWEAK;

  const update = (patch: Partial<typeof params>) => {
    const next = { ...params, ...patch };
    dispatch({ type: "AUTHORING_PBR_TWEAK_SET", role: active, params: patch });
    sceneRef.current?.applyPbrTweak(active, next);
  };

  return (
    <div className="ms-prompt-panel">
      <div className="ms-panel-label">PBR · {active}</div>
      <div className="ms-hint">
        Live factors. Saved into the baked GLB material on Save.
      </div>
      <Slider label="Normal scale" value={params.normalScale} min={0} max={3} step={0.05} onChange={(v) => update({ normalScale: v })} />
      <Slider label="AO strength" value={params.aoStrength} min={0} max={2} step={0.05} onChange={(v) => update({ aoStrength: v })} />
      <Slider label="Roughness" value={params.roughnessFactor} min={0} max={1} step={0.01} onChange={(v) => update({ roughnessFactor: v })} />
      <Slider label="Metallic" value={params.metallicFactor} min={0} max={1} step={0.01} onChange={(v) => update({ metallicFactor: v })} />
    </div>
  );
}
