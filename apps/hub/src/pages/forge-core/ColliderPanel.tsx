import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  createVhacdWorkerRunner,
  type VhacdOptions,
  type VhacdProgress
} from "@common/collider-vhacd";
import type { ViewportHandle } from "./Viewport";
import { createColliderHelper, type ColliderParams } from "./processing/colliders";
import {
  buildVhacdColliderForObject,
  normalizeVhacdOptions,
  readVhacdPresetFile,
  writeVhacdPresetFile,
  type ForgeColliderGenerationMetadata,
  type ForgeVhacdPresetFile
} from "./processing/collider-vhacd";

interface Props {
  viewport: ViewportHandle | null;
  onColliderChange: (params: ColliderParams) => void;
  onColliderGenerationChange: (
    metadata: ForgeColliderGenerationMetadata | null
  ) => void;
  currentCollider?: ColliderParams | null;
  currentColliderGeneration?: ForgeColliderGenerationMetadata | null;
  hideTitle?: boolean;
  refitTrigger?: number;
}

function readNumberInput(value: string, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return parsed;
}

function formatProgress(progress: VhacdProgress): string {
  const percent = Math.round(progress.propProgress * 100);
  return `${progress.message} (${percent}%)`;
}

type NumberOptionField = {
  key: keyof VhacdOptions;
  label: string;
  min: number;
  max: number;
  step: number;
};

const NUMBER_FIELDS: NumberOptionField[] = [
  { key: "resolution", label: "Resolution", min: 10, max: 256, step: 1 },
  { key: "maxConvexHulls", label: "Max Hulls", min: 1, max: 64, step: 1 },
  { key: "concavity", label: "Concavity", min: 0, max: 1, step: 0.0005 },
  { key: "alpha", label: "Alpha", min: 0, max: 1, step: 0.01 },
  { key: "beta", label: "Beta", min: 0, max: 1, step: 0.01 },
  { key: "sliverPenalty", label: "Sliver Penalty", min: 0, max: 3, step: 0.05 },
  { key: "planeDownsampling", label: "Plane Downsample", min: 1, max: 12, step: 1 },
  { key: "convexHullDownsampling", label: "Hull Downsample", min: 1, max: 12, step: 1 },
  { key: "minVoxelCountPerPart", label: "Min Voxels/Part", min: 4, max: 200, step: 1 },
  { key: "maxHullPointSamples", label: "Max Hull Samples", min: 64, max: 9000, step: 1 },
  {
    key: "projectHullMaxDistance",
    label: "Project Max Distance",
    min: 0,
    max: 2,
    step: 0.01
  },
  { key: "maxGridCells", label: "Max Grid Cells", min: 250000, max: 20000000, step: 250000 },
  {
    key: "voxelizationTriangleSampleCount",
    label: "Voxel Tri Samples",
    min: 1000,
    max: 120000,
    step: 1000
  }
];

