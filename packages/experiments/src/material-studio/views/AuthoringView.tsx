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
import { PaintCanvas } from "../components/PaintCanvas";
import { prepareSurface } from "../uv-template/prepare";
import { derivePbrMaps } from "../pbr-derive";
import {
  DEFAULT_PBR_PARAMS,
  atlasToImageData,
  type Atlas,
  type GeneratedMaps,
  type IslandLayout,
  type Surface,
  type SubmeshUvData,
  type SurfaceState,
} from "../types";

function freshPbrSurfaceState(opts: {
  surface: Surface;
  prompt: string;
  atlas: Atlas;
  islandLayout: IslandLayout;
  maps: GeneratedMaps;
  approved?: boolean;
}): SurfaceState {
  return {
    surface: opts.surface,
    prompt: opts.prompt,
    atlas: opts.atlas,
    islandLayout: opts.islandLayout,
    maps: opts.maps,
    editHistory: [],
    editFuture: [],
    templateSent: null,
    aiRaw: null,
    promptHistory: opts.prompt ? [opts.prompt] : [],
    approved: opts.approved ?? false,
  };
}

function freshSyntheticSurfaceState(s: Surface, glassParams: NonNullable<SurfaceState["glassParams"]>): SurfaceState {
  return {
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
    glassParams,
  };
}

function seedFromUvData(uvData: SubmeshUvData): { atlas: Atlas; islandLayout: IslandLayout; maps: GeneratedMaps } {
  const prep = prepareSurface(uvData);
  const maps = derivePbrMaps(atlasToImageData(prep.atlas), DEFAULT_PBR_PARAMS);
  return { atlas: prep.atlas, islandLayout: prep.islandLayout, maps };
}

