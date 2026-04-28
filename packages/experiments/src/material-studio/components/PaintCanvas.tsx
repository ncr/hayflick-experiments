import { useEffect, useRef, useState } from "react";
import { useAppDispatch, useAppState } from "../state/context";
import { useSceneRef } from "../engine/scene-context";
import { cloneMask, cloneRgba, drawLine, hexToRgb } from "../paint/atlas-buffer";
import { DEFAULT_COLOR, PALETTE } from "../paint/palette";
import { atlasToImageData, DEFAULT_PBR_PARAMS } from "../types";
import { derivePbrMaps } from "../pbr-derive";

type Tool = "pencil" | "eraser";

const ZOOM_LEVELS = [1, 2, 4, 8, 12, 16, 24] as const;
const DEFAULT_ZOOM = 8;
/** Grid auto-shows from this zoom up; below it the lines obscure pixels. */
const GRID_AUTO_ZOOM = 4;

export function PaintCanvas() {
  const { authoring } = useAppState();
  const dispatch = useAppDispatch();
  const sceneRef = useSceneRef();

  const active = authoring?.activeRole ?? null;
  const surfaceState = active ? authoring?.surfaceStates[active] : null;
  const atlas = surfaceState?.atlas ?? null;
  const islandLayout = surfaceState?.islandLayout ?? null;

  const [tool, setTool] = useState<Tool>("pencil");
  const [color, setColor] = useState<string>(DEFAULT_COLOR);
  const [zoom, setZoom] = useState<number>(DEFAULT_ZOOM);
  const [gridOn, setGridOn] = useState<boolean>(true);

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const strokeRef = useRef<{
    rgba: Uint8ClampedArray<ArrayBuffer>;
    mask: Uint8Array<ArrayBuffer>;
    lastX: number;
    lastY: number;
    pointerId: number;
  } | null>(null);

  // Repaint canvas pixels whenever the atlas reference changes (after
  // commit / undo / redo / generate / surface switch).
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !atlas) return;
    canvas.width = atlas.width;
    canvas.height = atlas.height;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.imageSmoothingEnabled = false;
    ctx.putImageData(atlasToImageData(atlas), 0, 0);
  }, [atlas]);

  if (!authoring || !active || !surfaceState || !atlas) {
    return <div className="ms-paint-empty">Select a PBR surface to paint.</div>;
  }

  const eventToAtlasCoords = (clientX: number, clientY: number): { x: number; y: number } | null => {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return null;
    const x = Math.floor(((clientX - rect.left) / rect.width) * atlas.width);
    const y = Math.floor(((clientY - rect.top) / rect.height) * atlas.height);
    if (x < 0 || x >= atlas.width || y < 0 || y >= atlas.height) return null;
    return { x, y };
  };

  const paintColor = (): { r: number; g: number; b: number; mask: number } => {
    if (tool === "eraser") return { r: 255, g: 255, b: 255, mask: 0 };
    const c = hexToRgb(color);
    return { r: c.r, g: c.g, b: c.b, mask: 1 };
  };

  const previewPixels = (rgba: Uint8ClampedArray<ArrayBuffer>) => {
    const canvas = canvasRef.current;
    if (canvas) {
      const ctx = canvas.getContext("2d");
      if (ctx) ctx.putImageData(new ImageData(rgba, atlas.width, atlas.height), 0, 0);
    }
    sceneRef.current?.updateBaseColor(active, rgba, atlas.width, atlas.height);
  };

  const stroke = (
    rgba: Uint8ClampedArray<ArrayBuffer>,
    mask: Uint8Array<ArrayBuffer>,
    x0: number, y0: number, x1: number, y1: number
  ) => {
    const c = paintColor();
    drawLine(rgba, mask, atlas.width, atlas.height, x0, y0, x1, y1, c.r, c.g, c.b, c.mask);
    previewPixels(rgba);
  };

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    const pt = eventToAtlasCoords(e.clientX, e.clientY);
    if (!pt) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    const rgba = cloneRgba(atlas.rgba);
    const mask = cloneMask(atlas.mask);
    strokeRef.current = { rgba, mask, lastX: pt.x, lastY: pt.y, pointerId: e.pointerId };
    stroke(rgba, mask, pt.x, pt.y, pt.x, pt.y);
  };

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const s = strokeRef.current;
    if (!s || s.pointerId !== e.pointerId) return;
    const pt = eventToAtlasCoords(e.clientX, e.clientY);
    if (!pt) return;
    if (pt.x === s.lastX && pt.y === s.lastY) return;
    stroke(s.rgba, s.mask, s.lastX, s.lastY, pt.x, pt.y);
    s.lastX = pt.x;
    s.lastY = pt.y;
  };

  const onPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    const s = strokeRef.current;
    if (!s || s.pointerId !== e.pointerId) return;
    e.currentTarget.releasePointerCapture(e.pointerId);
    strokeRef.current = null;
    // Settle: re-derive PBR maps and apply the full texture set so normal
    // and ARM catch up to the live baseColor.
    const baseColor = new ImageData(s.rgba, atlas.width, atlas.height);
    const maps = derivePbrMaps(baseColor, DEFAULT_PBR_PARAMS);
    sceneRef.current?.applyPbrTextures(active, maps);
    dispatch({
      type: "AUTHORING_PAINT_COMMIT",
      role: active,
      nextRgba: s.rgba,
      nextMask: s.mask,
      maps,
      tag: "paint",
    });
  };

  const handleClearMask = () => {
    dispatch({ type: "AUTHORING_CLEAR_MASK", role: active });
  };

  const handleColorPick = (hex: string) => {
    setColor(hex);
    setTool("pencil");
  };

  const cssW = atlas.width * zoom;
  const cssH = atlas.height * zoom;
  const paintedCount = countPainted(atlas.mask);

  return (
    <div className="ms-paint-canvas">
      <div className="ms-paint-toolbar">
        <button
          className={`ms-btn ${tool === "pencil" ? "ms-btn-success-on" : ""}`}
          onClick={() => setTool("pencil")}
          title="Pencil"
        >
          ✏ Pencil
        </button>
        <button
          className={`ms-btn ${tool === "eraser" ? "ms-btn-success-on" : ""}`}
          onClick={() => setTool("eraser")}
          title="Eraser"
        >
          ⌫ Erase
        </button>
        <div className="ms-palette" role="group" aria-label="Palette">
          {PALETTE.map((sw) => (
            <button
              key={sw.hex}
              className={`ms-swatch-btn ${color === sw.hex ? "ms-swatch-btn-active" : ""}`}
              style={{ background: sw.hex }}
              onClick={() => handleColorPick(sw.hex)}
              title={sw.label}
              aria-label={sw.label}
            />
          ))}
        </div>
        <input
          type="color"
          value={color}
          onChange={(e) => handleColorPick(e.target.value)}
          className="ms-color-input"
          title="Custom colour"
        />
        <button
          className="ms-btn"
          onClick={handleClearMask}
          disabled={paintedCount === 0}
          title="Reset paint mask — AI may overwrite all cells on next Generate"
        >
          Clear mask
        </button>
        <select
          className="ms-zoom-select"
          value={zoom}
          onChange={(e) => setZoom(Number(e.target.value))}
          title="Zoom"
        >
          {ZOOM_LEVELS.map((z) => (
            <option key={z} value={z}>
              {z}×
            </option>
          ))}
        </select>
        <button
          className={`ms-btn ${gridOn ? "ms-btn-success-on" : ""}`}
          onClick={() => setGridOn((v) => !v)}
          title="Toggle pixel grid"
        >
          # Grid
        </button>
      </div>
      <div className="ms-paint-canvas-scroll">
        <div
          className="ms-paint-canvas-wrap"
          style={{ width: cssW, height: cssH }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
        >
          <canvas
            ref={canvasRef}
            width={atlas.width}
            height={atlas.height}
            style={{
              width: cssW,
              height: cssH,
              imageRendering: "pixelated",
              display: "block",
            }}
          />
          {islandLayout && (
            <svg
              className="ms-island-overlay"
              width={cssW}
              height={cssH}
              viewBox={`0 0 ${atlas.width} ${atlas.height}`}
              shapeRendering="crispEdges"
              style={{ position: "absolute", top: 0, left: 0, pointerEvents: "none" }}
            >
              {gridOn && zoom >= GRID_AUTO_ZOOM && islandLayout.islands.map((isl, i) => (
                <IslandGrid key={`g${i}`} isl={isl} />
              ))}
              {islandLayout.islands.map((isl, i) => (
                <rect
                  key={i}
                  x={isl.x}
                  y={isl.y}
                  width={isl.cellsX * isl.cellPx}
                  height={isl.cellsY * isl.cellPx}
                  fill="none"
                  stroke="#ff00ff"
                  strokeOpacity="0.6"
                  strokeWidth={1}
                  vectorEffect="non-scaling-stroke"
                />
              ))}
            </svg>
          )}
        </div>
      </div>
      <div className="ms-paint-status">
        <span>{atlas.width}×{atlas.height}</span>
        <span>·</span>
        <span>{islandLayout?.islands.length ?? 0} island(s)</span>
        <span>·</span>
        <span>{paintedCount} painted</span>
      </div>
    </div>
  );
}

