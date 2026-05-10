import { useAppDispatch, useAppState } from "../state/context";

function humaniseRole(role: string): string {
  if (role === "accent") return "Glass";
  const words = role.replace(/_/g, " ").split(/\s+/).filter(Boolean);
  return words.map((w) => w[0].toUpperCase() + w.slice(1)).join(" ");
}

export function SurfaceList() {
  const { authoring } = useAppState();
  const dispatch = useAppDispatch();
  if (!authoring) return null;

  return (
    <div className="ms-surface-list">
      <div className="ms-panel-label">Surfaces</div>
      {authoring.surfaces.map((s) => {
        const st = authoring.surfaceStates[s.role];
        const active = authoring.activeRole === s.role;
        const maps = st?.maps;
        return (
          <button
            key={s.role}
            className={`ms-surface-row ${active ? "ms-surface-row-active" : ""}`}
            onClick={() => dispatch({ type: "AUTHORING_SELECT_SURFACE", role: s.role })}
          >
            <SwatchChip maps={maps} kind={s.kind} glassTint={st?.glassParams?.tint} />
            <div className="ms-surface-row-body">
              <div className="ms-surface-row-name">{humaniseRole(s.role)}</div>
              <div className="ms-surface-row-tag">{s.kind === "synthetic" ? "Glass" : "PBR"}</div>
            </div>
            <div className={`ms-check-mark ${st?.approved ? "ms-check-mark-on" : ""}`}>
              {st?.approved ? "✓" : "·"}
            </div>
          </button>
        );
      })}
    </div>
  );
}

function SwatchChip({
  maps,
  kind,
  glassTint,
}: {
  maps: { baseColor: ImageData } | null | undefined;
  kind: "pbr" | "synthetic";
  glassTint?: string;
}) {
  if (kind === "synthetic") {
    return <span className="ms-swatch" style={{ background: glassTint ?? "#b8d2eb" }} />;
  }
  if (!maps) return <span className="ms-swatch ms-swatch-empty" />;
  const color = averageColor(maps.baseColor);
  return <span className="ms-swatch" style={{ background: color }} />;
}

function averageColor(img: ImageData): string {
  let r = 0,
    g = 0,
    b = 0;
  const n = img.data.length / 4;
  for (let i = 0; i < img.data.length; i += 4) {
    r += img.data[i];
    g += img.data[i + 1];
    b += img.data[i + 2];
  }
  return `rgb(${Math.round(r / n)}, ${Math.round(g / n)}, ${Math.round(b / n)})`;
}
