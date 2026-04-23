import { useEffect, useRef, useState } from "react";
import { loadDiagScene } from "./registry";

export function DiagPage({ slug }: { slug: string }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cleanup: (() => void) | null = null;
    let disposed = false;

    const mount = hostRef.current;
    if (!mount) return;

    mount.replaceChildren();
    mount.removeAttribute("data-render-ready");
    setError(null);

    loadDiagScene(slug)
      .then((scene) => {
        if (disposed) return;
        if (!scene) {
          setError(`Unknown diag scene: ${slug}`);
          return;
        }
        const rect = mount.getBoundingClientRect();
        return scene.init({
          mount,
          width: Math.floor(rect.width),
          height: Math.floor(rect.height),
          slug
        });
      })
      .then((result) => {
        if (typeof result === "function") cleanup = result;
      })
      .catch((cause: unknown) => {
        setError(cause instanceof Error ? cause.message : "Unknown error");
      });

    return () => {
      disposed = true;
      if (cleanup) cleanup();
      mount.replaceChildren();
    };
  }, [slug]);

  return (
    <>
      <div
        ref={hostRef}
        data-diag-slug={slug}
        style={{
          position: "fixed",
          inset: 0,
          margin: 0,
          padding: 0,
          background: "#000",
          overflow: "hidden"
        }}
      />
      {error && (
        <div
          style={{
            position: "fixed",
            top: 8,
            left: 8,
            padding: "6px 10px",
            background: "rgba(160, 20, 20, 0.92)",
            color: "#fff",
            font: "12px ui-monospace, monospace",
            borderRadius: 4,
            zIndex: 100
          }}
        >
          Diag error: {error}
        </div>
      )}
    </>
  );
}
