import { useState } from "react";
import type { PropItem } from "./types";
import { generate3DParallel } from "./batch";

interface Props {
  props: Map<string, PropItem>;
  selectedPropId: string | null;
  onSelectProp: (id: string) => void;
  updateProp: (id: string, patch: Partial<PropItem>) => void;
  onRemoveProp: (id: string) => void;
}

export function BatchImageGallery({
  props,
  selectedPropId,
  onSelectProp,
  updateProp,
  onRemoveProp,
}: Props) {
  const [generating3D, setGenerating3D] = useState(false);

  const items = Array.from(props.values());

  const handleGenerateAll3D = async () => {
    const ready = items.filter((p) => p.status === "image-ready");
    if (ready.length === 0) return;
    setGenerating3D(true);
    try {
      await generate3DParallel(ready, updateProp, 5);
    } finally {
      setGenerating3D(false);
    }
  };

  const imageReadyCount = items.filter(
    (p) => p.status === "image-ready"
  ).length;

  if (items.length === 0) {
    return (
      <div className="forge-panel forge-section" data-testid="forge-batch-gallery">
        <h3>Props Queue</h3>
        <p className="forge-muted">No props in queue</p>
      </div>
    );
  }

  return (
    <div className="forge-panel forge-section" data-testid="forge-batch-gallery">
      <h3>Props Queue ({items.length})</h3>

      <div className="forge-image-grid">
        {items.map((item) => (
          <div
            key={item.id}
            className={`forge-image-cell ${selectedPropId === item.id ? "forge-image-cell-selected" : ""}`}
            onClick={() => onSelectProp(item.id)}
            title={item.description}
            data-testid={`prop-cell-${item.id}`}
          >
            {item.conceptImage ? (
              <img src={item.conceptImage} alt={item.description} />
            ) : (
              <div className="forge-image-cell-placeholder">
                {item.description.slice(0, 30)}
              </div>
            )}
            <StatusBadge item={item} />
          </div>
        ))}
      </div>

      <div className="forge-gallery-actions">
        <button
          className="forge-btn forge-btn-primary"
          onClick={handleGenerateAll3D}
          disabled={generating3D || imageReadyCount === 0}
          data-testid="generate-all-3d-btn"
        >
          {generating3D
            ? "Generating 3D..."
            : `Generate All 3D (${imageReadyCount})`}
        </button>
        {selectedPropId && (
          <button
            className="forge-btn forge-btn-danger forge-btn-sm"
            onClick={() => onRemoveProp(selectedPropId)}
            data-testid="remove-prop-btn"
          >
            Remove
          </button>
        )}
      </div>

      {/* Selected prop details */}
      {selectedPropId && props.has(selectedPropId) && (
        <SelectedPropInfo item={props.get(selectedPropId)!} />
      )}
    </div>
  );
}

function StatusBadge({ item }: { item: PropItem }) {
  if (item.status === "generating-image") {
    return (
      <span className="forge-image-cell-badge forge-image-cell-badge-generating">
        img...
      </span>
    );
  }
  if (item.status === "generating-3d") {
    return (
      <span className="forge-image-cell-badge forge-image-cell-badge-generating">
        3D {item.modelProgress}%
      </span>
    );
  }
  if (item.status === "3d-ready" || item.status === "exported") {
    return (
      <span className="forge-image-cell-badge forge-image-cell-badge-ready">
        3D
      </span>
    );
  }
  if (item.status === "image-ready") {
    return (
      <span className="forge-image-cell-badge forge-image-cell-badge-ready">
        img
      </span>
    );
  }
  if (item.imageError || item.modelError) {
    return (
      <span className="forge-image-cell-badge forge-image-cell-badge-error">
        err
      </span>
    );
  }
  return null;
}

function SelectedPropInfo({ item }: { item: PropItem }) {
  return (
    <div style={{ marginTop: "0.5rem" }}>
      <div className="forge-info" data-testid="selected-prop-desc">
        {item.description}
      </div>
      {item.imageError && (
        <div className="forge-error">{item.imageError}</div>
      )}
      {item.modelError && (
        <div className="forge-error">{item.modelError}</div>
      )}
    </div>
  );
}
