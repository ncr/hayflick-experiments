import { useEffect, useMemo, useRef, useState } from "react";
import {
  generateFromTemplate,
  syntheticArtifacts,
  type GenerateResult
} from "./image-api";
import { PRESETS, getPreset } from "./presets";
import type { RgbaBuffer } from "./uv-template";

type Status =
  | { kind: "idle" }
  | { kind: "running"; label: string }
  | { kind: "error"; message: string };

type Quality = "low" | "medium" | "high";

type ResultSource = "ai" | "synthetic" | "template-only";

type ResultState = {
  source: ResultSource;
  result: GenerateResult;
};

export function App() {
  const [presetId, setPresetId] = useState(PRESETS[0].id);
  const preset = useMemo(() => getPreset(presetId), [presetId]);
  const [prompts, setPrompts] = useState<string[]>(preset.defaultPrompts);
  const [quality, setQuality] = useState<Quality>("medium");
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  const [resultState, setResultState] = useState<ResultState | null>(null);

  // When the preset changes, reset prompts to defaults. We don't pre-build a
  // synthetic preview on mount any more — that meant painting a 1024² buffer
  // and (worse) toDataURL-encoding it before first paint, which blocked the
  // main thread for hundreds of ms in StrictMode. The user can click
  // "Synthetic preview" to see the template + a synthetic paint-through.
  useEffect(() => {
    setPrompts(preset.defaultPrompts);
    setResultState(null);
  }, [preset]);

  const onGenerate = async () => {
    if (status.kind === "running") return;
    setStatus({ kind: "running", label: `Calling gpt-image-2 (${quality})…` });
    try {
      const r = await generateFromTemplate({
        template: preset.template,
        islandPrompts: prompts,
        quality
      });
      setResultState({ source: "ai", result: r });
      setStatus({ kind: "idle" });
    } catch (err) {
      setStatus({ kind: "error", message: (err as Error).message });
    }
  };

  const onSynthetic = () => {
    const r = syntheticArtifacts({
      template: preset.template,
      islandPrompts: prompts
    });
    setResultState({ source: "synthetic", result: r });
    setStatus({ kind: "idle" });
  };

  const result = resultState?.result;
  const source = resultState?.source;
  const middleLabel =
    source === "ai"
      ? "AI raw output"
      : source === "synthetic"
        ? "Synthetic raw (local, no API)"
        : "Template only — click a button below";
  const showIslands = source === "ai" || source === "synthetic";
  const islandLabelPrefix = source === "synthetic" ? "Synthetic" : "AI";

  return (
    <div className="utp-app">
      <div className="utp-controls">
        <h2>UV Template Probe</h2>
        <p className="utp-hint">
          Send a multi-island template to gpt-image-2 and see whether the
          model paints inside the magenta-outlined islands and respects the
          per-cell grid. Probe for "approach 3" — UV-aware AI texturing.
        </p>

        <label className="utp-label">
          Preset
          <select
            className="utp-select"
            value={presetId}
            onChange={(e) => setPresetId(e.target.value)}
          >
            {PRESETS.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
          </select>
        </label>

        <div className="utp-island-prompts">
          {preset.template.islands.map((isl, idx) => (
            <label key={idx} className="utp-label">
              <span>
                {isl.name ?? `Island ${idx + 1}`}{" "}
                <span className="utp-dim">
                  {isl.cellsX}×{isl.cellsY}
                </span>
              </span>
              <textarea
                className="utp-prompt"
                value={prompts[idx] ?? ""}
                onChange={(e) => {
                  const next = [...prompts];
                  next[idx] = e.target.value;
                  setPrompts(next);
                }}
                rows={2}
              />
            </label>
          ))}
        </div>

        <label className="utp-label">
          Quality
          <select
            className="utp-select"
            value={quality}
            onChange={(e) => setQuality(e.target.value as Quality)}
          >
            <option value="low">low (fastest — known bad for multi-island)</option>
            <option value="medium">medium (recommended minimum)</option>
            <option value="high">high (slowest)</option>
          </select>
        </label>

        <div className="utp-buttons">
          <button
            type="button"
            className="utp-btn primary"
            disabled={status.kind === "running"}
            onClick={onGenerate}
          >
            {status.kind === "running" ? status.label : "Generate via AI"}
          </button>
          <button
            type="button"
            className="utp-btn"
            onClick={onSynthetic}
            disabled={status.kind === "running"}
          >
            Synthetic preview
          </button>
        </div>
        {status.kind === "error" && (
          <div className="utp-error">{status.message}</div>
        )}
      </div>

      <div className="utp-results">
        <div className="utp-row">
          <PreviewBuffer label="Template sent" buffer={result?.templateSent} maxWidth={420} />
          <PreviewBuffer
            label={middleLabel}
            buffer={source === "template-only" ? undefined : result?.aiRaw}
            maxWidth={420}
          />
        </div>
        {showIslands && (
          <div className="utp-island-row">
            {(result?.islandPixelArt ?? []).map((buf, idx) => (
              <PreviewBuffer
                key={idx}
                label={`${islandLabelPrefix} — ${preset.template.islands[idx]?.name ?? `Island ${idx + 1}`}`}
                buffer={buf}
                scale={6}
                maxWidth={200}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function PreviewBuffer({
  label,
  buffer,
  scale = 1,
  maxWidth = 240
}: {
  label: string;
  buffer: RgbaBuffer | undefined;
  scale?: number;
  maxWidth?: number;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  // Paint the buffer straight to a canvas — `toDataURL` on a 1024² image is
  // a few hundred ms of PNG-encoding on the main thread, which doubles in
  // StrictMode and was making this page take seconds to render. CSS handles
  // the upscale; image-rendering: pixelated keeps it crisp.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !buffer) return;
    canvas.width = buffer.width;
    canvas.height = buffer.height;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const id = new ImageData(
      new Uint8ClampedArray(buffer.data),
      buffer.width,
      buffer.height
    );
    ctx.putImageData(id, 0, 0);
  }, [buffer]);

  if (!buffer) {
    return (
      <div className="utp-preview empty">
        <div className="utp-preview-label">{label}</div>
      </div>
    );
  }
  const displayW = Math.min(maxWidth, buffer.width * scale);
  const displayH = (displayW / buffer.width) * buffer.height;
  return (
    <div className="utp-preview">
      <div className="utp-preview-label">
        {label}{" "}
        <span className="utp-dim">
          {buffer.width}×{buffer.height}
        </span>
      </div>
      <canvas
        ref={canvasRef}
        width={buffer.width}
        height={buffer.height}
        style={{
          width: `${displayW}px`,
          height: `${displayH}px`,
          imageRendering: "pixelated"
        }}
      />
    </div>
  );
}