function countPainted(mask: Uint8Array<ArrayBuffer>): number {
  let n = 0;
  for (let i = 0; i < mask.length; i++) if (mask[i] !== 0) n++;
  return n;
}

function IslandGrid({ isl }: { isl: { x: number; y: number; cellsX: number; cellsY: number; cellPx: number } }) {
  const x0 = isl.x;
  const y0 = isl.y;
  const x1 = isl.x + isl.cellsX * isl.cellPx;
  const y1 = isl.y + isl.cellsY * isl.cellPx;
  const verts: number[] = [];
  for (let cx = 1; cx < isl.cellsX; cx++) verts.push(x0 + cx * isl.cellPx);
  const horiz: number[] = [];
  for (let cy = 1; cy < isl.cellsY; cy++) horiz.push(y0 + cy * isl.cellPx);
  return (
    <g>
      {verts.map((x, i) => (
        <line
          key={`v${i}`}
          x1={x}
          x2={x}
          y1={y0}
          y2={y1}
          stroke="#000000"
          strokeOpacity="0.45"
          strokeWidth={1}
          vectorEffect="non-scaling-stroke"
        />
      ))}
      {horiz.map((y, i) => (
        <line
          key={`h${i}`}
          x1={x0}
          x2={x1}
          y1={y}
          y2={y}
          stroke="#000000"
          strokeOpacity="0.45"
          strokeWidth={1}
          vectorEffect="non-scaling-stroke"
        />
      ))}
    </g>
  );
}
