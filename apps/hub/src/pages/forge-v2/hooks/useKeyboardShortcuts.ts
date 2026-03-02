import { useEffect } from "react";
import { useForgeState, useForgeDispatch } from "../state/forge-context";
import type { StageId } from "../state/forge-store";

const STAGE_KEYS: Record<string, StageId> = {
  "1": "ref",
  "2": "mesh",
  "3": "physics",
};

interface Options {
  onPrimaryAction: () => void;
}

export function useKeyboardShortcuts({ onPrimaryAction }: Options) {
  const { activeStage, ref, mesh } = useForgeState();
  const dispatch = useForgeDispatch();

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      const target = e.target as HTMLElement;
      const isInput =
        target.tagName === "INPUT" ||
        target.tagName === "TEXTAREA" ||
        target.tagName === "SELECT";

      // Escape: blur focused input
      if (e.key === "Escape") {
        if (isInput) {
          target.blur();
          e.preventDefault();
        }
        return;
      }

      // Cmd/Ctrl+Enter: trigger primary action (always works)
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        onPrimaryAction();
        return;
      }

      // Skip remaining shortcuts when input is focused
      if (isInput) return;

      // Stage switch: 1-3
      const stage = STAGE_KEYS[e.key];
      if (stage) {
        const canSwitch =
          stage === "ref" ||
          (stage === "mesh" && ref.status !== "EMPTY") ||
          (stage === "physics" && mesh.status !== "EMPTY");
        if (canSwitch) {
          dispatch({ type: "SET_ACTIVE_STAGE", stage });
          e.preventDefault();
        }
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [activeStage, dispatch, mesh.status, onPrimaryAction, ref.status]);
}
