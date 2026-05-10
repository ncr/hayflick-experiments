import type { ReactNode } from "react";
import { ForgeShell } from "./components/ForgeShell";

export type ForgeProps = {
  renderDrawer?: (open: boolean, onClose: () => void) => ReactNode;
};

export function Forge({ renderDrawer }: ForgeProps = {}) {
  return <ForgeShell renderDrawer={renderDrawer} />;
}
