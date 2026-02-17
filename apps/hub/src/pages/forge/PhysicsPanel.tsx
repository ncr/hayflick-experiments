import type { BBox } from "./processing/dimensions";
import {
  FORGE_PHYSICS_MATERIALS,
  normalizeForgePhysicsSettings,
  resolveForgeMass,
  withMaterialPresetDefaults
} from "./processing/physics";
import type {
  PropPhysicsMaterial,
  PropPhysicsSettings
} from "./types";

interface Props {
  value: PropPhysicsSettings;
  bbox: BBox | null;
  onChange: (next: PropPhysicsSettings) => void;
  hideTitle?: boolean;
}

export function PhysicsPanel({ value, bbox, onChange, hideTitle }: Props) {
  const normalized = normalizeForgePhysicsSettings(value, bbox);
  const resolvedMass = resolveForgeMass(normalized, bbox);

  return (
    <div className="forge-panel" data-testid="forge-physics">
      {!hideTitle && <h3>Physics</h3>}

      <div className="forge-field">
        <label>Mobility</label>
        <select
          value={normalized.mobility}
          onChange={(event) =>
            onChange(
              normalizeForgePhysicsSettings(
                {
                  ...normalized,
                  mobility: event.target.value as PropPhysicsSettings["mobility"]
                },
                bbox
              )
            )
          }
        >
          <option value="auto">Auto (runtime inference)</option>
          <option value="fixed">Fixed (support)</option>
          <option value="dynamic">Dynamic (loose)</option>
        </select>
      </div>

      <div className="forge-field">
        <label>Material</label>
        <select
          value={normalized.material}
          onChange={(event) => {
            const material = event.target.value as PropPhysicsMaterial;
            const withPreset = withMaterialPresetDefaults(normalized, material);
            onChange(normalizeForgePhysicsSettings(withPreset, bbox));
          }}
        >
          {FORGE_PHYSICS_MATERIALS.map((material) => (
            <option key={material} value={material}>
              {material}
            </option>
          ))}
        </select>
      </div>

      <div className="forge-field">
        <label>Mass Mode</label>
        <select
          value={normalized.massMode}
          onChange={(event) =>
            onChange(
              normalizeForgePhysicsSettings(
                {
                  ...normalized,
                  massMode: event.target.value as PropPhysicsSettings["massMode"]
                },
                bbox
              )
            )
          }
        >
          <option value="auto">Auto (volume x density)</option>
          <option value="manual">Manual</option>
        </select>
      </div>

      {normalized.massMode === "auto" ? (
        <div className="forge-field">
          <label>Mass Scale</label>
          <input
            type="number"
            min={0.1}
            max={10}
            step={0.05}
            value={normalized.massScale}
            onChange={(event) =>
              onChange(
                normalizeForgePhysicsSettings(
                  {
                    ...normalized,
                    massScale: Number(event.target.value)
                  },
                  bbox
                )
              )
            }
          />
        </div>
      ) : (
        <div className="forge-field">
          <label>Manual Mass</label>
          <input
            type="number"
            min={0.01}
            max={250}
            step={0.01}
            value={normalized.manualMass}
            onChange={(event) =>
              onChange(
                normalizeForgePhysicsSettings(
                  {
                    ...normalized,
                    manualMass: Number(event.target.value)
                  },
                  bbox
                )
              )
            }
          />
        </div>
      )}

      <div className="forge-info">
        Estimated Mass: {resolvedMass.toFixed(3)}
      </div>

      <div className="forge-field">
        <label>Friction</label>
        <input
          type="number"
          min={0}
          max={2}
          step={0.01}
          value={normalized.friction}
          onChange={(event) =>
            onChange(
              normalizeForgePhysicsSettings(
                {
                  ...normalized,
                  friction: Number(event.target.value)
                },
                bbox
              )
            )
          }
        />
      </div>

      <div className="forge-field">
        <label>Restitution</label>
        <input
          type="number"
          min={0}
          max={1}
          step={0.01}
          value={normalized.restitution}
          onChange={(event) =>
            onChange(
              normalizeForgePhysicsSettings(
                {
                  ...normalized,
                  restitution: Number(event.target.value)
                },
                bbox
              )
            )
          }
        />
      </div>

      <div className="forge-field">
        <label>Linear Damping</label>
        <input
          type="number"
          min={0}
          max={20}
          step={0.01}
          value={normalized.linearDamping}
          onChange={(event) =>
            onChange(
              normalizeForgePhysicsSettings(
                {
                  ...normalized,
                  linearDamping: Number(event.target.value)
                },
                bbox
              )
            )
          }
        />
      </div>

      <div className="forge-field">
        <label>Angular Damping</label>
        <input
          type="number"
          min={0}
          max={20}
          step={0.01}
          value={normalized.angularDamping}
          onChange={(event) =>
            onChange(
              normalizeForgePhysicsSettings(
                {
                  ...normalized,
                  angularDamping: Number(event.target.value)
                },
                bbox
              )
            )
          }
        />
      </div>

      <div className="forge-field">
        <label>Activation Delay (ms)</label>
        <input
          type="number"
          min={0}
          max={120000}
          step={10}
          value={normalized.activationDelayMs}
          disabled={normalized.mobility === "fixed"}
          onChange={(event) =>
            onChange(
              normalizeForgePhysicsSettings(
                {
                  ...normalized,
                  activationDelayMs: Number(event.target.value)
                },
                bbox
              )
            )
          }
        />
      </div>
    </div>
  );
}
