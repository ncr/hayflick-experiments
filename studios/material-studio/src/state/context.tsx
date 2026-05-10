import { createContext, useContext, useReducer, type Dispatch, type ReactNode } from "react";
import { INITIAL_STATE, type AppState } from "./types";
import { reducer, type Action } from "./reducer";

const StateCtx = createContext<AppState | null>(null);
const DispatchCtx = createContext<Dispatch<Action> | null>(null);

export function MaterialStudioProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, INITIAL_STATE);
  return (
    <StateCtx.Provider value={state}>
      <DispatchCtx.Provider value={dispatch}>{children}</DispatchCtx.Provider>
    </StateCtx.Provider>
  );
}

export function useAppState(): AppState {
  const v = useContext(StateCtx);
  if (!v) throw new Error("useAppState called outside MaterialStudioProvider");
  return v;
}

export function useAppDispatch(): Dispatch<Action> {
  const v = useContext(DispatchCtx);
  if (!v) throw new Error("useAppDispatch called outside MaterialStudioProvider");
  return v;
}
