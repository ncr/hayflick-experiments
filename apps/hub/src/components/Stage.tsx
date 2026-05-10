import { useEffect, useRef, useState } from "react";
import type { ExperimentRegistryEntry } from "@experiments/runtime";

type StageProps = {
  experiment: ExperimentRegistryEntry | undefined;
};

export function Stage({ experiment }: StageProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cleanup: (() => void) | null = null;
    let isDisposed = false;

    const mount = hostRef.current;
    if (!mount || !experiment) {
      return;
    }

    mount.replaceChildren();
    setError(null);

    experiment
      .load()
      .then(({ default: module }) => {
        if (isDisposed) {
          return;
        }

        const rect = mount.getBoundingClientRect();
        const dpr = Math.min(window.devicePixelRatio || 1, 2);

        return module.init({
          mount,
          width: Math.floor(rect.width),
          height: Math.floor(rect.height),
          dpr
        });
      })
      .then((result) => {
        if (typeof result === "function") {
          cleanup = result;
        }
      })
      .catch((cause: unknown) => {
        setError(cause instanceof Error ? cause.message : "Unknown experiment error");
      });

    return () => {
      isDisposed = true;
      if (cleanup) {
        cleanup();
      }
      mount.replaceChildren();
    };
  }, [experiment]);

  return (
    <div className="stage-shell">
      <div className="stage-ratio">
        <div className="stage-host" ref={hostRef} />
        {!experiment && <div className="stage-empty">Select an experiment to run.</div>}
        {error && <div className="stage-error">Experiment failed: {error}</div>}
      </div>
    </div>
  );
}