export function AuthoringView() {
  const appState = useAppState();
  const { authoring } = appState;
  const dispatch = useAppDispatch();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const sceneRef = useRef<AuthoringScene | null>(null);
  // Live ref into app state so the test handle below can read the current
  // active surface from a useEffect-captured closure.
  const stateRef = useRef(appState);
  stateRef.current = appState;
  const [sceneReady, setSceneReady] = useState(false);

  useEffect(() => {
    if (!containerRef.current) return;
    disposeThumbnailRenderer();
    const scene = new AuthoringScene(containerRef.current);
    sceneRef.current = scene;
    // Test hook — Playwright reads framebuffer pixels through this handle.
    // No-op when window is undefined (SSR safety).
    if (typeof window !== "undefined") {
      (window as Window & {
        __materialStudio?: {
          scene: AuthoringScene;
          getActiveSurfaceState: () => SurfaceState | null;
          getActiveRole: () => string | null;
          /** Test helper: paint one atlas pixel programmatically and push
           *  the change to the live texture. Bypasses the PaintCanvas DOM
           *  pointer flow so e2e specs can target islands packed beyond
           *  the viewport's CSS extent. */
          testPaintAtlasPixel: (
            role: string,
            x: number,
            y: number,
            r: number,
            g: number,
            b: number
          ) => boolean;
        };
      }).__materialStudio = {
        scene,
        getActiveSurfaceState: () => {
          const a = stateRef.current.authoring;
          if (!a || !a.activeRole) return null;
          return a.surfaceStates[a.activeRole] ?? null;
        },
        getActiveRole: () => stateRef.current.authoring?.activeRole ?? null,
        testPaintAtlasPixel: (role, x, y, r, g, b) => {
          const surf = stateRef.current.authoring?.surfaceStates?.[role];
          if (!surf?.atlas) return false;
          const { atlas } = surf;
          if (x < 0 || x >= atlas.width || y < 0 || y >= atlas.height) return false;
          const i = (y * atlas.width + x) * 4;
          atlas.rgba[i] = r;
          atlas.rgba[i + 1] = g;
          atlas.rgba[i + 2] = b;
          atlas.rgba[i + 3] = 255;
          atlas.mask[y * atlas.width + x] = 1;
          scene.updateBaseColor(role, atlas.rgba, atlas.width, atlas.height);
          return true;
        },
      };
    }
    setSceneReady(true);
    return () => {
      scene.dispose();
      sceneRef.current = null;
      if (typeof window !== "undefined") {
        delete (window as Window & { __materialStudio?: unknown }).__materialStudio;
      }
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
        const finalStates: Record<string, SurfaceState> = {};
        for (const s of surfaces) {
          if (s.kind === "synthetic") {
            const hydrated = sessionStatesSnapshot?.[s.role];
            const params = hydrated?.glassParams ?? { ...DEFAULT_GLASS_PARAMS };
            scene.applyGlass(s.role, params);
            finalStates[s.role] = hydrated ?? freshSyntheticSurfaceState(s, params);
            continue;
          }

          const uvData = scene.getSubmeshUvData(s.role);
          if (!uvData) {
            finalStates[s.role] =
              sessionStatesSnapshot?.[s.role] ??
              freshSyntheticSurfaceState(s, { ...DEFAULT_GLASS_PARAMS });
            continue;
          }

          const seeded = seedFromUvData(uvData);
          const hydrated = mode === "edit" ? sessionStatesSnapshot?.[s.role] : undefined;

          // Hydrate atlas pixels from saved baseColor when re-opening an
          // existing entry; otherwise use the blank starter atlas.
          let atlas: Atlas = seeded.atlas;
          let maps: GeneratedMaps = seeded.maps;
          if (hydrated?.atlas) {
            atlas = hydrated.atlas;
          } else if (hydrated?.maps?.baseColor) {
            atlas = {
              rgba: new Uint8ClampedArray(hydrated.maps.baseColor.data),
              mask: new Uint8Array(hydrated.maps.baseColor.width * hydrated.maps.baseColor.height),
              width: hydrated.maps.baseColor.width,
              height: hydrated.maps.baseColor.height,
            };
          }
          if (hydrated?.maps) maps = hydrated.maps;
          else if (atlas !== seeded.atlas) {
            // Atlas pixels came from hydration but maps didn't — re-derive.
            maps = derivePbrMaps(atlasToImageData(atlas), DEFAULT_PBR_PARAMS);
          }

          scene.applyAtlasUvs(s.role, seeded.islandLayout.newUvBuffer);
          scene.applyPbrTextures(s.role, maps);

          finalStates[s.role] = freshPbrSurfaceState({
            surface: s,
            prompt: hydrated?.prompt ?? defaultPromptForRole(s.role),
            atlas,
            islandLayout: seeded.islandLayout,
            maps,
            approved: hydrated?.approved ?? false,
          });
          if (hydrated?.promptHistory?.length) {
            finalStates[s.role].promptHistory = hydrated.promptHistory;
          }
        }
        const firstPbr = surfaces.find((s) => s.kind === "pbr");
        const activeRole =
          mode === "edit"
            ? sessionActiveRoleSnapshot ?? firstPbr?.role ?? surfaces[0]?.role ?? null
            : firstPbr?.role ?? surfaces[0]?.role ?? null;
        dispatch({
          type: "AUTHORING_LOAD_BASE_DONE",
          surfaces,
          surfaceStates: finalStates,
          activeRole,
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
          <div className="ms-paint-pane">
            {activeState?.surface.kind === "pbr" ? (
              <PaintCanvas />
            ) : (
              <div className="ms-paint-empty">
                {activeState ? "Glass surface — no atlas to paint." : "Select a surface to start."}
              </div>
            )}
          </div>
          <aside className="ms-right-pane">
            <div className="ms-viewport" ref={containerRef}>
              {authoring.loadingBase && <div className="ms-viewport-overlay">Loading mesh…</div>}
              {authoring.error && <div className="ms-viewport-overlay ms-hint-error">{authoring.error}</div>}
              {authoring.baking && (
                <div className="ms-viewport-overlay">Baking — this usually takes about 30 seconds.</div>
              )}
            </div>
            <SurfaceList />
            {activeState?.surface.kind === "pbr" ? <PromptPanel /> : activeState ? <GlassControls /> : null}
            <SaveBar onSave={handleSave} busy={authoring.baking} />
          </aside>
        </div>
      </div>
    </SceneRefProvider>
  );
}
