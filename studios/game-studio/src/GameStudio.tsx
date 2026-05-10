import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import type * as THREE from "three";
import type { GameModule, KnobRegistry, World } from "@common/gameplay";
import { ViewportPane } from "./panes/ViewportPane";
import { TweaksPane } from "./panes/TweaksPane";
import { ConsolePane } from "./panes/ConsolePane";
import { createKnobRegistry } from "./runtime/createKnobRegistry";
import { createDebugSink, type DebugSinkHandle } from "./runtime/createDebugSink";

declare global {
  interface Window {
    __gameStudio?: {
      gameId: string;
      world: World | null;
      knobs: KnobRegistry;
      debug: DebugSinkHandle;
    };
  }
}

type ShellProps = {
  game: GameModule<THREE.Object3D>;
  renderDrawer?: (open: boolean, onClose: () => void) => ReactNode;
};

export function GameStudioShell({ game, renderDrawer }: ShellProps) {
  const [registry] = useState(() => createKnobRegistry());
  const [debugHandle] = useState(() => createDebugSink({ maxEntries: 200 }));
  const [drawerOpen, setDrawerOpen] = useState(false);

  // Stable handle object — mutated when world arrives, published in an
  // effect. This avoids a render-order race where the child viewport
  // effect runs before the parent effect that would otherwise create
  // window.__gameStudio.
  const handleRef = useRef({
    gameId: game.id,
    world: null as World | null,
    knobs: registry,
    debug: debugHandle
  });
  handleRef.current.gameId = game.id;
  handleRef.current.knobs = registry;
  handleRef.current.debug = debugHandle;

  useEffect(() => {
    window.__gameStudio = handleRef.current;
    return () => {
      delete window.__gameStudio;
    };
  }, []);

  const onWorld = useCallback((world: World) => {
    handleRef.current.world = world;
  }, []);

  return (
    <div className="game-studio">
      <header className="game-studio-header">
        {renderDrawer && (
          <button
            type="button"
            className="game-studio-hamburger"
            onClick={() => setDrawerOpen((v) => !v)}
            aria-label="Toggle menu"
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <line x1="3" y1="6" x2="21" y2="6" />
              <line x1="3" y1="12" x2="21" y2="12" />
              <line x1="3" y1="18" x2="21" y2="18" />
            </svg>
          </button>
        )}
        <div className="game-studio-title">
          <strong>{game.title}</strong>
          {game.description && (
            <span className="game-studio-desc">{game.description}</span>
          )}
        </div>
      </header>
      <main className="game-studio-main">
        <section className="game-studio-viewport-pane">
          <ViewportPane
            game={game}
            knobs={registry}
            debug={debugHandle.sink}
            onWorld={onWorld}
          />
        </section>
        <aside className="game-studio-tweaks-pane">
          <h3>Tweaks</h3>
          <TweaksPane registry={registry} />
        </aside>
      </main>
      <footer className="game-studio-console-pane">
        <div className="game-studio-console-header">
          <h3>Console</h3>
          <button
            type="button"
            className="game-studio-console-clear"
            onClick={() => debugHandle.clear()}
          >
            Clear
          </button>
        </div>
        <ConsolePane handle={debugHandle} />
      </footer>
      {renderDrawer && renderDrawer(drawerOpen, () => setDrawerOpen(false))}
    </div>
  );
}
