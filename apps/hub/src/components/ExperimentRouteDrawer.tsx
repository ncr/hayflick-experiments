import { experiments, games } from "../registry";

type ExperimentRouteDrawerProps = {
  open: boolean;
  active:
    | { type: "forge" }
    | { type: "experiment"; id: string }
    | { type: "play"; id: string }
    | null;
  onClose: () => void;
  onSelectForge: () => void;
  onSelectExperiment: (id: string) => void;
  onSelectGame: (id: string) => void;
};

export function ExperimentRouteDrawer({
  open,
  active,
  onClose,
  onSelectForge,
  onSelectExperiment,
  onSelectGame
}: ExperimentRouteDrawerProps) {
  const isForgeActive = active?.type === "forge";

  return (
    <>
      {open && <div className="sidebar-backdrop" onClick={onClose} />}
      <aside className={`sidebar${open ? " open" : ""}`}>
        <h1>Experiments</h1>
        <ul>
          <li>
            <button className={isForgeActive ? "active" : ""} onClick={onSelectForge}>
              <span>Asset Forge</span>
            </button>
          </li>
          {experiments.map((entry) => {
            const isActive = active?.type === "experiment" && active.id === entry.id;
            return (
              <li key={entry.id}>
                <button
                  className={isActive ? "active" : ""}
                  onClick={() => onSelectExperiment(entry.id)}
                >
                  <span>{entry.title}</span>
                </button>
              </li>
            );
          })}
        </ul>
        {games.length > 0 && (
          <>
            <h1 className="sidebar-section">Games</h1>
            <ul>
              {games.map((entry) => {
                const isActive = active?.type === "play" && active.id === entry.id;
                return (
                  <li key={entry.id}>
                    <button
                      className={isActive ? "active" : ""}
                      onClick={() => onSelectGame(entry.id)}
                    >
                      <span>{entry.title}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </>
        )}
      </aside>
    </>
  );
}
