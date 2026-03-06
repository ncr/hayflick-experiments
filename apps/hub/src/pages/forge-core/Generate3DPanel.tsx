import { useState } from "react";
import { generateModel } from "./api/tripo";

interface Props {
  conceptImage: string | null;
  onModelGenerated: (glb: ArrayBuffer) => void;
}

export function Generate3DPanel({ conceptImage, onModelGenerated }: Props) {
  const [faceLimit, setFaceLimit] = useState(5000);
  const [pbr, setPbr] = useState(true);
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState(0);
  const [status, setStatus] = useState("");
  const [error, setError] = useState<string | null>(null);

  const handleGenerate = async () => {
    if (!conceptImage) return;
    setLoading(true);
    setError(null);
    setProgress(0);

    try {
      // Convert data URL to blob
      const resp = await fetch(conceptImage);
      const blob = await resp.blob();

      const glb = await generateModel(blob, { faceLimit, pbr }, (p, s) => {
        setProgress(Math.round(p));
        setStatus(s);
      });

      onModelGenerated(glb);
    } catch (err) {
      setError(err instanceof Error ? err.message : "3D generation failed");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="forge-panel" data-testid="forge-generate-3d">
      <h3>Generate 3D Model</h3>

      {conceptImage && (
        <div className="forge-concept-thumb">
          <img src={conceptImage} alt="Accepted concept" />
        </div>
      )}

      <div className="forge-field">
        <label>Face limit</label>
        <input
          type="number"
          value={faceLimit}
          onChange={(e) => setFaceLimit(Number(e.target.value))}
          min={1000}
          max={100000}
          step={1000}
          data-testid="face-limit"
        />
      </div>

      <div className="forge-field">
        <label>
          <input
            type="checkbox"
            checked={pbr}
            onChange={(e) => setPbr(e.target.checked)}
          />
          PBR textures
        </label>
      </div>

      <button
        className="forge-btn forge-btn-primary"
        onClick={handleGenerate}
        disabled={loading || !conceptImage}
        data-testid="generate-3d-btn"
      >
        {loading ? `Generating... ${progress}%` : "Generate 3D"}
      </button>

      {loading && (
        <div className="forge-progress">
          <div
            className="forge-progress-bar"
            style={{ width: `${progress}%` }}
          />
          <span>{status}</span>
        </div>
      )}

      {error && <div className="forge-error">{error}</div>}
    </div>
  );
}
