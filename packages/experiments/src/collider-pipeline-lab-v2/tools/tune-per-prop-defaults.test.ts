import { access, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { normalizePropGeometry } from "../pipeline/normalize";
import { scoreColliderQuality } from "../pipeline/score";
import {
  DEFAULT_QUALITY_WEIGHTS,
  DEFAULT_STRATEGY_PARAMS,
  STRATEGY_PARAM_SPECS
} from "../state/defaults";
import { DEFAULT_STRATEGY_PARAMS_BY_PROP } from "../state/per-prop-defaults.generated";
import { generateAabbCollider } from "../strategies/aabb";
import {
  generateAcdCollider,
  generateBspCollider,
  generateCapsuleFitCollider,
  generateCoacdCollider,
  generateCylinderFitCollider,
  generateEdgeCollapseCollider,
  generateHacdCollider,
  generateIncrementalHullCollider,
  generateKdopCollider,
  generateKmeansSegCollider,
  generateMultiSphereCollider,
  generateMvbbCollider,
  generateQemDecimateCollider,
  generateQuickhullCollider,
  generateRegionGrowCollider,
  generateSdfConvexCollider,
  generateSpectralSegCollider,
  generateSphereLeastSquaresCollider,
  generateSphereRitterCollider,
  generateVhacdCollider
} from "../strategies/extended";
import {
  generateBoxyFurnitureLegacyCollider,
  generateConcaveFurnitureLegacyCollider,
  generateConvexLegacyCollider
} from "../strategies/legacy-ported";
import { generateLayeredXCollider } from "../strategies/layered-x";
import { generateLayeredYCollider } from "../strategies/layered-y";
import { generateLayeredZCollider } from "../strategies/layered-z";
import { generateObbPcaCollider } from "../strategies/obb-pca";
import { generateSplitFitCollider } from "../strategies/split-fit";
import { generateSupportColumnsCollider } from "../strategies/support-columns";
import { generateVoxelGreedyCollider } from "../strategies/voxel-greedy";
import { generateConcavitySplitCollider } from "../strategies/concavity-split";
import type {
  NormalizedProp,
  StrategyGenerator,
  StrategyId,
  StrategyParamSpec,
  StrategyParamsById
} from "../types";
import { ACTIVE_STRATEGY_IDS } from "../types";

const RUN_TUNER = process.env.COLLIDER_V2_TUNE_DEFAULTS === "1";
const PROP_FILTER = (process.env.COLLIDER_V2_TUNE_PROP_FILTER ?? "")
  .split(",")
  .map((value) => value.trim())
  .filter((value) => value.length > 0);
const maybeIt = RUN_TUNER ? it : it.skip;
const OUTPUT_PATH = path.resolve(
  process.cwd(),
  "src/collider-pipeline-lab-v2/state/per-prop-defaults.generated.ts"
);

const STRATEGY_GENERATORS = {
  "aabb": generateAabbCollider,
  "obb-pca": generateObbPcaCollider,
  "layered-y": generateLayeredYCollider,
  "layered-x": generateLayeredXCollider,
  "layered-z": generateLayeredZCollider,
  "voxel-greedy": generateVoxelGreedyCollider,
  "split-fit": generateSplitFitCollider,
  "support-columns": generateSupportColumnsCollider,
  "convex": generateConvexLegacyCollider,
  "boxy-furniture": generateBoxyFurnitureLegacyCollider,
  "concave-furniture": generateConcaveFurnitureLegacyCollider,
  "coacd": generateCoacdCollider,
  "v-hacd": generateVhacdCollider,
  "hacd": generateHacdCollider,
  "acd": generateAcdCollider,
  "quickhull": generateQuickhullCollider,
  "incremental-hull": generateIncrementalHullCollider,
  "mvbb": generateMvbbCollider,
  "k-dop": generateKdopCollider,
  "sphere-ritter": generateSphereRitterCollider,
  "sphere-ls": generateSphereLeastSquaresCollider,
  "capsule-fit": generateCapsuleFitCollider,
  "cylinder-fit": generateCylinderFitCollider,
  "multi-sphere": generateMultiSphereCollider,
  "kmeans-seg": generateKmeansSegCollider,
  "spectral-seg": generateSpectralSegCollider,
  "region-grow": generateRegionGrowCollider,
  "bsp": generateBspCollider,
  "concavity-split": generateConcavitySplitCollider,
  "sdf-convex": generateSdfConvexCollider,
  "qem-decimate": generateQemDecimateCollider,
  "edge-collapse": generateEdgeCollapseCollider
} satisfies { [K in StrategyId]: StrategyGenerator<K> };

type PropEntry = {
  id: string;
  modelPath: string;
};

type MutableStrategyParams = Record<string, number>;

const BOUNDED_TUNER_STRATEGIES = new Set<StrategyId>([
  "coacd",
  "v-hacd",
  "hacd",
  "acd",
  "sdf-convex",
  "kmeans-seg",
  "spectral-seg",
  "region-grow",
  "bsp",
  "concavity-split",
  "convex",
  "voxel-greedy",
  "support-columns"
]);

const BOUNDED_PARAM_KEYS = new Set([
  "resolution",
  "maxParts",
  "clusterCount",
  "maxDepth",
  "minPoints",
  "maxSamplePoints",
  "maxHullPoints",
  "minClusterPoints",
  "sampleCount",
  "radialSamples",
  "smoothPasses"
]);

function repoRootDir(): string {
  return path.resolve(process.cwd(), "..", "..");
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function listPropEntries(): Promise<PropEntry[]> {
  const propsRoot = path.resolve(repoRootDir(), "assets/forge/props");
  const entries = await readdir(propsRoot, { withFileTypes: true });
  const props: PropEntry[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const id = entry.name;
    const processed = path.join(propsRoot, id, "processed", "model.glb");
    const raw = path.join(propsRoot, id, "raw", "tripo-output.glb");
    if (await exists(processed)) {
      props.push({ id, modelPath: processed });
      continue;
    }
    if (await exists(raw)) {
      props.push({ id, modelPath: raw });
    }
  }

  const ordered = props.sort((a, b) => a.id.localeCompare(b.id));
  if (PROP_FILTER.length <= 0) {
    return ordered;
  }
  const filterSet = new Set(PROP_FILTER);
  return ordered.filter((entry) => filterSet.has(entry.id));
}

function createNodeGltfShims(): void {
  const globalScope = globalThis as unknown as {
    self?: unknown;
    createImageBitmap?: typeof globalThis.createImageBitmap;
  };
  if (typeof globalScope.self === "undefined") {
    globalScope.self = globalThis;
  }
  if (typeof globalScope.createImageBitmap === "undefined") {
    globalScope.createImageBitmap = (async () =>
      ({
        width: 1,
        height: 1,
        close() {
          // no-op shim for Node runtime
        }
      }) as unknown as ImageBitmap) as typeof globalThis.createImageBitmap;
  }
}

async function loadGlbAsGroup(filePath: string): Promise<THREE.Group> {
  const raw = await readFile(filePath);
  const arrayBuffer = raw.buffer.slice(
    raw.byteOffset,
    raw.byteOffset + raw.byteLength
  ) as ArrayBuffer;
  const loader = new GLTFLoader();
  return await new Promise<THREE.Group>((resolve, reject) => {
    loader.parse(
      arrayBuffer,
      "",
      (gltf) => resolve((gltf.scene ?? new THREE.Group()) as THREE.Group),
      (error) => reject(error)
    );
  });
}

function mulberry32(seed: number): () => number {
  let t = seed >>> 0;
  return () => {
    t += 0x6d2b79f5;
    let value = Math.imul(t ^ (t >>> 15), t | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function hashSeed(value: string): number {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function quantizeToSpec(value: number, spec: StrategyParamSpec): number {
  const clamped = clamp(value, spec.min, spec.max);
  const steps = Math.round((clamped - spec.min) / spec.step);
  const quantized = spec.min + steps * spec.step;
  const bounded = clamp(quantized, spec.min, spec.max);
  if (spec.type === "int") {
    return Math.round(bounded);
  }
  const decimals = Math.max(0, String(spec.step).split(".")[1]?.length ?? 0);
  return Number(bounded.toFixed(Math.min(6, decimals + 1)));
}

function getTunerSearchSpec(
  strategyId: StrategyId,
  spec: StrategyParamSpec,
  defaultValue: number
): StrategyParamSpec {
  if (
    !BOUNDED_TUNER_STRATEGIES.has(strategyId) ||
    !BOUNDED_PARAM_KEYS.has(spec.key)
  ) {
    return spec;
  }
  const span = spec.max - spec.min;
  if (span <= 0) {
    return spec;
  }

  const boundedMin = clamp(defaultValue - span * 0.2, spec.min, spec.max);
  const boundedMax = clamp(defaultValue + span * 0.3, spec.min, spec.max);
  if (boundedMax <= boundedMin) {
    return {
      ...spec,
      min: spec.min,
      max: spec.max
    };
  }
  return {
    ...spec,
    min: spec.type === "int" ? Math.round(boundedMin) : boundedMin,
    max: spec.type === "int" ? Math.round(boundedMax) : boundedMax
  };
}

function randomValueForSpec(spec: StrategyParamSpec, rand: () => number): number {
  const raw = spec.min + rand() * (spec.max - spec.min);
  return quantizeToSpec(raw, spec);
}

function mutateParams(
  strategyId: StrategyId,
  base: MutableStrategyParams,
  defaults: MutableStrategyParams,
  specs: StrategyParamSpec[],
  rand: () => number,
  aggressive: boolean
): MutableStrategyParams {
  const next: MutableStrategyParams = { ...base };
  let changed = false;

  for (const rawSpec of specs) {
    const defaultValue = defaults[rawSpec.key] ?? rawSpec.min;
    const spec = getTunerSearchSpec(strategyId, rawSpec, defaultValue);
    const key = spec.key;
    const mode = rand();
    if (mode < (aggressive ? 0.85 : 0.6)) {
      let value: number;
      if (mode < 0.12) {
        value = spec.min;
      } else if (mode < 0.24) {
        value = spec.max;
      } else if (mode < 0.34) {
        value = quantizeToSpec((spec.min + spec.max) * 0.5, spec);
      } else if (mode < 0.6) {
        const span = spec.max - spec.min;
        const jitter = span * (aggressive ? 0.3 : 0.12) * (rand() * 2 - 1);
        value = quantizeToSpec((base[key] ?? spec.min) + jitter, spec);
      } else {
        value = randomValueForSpec(spec, rand);
      }
      if (value !== next[key]) {
        changed = true;
      }
      next[key] = value;
    }
  }

  if (!changed && specs.length > 0) {
    const chosenRaw = specs[Math.floor(rand() * specs.length)];
    const chosen = getTunerSearchSpec(
      strategyId,
      chosenRaw,
      defaults[chosenRaw.key] ?? chosenRaw.min
    );
    next[chosen.key] = randomValueForSpec(chosen, rand);
  }
  return next;
}

function evaluateStrategy<K extends StrategyId>(
  strategyId: K,
  prop: NormalizedProp,
  params: StrategyParamsById[K]
): number {
  const generator = STRATEGY_GENERATORS[strategyId] as StrategyGenerator<K>;
  const parts = generator(prop, params);
  return scoreColliderQuality(prop, parts, DEFAULT_QUALITY_WEIGHTS).finalScore;
}

function tuneStrategyForProp<K extends StrategyId>(
  prop: NormalizedProp,
  strategyId: K
): StrategyParamsById[K] {
  const specs = STRATEGY_PARAM_SPECS[strategyId];
  const bounded = BOUNDED_TUNER_STRATEGIES.has(strategyId as StrategyId);
  const seed = hashSeed(`${prop.propId}:${strategyId}`);
  const rand = mulberry32(seed);
  const defaultParams = {
    ...(DEFAULT_STRATEGY_PARAMS[strategyId] as Record<string, number>)
  } as MutableStrategyParams;

  let best = {
    ...defaultParams
  } as MutableStrategyParams;
  let bestScore = evaluateStrategy(
    strategyId,
    prop,
    best as StrategyParamsById[K]
  );

  const randomTrials = bounded
    ? Math.max(8, specs.length * 4)
    : Math.max(20, specs.length * 10);
  for (let i = 0; i < randomTrials; i += 1) {
    const candidate = mutateParams(
      strategyId,
      best,
      defaultParams,
      specs,
      rand,
      i < randomTrials * 0.45
    );
    const score = evaluateStrategy(
      strategyId,
      prop,
      candidate as StrategyParamsById[K]
    );
    if (score < bestScore) {
      best = candidate;
      bestScore = score;
    }
  }

  const coordinatePasses = bounded ? 1 : 2;
  for (let pass = 0; pass < coordinatePasses; pass += 1) {
    for (const rawSpec of specs) {
      const spec = getTunerSearchSpec(
        strategyId,
        rawSpec,
        defaultParams[rawSpec.key] ?? rawSpec.min
      );
      const key = spec.key;
      const baseValue = best[key];
      const candidates = new Set<number>([
        spec.min,
        spec.max,
        quantizeToSpec((spec.min + spec.max) * 0.5, spec),
        baseValue,
        quantizeToSpec(baseValue + spec.step, spec),
        quantizeToSpec(baseValue - spec.step, spec)
      ]);
      if (!bounded) {
        candidates.add(quantizeToSpec(baseValue + spec.step * 2, spec));
        candidates.add(quantizeToSpec(baseValue - spec.step * 2, spec));
        candidates.add(
          quantizeToSpec(baseValue + (spec.max - spec.min) * 0.1, spec)
        );
        candidates.add(
          quantizeToSpec(baseValue - (spec.max - spec.min) * 0.1, spec)
        );
      }

      for (const value of candidates) {
        const candidate = { ...best, [key]: value };
        const score = evaluateStrategy(
          strategyId,
          prop,
          candidate as StrategyParamsById[K]
        );
        if (score < bestScore) {
          best = candidate;
          bestScore = score;
        }
      }
    }
  }

  return best as StrategyParamsById[K];
}

function renderGeneratedSource(
  byProp: Record<string, Partial<StrategyParamsById>>
): string {
  return [
    `import type { StrategyParamsById } from "../types";`,
    ``,
    `export const DEFAULT_STRATEGY_PARAMS_BY_PROP: Record<string, Partial<StrategyParamsById>> = ${JSON.stringify(byProp, null, 2)};`,
    ``
  ].join("\n");
}

function deepCloneStrategyParams(source: StrategyParamsById): StrategyParamsById {
  return JSON.parse(JSON.stringify(source)) as StrategyParamsById;
}

maybeIt(
  "searches best params per strategy/prop and writes generated defaults",
  async () => {
    createNodeGltfShims();
    const propEntries = await listPropEntries();
    expect(propEntries.length).toBeGreaterThan(0);

    const tunedByProp: Record<string, Partial<StrategyParamsById>> = JSON.parse(
      JSON.stringify(DEFAULT_STRATEGY_PARAMS_BY_PROP)
    ) as Record<string, Partial<StrategyParamsById>>;

    for (const entry of propEntries) {
      console.log(`[tune] loading ${entry.id} from ${path.relative(repoRootDir(), entry.modelPath)}`);
      const group = await loadGlbAsGroup(entry.modelPath);
      const normalized = normalizePropGeometry(group, entry.id);
      const perStrategy = deepCloneStrategyParams(DEFAULT_STRATEGY_PARAMS);

      for (const strategyId of ACTIVE_STRATEGY_IDS) {
        const baseline = DEFAULT_STRATEGY_PARAMS[strategyId];
        const baselineScore = evaluateStrategy(strategyId, normalized, baseline);
        const tuned = tuneStrategyForProp(normalized, strategyId);
        const tunedScore = evaluateStrategy(strategyId, normalized, tuned);
        Object.assign(
          perStrategy[strategyId] as Record<string, unknown>,
          tuned as Record<string, unknown>
        );
        console.log(
          `[tune] ${entry.id} :: ${strategyId} :: baseline=${baselineScore.toFixed(5)} tuned=${tunedScore.toFixed(5)}`
        );
      }

      tunedByProp[entry.id] = perStrategy;
      const source = renderGeneratedSource(tunedByProp);
      await writeFile(OUTPUT_PATH, source, "utf8");
      console.log(`[tune] checkpoint ${entry.id}`);
    }

    const source = renderGeneratedSource(tunedByProp);
    await writeFile(OUTPUT_PATH, source, "utf8");
    expect(source.length).toBeGreaterThan(100);
    console.log(`[tune] wrote ${path.relative(process.cwd(), OUTPUT_PATH)}`);
  },
  1_800_000
);

describe("manual tuner gate", () => {
  it("stays skipped unless COLLIDER_V2_TUNE_DEFAULTS=1", () => {
    expect(true).toBe(true);
  });
});
