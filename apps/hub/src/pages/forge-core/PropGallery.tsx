import { useEffect, useState } from "react";
import * as fsApi from "./api/fs";

interface SavedProp {
  id: string;
  description: string;
  conceptImage: string | null;
}

interface Props {
  onSelectProp: (propId: string) => void;
  selectedProp: string;
  refreshToken?: number;
}

export function PropGallery({ onSelectProp, selectedProp, refreshToken }: Props) {
  const [props, setProps] = useState<SavedProp[]>([]);
  const [loading, setLoading] = useState(false);

  const loadProps = async () => {
    setLoading(true);
    try {
      const ids = await fsApi.listDirs("props");
      const loaded = await Promise.all(
        ids.map(async (id) => {
          const item: SavedProp = { id, description: id, conceptImage: null };
          // Load meta for description
          try {
            const meta = await fsApi.readJson<{ description?: string }>(
              `props/${id}/meta.json`
            );
            if (meta.description) item.description = meta.description;
          } catch {
            // no meta
          }
          // Load concept thumbnail
          try {
            const res = await fsApi.readFile(`props/${id}/raw/concept.png`);
            const blob = await res.blob();
            item.conceptImage = await new Promise<string>((resolve) => {
              const reader = new FileReader();
              reader.onload = () => resolve(reader.result as string);
              reader.readAsDataURL(blob);
            });
          } catch {
            // no image
          }
          return item;
        })
      );
      setProps(loaded);
    } catch {
      // no props dir
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadProps();
  }, [refreshToken]);

  if (props.length === 0 && !loading) {
    return (
      <div className="forge-panel forge-gallery" data-testid="forge-gallery">
        <h3>
          Saved Props{" "}
          <button className="forge-btn-icon" onClick={loadProps} title="Refresh">
            ↻
          </button>
        </h3>
        <p className="forge-muted">No saved props yet</p>
      </div>
    );
  }

  return (
    <div className="forge-panel forge-gallery" data-testid="forge-gallery">
      <h3>
        Saved Props ({props.length}){" "}
        <button className="forge-btn-icon" onClick={loadProps} title="Refresh">
          ↻
        </button>
      </h3>
      <div className="forge-saved-grid">
        {props.map((prop) => (
          <button
            key={prop.id}
            className={`forge-saved-card ${
              selectedProp === prop.id ? "forge-saved-card-active" : ""
            }`}
            onClick={() => onSelectProp(prop.id)}
            title={prop.description}
          >
            {prop.conceptImage ? (
              <img
                className="forge-saved-card-img"
                src={prop.conceptImage}
                alt={prop.description}
              />
            ) : (
              <div className="forge-saved-card-placeholder" />
            )}
            <span className="forge-saved-card-label">
              {prop.description}
            </span>
          </button>
        ))}
      </div>
      {loading && <p className="forge-muted">Loading...</p>}
    </div>
  );
}
