import type {
  QualityWeights,
  StrategyId,
  StrategyParamSpecsById,
  StrategyParamsById
} from "../types";
import { STRATEGY_IDS } from "../types";
import { DEFAULT_STRATEGY_PARAMS_BY_PROP } from "./per-prop-defaults.generated";

const INFLATE_SPEC = {
  key: "inflate",
  label: "Inflate",
  min: 0,
  max: 0.05,
  step: 0.001,
  type: "float" as const
};

export const STRATEGY_LABELS: Record<StrategyId, string> = {
  "aabb": "AABB",
  "obb-pca": "OBB (PCA)",
  "layered-y": "Layered Y",
  "layered-x": "Layered X",
  "layered-z": "Layered Z",
  "voxel-greedy": "Voxel Greedy",
  "split-fit": "Split Fit",
  "support-columns": "Support Columns",
  "convex": "Convex (Legacy)",
  "boxy-furniture": "Boxy Furniture",
  "concave-furniture": "Concave Furniture",
  "coacd": "CoACD",
  "v-hacd": "V-HACD",
  "hacd": "HACD",
  "acd": "ACD",
  "quickhull": "Quickhull",
  "incremental-hull": "Incremental Hull",
  "mvbb": "MVBB",
  "k-dop": "k-DOP",
  "sphere-ritter": "Sphere (Ritter)",
  "sphere-ls": "Sphere (Least-Squares)",
  "capsule-fit": "Capsule Fit",
  "cylinder-fit": "Cylinder Fit",
  "multi-sphere": "Multi-Sphere",
  "kmeans-seg": "k-means Segmentation",
  "spectral-seg": "Spectral Segmentation",
  "region-grow": "Region Growing",
  "bsp": "BSP Partition",
  "concavity-split": "Concavity Split",
  "sdf-convex": "SDF Convex",
  "qem-decimate": "QEM Decimate",
  "edge-collapse": "Edge Collapse"
};

export const DEFAULT_STRATEGY_PARAMS: StrategyParamsById = {
  "aabb": {
    inflate: 0.01
  },
  "obb-pca": {
    inflate: 0.008
  },
  "layered-y": {
    layerCount: 4,
    minPointsPerLayer: 70,
    mergeSimilarity: 0.2,
    inflate: 0.006
  },
  "layered-x": {
    layerCount: 5,
    minPointsPerLayer: 60,
    mergeSimilarity: 0.2,
    inflate: 0.006
  },
  "layered-z": {
    layerCount: 5,
    minPointsPerLayer: 60,
    mergeSimilarity: 0.2,
    inflate: 0.006
  },
  "voxel-greedy": {
    resolution: 18,
    maxParts: 10,
    inflate: 0.004
  },
  "split-fit": {
    maxDepth: 4,
    maxParts: 8,
    minGain: 0.08,
    inflate: 0.005
  },
  "support-columns": {
    resolution: 20,
    baseLayers: 2,
    topCoverageThreshold: 0.2,
    maxParts: 8,
    inflate: 0.004
  },
  "convex": {
    targetParts: 4,
    maxSamplePoints: 2600,
    maxHullPoints: 180,
    minClusterPoints: 24,
    inflate: 0.004
  },
  "boxy-furniture": {
    mode: 1,
    budget: 0,
    maxParts: 10,
    inflate: 0.004
  },
  "concave-furniture": {
    mode: 1,
    budget: 1,
    maxParts: 12,
    inflate: 0.004
  },
  "coacd": {
    resolution: 24,
    detail: 0.55,
    maxParts: 12,
    inflate: 0.004
  },
  "v-hacd": {
    resolution: 28,
    detail: 0.62,
    maxParts: 14,
    inflate: 0.004
  },
  "hacd": {
    resolution: 22,
    detail: 0.5,
    maxParts: 12,
    inflate: 0.004
  },
  "acd": {
    resolution: 20,
    detail: 0.48,
    maxParts: 10,
    inflate: 0.004
  },
  "quickhull": {
    tighten: 0.15,
    inflate: 0.004
  },
  "incremental-hull": {
    tighten: 0.08,
    inflate: 0.004
  },
  "mvbb": {
    sampleCount: 20,
    inflate: 0.006
  },
  "k-dop": {
    directionCount: 18,
    maxParts: 6,
    inflate: 0.005
  },
  "sphere-ritter": {
    maxParts: 1,
    inflate: 0.003
  },
  "sphere-ls": {
    maxParts: 1,
    inflate: 0.003
  },
  "capsule-fit": {
    segments: 3,
    inflate: 0.004
  },
  "cylinder-fit": {
    segments: 4,
    radialSamples: 12,
    inflate: 0.004
  },
  "multi-sphere": {
    sphereCount: 4,
    inflate: 0.003
  },
  "kmeans-seg": {
    clusterCount: 6,
    maxParts: 10,
    inflate: 0.004
  },
  "spectral-seg": {
    clusterCount: 6,
    maxParts: 10,
    inflate: 0.004
  },
  "region-grow": {
    clusterCount: 5,
    maxParts: 10,
    inflate: 0.004
  },
  "bsp": {
    maxDepth: 4,
    minPoints: 80,
    maxParts: 10,
    inflate: 0.004
  },
  "concavity-split": {
    resolution: 24,
    maxParts: 10,
    maxDepth: 8,
    minLeafVoxels: 24,
    splitCandidates: 8,
    concavityThreshold: 0.34,
    minConcavityGain: 0.02,
    complexityPenalty: 0.012,
    inflate: 0.004
  },
  "sdf-convex": {
    resolution: 24,
    smoothPasses: 2,
    maxParts: 12,
    inflate: 0.004
  },
  "qem-decimate": {
    targetRatio: 0.45,
    maxParts: 8,
    inflate: 0.004
  },
  "edge-collapse": {
    targetRatio: 0.35,
    maxParts: 8,
    inflate: 0.004
  }
};

