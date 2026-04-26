import { useEffect, useMemo, useState } from "react";
import {
  deleteEntry,
  listEntries,
  type CachedGeneration
} from "@common/core/imagegen-cache";

export type HistoryPickerProps = {
  source: string;
  tags?: Record<string, string>;
  /**
   * Whether entries that don't match the active mesh+role should still be
   * listed (preview-only; "Apply" disabled). Default true so the user can
   * browse history broadly.
   */
  includeOtherContexts?: boolean;
  onClose: () => void;
  onPick: (entry: CachedGeneration) => Promise<void> | void;
  /**
   * Predicate run on each entry to decide if "Apply" is enabled. If unset,
   * any entry can be applied.
   */
  canApply?: (entry: CachedGeneration) => boolean;
};

export function HistoryPicker(props: HistoryPickerProps) {
  const [entries, setEntries] = useState<CachedGeneration[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setEntries(null);
    setError(null);
    const load = async () => {
      try {
        const filter = props.includeOtherContexts === false
          ? { source: props.source, tags: props.tags }
          : { source: props.source };
        const list = await listEntries(filter);
        if (cancelled) return;
        setEntries(list);
      } catch (err) {
        if (!cancelled) setError((err as Error).message);
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [props.source, JSON.stringify(props.tags), props.includeOtherContexts]);

  const handleDelete = async (id: string) => {
    if (!confirm("Delete this generation from history?")) return;
    try {
      await deleteEntry(id);
      setEntries((cur) => (cur ? cur.filter((e) => e.id !== id) : cur));
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const handlePick = async (entry: CachedGeneration) => {
    setBusy(true);
    try {
      await props.onPick(entry);
      props.onClose();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="ms-modal-overlay" onClick={props.onClose}>
      <div className="ms-modal" onClick={(e) => e.stopPropagation()}>
        <div className="ms-modal-header">
          <span>History</span>
          <button className="ms-icon-btn" onClick={props.onClose} title="Close">
            ×
          </button>
        </div>
        {error && <div className="ms-modal-error">{error}</div>}
        {entries === null && !error && (
          <div className="ms-modal-empty">Loading…</div>
        )}
        {entries !== null && entries.length === 0 && (
          <div className="ms-modal-empty">No generations yet for this source.</div>
        )}
        {entries !== null && entries.length > 0 && (
          <div className="ms-history-grid">
            {entries.map((entry) => (
              <HistoryEntryCard
                key={entry.id}
                entry={entry}
                applyEnabled={props.canApply ? props.canApply(entry) : true}
                busy={busy}
                onPick={() => handlePick(entry)}
                onDelete={() => handleDelete(entry.id)}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function HistoryEntryCard(props: {
  entry: CachedGeneration;
  applyEnabled: boolean;
  busy: boolean;
  onPick: () => void;
  onDelete: () => void;
}) {
  const { entry } = props;
  const url = useMemo(
    () => `data:${entry.outputMimeType};base64,${entry.outputB64}`,
    [entry.outputMimeType, entry.outputB64]
  );
  const time = useMemo(() => new Date(entry.createdAt).toLocaleString(), [entry.createdAt]);
  const tagsLabel = Object.entries(entry.tags)
    .map(([k, v]) => `${k}=${v}`)
    .join(" · ");
  return (
    <div className="ms-history-card">
      <img className="ms-history-thumb" src={url} alt={entry.prompt} />
      <div className="ms-history-card-body">
        <div className="ms-history-card-prompt" title={entry.prompt}>
          {entry.prompt}
        </div>
        <div className="ms-history-card-meta">
          <span>{time}</span>
          {tagsLabel && <span>{tagsLabel}</span>}
        </div>
        <div className="ms-history-card-actions">
          <button
            className="ms-btn ms-btn-primary"
            disabled={!props.applyEnabled || props.busy}
            onClick={props.onPick}
            title={props.applyEnabled ? "Restore this generation" : "Different mesh / role"}
          >
            Apply
          </button>
          <button className="ms-btn" onClick={props.onDelete} disabled={props.busy}>
            Delete
          </button>
        </div>
      </div>
    </div>
  );
}
