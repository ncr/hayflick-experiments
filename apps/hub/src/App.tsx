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

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <h1>Experiments</h1>
        <ul>
          {experiments.map((entry) => {
            const active = selectedId === entry.id;
            return (
              <li key={entry.id}>
                <button className={active ? "active" : ""} onClick={() => setSelectedId(entry.id)}>
                  <span>{entry.title}</span>
                </button>
              </li>
            );
          })}
        </ul>
      </aside>
      <main className="main-pane">
        <header className="main-header">
          <div>
            <h2>{selected?.title ?? "No experiment selected"}</h2>
            <p>{selected?.description ?? "Pick an experiment from the left list."}</p>
            <p className="build-stamp">Build {buildId} ({buildSha})</p>
          </div>
        </header>
        <Stage experiment={selected} />
      </main>
    </div>
  );
}
