import { useEffect, useMemo, useRef, useState } from "react";
import {
  generateFromGrid,
  syntheticArtifacts,
  type GenerateResult
} from "./image-api";
import { createScene, type SceneHandle } from "./scene";
import type { RgbaBuffer } from "./pixel-grid";

const DEFAULT_PROMPT =
  "stylized brick wall with mortar joints, two distinct brick tones, vibrant, deliberate chunky pixels";

// Choose 32×32 cells at 32 px each → 1024×1024 source image (a supported
// gpt-image-2 size). One full UV cycle is one tile (128 cm) → 32 horizontal
// screen pixels at zoom 1, so each texel maps to one screen pixel along the
// horizontal iso axis.
const CELLS_X = 32;
const CELLS_Y = 32;
const CELL_PX = 32;

type Status =
  | { kind: "idle" }
  | { kind: "running"; label: string }
  | { kind: "error"; message: string };

export function App() {
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const sceneRef = useRef<SceneHandle | null>(null);
  const [prompt, setPrompt] = useState(DEFAULT_PROMPT);
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  const [result, setResult] = useState<GenerateResult | null>(null);

  // Mount the Three.js scene once.
  useEffect(() => {
    let cancelled = false;
    let handle: SceneHandle | null = null;
    const mount = viewportRef.current;
    if (!mount) return;

    (async () => {
      try {
        handle = await createScene(mount);
        if (cancelled) {
          handle.dispose();
          return;
        }
        sceneRef.current = handle;
        // Default to the synthetic test pattern so the scene is non-blank
        // immediately. The e2e pixel-verification test depends on this.
        const synthetic = syntheticArtifacts({
          cellsX: CELLS_X,
          cellsY: CELLS_Y,
          cellPx: CELL_PX,
          userPrompt: ""
        });
        handle.setTexture(synthetic.pixelArt);
        setResult(synthetic);
        handle.forceFrame(3);
        // Expose a programmatic handle for tests + manual diagnostics.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (window as any).__pixelArtTex = {
          readPixel: (x: number, y: number) => handle!.readPixel(x, y),
          getCalibrationQuadBounds: () => handle!.getCalibrationQuadBounds(),
          getCurrentPixelArt: () => synthetic.pixelArt,
          forceFrame: (n?: number) => handle!.forceFrame(n),
          calibrationTexelCenterCanvas: (tx: number, ty: number) =>
            handle!.calibrationTexelCenterCanvas(tx, ty),
          getTexelResolution: () => handle!.getTexelResolution(),
          getViewState: () => handle!.getViewState(),
          getSceneSummary: () => handle!.getSceneSummary(),
          frameAndReadPixels: (positions: Array<{ x: number; y: number }>) =>
            handle!.frameAndReadPixels(positions)
        };
        // Sentinel for Playwright.
        mount.setAttribute("data-render-ready", "1");
      } catch (err) {
        setStatus({ kind: "error", message: (err as Error).message });
      }
    })();

    return () => {
      cancelled = true;
      mount.removeAttribute("data-render-ready");
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      delete (window as any).__pixelArtTex;
      handle?.dispose();
      sceneRef.current = null;
    };
  }, []);

  const onGenerate = async () => {
    if (status.kind === "running") return;
    setStatus({ kind: "running", label: "Calling gpt-image-2…" });
    try {
      const r = await generateFromGrid({
        cellsX: CELLS_X,
        cellsY: CELLS_Y,
        cellPx: CELL_PX,
        userPrompt: prompt
      });
      setResult(r);
      sceneRef.current?.setTexture(r.pixelArt);
      sceneRef.current?.forceFrame(3);
      // Update the pixel-art reference exposed for tests.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const handle = (window as any).__pixelArtTex;
      if (handle) handle.getCurrentPixelArt = () => r.pixelArt;
      setStatus({ kind: "idle" });
    } catch (err) {
      setStatus({ kind: "error", message: (err as Error).message });
    }
  };

  const onSynthetic = () => {
    const synthetic = syntheticArtifacts({
      cellsX: CELLS_X,
      cellsY: CELLS_Y,
      cellPx: CELL_PX,
      userPrompt: ""
    });
    setResult(synthetic);
    sceneRef.current?.setTexture(synthetic.pixelArt);
    sceneRef.current?.forceFrame(3);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const handle = (window as any).__pixelArtTex;
    if (handle) handle.getCurrentPixelArt = () => synthetic.pixelArt;
    setStatus({ kind: "idle" });
  };

  return (
    <div className="patex-app">
      <div className="patex-controls">
        <h2>Pixel-Art Tex POC</h2>
        <p className="patex-hint">
          {CELLS_X}×{CELLS_Y} texels → {CELLS_X * CELL_PX}×{CELLS_Y * CELL_PX}{" "}
          grid PNG → gpt-image-2 → median per cell → DataTexture (NEAREST,
          no mipmaps, no MSAA). Calibration quad on the left maps one texel
          to one screen pixel along the iso axis at zoom 1.
        </p>
        <label className="patex-label">
          Prompt
          <textarea
            className="patex-prompt"
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            rows={3}
          />
        </label>
        <div className="patex-buttons">
          <button
            type="button"
            className="patex-btn primary"
            disabled={status.kind === "running"}
            onClick={onGenerate}
          >
            {status.kind === "running" ? status.label : "Generate via AI"}
          </button>
          <button
            type="button"
            className="patex-btn"
            onClick={onSynthetic}
            disabled={status.kind === "running"}
          >
            Synthetic test pattern
          </button>
        </div>
        {status.kind === "error" && (
          <div className="patex-error">{status.message}</div>
        )}
        <div className="patex-previews">
          <PreviewBuffer label="Grid sent" buffer={result?.gridSent} />
          <PreviewBuffer label="AI raw" buffer={result?.aiRaw} />
          <PreviewBuffer
            label={`Pixel art (${CELLS_X}×${CELLS_Y})`}
            buffer={result?.pixelArt}
            scale={6}
          />
        </div>
      </div>
      <div className="patex-viewport" ref={viewportRef} />
    </div>
  );
}

function PreviewBuffer({
  label,
  buffer,
  scale = 1
}: {
  label: string;
  buffer: RgbaBuffer | undefined;
  scale?: number;
}) {
  const dataUrl = useMemo(() => {
    if (!buffer) return null;
    const canvas = document.createElement("canvas");
    canvas.width = buffer.width;
    canvas.height = buffer.height;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    const id = new ImageData(
      new Uint8ClampedArray(buffer.data),
      buffer.width,
      buffer.height
    );
    ctx.putImageData(id, 0, 0);
    return canvas.toDataURL();
  }, [buffer]);
  if (!buffer || !dataUrl) {
    return (
      <div className="patex-preview empty">
        <div className="patex-preview-label">{label}</div>
      </div>
    );
  }
  const displayW = Math.min(160, buffer.width * scale);
  return (
    <div className="patex-preview">
      <div className="patex-preview-label">
        {label} <span className="patex-dim">{buffer.width}×{buffer.height}</span>
      </div>
      <img
        src={dataUrl}
        width={displayW}
        height={(displayW / buffer.width) * buffer.height}
        style={{ imageRendering: "pixelated" }}
        alt={label}
      />
    </div>
  );
}
