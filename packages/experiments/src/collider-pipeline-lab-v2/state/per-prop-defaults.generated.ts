import type { StrategyParamsById } from "../types";

export const DEFAULT_STRATEGY_PARAMS_BY_PROP: Record<string, Partial<StrategyParamsById>> = {
  "ammo-crate": {
    "aabb": {
      "inflate": 0
    },
    "obb-pca": {
      "inflate": 0
    },
    "layered-y": {
      "layerCount": 1,
      "minPointsPerLayer": 35,
      "mergeSimilarity": 0.53,
      "inflate": 0
    },
    "layered-x": {
      "layerCount": 1,
      "minPointsPerLayer": 300,
      "mergeSimilarity": 0,
      "inflate": 0
    },
    "layered-z": {
      "layerCount": 1,
      "minPointsPerLayer": 20,
      "mergeSimilarity": 0.35,
      "inflate": 0
    },
    "voxel-greedy": {
      "resolution": 14,
      "maxParts": 5,
      "inflate": 0
    },
    "split-fit": {
      "maxDepth": 4,
      "maxParts": 13,
      "minGain": 0.08,
      "inflate": 0
    },
    "support-columns": {
      "resolution": 22,
      "baseLayers": 8,
      "topCoverageThreshold": 0.6,
      "maxParts": 9,
      "inflate": 0
    },
    "convex": {
      "targetParts": 1,
      "maxSamplePoints": 1260,
      "maxHullPoints": 205,
      "minClusterPoints": 42,
      "inflate": 0
    },
    "boxy-furniture": {
      "mode": 1,
      "budget": 1,
      "maxParts": 7,
      "inflate": 0
    },
    "concave-furniture": {
      "mode": 1,
      "budget": 1,
      "maxParts": 1,
      "inflate": 0
    },
    "coacd": {
      "resolution": 36,
      "detail": 0.19,
      "maxParts": 6,
      "inflate": 0
    },
    "v-hacd": {
      "resolution": 20,
      "detail": 0.55,
      "maxParts": 8,
      "inflate": 0
    },
    "hacd": {
      "resolution": 24,
      "detail": 0.1,
      "maxParts": 8,
      "inflate": 0
    },
    "acd": {
      "resolution": 22,
      "detail": 0.49,
      "maxParts": 12,
      "inflate": 0
    },
    "quickhull": {
      "tighten": 0.45,
      "inflate": 0.004
    },
    "incremental-hull": {
      "tighten": 0.18,
      "inflate": 0.05
    },
    "mvbb": {
      "sampleCount": 37,
      "inflate": 0
    },
    "k-dop": {
      "directionCount": 6,
      "maxParts": 1,
      "inflate": 0
    },
    "sphere-ritter": {
      "maxParts": 1,
      "inflate": 0
    },
    "sphere-ls": {
      "maxParts": 1,
      "inflate": 0
    },
    "capsule-fit": {
      "segments": 1,
      "inflate": 0
    },
    "cylinder-fit": {
      "segments": 1,
      "radialSamples": 6,
      "inflate": 0
    },
    "multi-sphere": {
      "sphereCount": 1,
      "inflate": 0
    },
    "kmeans-seg": {
      "clusterCount": 2,
      "maxParts": 19,
      "inflate": 0
    },
    "spectral-seg": {
      "clusterCount": 3,
      "maxParts": 12,
      "inflate": 0
    },
    "region-grow": {
      "clusterCount": 7,
      "maxParts": 4,
      "inflate": 0.05
    },
    "bsp": {
      "maxDepth": 2,
      "minPoints": 120,
      "maxParts": 5,
      "inflate": 0
    },
    "sdf-convex": {
      "resolution": 36,
      "smoothPasses": 4,
      "maxParts": 6,
      "inflate": 0.028
    },
    "qem-decimate": {
      "targetRatio": 1,
      "maxParts": 1,
      "inflate": 0
    },
    "edge-collapse": {
      "targetRatio": 0.29,
      "maxParts": 1,
      "inflate": 0
    }
  },
  "braun-inspired-desk": {
    "aabb": {
      "inflate": 0.005
    },
    "obb-pca": {
      "inflate": 0
    },
    "layered-y": {
      "layerCount": 4,
      "minPointsPerLayer": 75,
      "mergeSimilarity": 0,
      "inflate": 0.041
    },
    "layered-x": {
      "layerCount": 12,
      "minPointsPerLayer": 300,
      "mergeSimilarity": 0.06,
      "inflate": 0.039
    },
    "layered-z": {
      "layerCount": 1,
      "minPointsPerLayer": 135,
      "mergeSimilarity": 0.15,
      "inflate": 0.005
    },
    "voxel-greedy": {
      "resolution": 20,
      "maxParts": 7,
      "inflate": 0.025
    },
    "split-fit": {
      "maxDepth": 1,
      "maxParts": 8,
      "minGain": 0.01,
      "inflate": 0.034
    },
    "support-columns": {
      "resolution": 24,
      "baseLayers": 3,
      "topCoverageThreshold": 0.6,
      "maxParts": 8,
      "inflate": 0.05
    },
    "convex": {
      "targetParts": 8,
      "maxSamplePoints": 3160,
      "maxHullPoints": 273,
      "minClusterPoints": 8,
      "inflate": 0
    },
    "boxy-furniture": {
      "mode": 1,
      "budget": 0,
      "maxParts": 17,
      "inflate": 0
    },
    "concave-furniture": {
      "mode": 0,
      "budget": 0,
      "maxParts": 13,
      "inflate": 0.039
    },
    "coacd": {
      "resolution": 25,
      "detail": 0.55,
      "maxParts": 6,
      "inflate": 0
    },
    "v-hacd": {
      "resolution": 40,
      "detail": 1,
      "maxParts": 23,
      "inflate": 0
    },
    "hacd": {
      "resolution": 14,
      "detail": 0.1,
      "maxParts": 6,
      "inflate": 0.012
    },
    "acd": {
      "resolution": 23,
      "detail": 0.1,
      "maxParts": 18,
      "inflate": 0
    },
    "quickhull": {
      "tighten": 0.5,
      "inflate": 0.004
    },
    "incremental-hull": {
      "tighten": 0.01,
      "inflate": 0.008
    },
    "mvbb": {
      "sampleCount": 8,
      "inflate": 0
    },
    "k-dop": {
      "directionCount": 26,
      "maxParts": 1,
      "inflate": 0.005
    },
    "sphere-ritter": {
      "maxParts": 1,
      "inflate": 0.025
    },
    "sphere-ls": {
      "maxParts": 10,
      "inflate": 0.006
    },
    "capsule-fit": {
      "segments": 1,
      "inflate": 0.005
    },
    "cylinder-fit": {
      "segments": 5,
      "radialSamples": 14,
      "inflate": 0.031
    },
    "multi-sphere": {
      "sphereCount": 1,
      "inflate": 0.025
    },
    "kmeans-seg": {
      "clusterCount": 13,
      "maxParts": 14,
      "inflate": 0
    },
    "spectral-seg": {
      "clusterCount": 10,
      "maxParts": 18,
      "inflate": 0
    },
    "region-grow": {
      "clusterCount": 11,
      "maxParts": 16,
      "inflate": 0.049
    },
    "bsp": {
      "maxDepth": 3,
      "minPoints": 20,
      "maxParts": 11,
      "inflate": 0
    },
    "sdf-convex": {
      "resolution": 35,
      "smoothPasses": 1,
      "maxParts": 21,
      "inflate": 0.034
    },
    "qem-decimate": {
      "targetRatio": 0.55,
      "maxParts": 20,
      "inflate": 0
    },
    "edge-collapse": {
      "targetRatio": 0.53,
      "maxParts": 20,
      "inflate": 0
    }
  },
  "chemical-flask": {
    "aabb": {
      "inflate": 0
    },
    "obb-pca": {
      "inflate": 0.002
    },
    "layered-y": {
      "layerCount": 7,
      "minPointsPerLayer": 20,
      "mergeSimilarity": 0.5,
      "inflate": 0
    },
    "layered-x": {
      "layerCount": 10,
      "minPointsPerLayer": 20,
      "mergeSimilarity": 0.07,
      "inflate": 0
    },
    "layered-z": {
      "layerCount": 8,
      "minPointsPerLayer": 300,
      "mergeSimilarity": 0.01,
      "inflate": 0.001
    },
    "voxel-greedy": {
      "resolution": 18,
      "maxParts": 8,
      "inflate": 0
    },
    "split-fit": {
      "maxDepth": 5,
      "maxParts": 13,
      "minGain": 0.21,
      "inflate": 0.001
    },
    "support-columns": {
      "resolution": 20,
      "baseLayers": 3,
      "topCoverageThreshold": 0.16,
      "maxParts": 3,
      "inflate": 0
    },
    "convex": {
      "targetParts": 4,
      "maxSamplePoints": 1260,
      "maxHullPoints": 323,
      "minClusterPoints": 28,
      "inflate": 0
    },
    "boxy-furniture": {
      "mode": 1,
      "budget": 1,
      "maxParts": 1,
      "inflate": 0
    },
    "concave-furniture": {
      "mode": 1,
      "budget": 0,
      "maxParts": 1,
      "inflate": 0
    },
    "coacd": {
      "resolution": 23,
      "detail": 0.55,
      "maxParts": 9,
      "inflate": 0.026
    },
    "v-hacd": {
      "resolution": 20,
      "detail": 0.1,
      "maxParts": 8,
      "inflate": 0
    },
    "hacd": {
      "resolution": 34,
      "detail": 0.22,
      "maxParts": 15,
      "inflate": 0.025
    },
    "acd": {
      "resolution": 21,
      "detail": 0.1,
      "maxParts": 12,
      "inflate": 0.001
    },
    "quickhull": {
      "tighten": 0,
      "inflate": 0.002
    },
    "incremental-hull": {
      "tighten": 0.03,
      "inflate": 0.008
    },
    "mvbb": {
      "sampleCount": 36,
      "inflate": 0.001
    },
    "k-dop": {
      "directionCount": 23,
      "maxParts": 20,
      "inflate": 0
    },
    "sphere-ritter": {
      "maxParts": 2,
      "inflate": 0
    },
    "sphere-ls": {
      "maxParts": 5,
      "inflate": 0.05
    },
    "capsule-fit": {
      "segments": 7,
      "inflate": 0.006
    },
    "cylinder-fit": {
      "segments": 7,
      "radialSamples": 6,
      "inflate": 0.008
    },
    "multi-sphere": {
      "sphereCount": 2,
      "inflate": 0
    },
    "kmeans-seg": {
      "clusterCount": 9,
      "maxParts": 10,
      "inflate": 0.013
    },
    "spectral-seg": {
      "clusterCount": 7,
      "maxParts": 19,
      "inflate": 0
    },
    "region-grow": {
      "clusterCount": 12,
      "maxParts": 12,
      "inflate": 0.029
    },
    "bsp": {
      "maxDepth": 5,
      "minPoints": 270,
      "maxParts": 17,
      "inflate": 0
    },
    "sdf-convex": {
      "resolution": 36,
      "smoothPasses": 4,
      "maxParts": 18,
      "inflate": 0.026
    },
    "qem-decimate": {
      "targetRatio": 0.06,
      "maxParts": 13,
      "inflate": 0.001
    },
    "edge-collapse": {
      "targetRatio": 0.15,
      "maxParts": 8,
      "inflate": 0
    }
  },
  "commodore-pet-inspired-computer": {
    "aabb": {
      "inflate": 0.001
    },
    "obb-pca": {
      "inflate": 0
    },
    "layered-y": {
      "layerCount": 12,
      "minPointsPerLayer": 140,
      "mergeSimilarity": 0.04,
      "inflate": 0
    },
    "layered-x": {
      "layerCount": 8,
      "minPointsPerLayer": 20,
      "mergeSimilarity": 0.04,
      "inflate": 0.003
    },
    "layered-z": {
      "layerCount": 8,
      "minPointsPerLayer": 20,
      "mergeSimilarity": 0.25,
      "inflate": 0
    },
    "voxel-greedy": {
      "resolution": 13,
      "maxParts": 8,
      "inflate": 0.001
    },
    "split-fit": {
      "maxDepth": 4,
      "maxParts": 7,
      "minGain": 0.01,
      "inflate": 0
    },
    "support-columns": {
      "resolution": 23,
      "baseLayers": 1,
      "topCoverageThreshold": 0.33,
      "maxParts": 3,
      "inflate": 0
    },
    "convex": {
      "targetParts": 6,
      "maxSamplePoints": 3410,
      "maxHullPoints": 265,
      "minClusterPoints": 64,
      "inflate": 0
    },
    "boxy-furniture": {
      "mode": 1,
      "budget": 1,
      "maxParts": 9,
      "inflate": 0
    },
    "concave-furniture": {
      "mode": 1,
      "budget": 1,
      "maxParts": 6,
      "inflate": 0.001
    },
    "coacd": {
      "resolution": 26,
      "detail": 0.38,
      "maxParts": 16,
      "inflate": 0
    },
    "v-hacd": {
      "resolution": 21,
      "detail": 0.1,
      "maxParts": 23,
      "inflate": 0
    },
    "hacd": {
      "resolution": 14,
      "detail": 0.5,
      "maxParts": 10,
      "inflate": 0.003
    },
    "acd": {
      "resolution": 23,
      "detail": 1,
      "maxParts": 6,
      "inflate": 0
    },
    "quickhull": {
      "tighten": 0.4,
      "inflate": 0
    },
    "incremental-hull": {
      "tighten": 0.01,
      "inflate": 0.003
    },
    "mvbb": {
      "sampleCount": 50,
      "inflate": 0
    },
    "k-dop": {
      "directionCount": 26,
      "maxParts": 11,
      "inflate": 0.001
    },
    "sphere-ritter": {
      "maxParts": 1,
      "inflate": 0
    },
    "sphere-ls": {
      "maxParts": 1,
      "inflate": 0
    },
    "capsule-fit": {
      "segments": 6,
      "inflate": 0.001
    },
    "cylinder-fit": {
      "segments": 1,
      "radialSamples": 29,
      "inflate": 0
    },
    "multi-sphere": {
      "sphereCount": 1,
      "inflate": 0
    },
    "kmeans-seg": {
      "clusterCount": 8,
      "maxParts": 10,
      "inflate": 0.003
    },
    "spectral-seg": {
      "clusterCount": 6,
      "maxParts": 10,
      "inflate": 0.003
    },
    "region-grow": {
      "clusterCount": 11,
      "maxParts": 8,
      "inflate": 0.038
    },
    "bsp": {
      "maxDepth": 5,
      "minPoints": 20,
      "maxParts": 6,
      "inflate": 0.025
    },
    "sdf-convex": {
      "resolution": 24,
      "smoothPasses": 4,
      "maxParts": 21,
      "inflate": 0.044
    },
    "qem-decimate": {
      "targetRatio": 0.57,
      "maxParts": 6,
      "inflate": 0.001
    },
    "edge-collapse": {
      "targetRatio": 0.35,
      "maxParts": 8,
      "inflate": 0.001
    }
  },
  "eames-style-chair-but-in-our-scifi-style": {
    "aabb": {
      "inflate": 0
    },
    "obb-pca": {
      "inflate": 0
    },
    "layered-y": {
      "layerCount": 10,
      "minPointsPerLayer": 125,
      "mergeSimilarity": 0.3,
      "inflate": 0.002
    },
    "layered-x": {
      "layerCount": 12,
      "minPointsPerLayer": 140,
      "mergeSimilarity": 0.15,
      "inflate": 0.001
    },
    "layered-z": {
      "layerCount": 4,
      "minPointsPerLayer": 20,
      "mergeSimilarity": 0.6,
      "inflate": 0
    },
    "voxel-greedy": {
      "resolution": 13,
      "maxParts": 17,
      "inflate": 0
    },
    "split-fit": {
      "maxDepth": 4,
      "maxParts": 7,
      "minGain": 0.01,
      "inflate": 0
    },
    "support-columns": {
      "resolution": 30,
      "baseLayers": 1,
      "topCoverageThreshold": 0.05,
      "maxParts": 9,
      "inflate": 0
    },
    "convex": {
      "targetParts": 6,
      "maxSamplePoints": 2710,
      "maxHullPoints": 321,
      "minClusterPoints": 30,
      "inflate": 0.025
    },
    "boxy-furniture": {
      "mode": 1,
      "budget": 1,
      "maxParts": 7,
      "inflate": 0
    },
    "concave-furniture": {
      "mode": 1,
      "budget": 1,
      "maxParts": 5,
      "inflate": 0
    },
    "coacd": {
      "resolution": 16,
      "detail": 0.1,
      "maxParts": 21,
      "inflate": 0.024
    },
    "v-hacd": {
      "resolution": 21,
      "detail": 0.5,
      "maxParts": 8,
      "inflate": 0
    },
    "hacd": {
      "resolution": 14,
      "detail": 0.55,
      "maxParts": 9,
      "inflate": 0.025
    },
    "acd": {
      "resolution": 20,
      "detail": 0.48,
      "maxParts": 10,
      "inflate": 0
    },
    "quickhull": {
      "tighten": 0.15,
      "inflate": 0
    },
    "incremental-hull": {
      "tighten": 0,
      "inflate": 0
    },
    "mvbb": {
      "sampleCount": 11,
      "inflate": 0
    },
    "k-dop": {
      "directionCount": 26,
      "maxParts": 11,
      "inflate": 0.042
    },
    "sphere-ritter": {
      "maxParts": 1,
      "inflate": 0
    },
    "sphere-ls": {
      "maxParts": 11,
      "inflate": 0.017
    },
    "capsule-fit": {
      "segments": 5,
      "inflate": 0.036
    },
    "cylinder-fit": {
      "segments": 5,
      "radialSamples": 6,
      "inflate": 0.02
    },
    "multi-sphere": {
      "sphereCount": 1,
      "inflate": 0
    },
    "kmeans-seg": {
      "clusterCount": 9,
      "maxParts": 19,
      "inflate": 0
    },
    "spectral-seg": {
      "clusterCount": 6,
      "maxParts": 10,
      "inflate": 0.049
    },
    "region-grow": {
      "clusterCount": 8,
      "maxParts": 4,
      "inflate": 0.047
    },
    "bsp": {
      "maxDepth": 2,
      "minPoints": 60,
      "maxParts": 6,
      "inflate": 0.02
    },
    "sdf-convex": {
      "resolution": 36,
      "smoothPasses": 1,
      "maxParts": 6,
      "inflate": 0.026
    },
    "qem-decimate": {
      "targetRatio": 0.05,
      "maxParts": 18,
      "inflate": 0
    },
    "edge-collapse": {
      "targetRatio": 0.05,
      "maxParts": 11,
      "inflate": 0.044
    }
  },
  "large-desk-without-drawers": {
    "aabb": {
      "inflate": 0
    },
    "obb-pca": {
      "inflate": 0
    },
    "layered-y": {
      "layerCount": 2,
      "minPointsPerLayer": 160,
      "mergeSimilarity": 0.2,
      "inflate": 0
    },
    "layered-x": {
      "layerCount": 1,
      "minPointsPerLayer": 60,
      "mergeSimilarity": 0.3,
      "inflate": 0
    },
    "layered-z": {
      "layerCount": 11,
      "minPointsPerLayer": 270,
      "mergeSimilarity": 0.3,
      "inflate": 0
    },
    "voxel-greedy": {
      "resolution": 17,
      "maxParts": 10,
      "inflate": 0.05
    },
    "split-fit": {
      "maxDepth": 3,
      "maxParts": 6,
      "minGain": 0.35,
      "inflate": 0
    },
    "support-columns": {
      "resolution": 14,
      "baseLayers": 4,
      "topCoverageThreshold": 0.56,
      "maxParts": 15,
      "inflate": 0
    },
    "convex": {
      "targetParts": 1,
      "maxSamplePoints": 4610,
      "maxHullPoints": 85,
      "minClusterPoints": 44,
      "inflate": 0
    },
    "boxy-furniture": {
      "mode": 1,
      "budget": 0,
      "maxParts": 21,
      "inflate": 0
    },
    "concave-furniture": {
      "mode": 1,
      "budget": 1,
      "maxParts": 5,
      "inflate": 0
    },
    "coacd": {
      "resolution": 20,
      "detail": 0.55,
      "maxParts": 6,
      "inflate": 0.025
    },
    "v-hacd": {
      "resolution": 40,
      "detail": 0.63,
      "maxParts": 8,
      "inflate": 0
    },
    "hacd": {
      "resolution": 15,
      "detail": 0.5,
      "maxParts": 13,
      "inflate": 0.026
    },
    "acd": {
      "resolution": 19,
      "detail": 0.15,
      "maxParts": 19,
      "inflate": 0.049
    },
    "quickhull": {
      "tighten": 0.68,
      "inflate": 0.015
    },
    "incremental-hull": {
      "tighten": 0.08,
      "inflate": 0.022
    },
    "mvbb": {
      "sampleCount": 34,
      "inflate": 0
    },
    "k-dop": {
      "directionCount": 18,
      "maxParts": 6,
      "inflate": 0.005
    },
    "sphere-ritter": {
      "maxParts": 1,
      "inflate": 0.025
    },
    "sphere-ls": {
      "maxParts": 9,
      "inflate": 0.008
    },
    "capsule-fit": {
      "segments": 4,
      "inflate": 0.027
    },
    "cylinder-fit": {
      "segments": 4,
      "radialSamples": 6,
      "inflate": 0.006
    },
    "multi-sphere": {
      "sphereCount": 1,
      "inflate": 0.025
    },
    "kmeans-seg": {
      "clusterCount": 12,
      "maxParts": 17,
      "inflate": 0.035
    },
    "spectral-seg": {
      "clusterCount": 8,
      "maxParts": 7,
      "inflate": 0.027
    },
    "region-grow": {
      "clusterCount": 12,
      "maxParts": 12,
      "inflate": 0.025
    },
    "bsp": {
      "maxDepth": 7,
      "minPoints": 300,
      "maxParts": 15,
      "inflate": 0
    },
    "sdf-convex": {
      "resolution": 29,
      "smoothPasses": 1,
      "maxParts": 6,
      "inflate": 0.035
    },
    "qem-decimate": {
      "targetRatio": 0.58,
      "maxParts": 20,
      "inflate": 0.036
    },
    "edge-collapse": {
      "targetRatio": 0.49,
      "maxParts": 9,
      "inflate": 0.044
    }
  },
  "mainframe-with-many-distinct-status-lights": {
    "aabb": {
      "inflate": 0.001
    },
    "obb-pca": {
      "inflate": 0
    },
    "layered-y": {
      "layerCount": 12,
      "minPointsPerLayer": 295,
      "mergeSimilarity": 0.05,
      "inflate": 0.003
    },
    "layered-x": {
      "layerCount": 4,
      "minPointsPerLayer": 20,
      "mergeSimilarity": 0.24,
      "inflate": 0.001
    },
    "layered-z": {
      "layerCount": 3,
      "minPointsPerLayer": 20,
      "mergeSimilarity": 0.6,
      "inflate": 0.001
    },
    "voxel-greedy": {
      "resolution": 16,
      "maxParts": 8,
      "inflate": 0
    },
    "split-fit": {
      "maxDepth": 5,
      "maxParts": 8,
      "minGain": 0.11,
      "inflate": 0.003
    },
    "support-columns": {
      "resolution": 21,
      "baseLayers": 3,
      "topCoverageThreshold": 0.54,
      "maxParts": 8,
      "inflate": 0.001
    },
    "convex": {
      "targetParts": 2,
      "maxSamplePoints": 1610,
      "maxHullPoints": 209,
      "minClusterPoints": 76,
      "inflate": 0.003
    },
    "boxy-furniture": {
      "mode": 1,
      "budget": 0,
      "maxParts": 19,
      "inflate": 0.001
    },
    "concave-furniture": {
      "mode": 1,
      "budget": 0,
      "maxParts": 13,
      "inflate": 0.01
    },
    "coacd": {
      "resolution": 20,
      "detail": 0.79,
      "maxParts": 6,
      "inflate": 0.015
    },
    "v-hacd": {
      "resolution": 40,
      "detail": 0.1,
      "maxParts": 16,
      "inflate": 0.001
    },
    "hacd": {
      "resolution": 14,
      "detail": 1,
      "maxParts": 6,
      "inflate": 0.012
    },
    "acd": {
      "resolution": 24,
      "detail": 0.98,
      "maxParts": 11,
      "inflate": 0
    },
    "quickhull": {
      "tighten": 0.68,
      "inflate": 0
    },
    "incremental-hull": {
      "tighten": 0.42,
      "inflate": 0.003
    },
    "mvbb": {
      "sampleCount": 58,
      "inflate": 0
    },
    "k-dop": {
      "directionCount": 23,
      "maxParts": 15,
      "inflate": 0.003
    },
    "sphere-ritter": {
      "maxParts": 1,
      "inflate": 0
    },
    "sphere-ls": {
      "maxParts": 7,
      "inflate": 0.041
    },
    "capsule-fit": {
      "segments": 5,
      "inflate": 0.003
    },
    "cylinder-fit": {
      "segments": 5,
      "radialSamples": 6,
      "inflate": 0.023
    },
    "multi-sphere": {
      "sphereCount": 1,
      "inflate": 0
    },
    "kmeans-seg": {
      "clusterCount": 11,
      "maxParts": 19,
      "inflate": 0.007
    },
    "spectral-seg": {
      "clusterCount": 6,
      "maxParts": 10,
      "inflate": 0.003
    },
    "region-grow": {
      "clusterCount": 2,
      "maxParts": 10,
      "inflate": 0.004
    },
    "bsp": {
      "maxDepth": 2,
      "minPoints": 200,
      "maxParts": 7,
      "inflate": 0.001
    },
    "sdf-convex": {
      "resolution": 16,
      "smoothPasses": 3,
      "maxParts": 6,
      "inflate": 0
    },
    "qem-decimate": {
      "targetRatio": 1,
      "maxParts": 3,
      "inflate": 0.001
    },
    "edge-collapse": {
      "targetRatio": 1,
      "maxParts": 3,
      "inflate": 0.001
    }
  },
  "microscope": {
    "aabb": {
      "inflate": 0.001
    },
    "obb-pca": {
      "inflate": 0
    },
    "layered-y": {
      "layerCount": 7,
      "minPointsPerLayer": 130,
      "mergeSimilarity": 0.01,
      "inflate": 0.028
    },
    "layered-x": {
      "layerCount": 8,
      "minPointsPerLayer": 30,
      "mergeSimilarity": 0.6,
      "inflate": 0
    },
    "layered-z": {
      "layerCount": 5,
      "minPointsPerLayer": 20,
      "mergeSimilarity": 0,
      "inflate": 0.022
    },
    "voxel-greedy": {
      "resolution": 13,
      "maxParts": 5,
      "inflate": 0.003
    },
    "split-fit": {
      "maxDepth": 3,
      "maxParts": 6,
      "minGain": 0.08,
      "inflate": 0.03
    },
    "support-columns": {
      "resolution": 21,
      "baseLayers": 8,
      "topCoverageThreshold": 0.43,
      "maxParts": 3,
      "inflate": 0.023
    },
    "convex": {
      "targetParts": 7,
      "maxSamplePoints": 1260,
      "maxHullPoints": 85,
      "minClusterPoints": 42,
      "inflate": 0.032
    },
    "boxy-furniture": {
      "mode": 0,
      "budget": 1,
      "maxParts": 5,
      "inflate": 0
    },
    "concave-furniture": {
      "mode": 1,
      "budget": 0,
      "maxParts": 13,
      "inflate": 0.032
    },
    "coacd": {
      "resolution": 20,
      "detail": 0.27,
      "maxParts": 14,
      "inflate": 0.04
    },
    "v-hacd": {
      "resolution": 21,
      "detail": 0.3,
      "maxParts": 8,
      "inflate": 0.025
    },
    "hacd": {
      "resolution": 16,
      "detail": 0.4,
      "maxParts": 12,
      "inflate": 0.047
    },
    "acd": {
      "resolution": 26,
      "detail": 0.14,
      "maxParts": 4,
      "inflate": 0.019
    },
    "quickhull": {
      "tighten": 0.7,
      "inflate": 0.014
    },
    "incremental-hull": {
      "tighten": 0.44,
      "inflate": 0
    },
    "mvbb": {
      "sampleCount": 12,
      "inflate": 0.001
    },
    "k-dop": {
      "directionCount": 26,
      "maxParts": 20,
      "inflate": 0.029
    },
    "sphere-ritter": {
      "maxParts": 1,
      "inflate": 0
    },
    "sphere-ls": {
      "maxParts": 6,
      "inflate": 0.02
    },
    "capsule-fit": {
      "segments": 6,
      "inflate": 0.029
    },
    "cylinder-fit": {
      "segments": 6,
      "radialSamples": 6,
      "inflate": 0.029
    },
    "multi-sphere": {
      "sphereCount": 1,
      "inflate": 0
    },
    "kmeans-seg": {
      "clusterCount": 2,
      "maxParts": 4,
      "inflate": 0.024
    },
    "spectral-seg": {
      "clusterCount": 6,
      "maxParts": 10,
      "inflate": 0.003
    },
    "region-grow": {
      "clusterCount": 2,
      "maxParts": 19,
      "inflate": 0
    },
    "bsp": {
      "maxDepth": 4,
      "minPoints": 314,
      "maxParts": 7,
      "inflate": 0.014
    },
    "sdf-convex": {
      "resolution": 16,
      "smoothPasses": 3,
      "maxParts": 21,
      "inflate": 0
    },
    "qem-decimate": {
      "targetRatio": 0.06,
      "maxParts": 4,
      "inflate": 0.019
    },
    "edge-collapse": {
      "targetRatio": 0.05,
      "maxParts": 12,
      "inflate": 0.034
    }
  },
  "professional-workbench-chair": {
    "aabb": {
      "inflate": 0
    },
    "obb-pca": {
      "inflate": 0
    },
    "layered-y": {
      "layerCount": 12,
      "minPointsPerLayer": 160,
      "mergeSimilarity": 0.3,
      "inflate": 0
    },
    "layered-x": {
      "layerCount": 11,
      "minPointsPerLayer": 290,
      "mergeSimilarity": 0.03,
      "inflate": 0.02
    },
    "layered-z": {
      "layerCount": 12,
      "minPointsPerLayer": 20,
      "mergeSimilarity": 0.14,
      "inflate": 0.017
    },
    "voxel-greedy": {
      "resolution": 18,
      "maxParts": 9,
      "inflate": 0
    },
    "split-fit": {
      "maxDepth": 4,
      "maxParts": 9,
      "minGain": 0.08,
      "inflate": 0.017
    },
    "support-columns": {
      "resolution": 14,
      "baseLayers": 7,
      "topCoverageThreshold": 0.6,
      "maxParts": 6,
      "inflate": 0
    },
    "convex": {
      "targetParts": 5,
      "maxSamplePoints": 2760,
      "maxHullPoints": 323,
      "minClusterPoints": 76,
      "inflate": 0.003
    },
    "boxy-furniture": {
      "mode": 1,
      "budget": 0,
      "maxParts": 1,
      "inflate": 0
    },
    "concave-furniture": {
      "mode": 0,
      "budget": 1,
      "maxParts": 19,
      "inflate": 0
    },
    "coacd": {
      "resolution": 36,
      "detail": 0.26,
      "maxParts": 7,
      "inflate": 0.025
    },
    "v-hacd": {
      "resolution": 25,
      "detail": 0.1,
      "maxParts": 20,
      "inflate": 0.001
    },
    "hacd": {
      "resolution": 14,
      "detail": 0.46,
      "maxParts": 6,
      "inflate": 0.004
    },
    "acd": {
      "resolution": 20,
      "detail": 0.48,
      "maxParts": 12,
      "inflate": 0.003
    },
    "quickhull": {
      "tighten": 0.54,
      "inflate": 0.004
    },
    "incremental-hull": {
      "tighten": 0.63,
      "inflate": 0.004
    },
    "mvbb": {
      "sampleCount": 64,
      "inflate": 0
    },
    "k-dop": {
      "directionCount": 6,
      "maxParts": 11,
      "inflate": 0
    },
    "sphere-ritter": {
      "maxParts": 1,
      "inflate": 0.017
    },
    "sphere-ls": {
      "maxParts": 2,
      "inflate": 0
    },
    "capsule-fit": {
      "segments": 3,
      "inflate": 0
    },
    "cylinder-fit": {
      "segments": 2,
      "radialSamples": 21,
      "inflate": 0
    },
    "multi-sphere": {
      "sphereCount": 1,
      "inflate": 0.017
    },
    "kmeans-seg": {
      "clusterCount": 13,
      "maxParts": 19,
      "inflate": 0.027
    },
    "spectral-seg": {
      "clusterCount": 6,
      "maxParts": 10,
      "inflate": 0.003
    },
    "region-grow": {
      "clusterCount": 9,
      "maxParts": 11,
      "inflate": 0.043
    },
    "bsp": {
      "maxDepth": 3,
      "minPoints": 314,
      "maxParts": 13,
      "inflate": 0.024
    },
    "sdf-convex": {
      "resolution": 36,
      "smoothPasses": 4,
      "maxParts": 21,
      "inflate": 0.028
    },
    "qem-decimate": {
      "targetRatio": 0.48,
      "maxParts": 20,
      "inflate": 0.045
    },
    "edge-collapse": {
      "targetRatio": 0.05,
      "maxParts": 13,
      "inflate": 0.001
    }
  },
  "tall-standing-lamp": {
    "aabb": {
      "inflate": 0
    },
    "obb-pca": {
      "inflate": 0
    },
    "layered-y": {
      "layerCount": 12,
      "minPointsPerLayer": 20,
      "mergeSimilarity": 0.3,
      "inflate": 0
    },
    "layered-x": {
      "layerCount": 10,
      "minPointsPerLayer": 20,
      "mergeSimilarity": 0.07,
      "inflate": 0
    },
    "layered-z": {
      "layerCount": 10,
      "minPointsPerLayer": 25,
      "mergeSimilarity": 0.3,
      "inflate": 0
    },
    "voxel-greedy": {
      "resolution": 25,
      "maxParts": 6,
      "inflate": 0
    },
    "split-fit": {
      "maxDepth": 4,
      "maxParts": 24,
      "minGain": 0.09,
      "inflate": 0
    },
    "support-columns": {
      "resolution": 30,
      "baseLayers": 7,
      "topCoverageThreshold": 0.33,
      "maxParts": 5,
      "inflate": 0
    },
    "convex": {
      "targetParts": 8,
      "maxSamplePoints": 2960,
      "maxHullPoints": 317,
      "minClusterPoints": 48,
      "inflate": 0.048
    },
    "boxy-furniture": {
      "mode": 0,
      "budget": 1,
      "maxParts": 13,
      "inflate": 0
    },
    "concave-furniture": {
      "mode": 1,
      "budget": 1,
      "maxParts": 4,
      "inflate": 0
    },
    "coacd": {
      "resolution": 36,
      "detail": 0.1,
      "maxParts": 6,
      "inflate": 0
    },
    "v-hacd": {
      "resolution": 20,
      "detail": 0.1,
      "maxParts": 8,
      "inflate": 0
    },
    "hacd": {
      "resolution": 34,
      "detail": 0.41,
      "maxParts": 14,
      "inflate": 0
    },
    "acd": {
      "resolution": 32,
      "detail": 1,
      "maxParts": 4,
      "inflate": 0
    },
    "quickhull": {
      "tighten": 0.11,
      "inflate": 0
    },
    "incremental-hull": {
      "tighten": 0.05,
      "inflate": 0.014
    },
    "mvbb": {
      "sampleCount": 27,
      "inflate": 0
    },
    "k-dop": {
      "directionCount": 15,
      "maxParts": 10,
      "inflate": 0
    },
    "sphere-ritter": {
      "maxParts": 7,
      "inflate": 0
    },
    "sphere-ls": {
      "maxParts": 6,
      "inflate": 0.045
    },
    "capsule-fit": {
      "segments": 7,
      "inflate": 0
    },
    "cylinder-fit": {
      "segments": 7,
      "radialSamples": 6,
      "inflate": 0
    },
    "multi-sphere": {
      "sphereCount": 7,
      "inflate": 0
    },
    "kmeans-seg": {
      "clusterCount": 6,
      "maxParts": 10,
      "inflate": 0
    },
    "spectral-seg": {
      "clusterCount": 8,
      "maxParts": 19,
      "inflate": 0
    },
    "region-grow": {
      "clusterCount": 12,
      "maxParts": 19,
      "inflate": 0.026
    },
    "bsp": {
      "maxDepth": 3,
      "minPoints": 314,
      "maxParts": 17,
      "inflate": 0.039
    },
    "sdf-convex": {
      "resolution": 28,
      "smoothPasses": 1,
      "maxParts": 16,
      "inflate": 0.03
    },
    "qem-decimate": {
      "targetRatio": 0.23,
      "maxParts": 11,
      "inflate": 0
    },
    "edge-collapse": {
      "targetRatio": 0.05,
      "maxParts": 16,
      "inflate": 0
    }
  }
};
