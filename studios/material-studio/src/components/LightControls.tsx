import { useEffect, useState } from "react";
import { useSceneRef } from "../engine/scene-context";
import { Slider } from "./Slider";

const DEFAULT_SPEED = 0.6;

/**
 * Scene-wide light controls. Local component state — the orbit doesn't
 * persist into the saved entry; it's a viewing aid.
 */
export function LightControls() {
  const sceneRef = useSceneRef();
  const [enabled, setEnabled] = useState(false);
  const [speed, setSpeed] = useState(DEFAULT_SPEED);

  useEffect(() => {
    sceneRef.current?.setLightOrbit({ enabled, speed });
  }, [enabled, speed, sceneRef]);

  return (
    <div className="ms-prompt-panel">
      <div className="ms-panel-label">Lighting</div>
      <label className="ms-field">
        <span>Orbit key light</span>
        <input
          type="checkbox"
          checked={enabled}
          onChange={(e) => setEnabled(e.target.checked)}
        />
      </label>
      {enabled && (
        <Slider
          label="Speed"
          value={speed}
          min={0.05}
          max={3}
          step={0.05}
          onChange={setSpeed}
        />
      )}
    </div>
  );
}
