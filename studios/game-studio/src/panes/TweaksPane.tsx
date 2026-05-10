import { useSyncExternalStore } from "react";
import type { KnobEntry, KnobRegistry } from "@common/gameplay";

type Props = {
  registry: KnobRegistry;
};

export function TweaksPane({ registry }: Props) {
  const entries = useSyncExternalStore(
    (cb) => registry.subscribe(cb),
    () => registry.entries(),
    () => registry.entries()
  );

  if (entries.length === 0) {
    return <div className="game-studio-tweaks-empty">No knobs registered.</div>;
  }

  return (
    <div className="game-studio-tweaks-list">
      {entries.map((entry) => (
        <KnobRow key={entry.spec.key} entry={entry} />
      ))}
    </div>
  );
}

function KnobRow({ entry }: { entry: KnobEntry }) {
  const spec = entry.spec;
  const value = entry.get();

  if (spec.kind === "number") {
    const v = Number(value);
    const step = spec.step ?? Math.max((spec.max - spec.min) / 100, 0.0001);
    return (
      <label className="knob knob-number">
        <span className="knob-key">{spec.key}</span>
        <input
          type="range"
          min={spec.min}
          max={spec.max}
          step={step}
          value={v}
          onChange={(e) => entry.set(Number(e.target.value))}
        />
        <span className="knob-value">{formatNumber(v)}</span>
      </label>
    );
  }

  if (spec.kind === "toggle") {
    const v = Boolean(value);
    return (
      <label className="knob knob-toggle">
        <span className="knob-key">{spec.key}</span>
        <input
          type="checkbox"
          checked={v}
          onChange={(e) => entry.set(e.target.checked)}
        />
      </label>
    );
  }

  const v = String(value);
  return (
    <label className="knob knob-select">
      <span className="knob-key">{spec.key}</span>
      <select value={v} onChange={(e) => entry.set(e.target.value)}>
        {spec.options.map((opt) => (
          <option key={opt} value={opt}>
            {opt}
          </option>
        ))}
      </select>
    </label>
  );
}

function formatNumber(n: number): string {
  if (Number.isInteger(n)) return String(n);
  if (Math.abs(n) >= 100) return n.toFixed(1);
  return n.toFixed(2);
}
