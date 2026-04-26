import { useState } from "react";
import { FORGE_CONCEPT_CACHE_SOURCE, generateImage } from "./api/openai";
import { HistoryPicker } from "./HistoryPicker";
import type { StyleGuide } from "./StyleGuidePanel";

interface Props {
  styleGuide: StyleGuide;
  conceptImage: string | null;
  onConceptImage: (dataUrl: string) => void;
  propDescription: string;
  onPropDescription: (desc: string) => void;
  onAccept: () => void;
}

export function GenerateImagePanel({
  styleGuide,
  conceptImage,
  onConceptImage,
  propDescription,
  onPropDescription,
  onAccept,
}: Props) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [size, setSize] = useState("1024x1024");
  const [showHistory, setShowHistory] = useState(false);

  const composePrompt = () => {
    const parts = [
      styleGuide.prompt,
      propDescription,
      "3/4 view, product shot, centered object, plain mid-gray background.",
    ].filter(Boolean);
    return parts.join(" ");
  };

  const handleGenerate = async () => {
    if (!propDescription.trim()) return;
    setLoading(true);
    setError(null);
    try {
      const prompt = composePrompt();
      const result = await generateImage(prompt, size);
      if (result.b64_json) {
        onConceptImage(`data:image/png;base64,${result.b64_json}`);
      } else if (result.url) {
        // Fetch and convert to data URL for local storage
        const resp = await fetch(result.url);
        const blob = await resp.blob();
        const reader = new FileReader();
        const dataUrl = await new Promise<string>((resolve) => {
          reader.onload = () => resolve(reader.result as string);
          reader.readAsDataURL(blob);
        });
        onConceptImage(dataUrl);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Generation failed");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="forge-panel" data-testid="forge-generate-image">
      <h3>Generate Reference Image</h3>

      <div className="forge-field">
        <label>Prop description</label>
        <input
          type="text"
          value={propDescription}
          onChange={(e) => onPropDescription(e.target.value)}
          placeholder="A simple wooden dining chair"
          data-testid="prop-description"
        />
      </div>

      <div className="forge-field">
        <label>Image size</label>
        <select value={size} onChange={(e) => setSize(e.target.value)}>
          <option value="1024x1024">1024x1024</option>
          <option value="1024x1536">1024x1536 (portrait)</option>
          <option value="1536x1024">1536x1024 (landscape)</option>
        </select>
      </div>

      <div className="forge-field">
        <label>Composed prompt</label>
        <div className="forge-prompt-preview">{composePrompt()}</div>
      </div>

      <div className="forge-button-row">
        <button
          className="forge-btn forge-btn-primary"
          onClick={handleGenerate}
          disabled={loading || !propDescription.trim()}
          data-testid="generate-image-btn"
        >
          {loading ? "Generating..." : "Generate Image"}
        </button>
        <button
          className="forge-btn"
          onClick={() => setShowHistory(true)}
          disabled={loading}
        >
          History
        </button>
      </div>

      {error && <div className="forge-error">{error}</div>}

      {showHistory && (
        <HistoryPicker
          source={FORGE_CONCEPT_CACHE_SOURCE}
          onClose={() => setShowHistory(false)}
          onPick={(entry) => {
            onConceptImage(`data:${entry.outputMimeType};base64,${entry.outputB64}`);
            if (entry.prompt && !propDescription) onPropDescription(entry.prompt);
          }}
        />
      )}

      {conceptImage && (
        <div className="forge-concept-preview" data-testid="concept-image">
          <img src={conceptImage} alt="Generated concept" />
          <div className="forge-concept-actions">
            <button
              className="forge-btn"
              onClick={handleGenerate}
              disabled={loading}
            >
              Regenerate
            </button>
            <button
              className="forge-btn forge-btn-primary"
              onClick={onAccept}
              data-testid="accept-image-btn"
            >
              Accept
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
