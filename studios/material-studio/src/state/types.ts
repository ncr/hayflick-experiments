import type { Surface, SurfaceState } from "../types";

export type LibraryEntry = {
  name: string;
  baseMeshId: string | null;
  roles: string[];
  prompts: Record<string, string>;
  bakedAt: string | null;
  updatedAt: string | null;
  protected: boolean;
};

export type ToastLevel = "info" | "success" | "error";
export type Toast = { id: number; level: ToastLevel; message: string };

export type LibraryView = {
  kind: "library";
};

export type BasePickerView = {
  kind: "base-picker";
};

export type AuthoringView = {
  kind: "authoring";
};

export type View = LibraryView | BasePickerView | AuthoringView;

export type AuthoringSession = {
  mode: "new" | "edit";
  baseMeshId: string;
  entryName: string;
  originalName: string | null;
  protected: boolean;
  surfaces: Surface[];
  surfaceStates: Record<string, SurfaceState>;
  activeRole: string | null;
  baking: boolean;
  dirty: boolean;
  loadingBase: boolean;
  error: string | null;
};

export type AppState = {
  view: View;
  library: {
    loading: boolean;
    entries: LibraryEntry[];
    error: string | null;
    search: string;
    baseMeshFilter: string | null;
  };
  basePicker: {
    loading: boolean;
    meshes: string[];
    error: string | null;
  };
  authoring: AuthoringSession | null;
  toasts: Toast[];
  highlightEntry: string | null;
};

export const INITIAL_STATE: AppState = {
  view: { kind: "library" },
  library: { loading: false, entries: [], error: null, search: "", baseMeshFilter: null },
  basePicker: { loading: false, meshes: [], error: null },
  authoring: null,
  toasts: [],
  highlightEntry: null,
};
