import { useSyncExternalStore } from "react";
import type { ViewportController } from "./ViewportPane";

type Props = {
  controller: ViewportController | null;
};

const EMPTY_LADDER: ReturnType<ViewportController["getLadder"]> = [];

export function ZoomRadio({ controller }: Props) {
  const ladder = useSyncExternalStore(
    (cb) => controller?.subscribe(cb) ?? noop,
    () => controller?.getLadder() ?? EMPTY_LADDER,
    () => controller?.getLadder() ?? EMPTY_LADDER
  );
  const current = useSyncExternalStore(
    (cb) => controller?.subscribe(cb) ?? noop,
    () => controller?.getCurrentZoom() ?? 0,
    () => controller?.getCurrentZoom() ?? 0
  );

  if (!controller || ladder.length === 0) {
    return null;
  }

  return (
    <div className="game-studio-zoom" role="radiogroup" aria-label="Zoom">
      {ladder.map(({ zoom, texelMm }) => {
        const checked = Math.abs(zoom - current) < 1e-6;
        return (
          <label
            key={zoom}
            className={"game-studio-zoom-option" + (checked ? " active" : "")}
          >
            <input
              type="radio"
              name="game-studio-zoom"
              checked={checked}
              onChange={() => controller.setZoom(zoom)}
            />
            <span className="game-studio-zoom-label">{formatZoom(zoom)}×</span>
            <span className="game-studio-zoom-mm">{formatMm(texelMm)}</span>
          </label>
        );
      })}
    </div>
  );
}

function noop(): () => void {
  return () => {};
}

function formatZoom(z: number): string {
  return Number.isInteger(z) ? String(z) : z.toFixed(2);
}

function formatMm(mm: number): string {
  if (!Number.isFinite(mm) || mm <= 0) return "—";
  if (mm < 0.1) return `${(mm * 1000).toFixed(0)}µm`;
  return `${mm.toFixed(mm < 1 ? 2 : 1)}mm`;
}
