import { useEffect, useState } from "react";
import * as fsApi from "./api/fs";

interface Props {
  onSelectProp: (propId: string) => void;
  selectedProp: string;
}

export function PropGallery({ onSelectProp, selectedProp }: Props) {
  const [props, setProps] = useState<string[]>([]);

  useEffect(() => {
    fsApi.listDirs("props").then(setProps).catch(() => {});
  }, []);

  const refresh = () => {
    fsApi.listDirs("props").then(setProps).catch(() => {});
  };

  if (props.length === 0) {
    return (
      <div className="forge-panel forge-gallery" data-testid="forge-gallery">
        <h3>
          Props{" "}
          <button className="forge-btn-icon" onClick={refresh} title="Refresh">
            ↻
          </button>
        </h3>
        <p className="forge-muted">No props yet</p>
      </div>
    );
  }

  return (
    <div className="forge-panel forge-gallery" data-testid="forge-gallery">
      <h3>
        Props{" "}
        <button className="forge-btn-icon" onClick={refresh} title="Refresh">
          ↻
        </button>
      </h3>
      <ul className="forge-prop-list">
        {props.map((id) => (
          <li key={id}>
            <button
              className={`forge-prop-item ${
                selectedProp === id ? "forge-prop-active" : ""
              }`}
              onClick={() => onSelectProp(id)}
            >
              {id}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
