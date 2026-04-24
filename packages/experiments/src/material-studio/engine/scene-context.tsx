import { createContext, useContext, type ReactNode, type RefObject } from "react";
import type { AuthoringScene } from "./authoring-scene";

const Ctx = createContext<RefObject<AuthoringScene | null> | null>(null);

export function SceneRefProvider({
  value,
  children,
}: {
  value: RefObject<AuthoringScene | null>;
  children: ReactNode;
}) {
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useSceneRef(): RefObject<AuthoringScene | null> {
  const v = useContext(Ctx);
  if (!v) throw new Error("useSceneRef outside SceneRefProvider");
  return v;
}
