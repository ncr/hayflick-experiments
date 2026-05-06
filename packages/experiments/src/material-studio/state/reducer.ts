import type { AppState, AuthoringSession, LibraryEntry, Toast, ToastLevel } from "./types";
import {
  DEFAULT_PBR_TWEAK,
  MAX_EDIT_HISTORY,
  type Atlas,
  type AtlasSnapshot,
  type GeneratedMaps,
  type IslandLayout,
  type Surface,
  type SurfaceState,
} from "../types";
import type { RgbaBuffer } from "../../uv-template-probe/uv-template";

export type Action =
  | { type: "LIBRARY_LOAD_START" }
  | { type: "LIBRARY_LOAD_DONE"; entries: LibraryEntry[] }
  | { type: "LIBRARY_LOAD_FAIL"; error: string }
  | { type: "LIBRARY_SET_SEARCH"; value: string }
  | { type: "LIBRARY_SET_BASE_FILTER"; value: string | null }
  | { type: "LIBRARY_REMOVE_ENTRY"; name: string }
  | { type: "LIBRARY_PATCH_ENTRY"; name: string; patch: Partial<LibraryEntry> }
  | { type: "LIBRARY_RENAME_ENTRY"; from: string; to: string }
  | { type: "LIBRARY_ADD_ENTRY"; entry: LibraryEntry }
  | { type: "HIGHLIGHT_ENTRY"; name: string | null }
  | { type: "BASE_LOAD_START" }
  | { type: "BASE_LOAD_DONE"; meshes: string[] }
  | { type: "BASE_LOAD_FAIL"; error: string }
  | { type: "ENTER_LIBRARY" }
  | { type: "ENTER_BASE_PICKER" }
  | { type: "START_NEW"; baseMeshId: string }
  | { type: "START_EDIT"; session: AuthoringSession }
  | { type: "AUTHORING_LOAD_BASE_START" }
  | {
      type: "AUTHORING_LOAD_BASE_DONE";
      surfaces: Surface[];
      surfaceStates: Record<string, SurfaceState>;
      activeRole: string | null;
    }
  | { type: "AUTHORING_LOAD_BASE_FAIL"; error: string }
  | { type: "AUTHORING_SELECT_SURFACE"; role: string }
  | { type: "AUTHORING_SET_PROMPT"; role: string; prompt: string }
  | {
      type: "AUTHORING_PAINT_COMMIT";
      role: string;
      nextRgba: Uint8ClampedArray<ArrayBuffer>;
      nextMask: Uint8Array<ArrayBuffer>;
      maps: GeneratedMaps;
      tag: AtlasSnapshot["tag"];
    }
  | { type: "AUTHORING_UNDO"; role: string; maps: GeneratedMaps }
  | { type: "AUTHORING_REDO"; role: string; maps: GeneratedMaps }
  | { type: "AUTHORING_CLEAR_MASK"; role: string }
  | {
      type: "AUTHORING_GENERATED";
      role: string;
      atlas: Atlas;
      maps: GeneratedMaps;
      islandLayout: IslandLayout;
      templateSent: RgbaBuffer;
      aiRaw: RgbaBuffer;
      prompt: string;
    }
  | { type: "AUTHORING_APPROVE"; role: string }
  | { type: "AUTHORING_UNAPPROVE"; role: string }
  | { type: "AUTHORING_SET_NAME"; name: string }
  | { type: "AUTHORING_SET_PROTECTED"; value: boolean }
  | { type: "AUTHORING_SET_DIRTY"; value: boolean }
  | { type: "AUTHORING_BAKE_START" }
  | { type: "AUTHORING_BAKE_DONE" }
  | { type: "AUTHORING_BAKE_FAIL"; error: string }
  | { type: "AUTHORING_GLASS_SET"; role: string; params: Partial<NonNullable<SurfaceState["glassParams"]>> }
  | { type: "AUTHORING_PBR_TWEAK_SET"; role: string; params: Partial<NonNullable<SurfaceState["pbrTweak"]>> }
  | { type: "TOAST_ADD"; level: ToastLevel; message: string }
  | { type: "TOAST_DISMISS"; id: number };

let toastIdSeq = 1;
function mkToast(level: ToastLevel, message: string): Toast {
  return { id: toastIdSeq++, level, message };
}

function patchSurface(state: AppState, role: string, patch: Partial<SurfaceState>, dirty = true): AppState {
  if (!state.authoring) return state;
  const cur = state.authoring.surfaceStates[role];
  if (!cur) return state;
  return {
    ...state,
    authoring: {
      ...state.authoring,
      dirty: dirty || state.authoring.dirty,
      surfaceStates: { ...state.authoring.surfaceStates, [role]: { ...cur, ...patch } },
    },
  };
}

function snapshotOf(atlas: Atlas, tag: AtlasSnapshot["tag"]): AtlasSnapshot {
  return { rgba: atlas.rgba, mask: atlas.mask, tag };
}

