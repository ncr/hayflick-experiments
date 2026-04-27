import { useEffect, useMemo, useRef, useState } from "react";
import type { CachedGeneration } from "@common/core/imagegen-cache";
import { useAppDispatch, useAppState } from "../state/context";
import { useSceneRef } from "../engine/scene-context";
import {
  MATERIAL_STUDIO_CACHE_SOURCE,
  base64PngToImageData,
  generateBaseColorFromTemplate
} from "../api-client";
import { derivePbrMaps } from "../pbr-derive";
import {
  DEFAULT_PBR_PARAMS,
  atlasToImageData,
  type Atlas,
  type GeneratedMaps,
  type IslandLayout,
} from "../types";
import type { RgbaBuffer } from "../../uv-template-probe/uv-template";
import { HistoryPicker } from "./HistoryPicker";

const DELTA_CHIPS = [
  { label: "+ weathered", delta: " Subtly weathered with faint wear patterns; still reads as pristine overall." },
  { label: "+ pristine", delta: " Perfectly pristine, no damage, no discolouration." },
  { label: "+ warmer", delta: " Shift the palette towards warmer tones (warm whites, amber accents)." },
  { label: "+ cooler", delta: " Shift the palette towards cooler tones (cool whites, pale blues)." },
  { label: "+ coarser", delta: " Larger visible structural elements; fewer, chunkier blocks." },
  { label: "+ finer", delta: " Tighter grid, smaller blocks, more visual density." },
];

export function PromptPanel() {
  const { authoring } = useAppState();
  const dispatch = useAppDispatch();
  const sceneRef = useSceneRef();
  const [generating, setGenerating] = useState(false);
  const [showHistory, setShowHistory] = useState(false);

  const active = authoring?.activeRole ?? null;
  const state = active ? authoring?.surfaceStates[active] : null;

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
    const uvData = sceneRef.current?.getSubmeshUvData(active) ?? null;
    if (!uvData) {
      dispatch({
        type: "TOAST_ADD",
        level: "error",
        message: `No UV data for surface "${active}". Mesh may not have a UV channel.`,
      });
      return;
    }
    setGenerating(true);
    try {
      const result = await generateBaseColorFromTemplate({
        uvData,
        prompt,
        atlas: state.atlas ?? undefined,
        cacheTags: { baseMeshId: authoring.baseMeshId, role: active },
      });
      const baseColor = atlasToImageData(result.atlas);
      const maps: GeneratedMaps = derivePbrMaps(baseColor, DEFAULT_PBR_PARAMS);
      sceneRef.current?.applyAtlasUvs(active, result.islandLayout.newUvBuffer);
      sceneRef.current?.applyPbrTextures(active, maps);
      dispatch({
        type: "AUTHORING_GENERATED",
        role: active,
        atlas: result.atlas,
        maps,
        islandLayout: result.islandLayout,
        templateSent: result.templateSent,
        aiRaw: result.aiRaw,
        prompt,
      });
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
    if (!state.atlas || state.editHistory.length === 0) return;
    const top = state.editHistory[state.editHistory.length - 1];
    const baseColor = new ImageData(
      new Uint8ClampedArray(top.rgba),
      state.atlas.width,
      state.atlas.height
    );
    const maps = derivePbrMaps(baseColor, DEFAULT_PBR_PARAMS);
    sceneRef.current?.applyPbrTextures(active, maps);
    dispatch({ type: "AUTHORING_UNDO", role: active, maps });
  };

  const handleRedo = () => {
    if (!state.atlas || state.editFuture.length === 0) return;
    const top = state.editFuture[state.editFuture.length - 1];
    const baseColor = new ImageData(
      new Uint8ClampedArray(top.rgba),
      state.atlas.width,
      state.atlas.height
    );
    const maps = derivePbrMaps(baseColor, DEFAULT_PBR_PARAMS);
    sceneRef.current?.applyPbrTextures(active, maps);
    dispatch({ type: "AUTHORING_REDO", role: active, maps });
  };

  const handleApprove = () => {
    if (state.approved) dispatch({ type: "AUTHORING_UNAPPROVE", role: active });
    else dispatch({ type: "AUTHORING_APPROVE", role: active });
  };

  const handleHistoryPick = (p: string) => {
    dispatch({ type: "AUTHORING_SET_PROMPT", role: active, prompt: p });
  };

  const handlePickFromCache = async (entry: CachedGeneration) => {
    if (!entry.contextJson) {
      throw new Error("Cache entry has no material-studio context — cannot restore.");
    }
    const ctx = JSON.parse(entry.contextJson) as {
      // Older entries (pre-shrink) also stored finalAtlasB64 here; we read
      // outputB64 first and fall back to ctx.finalAtlasB64 for backwards compat.
      finalAtlasB64?: string;
      islandLayout: {
        templateWidth: number;
        templateHeight: number;
        islands: IslandLayout["islands"];
        uvRemap: IslandLayout["uvRemap"];
        vertexToIslandId: number[];
        newUv: number[];
      };
    };
    const atlasB64 = entry.outputB64 || ctx.finalAtlasB64;
    if (!atlasB64) throw new Error("Cache entry has no atlas image.");
    const baseColor = await base64PngToImageData(atlasB64);
    const islandLayout: IslandLayout = {
      templateWidth: ctx.islandLayout.templateWidth,
      templateHeight: ctx.islandLayout.templateHeight,
      islands: ctx.islandLayout.islands,
      uvRemap: ctx.islandLayout.uvRemap,
      vertexToIslandId: ctx.islandLayout.vertexToIslandId,
      newUvBuffer: new Float32Array(ctx.islandLayout.newUv)
    };
    const atlas: Atlas = {
      rgba: new Uint8ClampedArray(baseColor.data),
      mask: new Uint8Array(baseColor.width * baseColor.height),
      width: baseColor.width,
      height: baseColor.height,
    };
    const maps: GeneratedMaps = derivePbrMaps(baseColor, DEFAULT_PBR_PARAMS);
    sceneRef.current?.applyAtlasUvs(active, islandLayout.newUvBuffer);
    sceneRef.current?.applyPbrTextures(active, maps);
    // Template + AI raw aren't persisted any more (would balloon cache to ~3 MB
    // per entry for transient QA data). The previews show the atlas only after
    // Apply; the user can re-generate to see the AI roundtrip if they want it.
    dispatch({
      type: "AUTHORING_GENERATED",
      role: active,
      atlas,
      maps,
      islandLayout,
      templateSent: makeBlankRgba(1, 1),
      aiRaw: makeBlankRgba(1, 1),
      prompt: entry.prompt
    });
  };

  const canApplyEntry = (entry: CachedGeneration): boolean =>
    entry.tags.baseMeshId === authoring.baseMeshId && entry.tags.role === active;

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
      <div className="ms-action-row">
        <button className="ms-btn ms-btn-primary" disabled={!canGenerate} onClick={() => run()}>
          {generating ? "Generating…" : state.maps ? "Regenerate" : "Generate"}
        </button>
        <button
          className="ms-btn"
          onClick={() => setShowHistory(true)}
          disabled={generating}
          title="Pick from past generations"
        >
          History
        </button>
        <button
          className="ms-btn"
          disabled={state.editHistory.length === 0 || generating}
          onClick={handleUndo}
          title="Undo last paint stroke or generate"
        >
          Undo
        </button>
        <button
          className="ms-btn"
          disabled={state.editFuture.length === 0 || generating}
          onClick={handleRedo}
          title="Redo"
        >
          Redo
        </button>
        <button
          className={`ms-btn ${state.approved ? "ms-btn-success-on" : ""}`}
          onClick={handleApprove}
          disabled={generating}
        >
          {state.approved ? "Approved ✓" : "Approve"}
        </button>
      </div>
      {showHistory && (
        <HistoryPicker
          source={MATERIAL_STUDIO_CACHE_SOURCE}
          tags={{ baseMeshId: authoring.baseMeshId, role: active }}
          onClose={() => setShowHistory(false)}
          onPick={handlePickFromCache}
          canApply={canApplyEntry}
        />
      )}
      <QaPreviews
        templateSent={state.templateSent ?? null}
        aiRaw={state.aiRaw ?? null}
        finalAtlas={state.maps?.baseColor ?? null}
        islandCount={state.islandLayout?.islands.length ?? null}
      />
    </div>
  );
}

