import { useState } from "react";
import type { PropItem } from "./types";
import type { StyleGuide } from "./StyleGuidePanel";
import { createPropItem, generateImagesParallel } from "./batch";

interface Props {
  styleGuide: StyleGuide;
  props: Map<string, PropItem>;
  updateProp: (id: string, patch: Partial<PropItem>) => void;
  onAddProps: (items: PropItem[]) => void;
}

export function BatchPromptPanel({
  styleGuide,
  props,
  updateProp,
  onAddProps,
}: Props) {
  const [text, setText] = useState("");
  const [generating, setGenerating] = useState(false);

  const handleAddToQueue = () => {
    const lines = text
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
    if (lines.length === 0) return;
    const items = lines.map(createPropItem);
    onAddProps(items);
    setText("");
  };

  const handleGenerateAllImages = async () => {
    const drafts = Array.from(props.values()).filter(
      (p) => p.status === "draft"
    );
    if (drafts.length === 0) return;
    setGenerating(true);
    try {
      await generateImagesParallel(drafts, styleGuide, updateProp, 5);
    } finally {
      setGenerating(false);
    }
  };

  const draftCount = Array.from(props.values()).filter(
    (p) => p.status === "draft"
  ).length;

  return (
    <div className="forge-panel forge-section" data-testid="forge-batch-prompt">
      <h3>Batch Prompts</h3>
      <div className="forge-field">
        <label>Enter prop descriptions (one per line)</label>
        <textarea
          className="forge-batch-textarea"
          rows={5}
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={"wooden chair\nstone well\niron lantern"}
          data-testid="batch-prompt-textarea"
        />
      </div>
      <div className="forge-batch-actions">
        <button
          className="forge-btn"
          onClick={handleAddToQueue}
          disabled={!text.trim()}
          data-testid="add-to-queue-btn"
        >
          Add to Queue
        </button>
        <button
          className="forge-btn forge-btn-primary"
          onClick={handleGenerateAllImages}
          disabled={generating || draftCount === 0}
          data-testid="generate-all-images-btn"
        >
          {generating
            ? "Generating..."
            : `Generate All Images (${draftCount})`}
        </button>
      </div>
    </div>
  );
}
