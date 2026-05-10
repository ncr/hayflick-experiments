import { useEffect, useMemo, useState } from "react";
import { useAppState, useAppDispatch } from "../state/context";
import { deleteEntry, duplicateEntry, listEntries, loadEntry, patchEntry } from "../api/catalog-client";
import { countReferences, rewriteReferences } from "../state/references";
import { base64PngToImageData } from "../api-client";
import { EntryCard } from "../components/EntryCard";
import { ConfirmDialog } from "../components/ConfirmDialog";
import type { LibraryEntry } from "../state/types";
import type { Surface, SurfaceState } from "../types";
import { DEFAULT_GLASS_PARAMS } from "../state/reducer";

type Modal =
  | null
  | { kind: "delete"; entry: LibraryEntry; refCount: number; busy: boolean }
  | { kind: "rename"; entry: LibraryEntry; value: string; refCount: number; busy: boolean; rewrite: boolean }
  | { kind: "duplicate"; entry: LibraryEntry; value: string; busy: boolean };

export function LibraryView() {
  const { library, highlightEntry } = useAppState();
  const dispatch = useAppDispatch();
  const [modal, setModal] = useState<Modal>(null);

  useEffect(() => {
    let cancelled = false;
    dispatch({ type: "LIBRARY_LOAD_START" });
    listEntries()
      .then((entries) => {
        if (!cancelled) dispatch({ type: "LIBRARY_LOAD_DONE", entries });
      })
      .catch((err: Error) => {
        if (!cancelled) dispatch({ type: "LIBRARY_LOAD_FAIL", error: err.message });
      });
    return () => {
      cancelled = true;
    };
  }, [dispatch]);

  const filtered = useMemo(() => {
    const s = library.search.trim().toLowerCase();
    return library.entries.filter((e) => {
      if (library.baseMeshFilter && e.baseMeshId !== library.baseMeshFilter) return false;
      if (s && !e.name.toLowerCase().includes(s)) return false;
      return true;
    });
  }, [library.entries, library.search, library.baseMeshFilter]);

  const baseMeshOptions = useMemo(() => {
    const set = new Set<string>();
    for (const e of library.entries) {
      if (e.baseMeshId) set.add(e.baseMeshId);
    }
    return Array.from(set).sort();
  }, [library.entries]);

  const doDelete = async (entry: LibraryEntry) => {
    setModal({ kind: "delete", entry, refCount: countReferences(entry.name), busy: false });
  };

  const confirmDelete = async () => {
    if (modal?.kind !== "delete") return;
    setModal({ ...modal, busy: true });
    try {
      await deleteEntry(modal.entry.name);
      dispatch({ type: "LIBRARY_REMOVE_ENTRY", name: modal.entry.name });
      dispatch({ type: "TOAST_ADD", level: "success", message: `Deleted ${modal.entry.name}` });
      setModal(null);
    } catch (err) {
      dispatch({ type: "TOAST_ADD", level: "error", message: (err as Error).message });
      setModal(null);
    }
  };

  const startRename = (entry: LibraryEntry) => {
    setModal({
      kind: "rename",
      entry,
      value: entry.name,
      refCount: countReferences(entry.name),
      busy: false,
      rewrite: true,
    });
  };

  const confirmRename = async () => {
    if (modal?.kind !== "rename") return;
    const target = modal.value.trim();
    if (!target || target === modal.entry.name) {
      setModal(null);
      return;
    }
    setModal({ ...modal, busy: true });
    try {
      await patchEntry(modal.entry.name, { rename: target });
      if (modal.rewrite && modal.refCount > 0) {
        rewriteReferences(modal.entry.name, target);
      }
      dispatch({ type: "LIBRARY_RENAME_ENTRY", from: modal.entry.name, to: target });
      dispatch({
        type: "TOAST_ADD",
        level: "success",
        message: `Renamed → ${target}${modal.rewrite && modal.refCount > 0 ? ` (${modal.refCount} map ref${modal.refCount === 1 ? "" : "s"} updated)` : ""}`,
      });
      setModal(null);
    } catch (err) {
      dispatch({ type: "TOAST_ADD", level: "error", message: (err as Error).message });
      setModal(null);
    }
  };

  const startDuplicate = (entry: LibraryEntry) => {
    setModal({ kind: "duplicate", entry, value: `${entry.name}-copy`, busy: false });
  };

  const confirmDuplicate = async () => {
    if (modal?.kind !== "duplicate") return;
    const target = modal.value.trim();
    if (!target) {
      setModal(null);
      return;
    }
    setModal({ ...modal, busy: true });
    try {
      const result = await duplicateEntry(modal.entry.name, target);
      const now = new Date().toISOString();
      const newEntry: LibraryEntry = {
        name: result.name,
        baseMeshId: modal.entry.baseMeshId,
        roles: [...modal.entry.roles],
        prompts: { ...modal.entry.prompts },
        bakedAt: now,
        updatedAt: now,
        protected: false,
      };
      dispatch({ type: "LIBRARY_ADD_ENTRY", entry: newEntry });
      dispatch({ type: "HIGHLIGHT_ENTRY", name: result.name });
      dispatch({ type: "TOAST_ADD", level: "success", message: `Duplicated → ${result.name}` });
      setModal(null);
    } catch (err) {
      dispatch({ type: "TOAST_ADD", level: "error", message: (err as Error).message });
      setModal(null);
    }
  };

  const startEdit = async (entry: LibraryEntry) => {
    if (entry.protected) {
      dispatch({ type: "TOAST_ADD", level: "info", message: `${entry.name} is locked — unlock to edit` });
      return;
    }
    if (!entry.baseMeshId) {
      dispatch({ type: "TOAST_ADD", level: "error", message: `${entry.name}: missing base mesh id in manifest` });
      return;
    }
    try {
      const loaded = await loadEntry(entry.name);
      const roles = loaded.manifest.roles ?? [];
      const surfaces: Surface[] = roles.map((role) => {
        const isGlass = role === "accent";
        return { role, kind: isGlass ? "synthetic" : "pbr", synthetic: isGlass ? "glass" : undefined };
      });
      const surfaceStates: Record<string, SurfaceState> = {};
      for (const s of surfaces) {
        const prompt = loaded.manifest.prompts?.[s.role] ?? "";
        if (s.kind === "synthetic") {
          surfaceStates[s.role] = {
            surface: s,
            prompt: "",
            atlas: null,
            islandLayout: null,
            maps: null,
            editHistory: [],
            editFuture: [],
            templateSent: null,
            aiRaw: null,
            promptHistory: [],
            approved: true,
            glassParams: { ...DEFAULT_GLASS_PARAMS },
          };
          continue;
        }
        const tex = loaded.textures[s.role];
        if (!tex) {
          surfaceStates[s.role] = {
            surface: s,
            prompt,
            atlas: null,
            islandLayout: null,
            maps: null,
            editHistory: [],
            editFuture: [],
            templateSent: null,
            aiRaw: null,
            promptHistory: prompt ? [prompt] : [],
            approved: false,
          };
          continue;
        }
        const [bc, nr, ar] = await Promise.all([
          base64PngToImageData(tex.baseColorB64),
          base64PngToImageData(tex.normalB64),
          base64PngToImageData(tex.armB64),
        ]);
        surfaceStates[s.role] = {
          surface: s,
          prompt,
          atlas: {
            rgba: new Uint8ClampedArray(bc.data),
            mask: new Uint8Array(bc.width * bc.height),
            width: bc.width,
            height: bc.height,
          },
          islandLayout: null,
          maps: { baseColor: bc, normal: nr, arm: ar },
          editHistory: [],
          editFuture: [],
          templateSent: null,
          aiRaw: null,
          promptHistory: prompt ? [prompt] : [],
          approved: true,
          pbrTweak: loaded.manifest.pbrTweaks?.[s.role]
            ? { ...loaded.manifest.pbrTweaks[s.role] }
            : undefined,
        };
      }
      const firstPbr = surfaces.find((s) => s.kind === "pbr");
      dispatch({
        type: "START_EDIT",
        session: {
          mode: "edit",
          baseMeshId: entry.baseMeshId,
          entryName: entry.name,
          originalName: entry.name,
          protected: entry.protected,
          surfaces,
          surfaceStates,
          activeRole: firstPbr?.role ?? surfaces[0]?.role ?? null,
          baking: false,
          dirty: false,
          loadingBase: true,
          error: null,
        },
      });
    } catch (err) {
      dispatch({ type: "TOAST_ADD", level: "error", message: (err as Error).message });
    }
  };

  const toggleProtected = async (entry: LibraryEntry) => {
    const next = !entry.protected;
    try {
      await patchEntry(entry.name, { protected: next });
      dispatch({ type: "LIBRARY_PATCH_ENTRY", name: entry.name, patch: { protected: next } });
      dispatch({
        type: "TOAST_ADD",
        level: "info",
        message: next ? `${entry.name} locked` : `${entry.name} unlocked`,
      });
    } catch (err) {
      dispatch({ type: "TOAST_ADD", level: "error", message: (err as Error).message });
    }
  };

  return (
    <div className="ms-view ms-library">
      <header className="ms-topbar">
        <button className="ms-btn ms-btn-primary" onClick={() => dispatch({ type: "ENTER_BASE_PICKER" })}>
          + New
        </button>
        <input
          className="ms-input ms-search"
          placeholder="Search by name…"
          value={library.search}
          onChange={(e) => dispatch({ type: "LIBRARY_SET_SEARCH", value: e.target.value })}
        />
        <div className="ms-filter-chips" role="toolbar" aria-label="Filter by base mesh">
          <button
            className={`ms-chip ${library.baseMeshFilter === null ? "ms-chip-active" : ""}`}
            onClick={() => dispatch({ type: "LIBRARY_SET_BASE_FILTER", value: null })}
          >
            All
          </button>
          {baseMeshOptions.map((id) => (
            <button
              key={id}
              className={`ms-chip ${library.baseMeshFilter === id ? "ms-chip-active" : ""}`}
              onClick={() => dispatch({ type: "LIBRARY_SET_BASE_FILTER", value: id })}
            >
              {id}
            </button>
          ))}
        </div>
      </header>

      <main className="ms-main">
        {library.loading && <div className="ms-hint">Loading library…</div>}
        {library.error && <div className="ms-hint ms-hint-error">Load failed: {library.error}</div>}
        {!library.loading && !library.error && library.entries.length === 0 && (
          <div className="ms-empty">
            <p>No textured meshes yet.</p>
            <button className="ms-btn ms-btn-primary" onClick={() => dispatch({ type: "ENTER_BASE_PICKER" })}>
              Create your first
            </button>
          </div>
        )}
        {!library.loading && !library.error && filtered.length === 0 && library.entries.length > 0 && (
          <div className="ms-hint">No entries match the current filter.</div>
        )}
        <div className="ms-grid">
          {filtered.map((entry) => (
            <EntryCard
              key={entry.name}
              entry={entry}
              highlighted={highlightEntry === entry.name}
              onEdit={() => startEdit(entry)}
              onDuplicate={() => startDuplicate(entry)}
              onRename={() => startRename(entry)}
              onToggleProtected={() => toggleProtected(entry)}
              onDelete={() => doDelete(entry)}
            />
          ))}
        </div>
      </main>

      {modal?.kind === "delete" && (
        <ConfirmDialog
          title={`Delete ${modal.entry.name}?`}
          body={
            <>
              <p>
                This removes <code>{modal.entry.name}</code> from the library and deletes the artifact, manifest, and texture
                PNGs from disk. This cannot be undone.
              </p>
              {modal.refCount > 0 && (
                <p className="ms-hint-warn">
                  {modal.refCount} tile{modal.refCount === 1 ? "" : "s"} in the saved map-editor state reference this entry —
                  they will show as missing after deletion.
                </p>
              )}
            </>
          }
          confirmLabel="Delete"
          confirmVariant="danger"
          busy={modal.busy}
          onConfirm={confirmDelete}
          onCancel={() => setModal(null)}
        />
      )}

      {modal?.kind === "rename" && (
        <ConfirmDialog
          title={`Rename ${modal.entry.name}`}
          body={
            <>
              <label className="ms-field">
                <span>New name</span>
                <input
                  className="ms-input"
                  value={modal.value}
                  autoFocus
                  onChange={(e) => setModal({ ...modal, value: e.target.value })}
                  onKeyDown={(e) => e.key === "Enter" && confirmRename()}
                />
              </label>
              {modal.refCount > 0 && (
                <label className="ms-check">
                  <input
                    type="checkbox"
                    checked={modal.rewrite}
                    onChange={(e) => setModal({ ...modal, rewrite: e.target.checked })}
                  />
                  <span>
                    Also update {modal.refCount} reference{modal.refCount === 1 ? "" : "s"} in the saved map-editor state
                  </span>
                </label>
              )}
            </>
          }
          confirmLabel="Rename"
          busy={modal.busy}
          onConfirm={confirmRename}
          onCancel={() => setModal(null)}
        />
      )}

      {modal?.kind === "duplicate" && (
        <ConfirmDialog
          title={`Duplicate ${modal.entry.name}`}
          body={
            <label className="ms-field">
              <span>New name</span>
              <input
                className="ms-input"
                value={modal.value}
                autoFocus
                onChange={(e) => setModal({ ...modal, value: e.target.value })}
                onKeyDown={(e) => e.key === "Enter" && confirmDuplicate()}
              />
            </label>
          }
          confirmLabel="Duplicate"
          busy={modal.busy}
          onConfirm={confirmDuplicate}
          onCancel={() => setModal(null)}
        />
      )}
    </div>
  );
}
