import { experiments } from "@experiments/catalog";

type ExperimentRouteDrawerProps = {
  open: boolean;
  active: { type: "forge-v2" } | { type: "experiment"; id: string } | null;
  onClose: () => void;
  onSelectForgeV2: () => void;
  onSelectExperiment: (id: string) => void;
};

export function ExperimentRouteDrawer({
  open,
  active,
  onClose,
  onSelectForgeV2,
  onSelectExperiment
}: ExperimentRouteDrawerProps) {
  const isForgeV2Active = active?.type === "forge-v2";

  return (
    <>
      {open && <div className="sidebar-backdrop" onClick={onClose} />}
      <aside className={`sidebar${open ? " open" : ""}`}>
        <h1>Experiments</h1>
        <ul>
          <li>
            <button className={isForgeV2Active ? "active" : ""} onClick={onSelectForgeV2}>
              <span>Asset Forge V2</span>
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
      </aside>
    </>
  );
}