function QaPreviews(props: {
  templateSent: RgbaBuffer | null;
  aiRaw: RgbaBuffer | null;
  finalAtlas: ImageData | null;
  islandCount: number | null;
}) {
  if (!props.templateSent && !props.aiRaw && !props.finalAtlas) return null;
  return (
    <div className="ms-qa-previews">
      <div className="ms-panel-label">Inspect</div>
      <PreviewBlock
        label="Template (sent to AI)"
        sub={props.islandCount != null ? `${props.islandCount} islands packed` : undefined}
        source={props.templateSent}
      />
      <PreviewBlock label="AI raw output" source={props.aiRaw} />
      <PreviewBlock
        label="Final atlas (baked into GLB)"
        sub={
          props.finalAtlas
            ? `${props.finalAtlas.width}×${props.finalAtlas.height}`
            : undefined
        }
        source={props.finalAtlas}
      />
    </div>
  );
}

function makeBlankRgba(width: number, height: number): RgbaBuffer {
  return { data: new Uint8ClampedArray(width * height * 4), width, height };
}

function PreviewBlock(props: {
  label: string;
  sub?: string;
  source: RgbaBuffer | ImageData | null;
}) {
  const ref = useRef<HTMLCanvasElement | null>(null);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    if (props.source) {
      canvas.width = props.source.width;
      canvas.height = props.source.height;
      const id =
        props.source instanceof ImageData
          ? props.source
          : new ImageData(
              new Uint8ClampedArray(props.source.data),
              props.source.width,
              props.source.height
            );
      ctx.putImageData(id, 0, 0);
    } else {
      canvas.width = 1;
      canvas.height = 1;
      ctx.clearRect(0, 0, 1, 1);
    }
  }, [props.source]);
  return (
    <div className="ms-qa-block">
      <div className="ms-qa-label">
        <span>{props.label}</span>
        {props.sub && <span className="ms-qa-sub">{props.sub}</span>}
      </div>
      {props.source ? (
        <canvas ref={ref} className="ms-qa-canvas" />
      ) : (
        <div className="ms-qa-empty">— not generated yet</div>
      )}
    </div>
  );
}
