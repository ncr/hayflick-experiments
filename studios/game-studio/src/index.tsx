import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import type * as THREE from "three";
import type { GameModule } from "@common/gameplay";
import { GameStudioShell } from "./GameStudio";
import "./styles.css";

export type GameStudioProps = {
  loadGame: () => Promise<{ default: GameModule<THREE.Object3D> }>;
  renderDrawer?: (open: boolean, onClose: () => void) => ReactNode;
};

type LoadState =
  | { kind: "loading" }
  | { kind: "loaded"; game: GameModule<THREE.Object3D> }
  | { kind: "error"; message: string };

export function GameStudio({ loadGame, renderDrawer }: GameStudioProps) {
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
  return <GameStudioShell game={state.game} renderDrawer={renderDrawer} />;
}