export function ColliderPanel({
  viewport,
  onColliderChange,
  onColliderGenerationChange,
  currentCollider,
  currentColliderGeneration,
  hideTitle,
  refitTrigger
}: Props) {
  const runnerRef = useRef(createVhacdWorkerRunner());
  const viewportRef = useRef<ViewportHandle | null>(viewport);
  const onColliderChangeRef = useRef(onColliderChange);
  const onGenerationChangeRef = useRef(onColliderGenerationChange);

  const [presetFile, setPresetFile] = useState<ForgeVhacdPresetFile | null>(null);
  const [selectedPresetName, setSelectedPresetName] = useState<string>("");
  const [options, setOptions] = useState<VhacdOptions>(normalizeVhacdOptions(null));
  const [status, setStatus] = useState("Select a model and run VHACD.");
  const [progressText, setProgressText] = useState("idle");
  const [building, setBuilding] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const requestTokenRef = useRef(0);

  useEffect(() => {
    viewportRef.current = viewport;
  }, [viewport]);

  useEffect(() => {
    onColliderChangeRef.current = onColliderChange;
  }, [onColliderChange]);

  useEffect(() => {
    onGenerationChangeRef.current = onColliderGenerationChange;
  }, [onColliderGenerationChange]);

  useEffect(() => {
    void (async () => {
      const loaded = await readVhacdPresetFile();
      setPresetFile(loaded);
      const preferred =
        loaded.presets.find((preset) => preset.name === loaded.defaultPreset) ??
        loaded.presets[0];
      if (preferred) {
        setSelectedPresetName(preferred.name);
        setOptions(normalizeVhacdOptions(preferred.options));
      }
    })();
  }, []);

  useEffect(() => {
    if (refitTrigger === undefined) {
      return;
    }
    setDirty(true);
    if (!building) {
      setStatus("Model changed. Recompute collider to refresh VHACD output.");
    }
  }, [refitTrigger, building]);

  useEffect(() => {
    const currentViewport = viewportRef.current;
    if (!currentViewport) {
      return;
    }
    if (!currentCollider) {
      currentViewport.setColliderPreviewObject(null);
      return;
    }
    currentViewport.setColliderPreviewObject(createColliderHelper(currentCollider));
  }, [currentCollider]);

  useEffect(() => {
    return () => {
      runnerRef.current.dispose();
      viewportRef.current?.setColliderPreviewObject(null);
    };
  }, []);

  const selectedPreset = useMemo(() => {
    if (!presetFile) {
      return null;
    }
    return presetFile.presets.find((preset) => preset.name === selectedPresetName) ?? null;
  }, [presetFile, selectedPresetName]);

  const updatePresetFile = useCallback(
    async (next: ForgeVhacdPresetFile) => {
      const saved = await writeVhacdPresetFile(next);
      setPresetFile(saved);
      return saved;
    },
    []
  );

  const onSelectPreset = useCallback(
    (nextName: string) => {
      if (!presetFile) {
        return;
      }
      const nextPreset = presetFile.presets.find((preset) => preset.name === nextName);
      if (!nextPreset) {
        return;
      }
      setSelectedPresetName(nextPreset.name);
      setOptions(normalizeVhacdOptions(nextPreset.options));
      setDirty(true);
      setStatus(`Preset "${nextPreset.name}" loaded. Click Recompute to apply.`);
    },
    [presetFile]
  );

  const onSaveAsPreset = useCallback(async () => {
    if (!presetFile) {
      return;
    }
    const nameRaw = window.prompt("Preset name");
    if (!nameRaw) {
      return;
    }
    const name = nameRaw.trim();
    if (name.length <= 0) {
      return;
    }
    const duplicate = presetFile.presets.some(
      (preset) => preset.name.toLowerCase() === name.toLowerCase()
    );
    if (duplicate) {
      setError(`Preset "${name}" already exists.`);
      return;
    }

    const saved = await updatePresetFile({
      ...presetFile,
      presets: [...presetFile.presets, { name, options: normalizeVhacdOptions(options) }]
    });
    setSelectedPresetName(name);
    setError(null);
    setStatus(`Preset "${name}" saved.`);
    setPresetFile(saved);
  }, [options, presetFile, updatePresetFile]);

  const onUpdatePreset = useCallback(async () => {
    if (!presetFile || !selectedPreset) {
      return;
    }
    const next = {
      ...presetFile,
      presets: presetFile.presets.map((preset) =>
        preset.name === selectedPreset.name
          ? { ...preset, options: normalizeVhacdOptions(options) }
          : preset
      )
    };
    await updatePresetFile(next);
    setError(null);
    setStatus(`Preset "${selectedPreset.name}" updated.`);
  }, [options, presetFile, selectedPreset, updatePresetFile]);

  const onDeletePreset = useCallback(async () => {
    if (!presetFile || !selectedPreset) {
      return;
    }
    if (presetFile.presets.length <= 1) {
      setError("At least one preset is required.");
      return;
    }
    const confirmed = window.confirm(`Delete preset "${selectedPreset.name}"?`);
    if (!confirmed) {
      return;
    }

    const nextPresets = presetFile.presets.filter(
      (preset) => preset.name !== selectedPreset.name
    );
    const nextDefault =
      presetFile.defaultPreset === selectedPreset.name
        ? nextPresets[0]?.name ?? ""
        : presetFile.defaultPreset;
    const next = {
      ...presetFile,
      defaultPreset: nextDefault,
      presets: nextPresets
    };
    const saved = await updatePresetFile(next);
    const fallback = saved.presets[0];
    if (fallback) {
      setSelectedPresetName(fallback.name);
      setOptions(normalizeVhacdOptions(fallback.options));
    }
    setError(null);
    setDirty(true);
    setStatus(`Preset "${selectedPreset.name}" deleted.`);
  }, [presetFile, selectedPreset, updatePresetFile]);

  const onSetDefaultPreset = useCallback(async () => {
    if (!presetFile || !selectedPreset) {
      return;
    }
    await updatePresetFile({
      ...presetFile,
      defaultPreset: selectedPreset.name
    });
    setStatus(`Preset "${selectedPreset.name}" set as default.`);
  }, [presetFile, selectedPreset, updatePresetFile]);

  const onNumberFieldChange = useCallback(
    (key: keyof VhacdOptions, value: string) => {
      const field = NUMBER_FIELDS.find((entry) => entry.key === key);
      if (!field) {
        return;
      }
      const nextValue = clamp(
        readNumberInput(value, options[key] as number),
        field.min,
        field.max
      );
      const normalized = normalizeVhacdOptions({
        ...options,
        [key]: nextValue
      });
      setOptions(normalized);
      setDirty(true);
    },
    [options]
  );

  const onRecompute = useCallback(async () => {
    const currentViewport = viewportRef.current;
    if (!currentViewport) {
      setError("No viewport available.");
      return;
    }
    const model = currentViewport.getModel();
    if (!model) {
      setError("No model loaded.");
      return;
    }

    const token = ++requestTokenRef.current;
    runnerRef.current.restart("VHACD run superseded");
    const normalizedOptions = normalizeVhacdOptions(options);
    const presetName = selectedPresetName || "Custom";

    setBuilding(true);
    setError(null);
    setProgressText("starting...");
    setStatus(`Running VHACD preset "${presetName}"...`);

    try {
      const built = await buildVhacdColliderForObject({
        sourceModel: model,
        presetName,
        inputOptions: normalizedOptions,
        runner: runnerRef.current,
        onProgress: (progress: VhacdProgress) => {
          if (token !== requestTokenRef.current) {
            return;
          }
          setProgressText(formatProgress(progress));
        }
      });
      if (token !== requestTokenRef.current) {
        return;
      }

      onColliderChangeRef.current(built.collider);
      onGenerationChangeRef.current(built.metadata);
      currentViewport.setColliderPreviewObject(createColliderHelper(built.collider));
      setDirty(false);
      setStatus(
        `VHACD done: ${built.metadata.hullCount} hulls, ${built.metadata.stats.voxelCount} voxels.`
      );
      setProgressText("done");
    } catch (runError) {
      if (token !== requestTokenRef.current) {
        return;
      }
      setError(runError instanceof Error ? runError.message : "VHACD recompute failed.");
      setStatus("VHACD failed.");
    } finally {
      if (token === requestTokenRef.current) {
        setBuilding(false);
      }
    }
  }, [options, selectedPresetName]);

  return (
    <div className="forge-panel" data-testid="forge-collider">
      {!hideTitle && <h3>Collider (VHACD)</h3>}

      <div className="forge-field">
        <label>Preset</label>
        <select
          value={selectedPresetName}
          onChange={(event) => onSelectPreset(event.target.value)}
          data-testid="vhacd-preset-select"
        >
          {(presetFile?.presets ?? []).map((preset) => (
            <option key={preset.name} value={preset.name}>
              {preset.name}
            </option>
          ))}
        </select>
      </div>

      <div className="forge-btn-group">
        <button className="forge-btn" onClick={() => void onSaveAsPreset()}>
          Save As Preset
        </button>
        <button className="forge-btn" onClick={() => void onUpdatePreset()}>
          Update Preset
        </button>
        <button className="forge-btn" onClick={() => void onDeletePreset()}>
          Delete Preset
        </button>
        <button className="forge-btn" onClick={() => void onSetDefaultPreset()}>
          Set Default
        </button>
      </div>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
          gap: "0.5rem"
        }}
      >
        {NUMBER_FIELDS.map((field) => (
          <div className="forge-field" key={field.key}>
            <label>{field.label}</label>
            <input
              type="number"
              min={field.min}
              max={field.max}
              step={field.step}
              value={(options[field.key] as number).toString()}
              onChange={(event) => onNumberFieldChange(field.key, event.target.value)}
            />
          </div>
        ))}
      </div>

      <div className="forge-field">
        <label>
          <input
            type="checkbox"
            checked={options.projectHullVertices}
            onChange={(event) => {
              setOptions(
                normalizeVhacdOptions({
                  ...options,
                  projectHullVertices: event.target.checked
                })
              );
              setDirty(true);
            }}
          />{" "}
          Project Hull Vertices
        </label>
      </div>
      <div className="forge-field">
        <label>
          <input
            type="checkbox"
            checked={options.precomputeBothHullVariants}
            onChange={(event) => {
              setOptions(
                normalizeVhacdOptions({
                  ...options,
                  precomputeBothHullVariants: event.target.checked
                })
              );
              setDirty(true);
            }}
          />{" "}
          Precompute Both Hull Variants
        </label>
      </div>

      <button
        className="forge-btn forge-btn-primary"
        onClick={() => void onRecompute()}
        disabled={building}
        data-testid="vhacd-recompute-btn"
      >
        {building ? "Running VHACD..." : "Recompute Collider"}
      </button>

      <div className="forge-info">
        <div>Status: {status}</div>
        <div>Progress: {progressText}</div>
        {dirty && <div>Model/settings changed. Collider is stale until recompute.</div>}
      </div>

      {currentColliderGeneration && (
        <div className="forge-info">
          <div>Preset Used: {currentColliderGeneration.presetName}</div>
          <div>Hulls: {currentColliderGeneration.hullCount}</div>
          <div>Voxels: {currentColliderGeneration.stats.voxelCount}</div>
          <div>Splits: {currentColliderGeneration.stats.splitCount}</div>
          <div>Merges: {currentColliderGeneration.stats.mergeCount}</div>
          <div>Signature: {currentColliderGeneration.signature}</div>
        </div>
      )}

      {error && <div className="forge-error">{error}</div>}
    </div>
  );
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
