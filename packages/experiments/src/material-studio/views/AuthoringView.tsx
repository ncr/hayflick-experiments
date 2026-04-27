import { useEffect, useRef, useState } from "react";
import { useAppDispatch, useAppState } from "../state/context";
import { AuthoringScene } from "../engine/authoring-scene";
import { SceneRefProvider } from "../engine/scene-context";
import { disposeThumbnailRenderer } from "../engine/thumbnail-renderer";
import { DEFAULT_GLASS_PARAMS } from "../state/reducer";
import { defaultPromptForRole } from "../api-client";
import { bakeFromAuthoring, bakeResultToLibraryEntry } from "../api/bake-client";
import { SurfaceList } from "../components/SurfaceList";
import { PromptPanel } from "../components/PromptPanel";
import { GlassControls } from "../components/GlassControls";
import { SaveBar } from "../components/SaveBar";
import type { SurfaceState } from "../types";

export function AuthoringView() {
  const { authoring } = useAppState();
  const dispatch = useAppDispatch();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const sceneRef = useRef<AuthoringScene | null>(null);
  const [sceneReady, setSceneReady] = useState(false);

  useEffect(() => {
    if (!containerRef.current) return;
    disposeThumbnailRenderer();
    const scene = new AuthoringScene(containerRef.current);
    sceneRef.current = scene;
    setSceneReady(true);
    return () => {
      scene.dispose();
      sceneRef.current = null;
      setSceneReady(false);
    };
  }, []);

  const mode = authoring?.mode;
  const baseMeshId = authoring?.baseMeshId;
  // Effect runs only when a new session is entered (mode / baseMeshId change).
  // At that moment authoring.surfaceStates is either the hydrated edit bundle
  // or empty (new mode); either way the closure captures the right snapshot
  // for this one-shot load.
  const sessionStatesSnapshot = authoring?.surfaceStates;
  const sessionActiveRoleSnapshot = authoring?.activeRole ?? null;

  useEffect(() => {
    if (!sceneReady || !baseMeshId) return;
    const scene = sceneRef.current;
    if (!scene) return;
    let cancelled = false;
    dispatch({ type: "AUTHORING_LOAD_BASE_START" });
    scene
      .loadBaseMesh(baseMeshId)
      .then((surfaces) => {
        if (cancelled) return;
        if (mode === "edit" && sessionStatesSnapshot) {
          for (const s of surfaces) {
            const st = sessionStatesSnapshot[s.role];
            if (!st) continue;
            if (s.kind === "synthetic" && st.glassParams) {
              scene.applyGlass(s.role, st.glassParams);
            } else if (st.maps) {
              scene.applyAtlasUvs(s.role, st.islandLayout?.newUvBuffer ?? null);
              scene.applyPbrTextures(s.role, st.maps);
            }
          }
          dispatch({
            type: "AUTHORING_LOAD_BASE_DONE",
            surfaces,
            surfaceStates: sessionStatesSnapshot,
            activeRole: sessionActiveRoleSnapshot,
          });
          return;
        }
        const initial: Record<string, SurfaceState> = {};
        for (const s of surfaces) {
          if (s.kind === "synthetic") {
            const params = { ...DEFAULT_GLASS_PARAMS };
            scene.applyGlass(s.role, params);
            initial[s.role] = {
              surface: s,
              prompt: "",
              maps: null,
              prevMaps: null,
              promptHistory: [],
              approved: true,
              glassParams: params,
            };
          } else {
            initial[s.role] = {
              surface: s,
              prompt: defaultPromptForRole(s.role),
              maps: null,
              prevMaps: null,
              promptHistory: [],
              approved: false,
            };
          }
        }
        const firstPbr = surfaces.find((s) => s.kind === "pbr");
        dispatch({
          type: "AUTHORING_LOAD_BASE_DONE",
          surfaces,
          surfaceStates: initial,
          activeRole: firstPbr?.role ?? surfaces[0]?.role ?? null,
        });
      })
      .catch((err: Error) => {
        if (!cancelled) dispatch({ type: "AUTHORING_LOAD_BASE_FAIL", error: err.message });
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sceneReady, baseMeshId, mode, dispatch]);

  const handleDiscard = () => {
    if (authoring?.dirty) {
      const ok = window.confirm("Discard unsaved changes?");
      if (!ok) return;
    }
    dispatch({ type: "ENTER_LIBRARY" });
  };

  const handleSave = async () => {
    if (!authoring) return;
    dispatch({ type: "AUTHORING_BAKE_START" });
    try {
      const result = await bakeFromAuthoring(authoring);
      dispatch({ type: "AUTHORING_BAKE_DONE" });
      dispatch({ type: "LIBRARY_ADD_ENTRY", entry: bakeResultToLibraryEntry(result) });
      dispatch({ type: "HIGHLIGHT_ENTRY", name: result.name });
      dispatch({
        type: "TOAST_ADD",
        level: "success",
        message: authoring.mode === "edit" ? `Updated ${result.name}` : `Created ${result.name}`,
      });
      dispatch({ type: "ENTER_LIBRARY" });
    } catch (err) {
      dispatch({ type: "AUTHORING_BAKE_FAIL", error: (err as Error).message });
      dispatch({ type: "TOAST_ADD", level: "error", message: (err as Error).message });
    }
  };

  const handlersRef = useRef({ save: handleSave, discard: handleDiscard });
  handlersRef.current.save = handleSave;
  handlersRef.current.discard = handleDiscard;

  useEffect(() => {
    const isTypingTarget = (t: EventTarget | null): boolean => {
      if (!(t instanceof HTMLElement)) return false;
      const tag = t.tagName;
      return tag === "INPUT" || tag === "TEXTAREA" || t.isContentEditable;
    };
    const onKey = (e: KeyboardEvent) => {
      if (!authoring) return;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        void handlersRef.current.save();
        return;
      }
      if (isTypingTarget(e.target)) return;
      if (e.key === "Escape") {
        e.preventDefault();
        handlersRef.current.discard();
        return;
      }
      const digit = Number(e.key);
      if (Number.isInteger(digit) && digit >= 1 && digit <= 9) {
        const s = authoring.surfaces[digit - 1];
        if (s) {
          e.preventDefault();
          dispatch({ type: "AUTHORING_SELECT_SURFACE", role: s.role });
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [authoring, dispatch]);

  if (!authoring) {
    return <div className="ms-hint">No authoring session active.</div>;
  }

  const activeState = authoring.activeRole ? authoring.surfaceStates[authoring.activeRole] : null;

  return (
    <SceneRefProvider value={sceneRef}>
      <div className="ms-view ms-authoring">
        <header className="ms-topbar">
          <button className="ms-btn" onClick={handleDiscard} disabled={authoring.baking}>
            ← Back
          </button>
          <div className="ms-topbar-title">
            {authoring.mode === "new" ? "New" : "Editing"} · {authoring.baseMeshId}
          </div>
        </header>
        <div className="ms-authoring-body">
          <div className="ms-viewport" ref={containerRef}>
            {authoring.loadingBase && <div className="ms-viewport-overlay">Loading mesh…</div>}
            {authoring.error && <div className="ms-viewport-overlay ms-hint-error">{authoring.error}</div>}
            {authoring.baking && <div className="ms-viewport-overlay">Baking — this usually takes about 30 seconds.</div>}
          </div>
          <aside className="ms-side-panel">
            <SurfaceList />
            {activeState?.surface.kind === "pbr" ? <PromptPanel /> : activeState ? <GlassControls /> : null}
            <SaveBar onSave={handleSave} busy={authoring.baking} />
          </aside>
        </div>
      </div>
    </SceneRefProvider>
  );
}