export function resolveDefaultStrategyParams(
  propId: string | null | undefined
): StrategyParamsById {
  if (!propId) {
    return DEFAULT_STRATEGY_PARAMS;
  }
  const propDefaults = DEFAULT_STRATEGY_PARAMS_BY_PROP[propId];
  if (!propDefaults) {
    return DEFAULT_STRATEGY_PARAMS;
  }

  const merged = JSON.parse(JSON.stringify(DEFAULT_STRATEGY_PARAMS)) as StrategyParamsById;
  for (const strategyId of STRATEGY_IDS) {
    const override = propDefaults[strategyId];
    if (!override) {
      continue;
    }
    Object.assign(
      merged[strategyId] as Record<string, unknown>,
      override as Record<string, unknown>
    );
  }
  return merged;
}

const LAYERED_SPECS = [
  {
    key: "layerCount",
    label: "Layer Count",
    min: 1,
    max: 12,
    step: 1,
    type: "int" as const
  },
  {
    key: "minPointsPerLayer",
    label: "Min Points/Layer",
    min: 20,
    max: 300,
    step: 5,
    type: "int" as const
  },
  {
    key: "mergeSimilarity",
    label: "Merge Similarity",
    min: 0,
    max: 0.6,
    step: 0.01,
    type: "float" as const
  },
  INFLATE_SPEC
];

const DECOMP_SPECS = [
  {
    key: "resolution",
    label: "Resolution",
    min: 8,
    max: 48,
    step: 1,
    type: "int" as const
  },
  {
    key: "detail",
    label: "Detail",
    min: 0.1,
    max: 1,
    step: 0.01,
    type: "float" as const
  },
  {
    key: "maxParts",
    label: "Max Parts",
    min: 1,
    max: 32,
    step: 1,
    type: "int" as const
  },
  INFLATE_SPEC
];

const SEGMENTATION_SPECS = [
  {
    key: "clusterCount",
    label: "Clusters",
    min: 2,
    max: 24,
    step: 1,
    type: "int" as const
  },
  {
    key: "maxParts",
    label: "Max Parts",
    min: 1,
    max: 32,
    step: 1,
    type: "int" as const
  },
  INFLATE_SPEC
];

