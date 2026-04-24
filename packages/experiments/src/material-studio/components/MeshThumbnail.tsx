import { useEffect, useRef, useState } from "react";
import { getThumbnailRenderer } from "../engine/thumbnail-renderer";

type Props = {
  cacheKey: string;
  kind: "base" | "entry";
  url: string;
  alt: string;
  className?: string;
};

export function MeshThumbnail({ cacheKey, kind, url, alt, className }: Props) {
  const [dataUrl, setDataUrl] = useState<string | null>(() => getThumbnailRenderer().cached(cacheKey));
  const [error, setError] = useState(false);
  const cancelled = useRef(false);

  useEffect(() => {
    cancelled.current = false;
    const renderer = getThumbnailRenderer();
    const hit = renderer.cached(cacheKey);
    if (hit) {
      setDataUrl(hit);
      return;
    }
    setDataUrl(null);
    setError(false);
    renderer
      .get(cacheKey, kind, url)
      .then((u) => {
        if (!cancelled.current) setDataUrl(u);
      })
      .catch(() => {
        if (!cancelled.current) setError(true);
      });
    return () => {
      cancelled.current = true;
    };
  }, [cacheKey, kind, url]);

  if (error) {
    return <div className={`ms-thumb ms-thumb-error ${className ?? ""}`}>×</div>;
  }
  if (!dataUrl) {
    return <div className={`ms-thumb ms-thumb-pending ${className ?? ""}`} />;
  }
  return <img className={`ms-thumb ${className ?? ""}`} src={dataUrl} alt={alt} draggable={false} />;
}
