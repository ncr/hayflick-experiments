import type { AppState, AuthoringSession, LibraryEntry, Toast, ToastLevel } from "./types";
import type { GeneratedMaps, IslandLayout, Surface, SurfaceState } from "../types";
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
  | { type: "AUTHORING_LOAD_BASE_DONE"; surfaces: Surface[]; surfaceStates: Record<string, SurfaceState>; activeRole: string | null }
  | { type: "AUTHORING_LOAD_BASE_FAIL"; error: string }
  | { type: "AUTHORING_SELECT_SURFACE"; role: string }
  | { type: "AUTHORING_SET_PROMPT"; role: string; prompt: string }
  | {
      type: "AUTHORING_GENERATED";
      role: string;
      maps: GeneratedMaps;
      prevMaps: GeneratedMaps | null;
      islandLayout: IslandLayout;
      prevIslandLayout: IslandLayout | null;
      templateSent: RgbaBuffer;
      aiRaw: RgbaBuffer;
      prompt: string;
    }
  | { type: "AUTHORING_UNDO_LAST_GEN"; role: string }
  | { type: "AUTHORING_APPROVE"; role: string }
  | { type: "AUTHORING_UNAPPROVE"; role: string }
  | { type: "AUTHORING_SET_NAME"; name: string }
  | { type: "AUTHORING_SET_PROTECTED"; value: boolean }
  | { type: "AUTHORING_SET_DIRTY"; value: boolean }
  | { type: "AUTHORING_BAKE_START" }
  | { type: "AUTHORING_BAKE_DONE" }
  | { type: "AUTHORING_BAKE_FAIL"; error: string }
  | { type: "AUTHORING_GLASS_SET"; role: string; params: Partial<NonNullable<SurfaceState["glassParams"]>> }
  | { type: "TOAST_ADD"; level: ToastLevel; message: string }
  | { type: "TOAST_DISMISS"; id: number };

let toastIdSeq = 1;
function mkToast(level: ToastLevel, message: string): Toast {
  return { id: toastIdSeq++, level, message };
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
      return state.authoring
        ? {
            ...state,
            authoring: {
              ...state.authoring,
              dirty: true,
              surfaceStates: {
                ...state.authoring.surfaceStates,
                [action.role]: { ...state.authoring.surfaceStates[action.role], prompt: action.prompt },
              },
            },
          }
        : state;
    case "AUTHORING_GENERATED":
      return state.authoring
        ? {
            ...state,
            authoring: {
              ...state.authoring,
              dirty: true,
              surfaceStates: {
                ...state.authoring.surfaceStates,
                [action.role]: {
                  ...state.authoring.surfaceStates[action.role],
                  maps: action.maps,
                  prevMaps: action.prevMaps,
                  islandLayout: action.islandLayout,
                  prevIslandLayout: action.prevIslandLayout,
                  templateSent: action.templateSent,
                  aiRaw: action.aiRaw,
                  approved: false,
                  prompt: action.prompt,
                  promptHistory: [
                    action.prompt,
                    ...(state.authoring.surfaceStates[action.role]?.promptHistory ?? []).filter((p) => p !== action.prompt),
                  ].slice(0, 8),
                },
              },
            },
          }
        : state;
    case "AUTHORING_UNDO_LAST_GEN": {
      if (!state.authoring) return state;
      const cur = state.authoring.surfaceStates[action.role];
      if (!cur?.prevMaps) return state;
      return {
        ...state,
        authoring: {
          ...state.authoring,
          dirty: true,
          surfaceStates: {
            ...state.authoring.surfaceStates,
            [action.role]: {
              ...cur,
              maps: cur.prevMaps,
              prevMaps: null,
              islandLayout: cur.prevIslandLayout ?? null,
              prevIslandLayout: null,
              approved: false,
            },
          },
        },
      };
    }
    case "AUTHORING_APPROVE":
      return state.authoring
        ? {
            ...state,
            authoring: {
              ...state.authoring,
              surfaceStates: {
                ...state.authoring.surfaceStates,
                [action.role]: { ...state.authoring.surfaceStates[action.role], approved: true },
              },
            },
          }
        : state;
    case "AUTHORING_UNAPPROVE":
      return state.authoring
        ? {
            ...state,
            authoring: {
              ...state.authoring,
              surfaceStates: {
                ...state.authoring.surfaceStates,
                [action.role]: { ...state.authoring.surfaceStates[action.role], approved: false },
              },
            },
          }
        : state;
    case "AUTHORING_SET_NAME":
      return state.authoring ? { ...state, authoring: { ...state.authoring, entryName: action.name, dirty: true } } : state;
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
    case "AUTHORING_GLASS_SET":
      return state.authoring
        ? {
            ...state,
            authoring: {
              ...state.authoring,
              dirty: true,
              surfaceStates: {
                ...state.authoring.surfaceStates,
                [action.role]: {
                  ...state.authoring.surfaceStates[action.role],
                  glassParams: {
                    ...(state.authoring.surfaceStates[action.role]?.glassParams ?? DEFAULT_GLASS_PARAMS),
                    ...action.params,
                  },
                },
              },
            },
          }
        : state;
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
