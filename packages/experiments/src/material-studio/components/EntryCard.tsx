import { MeshThumbnail } from "./MeshThumbnail";
import { entryKey, entryUrl } from "../engine/thumbnail-renderer";
import type { LibraryEntry } from "../state/types";

type Props = {
  entry: LibraryEntry;
  highlighted: boolean;
  onEdit: () => void;
  onDuplicate: () => void;
  onRename: () => void;
  onToggleProtected: () => void;
  onDelete: () => void;
};

export function EntryCard({ entry, highlighted, onEdit, onDuplicate, onRename, onToggleProtected, onDelete }: Props) {
  const version = entry.updatedAt ?? entry.bakedAt;
  return (
    <div className={`ms-card ${highlighted ? "ms-card-highlighted" : ""}`}>
      <button className="ms-card-thumb-btn" onClick={onEdit} title={`Edit ${entry.name}`}>
        <MeshThumbnail
          cacheKey={entryKey(entry.name, version)}
          kind="entry"
          url={entryUrl(entry.name)}
          alt={entry.name}
        />
        {entry.protected && <span className="ms-card-lock" title="Protected">Locked</span>}
      </button>
      <div className="ms-card-body">
        <div className="ms-card-name" title={entry.name}>
          {entry.name}
        </div>
        <div className="ms-card-meta">
          {entry.baseMeshId ?? "—"} · {entry.roles.length} surface{entry.roles.length === 1 ? "" : "s"}
        </div>
      </div>
      <div className="ms-card-actions">
        <button className="ms-icon-btn" onClick={onRename} title="Rename">✎</button>
        <button className="ms-icon-btn" onClick={onDuplicate} title="Duplicate">⎘</button>
        <button
          className={`ms-text-btn ${entry.protected ? "ms-text-btn-active" : ""}`}
          onClick={onToggleProtected}
          title={entry.protected ? "Unlock this entry" : "Protect from deletion"}
        >
          {entry.protected ? "Unlock" : "Lock"}
        </button>
        <button
          className="ms-icon-btn ms-icon-btn-danger"
          onClick={onDelete}
          disabled={entry.protected}
          title={entry.protected ? "Unlock to delete" : "Delete"}
        >
          ✕
        </button>
      </div>
    </div>
  );
}
