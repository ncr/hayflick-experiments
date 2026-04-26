import { useEffect, useState } from "react";
import {
  deleteEntry,
  listEntries,
  type CachedGeneration
} from "@common/core/imagegen-cache";

type Props = {
  source: string;
  onClose: () => void;
  onPick: (entry: CachedGeneration) => void;
};

/**
 * Minimal forge-styled history picker. Logic-wise identical to material-studio's
 * picker but renders with forge-* class names so it sits naturally in the
 * forge-core layout.
 */
export function HistoryPicker({ source, onClose, onPick }: Props) {
  const [entries, setEntries] = useState<CachedGeneration[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    listEntries({ source })
      .then((list) => {
        if (!cancelled) setEntries(list);
      })
      .catch((err) => {
        if (!cancelled) setError((err as Error).message);
      });
    return () => {
      cancelled = true;
    };
  }, [source]);

  const handleDelete = async (id: string) => {
    if (!confirm("Delete this generation from history?")) return;
    try {
      await deleteEntry(id);
      setEntries((cur) => (cur ? cur.filter((e) => e.id !== id) : cur));
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    <div className="forge-modal-overlay" onClick={onClose}>
      <div className="forge-modal" onClick={(e) => e.stopPropagation()}>
        <div className="forge-modal-header">
          <span>Concept image history</span>
          <button className="forge-btn" onClick={onClose}>
            Close
          </button>
        </div>
        {error && <div className="forge-error">{error}</div>}
        {entries === null && !error && (
          <div className="forge-modal-empty">Loading…</div>
        )}
        {entries !== null && entries.length === 0 && (
          <div className="forge-modal-empty">No past generations.</div>
        )}
        {entries !== null && entries.length > 0 && (
          <div className="forge-history-grid">
            {entries.map((entry) => (
              <div key={entry.id} className="forge-history-card">
                <img
                  className="forge-history-thumb"
                  src={`data:${entry.outputMimeType};base64,${entry.outputB64}`}
                  alt={entry.prompt}
                />
                <div className="forge-history-card-body">
                  <div
                    className="forge-history-card-prompt"
                    title={entry.prompt}
                  >
                    {entry.prompt}
                  </div>
                  <div className="forge-history-card-meta">
                    {new Date(entry.createdAt).toLocaleString()}
                  </div>
                  <div className="forge-history-card-actions">
                    <button
                      className="forge-btn forge-btn-primary"
                      onClick={() => {
                        onPick(entry);
                        onClose();
                      }}
                    >
                      Use
                    </button>
                    <button
                      className="forge-btn"
                      onClick={() => handleDelete(entry.id)}
                    >
                      Delete
                    </button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
