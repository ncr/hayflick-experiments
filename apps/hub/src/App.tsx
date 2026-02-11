import { useEffect, useMemo, useState } from "react";
import { experiments, getExperimentById } from "@experiments/catalog";
import { Stage } from "./components/Stage";

function readExperimentFromHash(): string | null {
  const hash = window.location.hash;
  if (!hash.startsWith("#/exp/")) {
    return null;
  }
  return hash.replace("#/exp/", "").trim() || null;
}

export function App() {
  const buildId = import.meta.env.VITE_BUILD_ID ?? "local";
  const buildSha = import.meta.env.VITE_BUILD_SHA?.slice(0, 7) ?? "dev";

  const [selectedId, setSelectedId] = useState<string | null>(() => readExperimentFromHash() ?? experiments[0]?.id ?? null);
  const [menuOpen, setMenuOpen] = useState(false);

  useEffect(() => {
    const onHashChange = () => {
      const id = readExperimentFromHash();
      if (id) {
        setSelectedId(id);
      }
    };

    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  useEffect(() => {
    if (selectedId) {
      window.history.replaceState({}, "", `#/exp/${selectedId}`);
    }
  }, [selectedId]);

  const selected = useMemo(() => {
    if (!selectedId) {
      return undefined;
    }
    return getExperimentById(selectedId);
  }, [selectedId]);

  const selectExperiment = (id: string) => {
    setSelectedId(id);
    setMenuOpen(false);
  };

  return (
    <div className="app-shell">
      {menuOpen && <div className="sidebar-backdrop" onClick={() => setMenuOpen(false)} />}
      <aside className={`sidebar${menuOpen ? " open" : ""}`}>
        <h1>Experiments</h1>
        <ul>
          {experiments.map((entry) => {
            const active = selectedId === entry.id;
            return (
              <li key={entry.id}>
                <button className={active ? "active" : ""} onClick={() => selectExperiment(entry.id)}>
                  <span>{entry.title}</span>
                </button>
              </li>
            );
          })}
        </ul>
      </aside>
      <main className="main-pane">
        <header className="main-header">
          <button className="hamburger" onClick={() => setMenuOpen((v) => !v)} aria-label="Toggle menu">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <line x1="3" y1="6" x2="21" y2="6" />
              <line x1="3" y1="12" x2="21" y2="12" />
              <line x1="3" y1="18" x2="21" y2="18" />
            </svg>
          </button>
          <div className="main-header-info">
            <h2>{selected?.title ?? "No experiment selected"}</h2>
            <p className="main-header-desc">{selected?.description ?? "Pick an experiment from the left list."}</p>
            <p className="build-stamp">Build {buildId} ({buildSha})</p>
          </div>
        </header>
        <Stage experiment={selected} />
      </main>
    </div>
  );
}
