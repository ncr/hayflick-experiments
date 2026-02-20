import type {
  QualityWeights,
  StrategyId,
  StrategyParamSpecsById,
  StrategyParamsById
} from "../types";

export const STRATEGY_LABELS: Record<StrategyId, string> = {
  "aabb": "AABB",
  "obb-pca": "OBB (PCA)",
  "layered-y": "Layered Y",
  "layered-x": "Layered X",
  "layered-z": "Layered Z",
  "voxel-greedy": "Voxel Greedy",
  "split-fit": "Split Fit",
  "support-columns": "Support Columns"
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
  }
};

export const STRATEGY_PARAM_SPECS: StrategyParamSpecsById = {
  "aabb": [
    {
      key: "inflate",
      label: "Inflate",
      min: 0,
      max: 0.05,
      step: 0.001,
      type: "float"
    }
  ],
  "obb-pca": [
    {
      key: "inflate",
      label: "Inflate",
      min: 0,
      max: 0.05,
      step: 0.001,
      type: "float"
    }
  ],
  "layered-y": [
    {
      key: "layerCount",
      label: "Layer Count",
      min: 1,
      max: 10,
      step: 1,
      type: "int"
    },
    {
      key: "minPointsPerLayer",
      label: "Min Points/Layer",
      min: 20,
      max: 300,
      step: 5,
      type: "int"
    },
    {
      key: "mergeSimilarity",
      label: "Merge Similarity",
      min: 0,
      max: 0.6,
      step: 0.01,
      type: "float"
    },
    {
      key: "inflate",
      label: "Inflate",
      min: 0,
      max: 0.05,
      step: 0.001,
      type: "float"
    }
  ],
  "layered-x": [
    {
      key: "layerCount",
      label: "Layer Count",
      min: 1,
      max: 12,
      step: 1,
      type: "int"
    },
    {
      key: "minPointsPerLayer",
      label: "Min Points/Layer",
      min: 20,
      max: 300,
      step: 5,
      type: "int"
    },
    {
      key: "mergeSimilarity",
      label: "Merge Similarity",
      min: 0,
      max: 0.6,
      step: 0.01,
      type: "float"
    },
    {
      key: "inflate",
      label: "Inflate",
      min: 0,
      max: 0.05,
      step: 0.001,
      type: "float"
    }
  ],
  "layered-z": [
    {
      key: "layerCount",
      label: "Layer Count",
      min: 1,
      max: 12,
      step: 1,
      type: "int"
    },
    {
      key: "minPointsPerLayer",
      label: "Min Points/Layer",
      min: 20,
      max: 300,
      step: 5,
      type: "int"
    },
    {
      key: "mergeSimilarity",
      label: "Merge Similarity",
      min: 0,
      max: 0.6,
      step: 0.01,
      type: "float"
    },
    {
      key: "inflate",
      label: "Inflate",
      min: 0,
      max: 0.05,
      step: 0.001,
      type: "float"
    }
  ],
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
      max: 20,
      step: 1,
      type: "int"
    },
    {
      key: "inflate",
      label: "Inflate",
      min: 0,
      max: 0.05,
      step: 0.001,
      type: "float"
    }
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
      max: 20,
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
    {
      key: "inflate",
      label: "Inflate",
      min: 0,
      max: 0.05,
      step: 0.001,
      type: "float"
    }
  ],
  "support-columns": [
    {
      key: "resolution",
      label: "Resolution",
      min: 8,
      max: 32,
      step: 1,
      type: "int"
    },
    {
      key: "baseLayers",
      label: "Base Layers",
      min: 1,
      max: 6,
      step: 1,
      type: "int"
    },
    {
      key: "topCoverageThreshold",
      label: "Top Coverage",
      min: 0.05,
      max: 0.5,
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
    {
      key: "inflate",
      label: "Inflate",
      min: 0,
      max: 0.05,
      step: 0.001,
      type: "float"
    }
  ]
};

export const DEFAULT_QUALITY_WEIGHTS: QualityWeights = {
  underfill: 0.55,
  overfill: 0.25,
  thinPenalty: 0.08,
  partPenalty: 0.07,
  flatBaseBonus: 0.05
};
