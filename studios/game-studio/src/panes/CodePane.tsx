import { useEffect, useState } from "react";
import type { GameSource } from "../index";

type LoadState =
  | { kind: "loading" }
  | { kind: "loaded"; sources: GameSource[] }
  | { kind: "error"; message: string };

type CodePaneProps = {
  loadSources?: () => Promise<GameSource[]>;
};

export function CodePane({ loadSources }: CodePaneProps) {
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [activePath, setActivePath] = useState<string | null>(null);

  useEffect(() => {
    if (!loadSources) {
      setState({ kind: "loaded", sources: [] });
      return;
    }
    let disposed = false;
    setState({ kind: "loading" });
    loadSources()
      .then((sources) => {
        if (disposed) return;
        setState({ kind: "loaded", sources });
        setActivePath(sources[0]?.path ?? null);
      })
      .catch((cause) => {
        if (disposed) return;
        setState({
          kind: "error",
          message: cause instanceof Error ? cause.message : "Failed to load sources"
        });
      });
    return () => {
      disposed = true;
    };
  }, [loadSources]);

  if (state.kind === "loading") {
    return <div className="game-studio-code-empty">Loading source…</div>;
  }
  if (state.kind === "error") {
    return <div className="game-studio-code-empty">Failed: {state.message}</div>;
  }
  if (state.sources.length === 0) {
    return <div className="game-studio-code-empty">No source files found.</div>;
  }

  const active = state.sources.find((s) => s.path === activePath) ?? state.sources[0];

  return (
    <div className="game-studio-code">
      <div className="game-studio-code-tabs" role="tablist">
        {state.sources.map((s) => (
          <button
            key={s.path}
            type="button"
            role="tab"
            aria-selected={s.path === active.path}
            className={
              "game-studio-code-tab" + (s.path === active.path ? " active" : "")
            }
            onClick={() => setActivePath(s.path)}
          >
            {s.path}
          </button>
        ))}
      </div>
      <pre className="game-studio-code-body">
        <code>{active.code}</code>
      </pre>
    </div>
  );
}
