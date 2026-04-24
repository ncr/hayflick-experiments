import { useEffect, useMemo, useRef, useState } from "react";
import { useAppDispatch, useAppState } from "../state/context";
import { useSceneRef } from "../engine/scene-context";
import { generateBaseColor } from "../api-client";
import { derivePbrMaps } from "../pbr-derive";
import { DEFAULT_PBR_PARAMS, type GeneratedMaps } from "../types";

const DELTA_CHIPS = [
  { label: "+ weathered", delta: " Subtly weathered with faint wear patterns; still reads as pristine overall." },
  { label: "+ pristine", delta: " Perfectly pristine, no damage, no discolouration." },
  { label: "+ warmer", delta: " Shift the palette towards warmer tones (warm whites, amber accents)." },
  { label: "+ cooler", delta: " Shift the palette towards cooler tones (cool whites, pale blues)." },
  { label: "+ coarser", delta: " Larger visible structural elements; fewer, chunkier blocks in the 64×64 grid." },
  { label: "+ finer", delta: " Tighter grid, smaller blocks, more visual density in the 64×64 grid." },
];

export function PromptPanel() {
  const { authoring } = useAppState();
  const dispatch = useAppDispatch();
  const sceneRef = useSceneRef();
  const [generating, setGenerating] = useState(false);
  const previewRef = useRef<HTMLCanvasElement | null>(null);

  const active = authoring?.activeRole ?? null;
  const state = active ? authoring?.surfaceStates[active] : null;

  useEffect(() => {
    if (!previewRef.current) return;
    const ctx = previewRef.current.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, 64, 64);
    if (state?.maps) ctx.putImageData(state.maps.baseColor, 0, 0);
  }, [state?.maps]);

  const canGenerate = useMemo(() => {
    return !!active && state?.surface.kind === "pbr" && !generating && (state?.prompt ?? "").trim().length > 0;
  }, [active, state, generating]);

  if (!authoring || !active || !state) {
    return <div className="ms-hint">Select a surface to begin.</div>;
  }

  if (state.surface.kind === "synthetic") {
    return null; // GlassControls handles this elsewhere
  }

  const run = async (promptOverride?: string) => {
    const prompt = (promptOverride ?? state.prompt).trim();
    if (!prompt) return;
    setGenerating(true);
    try {
      const baseColor = await generateBaseColor(prompt);
      const maps: GeneratedMaps = derivePbrMaps(baseColor, DEFAULT_PBR_PARAMS);
      sceneRef.current?.applyPbrTextures(active, maps);
      dispatch({ type: "AUTHORING_GENERATED", role: active, maps, prevMaps: state.maps, prompt });
    } catch (err) {
      dispatch({ type: "TOAST_ADD", level: "error", message: (err as Error).message });
    } finally {
      setGenerating(false);
    }
  };

  const handleDelta = (delta: string) => {
    const next = `${state.prompt}${delta}`;
    dispatch({ type: "AUTHORING_SET_PROMPT", role: active, prompt: next });
  };

  const handleUndo = () => {
    if (!state.prevMaps) return;
    sceneRef.current?.applyPbrTextures(active, state.prevMaps);
    dispatch({ type: "AUTHORING_UNDO_LAST_GEN", role: active });
  };

  const handleApprove = () => {
    if (state.approved) dispatch({ type: "AUTHORING_UNAPPROVE", role: active });
    else dispatch({ type: "AUTHORING_APPROVE", role: active });
  };

  const handleHistoryPick = (p: string) => {
    dispatch({ type: "AUTHORING_SET_PROMPT", role: active, prompt: p });
  };

  return (
    <div className="ms-prompt-panel">
      <div className="ms-panel-label">Prompt · {active}</div>
      <textarea
        className="ms-textarea"
        rows={7}
        value={state.prompt}
        onChange={(e) => dispatch({ type: "AUTHORING_SET_PROMPT", role: active, prompt: e.target.value })}
        placeholder="Describe this surface…"
        disabled={generating}
      />
      <div className="ms-chips">
        {DELTA_CHIPS.map((c) => (
          <button key={c.label} className="ms-chip" onClick={() => handleDelta(c.delta)} disabled={generating}>
            {c.label}
          </button>
        ))}
      </div>
      {state.promptHistory.length > 1 && (
        <details className="ms-history">
          <summary>Recent prompts ({state.promptHistory.length})</summary>
          <ul>
            {state.promptHistory.map((p, i) => (
              <li key={i}>
                <button className="ms-history-item" onClick={() => handleHistoryPick(p)} title={p}>
                  {p.length > 100 ? p.slice(0, 100) + "…" : p}
                </button>
                <button
                  className="ms-icon-btn"
                  onClick={() => navigator.clipboard?.writeText(p)}
                  title="Copy to clipboard"
                >
                  ⎘
                </button>
              </li>
            ))}
          </ul>
        </details>
      )}
      <div className="ms-preview-row">
        <canvas ref={previewRef} className="ms-preview-canvas" width={64} height={64} />
        <div className="ms-preview-info">
          <div className="ms-preview-label">64×64 baseColor</div>
          <div className="ms-preview-sub">{state.maps ? "Latest generation" : "No generation yet"}</div>
        </div>
      </div>
      <div className="ms-action-row">
        <button className="ms-btn ms-btn-primary" disabled={!canGenerate} onClick={() => run()}>
          {generating ? "Generating…" : state.maps ? "Regenerate" : "Generate"}
        </button>
        {state.maps && (
          <button className="ms-btn" disabled={!state.prevMaps || generating} onClick={handleUndo}>
            Undo
          </button>
        )}
        {state.maps && (
          <button
            className={`ms-btn ${state.approved ? "ms-btn-success-on" : ""}`}
            onClick={handleApprove}
            disabled={generating}
          >
            {state.approved ? "Approved ✓" : "Approve"}
          </button>
        )}
      </div>
    </div>
  );
}
