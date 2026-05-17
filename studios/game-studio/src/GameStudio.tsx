import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import type { GameModule, KnobRegistry, Scene, World } from "@common/gameplay";
import { ViewportPane, type ViewportController } from "./panes/ViewportPane";
import { TweaksPane } from "./panes/TweaksPane";
import { ConsolePane } from "./panes/ConsolePane";
import { CodePane } from "./panes/CodePane";
import { ZoomRadio } from "./panes/ZoomRadio";
import { createKnobRegistry } from "./runtime/createKnobRegistry";
import { createDebugSink, type DebugSinkHandle } from "./runtime/createDebugSink";
import type { GameSource } from "./index";

declare global {
  interface Window {
    __gameStudio?: {
      gameId: string;
      world: World | null;
      scene: Scene | null;
      knobs: KnobRegistry;
      debug: DebugSinkHandle;
      viewport: ViewportController | null;
    };
  }
}

type ShellProps = {
  game: GameModule;
  loadSources?: () => Promise<GameSource[]>;
  renderDrawer?: (open: boolean, onClose: () => void) => ReactNode;
};

type TopTab = "studio" | "code";

export function GameStudioShell({ game, loadSources, renderDrawer }: ShellProps) {
  const [registry] = useState(() => createKnobRegistry());
  const [debugHandle] = useState(() => createDebugSink({ maxEntries: 200 }));
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [topTab, setTopTab] = useState<TopTab>("studio");
  const [outlines, setOutlines] = useState(true);
  const [viewportController, setViewportController] =
    useState<ViewportController | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const target = e.target as HTMLElement | null;
      const tag = target?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      if (target?.isContentEditable) return;
      if (e.key === "g" || e.key === "G") {
        setTopTab("studio");
      } else if (e.key === "c" || e.key === "C") {
        setTopTab("code");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const handleRef = useRef({
    gameId: game.id,
    world: null as World | null,
    scene: null as Scene | null,
    knobs: registry,
    debug: debugHandle,
    viewport: null as ViewportController | null
  });
  handleRef.current.gameId = game.id;
  handleRef.current.knobs = registry;
  handleRef.current.debug = debugHandle;
  handleRef.current.viewport = viewportController;

  useEffect(() => {
    window.__gameStudio = handleRef.current;
    return () => {
      delete window.__gameStudio;
    };
  }, []);

  const onWorld = useCallback((world: World) => {
    handleRef.current.world = world;
  }, []);

  const onScene = useCallback((scene: Scene | null) => {
    handleRef.current.scene = scene;
  }, []);

  return (
    <div className={`game-studio game-studio-tab-${topTab}`}>
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
        <nav className="game-studio-top-tabs" role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={topTab === "studio"}
            className={
              "game-studio-top-tab" + (topTab === "studio" ? " active" : "")
            }
            onClick={() => setTopTab("studio")}
          >
            Game Studio
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={topTab === "code"}
            className={
              "game-studio-top-tab" + (topTab === "code" ? " active" : "")
            }
            onClick={() => setTopTab("code")}
          >
            Code
          </button>
        </nav>
      </header>
      <main className="game-studio-main">
        <section className="game-studio-viewport-pane">
          <ViewportPane
            game={game}
            knobs={registry}
            debug={debugHandle.sink}
            outlines={outlines}
            onWorld={onWorld}
            onScene={onScene}
            onController={setViewportController}
          />
        </section>
        <aside className="game-studio-tweaks-pane">
          <h3>Zoom</h3>
          <ZoomRadio controller={viewportController} />
          <h3 className="game-studio-tweaks-h3">Render</h3>
          <label className="knob knob-toggle">
            <span className="knob-key">outlines</span>
            <input
              type="checkbox"
              checked={outlines}
              onChange={(e) => setOutlines(e.target.checked)}
            />
          </label>
          <h3 className="game-studio-tweaks-h3">Tweaks</h3>
          <TweaksPane registry={registry} />
        </aside>
      </main>
      <footer className="game-studio-footer">
        <div className="game-studio-footer-header">
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
      {topTab === "code" && (
        <div className="game-studio-code-fullscreen">
          <CodePane loadSources={loadSources} />
        </div>
      )}
      {renderDrawer && renderDrawer(drawerOpen, () => setDrawerOpen(false))}
    </div>
  );
}
