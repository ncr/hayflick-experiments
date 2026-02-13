import { useState, useEffect, useRef } from "react";
import * as fsApi from "./api/fs";

export interface StyleGuide {
  name: string;
  prompt: string;
  negativePrompt: string;
  imageSize: string;
  referenceImages: string[]; // base64 data URLs
}

interface Props {
  value: StyleGuide;
  onChange: (guide: StyleGuide) => void;
}

export function StyleGuidePanel({ value, onChange }: Props) {
  const [savedGuides, setSavedGuides] = useState<string[]>([]);
  const [selectedGuide, setSelectedGuide] = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    fsApi.listDirs("style-guides").then(setSavedGuides).catch(() => {});
  }, []);

  const loadGuide = async (name: string) => {
    try {
      const guide = await fsApi.readJson<StyleGuide>(
        `style-guides/${name}/style-guide.json`
      );

      // Load reference images from disk
      let referenceImages: string[] = [];
      try {
        const entries = await fsApi.listEntries(`style-guides/${name}/references`);
        const imageFiles = entries
          .filter((e) => !e.isDirectory && /\.(png|jpg|jpeg)$/i.test(e.name))
          .sort((a, b) => a.name.localeCompare(b.name));

        const loaded = await Promise.all(
          imageFiles.map(async (entry) => {
            const res = await fsApi.readFile(
              `style-guides/${name}/references/${entry.name}`
            );
            const blob = await res.blob();
            return new Promise<string>((resolve) => {
              const reader = new FileReader();
              reader.onload = () => resolve(reader.result as string);
              reader.readAsDataURL(blob);
            });
          })
        );
        referenceImages = loaded;
      } catch {
        // No references dir
      }

      onChange({
        name,
        prompt: guide.prompt ?? "",
        negativePrompt: guide.negativePrompt ?? "",
        imageSize: guide.imageSize ?? "1024x1024",
        referenceImages,
      });
      setSelectedGuide(name);
    } catch {
      // Guide not found
    }
  };

  const saveGuide = async () => {
    if (!value.name.trim()) return;
    const slug = value.name.toLowerCase().replace(/[^a-z0-9]+/g, "-");
    await fsApi.writeJson(`style-guides/${slug}/style-guide.json`, {
      prompt: value.prompt,
      negativePrompt: value.negativePrompt,
      imageSize: value.imageSize,
    });
    // Save reference images
    for (let i = 0; i < value.referenceImages.length; i++) {
      const dataUrl = value.referenceImages[i];
      const blob = await fetch(dataUrl).then((r) => r.blob());
      await fsApi.writeBinary(
        `style-guides/${slug}/references/ref-${String(i + 1).padStart(2, "0")}.png`,
        blob
      );
    }
    setSavedGuides((prev) =>
      prev.includes(slug) ? prev : [...prev, slug]
    );
  };

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files) return;
    const readers: Promise<string>[] = [];
    for (let i = 0; i < Math.min(files.length, 4); i++) {
      readers.push(
        new Promise((resolve) => {
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result as string);
          reader.readAsDataURL(files[i]);
        })
      );
    }
    Promise.all(readers).then((results) => {
      onChange({
        ...value,
        referenceImages: [
          ...value.referenceImages,
          ...results,
        ].slice(0, 4),
      });
    });
  };

  const removeRef = (idx: number) => {
    onChange({
      ...value,
      referenceImages: value.referenceImages.filter((_, i) => i !== idx),
    });
  };

  return (
    <div className="forge-panel" data-testid="forge-style-guide">
      <h3>Style Guide</h3>

      {savedGuides.length > 0 && (
        <div className="forge-field">
          <label>Load saved guide</label>
          <select
            value={selectedGuide}
            onChange={(e) => {
              if (e.target.value) loadGuide(e.target.value);
            }}
          >
            <option value="">-- Select --</option>
            {savedGuides.map((g) => (
              <option key={g} value={g}>
                {g}
              </option>
            ))}
          </select>
        </div>
      )}

      <div className="forge-field">
        <label>Guide name</label>
        <input
          type="text"
          value={value.name}
          onChange={(e) => onChange({ ...value, name: e.target.value })}
          placeholder="e.g., medieval-fantasy"
          data-testid="style-guide-name"
        />
      </div>

      <div className="forge-field">
        <label>Style prompt</label>
        <textarea
          rows={3}
          value={value.prompt}
          onChange={(e) => onChange({ ...value, prompt: e.target.value })}
          placeholder="Stylized low-poly, warm palette, hand-painted textures..."
          data-testid="style-guide-prompt"
        />
      </div>

      <div className="forge-field">
        <label>Negative prompt</label>
        <textarea
          rows={2}
          value={value.negativePrompt}
          onChange={(e) =>
            onChange({ ...value, negativePrompt: e.target.value })
          }
          placeholder="Realistic, photographic, blurry..."
        />
      </div>

      <div className="forge-field">
        <label>Reference images (up to 4)</label>
        <div className="forge-ref-images">
          {value.referenceImages.map((img, i) => (
            <div key={i} className="forge-ref-thumb">
              <img src={img} alt={`ref ${i + 1}`} />
              <button onClick={() => removeRef(i)} className="forge-ref-remove">
                x
              </button>
            </div>
          ))}
          {value.referenceImages.length < 4 && (
            <button
              className="forge-ref-add"
              onClick={() => fileInputRef.current?.click()}
            >
              +
            </button>
          )}
        </div>
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          multiple
          style={{ display: "none" }}
          onChange={handleFileUpload}
        />
      </div>

      <button className="forge-btn" onClick={saveGuide}>
        Save Guide
      </button>
    </div>
  );
}
