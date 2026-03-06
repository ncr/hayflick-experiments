import { useEffect, useMemo, useState } from "react";
import { experiments, getExperimentById } from "@experiments/catalog";
import { ExperimentRouteDrawer } from "./components/ExperimentRouteDrawer";
import { Stage } from "./components/Stage";
import { Forge } from "./pages/Forge";

type Route =
  | { type: "experiment"; id: string }
  | { type: "forge" }
  | null;

function readRouteFromHash(): Route {
  const hash = window.location.hash;
  if (hash === "#/forge" || hash === "#/forge-v2") {
    return { type: "forge" };
  }
  if (hash.startsWith("#/exp/")) {
    const id = hash.replace("#/exp/", "").trim();
    return id ? { type: "experiment", id } : null;
  }
  return null;
}

export function App() {
  const buildId = import.meta.env.VITE_BUILD_ID ?? "local";
  const buildSha = import.meta.env.VITE_BUILD_SHA?.slice(0, 7) ?? "dev";

  const [route, setRoute] = useState<Route>(
    () => readRouteFromHash() ?? { type: "experiment", id: experiments[0]?.id ?? "" }
  );
  const [menuOpen, setMenuOpen] = useState(false);

  useEffect(() => {
    const onHashChange = () => {
      const r = readRouteFromHash();
      if (r) setRoute(r);
    };
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  useEffect(() => {
    if (!route) return;
    if (route.type === "forge") {
      window.history.replaceState({}, "", "#/forge");
    } else {
      window.history.replaceState({}, "", `#/exp/${route.id}`);
    }
  }, [route]);

  const selectedExperiment = useMemo(() => {
    if (route?.type !== "experiment") return undefined;
    return getExperimentById(route.id);
  }, [route]);

  const selectExperiment = (id: string) => {
    setRoute({ type: "experiment", id });
    setMenuOpen(false);
  };

  const selectForge = () => {
    setRoute({ type: "forge" });
    setMenuOpen(false);
  };
  if (route?.type === "forge") {
    return <Forge />;
  }

  return (
    <div className="app-shell">
      <ExperimentRouteDrawer
        open={menuOpen}
        active={route?.type === "experiment" ? route : null}
        onClose={() => setMenuOpen(false)}
        onSelectForge={selectForge}
        onSelectExperiment={selectExperiment}
      />
      <main className="main-pane">
        <header className="main-header">
          <button
            className="hamburger"
            onClick={() => setMenuOpen((v) => !v)}
            aria-label="Toggle menu"
            aria-expanded={menuOpen}
          >
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <line x1="3" y1="6" x2="21" y2="6" />
              <line x1="3" y1="12" x2="21" y2="12" />
              <line x1="3" y1="18" x2="21" y2="18" />
            </svg>
          </button>
          <div className="main-header-info">
            <h2>{selectedExperiment?.title ?? "No experiment selected"}</h2>
            <p className="main-header-desc">{selectedExperiment?.description ?? "Pick an experiment from the left list."}</p>
            <p className="build-stamp">Build {buildId} ({buildSha})</p>
          </div>
        </header>
        <Stage experiment={selectedExperiment} />
      </main>
    </div>
  );
}