export const STRATEGY_PARAM_SPECS: StrategyParamSpecsById = {
  "aabb": [INFLATE_SPEC],
  "obb-pca": [INFLATE_SPEC],
  "layered-y": LAYERED_SPECS,
  "layered-x": LAYERED_SPECS,
  "layered-z": LAYERED_SPECS,
  "voxel-greedy": [
    {
      key: "resolution",
      label: "Resolution",
      min: 8,
      max: 32,
      step: 1,
      type: "int"
    },
    {
      key: "maxParts",
      label: "Max Parts",
      min: 1,
      max: 24,
      step: 1,
      type: "int"
    },
    INFLATE_SPEC
  ],
  "split-fit": [
    {
      key: "maxDepth",
      label: "Max Depth",
      min: 1,
      max: 8,
      step: 1,
      type: "int"
    },
    {
      key: "maxParts",
      label: "Max Parts",
      min: 1,
      max: 24,
      step: 1,
      type: "int"
    },
    {
      key: "minGain",
      label: "Min Gain",
      min: 0.01,
      max: 0.4,
      step: 0.01,
      type: "float"
    },
    INFLATE_SPEC
  ],
  "support-columns": [
    {
      key: "resolution",
      label: "Resolution",
      min: 8,
      max: 40,
      step: 1,
      type: "int"
    },
    {
      key: "baseLayers",
      label: "Base Layers",
      min: 1,
      max: 8,
      step: 1,
      type: "int"
    },
    {
      key: "topCoverageThreshold",
      label: "Top Coverage",
      min: 0.05,
      max: 0.6,
      step: 0.01,
      type: "float"
    },
    {
      key: "maxParts",
      label: "Max Parts",
      min: 1,
      max: 24,
      step: 1,
      type: "int"
    },
    INFLATE_SPEC
  ],
  "convex": [
    {
      key: "targetParts",
      label: "Target Parts",
      min: 1,
      max: 8,
      step: 1,
      type: "int"
    },
    {
      key: "maxSamplePoints",
      label: "Max Samples",
      min: 300,
      max: 7000,
      step: 50,
      type: "int"
    },
    {
      key: "maxHullPoints",
      label: "Max Hull Points",
      min: 24,
      max: 500,
      step: 4,
      type: "int"
    },
    {
      key: "minClusterPoints",
      label: "Min Cluster Points",
      min: 8,
      max: 180,
      step: 2,
      type: "int"
    },
    INFLATE_SPEC
  ],
  "boxy-furniture": [
    {
      key: "mode",
      label: "Mode (0 static, 1 dynamic)",
      min: 0,
      max: 1,
      step: 1,
      type: "int"
    },
    {
      key: "budget",
      label: "Budget (0 strict, 1 balanced)",
      min: 0,
      max: 1,
      step: 1,
      type: "int"
    },
    {
      key: "maxParts",
      label: "Max Parts",
      min: 1,
      max: 24,
      step: 1,
      type: "int"
    },
    INFLATE_SPEC
  ],
  "concave-furniture": [
    {
      key: "mode",
      label: "Mode (0 static, 1 dynamic)",
      min: 0,
      max: 1,
      step: 1,
      type: "int"
    },
    {
      key: "budget",
      label: "Budget (0 strict, 1 balanced)",
      min: 0,
      max: 1,
      step: 1,
      type: "int"
    },
    {
      key: "maxParts",
      label: "Max Parts",
      min: 1,
      max: 24,
      step: 1,
      type: "int"
    },
    INFLATE_SPEC
  ],
  "coacd": DECOMP_SPECS,
  "v-hacd": DECOMP_SPECS,
  "hacd": DECOMP_SPECS,
  "acd": DECOMP_SPECS,
  "quickhull": [
    {
      key: "tighten",
      label: "Tighten",
      min: 0,
      max: 0.7,
      step: 0.01,
      type: "float"
    },
    INFLATE_SPEC
  ],
  "incremental-hull": [
    {
      key: "tighten",
      label: "Tighten",
      min: 0,
      max: 0.7,
      step: 0.01,
      type: "float"
    },
    INFLATE_SPEC
  ],
  "mvbb": [
    {
      key: "sampleCount",
      label: "Samples",
      min: 8,
      max: 64,
      step: 1,
      type: "int"
    },
    INFLATE_SPEC
  ],
  "k-dop": [
    {
      key: "directionCount",
      label: "Directions",
      min: 6,
      max: 26,
      step: 1,
      type: "int"
    },
    {
      key: "maxParts",
      label: "Max Parts",
      min: 1,
      max: 20,
      step: 1,
      type: "int"
    },
    INFLATE_SPEC
  ],
  "sphere-ritter": [
    {
      key: "maxParts",
      label: "Max Parts",
      min: 1,
      max: 12,
      step: 1,
      type: "int"
    },
    INFLATE_SPEC
  ],
  "sphere-ls": [
    {
      key: "maxParts",
      label: "Max Parts",
      min: 1,
      max: 12,
      step: 1,
      type: "int"
    },
    INFLATE_SPEC
  ],
  "capsule-fit": [
    {
      key: "segments",
      label: "Segments",
      min: 1,
      max: 12,
      step: 1,
      type: "int"
    },
    INFLATE_SPEC
  ],
  "cylinder-fit": [
    {
      key: "segments",
      label: "Segments",
      min: 1,
      max: 12,
      step: 1,
      type: "int"
    },
    {
      key: "radialSamples",
      label: "Radial Samples",
      min: 6,
      max: 40,
      step: 1,
      type: "int"
    },
    INFLATE_SPEC
  ],
  "multi-sphere": [
    {
      key: "sphereCount",
      label: "Sphere Count",
      min: 1,
      max: 16,
      step: 1,
      type: "int"
    },
    INFLATE_SPEC
  ],
  "kmeans-seg": SEGMENTATION_SPECS,
  "spectral-seg": SEGMENTATION_SPECS,
  "region-grow": SEGMENTATION_SPECS,
  "bsp": [
    {
      key: "maxDepth",
      label: "Max Depth",
      min: 1,
      max: 10,
      step: 1,
      type: "int"
    },
    {
      key: "minPoints",
      label: "Min Points",
      min: 20,
      max: 800,
      step: 10,
      type: "int"
    },
    {
      key: "maxParts",
      label: "Max Parts",
      min: 1,
      max: 24,
      step: 1,
      type: "int"
    },
    INFLATE_SPEC
  ],
  "concavity-split": [
    {
      key: "resolution",
      label: "Resolution",
      min: 8,
      max: 48,
      step: 1,
      type: "int"
    },
    {
      key: "maxParts",
      label: "Max Parts",
      min: 1,
      max: 24,
      step: 1,
      type: "int"
    },
    {
      key: "maxDepth",
      label: "Max Depth",
      min: 1,
      max: 12,
      step: 1,
      type: "int"
    },
    {
      key: "minLeafVoxels",
      label: "Min Leaf Voxels",
      min: 6,
      max: 240,
      step: 2,
      type: "int"
    },
    {
      key: "splitCandidates",
      label: "Split Candidates",
      min: 2,
      max: 16,
      step: 1,
      type: "int"
    },
    {
      key: "concavityThreshold",
      label: "Concavity Threshold",
      min: 0.05,
      max: 0.9,
      step: 0.01,
      type: "float"
    },
    {
      key: "complexityPenalty",
      label: "Complexity Penalty",
      min: 0,
      max: 0.08,
      step: 0.001,
      type: "float"
    },
    {
      key: "minConcavityGain",
      label: "Min Concavity Gain",
      min: 0,
      max: 0.25,
      step: 0.005,
      type: "float"
    },
    INFLATE_SPEC
  ],
  "sdf-convex": [
    {
      key: "resolution",
      label: "Resolution",
      min: 8,
      max: 48,
      step: 1,
      type: "int"
    },
    {
      key: "smoothPasses",
      label: "Smooth Passes",
      min: 0,
      max: 6,
      step: 1,
      type: "int"
    },
    {
      key: "maxParts",
      label: "Max Parts",
      min: 1,
      max: 32,
      step: 1,
      type: "int"
    },
    INFLATE_SPEC
  ],
  "qem-decimate": [
    {
      key: "targetRatio",
      label: "Target Ratio",
      min: 0.05,
      max: 1,
      step: 0.01,
      type: "float"
    },
    {
      key: "maxParts",
      label: "Max Parts",
      min: 1,
      max: 20,
      step: 1,
      type: "int"
    },
    INFLATE_SPEC
  ],
  "edge-collapse": [
    {
      key: "targetRatio",
      label: "Target Ratio",
      min: 0.05,
      max: 1,
      step: 0.01,
      type: "float"
    },
    {
      key: "maxParts",
      label: "Max Parts",
      min: 1,
      max: 20,
      step: 1,
      type: "int"
    },
    INFLATE_SPEC
  ]
};

export const DEFAULT_QUALITY_WEIGHTS: QualityWeights = {
  meshCoveragePenalty: 0.68,
  emptyVolumePenalty: 0.54,
  selfOverlapPenalty: 0.22,
  thinPenalty: 0.06,
  partPenalty: 0.08,
  baseOverreachPenalty: 0.12,
  flatBaseBonus: 0.02
};
