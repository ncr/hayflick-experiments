import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import type { GameModule } from "@common/gameplay";
import { GameStudioShell } from "./GameStudio";
import "./styles.css";

export type GameSource = { path: string; code: string };

export type GameStudioProps = {
  loadGame: () => Promise<{ default: GameModule }>;
  loadSources?: () => Promise<GameSource[]>;
  renderDrawer?: (open: boolean, onClose: () => void) => ReactNode;
};

type LoadState =
  | { kind: "loading" }
  | { kind: "loaded"; game: GameModule }
  | { kind: "error"; message: string };

export function GameStudio({ loadGame, loadSources, renderDrawer }: GameStudioProps) {
  const [state, setState] = useState<LoadState>({ kind: "loading" });

  useEffect(() => {
    let disposed = false;
    setState({ kind: "loading" });
    loadGame()
      .then((mod) => {
        if (!disposed) {
          setState({ kind: "loaded", game: mod.default });
        }
      })
      .catch((cause) => {
        if (!disposed) {
          setState({
            kind: "error",
            message: cause instanceof Error ? cause.message : "Failed to load game"
          });
        }
      });
    return () => {
      disposed = true;
    };
  }, [loadGame]);

  if (state.kind === "loading") {
    return <div className="game-studio-fallback">Loading game…</div>;
  }
  if (state.kind === "error") {
    return (
      <div className="game-studio-fallback game-studio-fallback-error">
        Failed: {state.message}
      </div>
    );
  }
  return (
    <GameStudioShell
      game={state.game}
      loadSources={loadSources}
      renderDrawer={renderDrawer}
    />
  );
}