function pushHistory(history: AtlasSnapshot[], snap: AtlasSnapshot): AtlasSnapshot[] {
  const next = [...history, snap];
  return next.length > MAX_EDIT_HISTORY ? next.slice(next.length - MAX_EDIT_HISTORY) : next;
}

function makeBlankMask(rgba: Uint8ClampedArray<ArrayBuffer>): Uint8Array<ArrayBuffer> {
  return new Uint8Array(rgba.length / 4);
}

export function reducer(state: AppState, action: Action): AppState {
  switch (action.type) {
    case "LIBRARY_LOAD_START":
      return { ...state, library: { ...state.library, loading: true, error: null } };
    case "LIBRARY_LOAD_DONE":
      return { ...state, library: { ...state.library, loading: false, entries: action.entries, error: null } };
    case "LIBRARY_LOAD_FAIL":
      return { ...state, library: { ...state.library, loading: false, error: action.error } };
    case "LIBRARY_SET_SEARCH":
      return { ...state, library: { ...state.library, search: action.value } };
    case "LIBRARY_SET_BASE_FILTER":
      return { ...state, library: { ...state.library, baseMeshFilter: action.value } };
    case "LIBRARY_REMOVE_ENTRY":
      return {
        ...state,
        library: { ...state.library, entries: state.library.entries.filter((e) => e.name !== action.name) },
      };
    case "LIBRARY_PATCH_ENTRY":
      return {
        ...state,
        library: {
          ...state.library,
          entries: state.library.entries.map((e) => (e.name === action.name ? { ...e, ...action.patch } : e)),
        },
      };
    case "LIBRARY_RENAME_ENTRY":
      return {
        ...state,
        library: {
          ...state.library,
          entries: state.library.entries.map((e) => (e.name === action.from ? { ...e, name: action.to } : e)),
        },
      };
    case "LIBRARY_ADD_ENTRY": {
      const without = state.library.entries.filter((e) => e.name !== action.entry.name);
      return { ...state, library: { ...state.library, entries: [action.entry, ...without] } };
    }
    case "HIGHLIGHT_ENTRY":
      return { ...state, highlightEntry: action.name };
    case "BASE_LOAD_START":
      return { ...state, basePicker: { ...state.basePicker, loading: true, error: null } };
    case "BASE_LOAD_DONE":
      return { ...state, basePicker: { loading: false, meshes: action.meshes, error: null } };
    case "BASE_LOAD_FAIL":
      return { ...state, basePicker: { ...state.basePicker, loading: false, error: action.error } };
    case "ENTER_LIBRARY":
      return { ...state, view: { kind: "library" }, authoring: null };
    case "ENTER_BASE_PICKER":
      return { ...state, view: { kind: "base-picker" } };
    case "START_NEW":
      return {
        ...state,
        view: { kind: "authoring" },
        authoring: {
          mode: "new",
          baseMeshId: action.baseMeshId,
          entryName: "",
          originalName: null,
          protected: false,
          surfaces: [],
          surfaceStates: {},
          activeRole: null,
          baking: false,
          dirty: false,
          loadingBase: true,
          error: null,
        },
      };
    case "START_EDIT":
      return { ...state, view: { kind: "authoring" }, authoring: action.session };
    case "AUTHORING_LOAD_BASE_START":
      return state.authoring ? { ...state, authoring: { ...state.authoring, loadingBase: true, error: null } } : state;
    case "AUTHORING_LOAD_BASE_DONE":
      return state.authoring
        ? {
            ...state,
            authoring: {
              ...state.authoring,
              loadingBase: false,
              surfaces: action.surfaces,
              surfaceStates: action.surfaceStates,
              activeRole: action.activeRole,
            },
          }
        : state;
    case "AUTHORING_LOAD_BASE_FAIL":
      return state.authoring
        ? { ...state, authoring: { ...state.authoring, loadingBase: false, error: action.error } }
        : state;
    case "AUTHORING_SELECT_SURFACE":
      return state.authoring ? { ...state, authoring: { ...state.authoring, activeRole: action.role } } : state;
    case "AUTHORING_SET_PROMPT":
      return patchSurface(state, action.role, { prompt: action.prompt });
    case "AUTHORING_PAINT_COMMIT": {
      if (!state.authoring) return state;
      const cur = state.authoring.surfaceStates[action.role];
      if (!cur || !cur.atlas) return state;
      const prevSnap = snapshotOf(cur.atlas, action.tag);
      const nextAtlas: Atlas = {
        rgba: action.nextRgba,
        mask: action.nextMask,
        width: cur.atlas.width,
        height: cur.atlas.height,
      };
      return patchSurface(state, action.role, {
        atlas: nextAtlas,
        maps: action.maps,
        editHistory: pushHistory(cur.editHistory, prevSnap),
        editFuture: [],
        approved: false,
      });
    }
    case "AUTHORING_UNDO": {
      if (!state.authoring) return state;
      const cur = state.authoring.surfaceStates[action.role];
      if (!cur || !cur.atlas || cur.editHistory.length === 0) return state;
      const top = cur.editHistory[cur.editHistory.length - 1];
      const futureSnap = snapshotOf(cur.atlas, top.tag);
      const prevAtlas: Atlas = {
        rgba: top.rgba,
        mask: top.mask,
        width: cur.atlas.width,
        height: cur.atlas.height,
      };
      return patchSurface(state, action.role, {
        atlas: prevAtlas,
        maps: action.maps,
        editHistory: cur.editHistory.slice(0, -1),
        editFuture: [...cur.editFuture, futureSnap],
        approved: false,
      });
    }
    case "AUTHORING_REDO": {
      if (!state.authoring) return state;
      const cur = state.authoring.surfaceStates[action.role];
      if (!cur || !cur.atlas || cur.editFuture.length === 0) return state;
      const top = cur.editFuture[cur.editFuture.length - 1];
      const historySnap = snapshotOf(cur.atlas, top.tag);
      const nextAtlas: Atlas = {
        rgba: top.rgba,
        mask: top.mask,
        width: cur.atlas.width,
        height: cur.atlas.height,
      };
      return patchSurface(state, action.role, {
        atlas: nextAtlas,
        maps: action.maps,
        editFuture: cur.editFuture.slice(0, -1),
        editHistory: pushHistory(cur.editHistory, historySnap),
        approved: false,
      });
    }
    case "AUTHORING_CLEAR_MASK": {
      if (!state.authoring) return state;
      const cur = state.authoring.surfaceStates[action.role];
      if (!cur || !cur.atlas) return state;
      const prevSnap = snapshotOf(cur.atlas, "clear-mask");
      const nextAtlas: Atlas = {
        rgba: cur.atlas.rgba,
        mask: makeBlankMask(cur.atlas.rgba),
        width: cur.atlas.width,
        height: cur.atlas.height,
      };
      return patchSurface(state, action.role, {
        atlas: nextAtlas,
        editHistory: pushHistory(cur.editHistory, prevSnap),
        editFuture: [],
      });
    }
    case "AUTHORING_GENERATED": {
      if (!state.authoring) return state;
      const cur = state.authoring.surfaceStates[action.role];
      if (!cur) return state;
      const history = cur.atlas
        ? pushHistory(cur.editHistory, snapshotOf(cur.atlas, "generate"))
        : cur.editHistory;
      return patchSurface(state, action.role, {
        atlas: action.atlas,
        maps: action.maps,
        islandLayout: action.islandLayout,
        templateSent: action.templateSent,
        aiRaw: action.aiRaw,
        prompt: action.prompt,
        promptHistory: [
          action.prompt,
          ...cur.promptHistory.filter((p) => p !== action.prompt),
        ].slice(0, 8),
        editHistory: history,
        editFuture: [],
        approved: false,
      });
    }
    case "AUTHORING_APPROVE":
      return patchSurface(state, action.role, { approved: true }, false);
    case "AUTHORING_UNAPPROVE":
      return patchSurface(state, action.role, { approved: false }, false);
    case "AUTHORING_SET_NAME":
      return state.authoring
        ? { ...state, authoring: { ...state.authoring, entryName: action.name, dirty: true } }
        : state;
    case "AUTHORING_SET_PROTECTED":
      return state.authoring ? { ...state, authoring: { ...state.authoring, protected: action.value } } : state;
    case "AUTHORING_SET_DIRTY":
      return state.authoring ? { ...state, authoring: { ...state.authoring, dirty: action.value } } : state;
    case "AUTHORING_BAKE_START":
      return state.authoring ? { ...state, authoring: { ...state.authoring, baking: true, error: null } } : state;
    case "AUTHORING_BAKE_DONE":
      return state.authoring ? { ...state, authoring: { ...state.authoring, baking: false, dirty: false } } : state;
    case "AUTHORING_BAKE_FAIL":
      return state.authoring ? { ...state, authoring: { ...state.authoring, baking: false, error: action.error } } : state;
    case "AUTHORING_GLASS_SET": {
      if (!state.authoring) return state;
      const cur = state.authoring.surfaceStates[action.role];
      if (!cur) return state;
      return patchSurface(state, action.role, {
        glassParams: { ...(cur.glassParams ?? DEFAULT_GLASS_PARAMS), ...action.params },
      });
    }
    case "AUTHORING_PBR_TWEAK_SET": {
      if (!state.authoring) return state;
      const cur = state.authoring.surfaceStates[action.role];
      if (!cur) return state;
      return patchSurface(state, action.role, {
        pbrTweak: { ...(cur.pbrTweak ?? DEFAULT_PBR_TWEAK), ...action.params },
      });
    }
    case "TOAST_ADD":
      return { ...state, toasts: [...state.toasts, mkToast(action.level, action.message)] };
    case "TOAST_DISMISS":
      return { ...state, toasts: state.toasts.filter((t) => t.id !== action.id) };
    default:
      return state;
  }
}

export const DEFAULT_GLASS_PARAMS = {
  tint: "#b8d2eb",
  roughness: 0.05,
  ior: 1.45,
  alpha: 0.35,
};
