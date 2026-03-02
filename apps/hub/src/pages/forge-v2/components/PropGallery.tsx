import { useForgeState, useForgeDispatch } from "../state/forge-context";
import { StatusBadge } from "./shared/StatusBadge";
import { lifecycleToStageStatuses, type GalleryFilter, type SavedPropListItem } from "../state/forge-store";

const FILTERS: { label: string; value: GalleryFilter }[] = [
  { label: "All", value: "all" },
  { label: "Ref", value: "ref" },
  { label: "Mesh", value: "mesh" },
  { label: "Phy", value: "physics" },
];

function highestValidStageStatus(item: SavedPropListItem) {
  const stages = lifecycleToStageStatuses(item.status);
  if (stages.physics === "VALID") return "VALID" as const;
  if (stages.pix === "VALID") return "VALID" as const;
  if (stages.mesh === "VALID") return "VALID" as const;
  if (stages.ref === "VALID") return "VALID" as const;
  return "EMPTY" as const;
}

/** Filters show props that NEED WORK at this stage (missing or outdated). */
function matchesFilter(item: SavedPropListItem, filter: GalleryFilter): boolean {
  if (filter === "all") return true;
  const stages = lifecycleToStageStatuses(item.status);
  if (filter === "ref") return stages.ref !== "VALID";
  if (filter === "mesh") return stages.mesh !== "VALID";
  if (filter === "physics") return stages.physics !== "VALID";
  return true;
}

interface Props {
  onSelectProp: (propId: string) => void;
}

export function PropGallery({ onSelectProp }: Props) {
  const state = useForgeState();
  const dispatch = useForgeDispatch();

  const filtered = state.savedProps.filter((item) => matchesFilter(item, state.galleryFilter));

  // Unsaved drafts from batch generation
  const savedIds = new Set(state.savedProps.map((s) => s.id));
  const unsavedDrafts = Array.from(state.drafts.values()).filter(
    (d) => !d.tempId.startsWith("saved-") && !savedIds.has(d.idSlug)
  );

  return (
    <div className="ps-gallery">
      <div className="ps-gallery-header">
        <div className="ps-gallery-filters">
          {FILTERS.map((f) => (
            <button
              key={f.value}
              className={`ps-filter-btn ${state.galleryFilter === f.value ? "ps-filter-btn-active" : ""}`}
              onClick={() => dispatch({ type: "SET_GALLERY_FILTER", filter: f.value })}
            >
              {f.label}
            </button>
          ))}
        </div>
      </div>
      <div className="ps-gallery-strip">
        {/* Unsaved drafts (from batch, in-progress) */}
        {unsavedDrafts.map((d) => (
          <button
            key={d.tempId}
            className={`ps-gallery-thumb ps-gallery-thumb-draft ${state.selectedDraftId === d.tempId ? "ps-gallery-thumb-active" : ""}`}
            onClick={() => dispatch({ type: "SELECT_DRAFT", id: d.tempId })}
            title={`${d.description} (${d.status})`}
          >
            <div className="ps-gallery-thumb-image">
              {d.conceptImage ? (
                <img src={d.conceptImage} alt={d.description} />
              ) : (
                <div className="ps-gallery-thumb-placeholder ps-gallery-thumb-pending">
                  {d.status === "generating-image" ? (
                    <span className="ps-spinner" />
                  ) : (
                    <span className="ps-text-muted" style={{ fontSize: 9 }}>{d.description.slice(0, 8)}</span>
                  )}
                </div>
              )}
            </div>
          </button>
        ))}

        {/* Saved props */}
        {filtered.map((item) => (
          <button
            key={item.id}
            className={`ps-gallery-thumb ${state.selectedPropId === item.id ? "ps-gallery-thumb-active" : ""}`}
            onClick={() => onSelectProp(item.id)}
            title={item.description}
          >
            <div className="ps-gallery-thumb-image">
              {item.conceptImage ? (
                <img src={item.conceptImage} alt={item.description} />
              ) : (
                <div className="ps-gallery-thumb-placeholder" />
              )}
            </div>
            <div className="ps-gallery-thumb-badge">
              <StatusBadge status={highestValidStageStatus(item)} size={6} />
            </div>
          </button>
        ))}

        {filtered.length <= 0 && unsavedDrafts.length <= 0 && (
          <div className="ps-gallery-empty">
            {state.savedProps.length <= 0
              ? "No props yet"
              : "No props match this filter."}
          </div>
        )}

        {/* "+" button — right end, opens batch pane */}
        <button
          className={`ps-gallery-thumb ps-gallery-add-btn ${state.batchMode ? "ps-gallery-thumb-active" : ""}`}
          onClick={() => dispatch({ type: "SET_BATCH_MODE", on: !state.batchMode })}
          title="Add new props (batch generate)"
        >
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <line x1="12" y1="5" x2="12" y2="19" />
            <line x1="5" y1="12" x2="19" y2="12" />
          </svg>
        </button>
      </div>
    </div>
  );
}
