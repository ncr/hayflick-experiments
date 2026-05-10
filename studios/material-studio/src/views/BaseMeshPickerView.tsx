import { useEffect, useState } from "react";
import { useAppDispatch, useAppState } from "../state/context";
import { listBaseMeshes, loadBaseMeshSidecar, type BaseMeshSidecar } from "../api/catalog-client";
import { MeshThumbnail } from "../components/MeshThumbnail";
import { baseMeshKey, baseMeshUrl } from "../engine/thumbnail-renderer";

export function BaseMeshPickerView() {
  const { basePicker } = useAppState();
  const dispatch = useAppDispatch();
  const [sidecars, setSidecars] = useState<Record<string, BaseMeshSidecar | null>>({});

  useEffect(() => {
    let cancelled = false;
    dispatch({ type: "BASE_LOAD_START" });
    listBaseMeshes()
      .then(async (meshes) => {
        if (cancelled) return;
        dispatch({ type: "BASE_LOAD_DONE", meshes });
        const results = await Promise.all(meshes.map((id) => loadBaseMeshSidecar(id).then((s) => [id, s] as const)));
        if (cancelled) return;
        setSidecars(Object.fromEntries(results));
      })
      .catch((err: Error) => {
        if (!cancelled) dispatch({ type: "BASE_LOAD_FAIL", error: err.message });
      });
    return () => {
      cancelled = true;
    };
  }, [dispatch]);

  return (
    <div className="ms-view ms-base-picker">
      <header className="ms-topbar">
        <button className="ms-btn" onClick={() => dispatch({ type: "ENTER_LIBRARY" })}>
          ← Back to library
        </button>
        <h2 className="ms-topbar-title">Pick a base mesh</h2>
      </header>
      <main className="ms-main">
        {basePicker.loading && <div className="ms-hint">Loading base meshes…</div>}
        {basePicker.error && <div className="ms-hint ms-hint-error">Load failed: {basePicker.error}</div>}
        <div className="ms-grid">
          {basePicker.meshes.map((id) => {
            const dims = sidecars[id]?.part?.dimensions;
            return (
              <button
                key={id}
                className="ms-card ms-card-clickable"
                onClick={() => dispatch({ type: "START_NEW", baseMeshId: id })}
                title={`Start a new textured mesh from ${id}`}
              >
                <div className="ms-card-thumb-btn">
                  <MeshThumbnail cacheKey={baseMeshKey(id)} kind="base" url={baseMeshUrl(id)} alt={id} />
                </div>
                <div className="ms-card-body">
                  <div className="ms-card-name">{id}</div>
                  <div className="ms-card-meta">
                    {dims ? `${dims[0]}×${dims[1]}×${dims[2]} cm` : sidecars[id] === null ? "—" : "…"}
                  </div>
                </div>
              </button>
            );
          })}
        </div>
      </main>
    </div>
  );
}
