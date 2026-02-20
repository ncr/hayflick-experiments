export type Vec3Tuple = [number, number, number];
export type QuatTuple = [number, number, number, number];

export type BoundingBox = {
  min: Vec3Tuple;
  max: Vec3Tuple;
  size: Vec3Tuple;
  center: Vec3Tuple;
  volume: number;
};

export type SampleTriangle = {
  a: Vec3Tuple;
  b: Vec3Tuple;
  c: Vec3Tuple;
  normal: Vec3Tuple;
  centroid: Vec3Tuple;
  area: number;
};

export type NormalizationTransform = {
  offset: Vec3Tuple;
  scale: number;
};

export type NormalizedProp = {
  propId: string;
  sourceBounds: {
    width: number;
    height: number;
    depth: number;
    longestAxis: number;
  };
  transform: NormalizationTransform;
  bbox: BoundingBox;
  points: Vec3Tuple[];
  triangles: SampleTriangle[];
  triangleCount: number;
  pointCount: number;
  meshVolume: number;
  sampleSignature: string;
};

export type SizeClass = "small" | "medium" | "large";
export type ComplexityClass = "low" | "medium" | "high";
export type SlendernessClass = "chunky" | "slender" | "very-slender";
export type ConcavityClass = "low" | "medium" | "high";
export type FlatnessClass = "low" | "medium" | "high";

export type ClassificationMetrics = {
  width: number;
  height: number;
  depth: number;
  longestAxis: number;
  shortestAxis: number;
  bboxVolume: number;
  meshVolume: number;
  compactness: number;
  triangleCount: number;
  pointCount: number;
  slenderness: number;
  complexityNorm: number;
  concavityHint: number;
  baseContactRatio: number;
  baseUpwardRatio: number;
  flatnessScore: number;
  axisAnisotropy: number;
};

export type PropClassification = {
  labels: {
    size: SizeClass;
    complexity: ComplexityClass;
    slenderness: SlendernessClass;
    concavity: ConcavityClass;
    flatness: FlatnessClass;
  };
  metrics: ClassificationMetrics;
};

export type ColliderPart = {
  position: Vec3Tuple;
  halfExtents: Vec3Tuple;
  rotation: QuatTuple;
  volume: number;
};

export const STRATEGY_IDS = [
  "aabb",
  "obb-pca",
  "layered-y",
  "layered-x",
  "layered-z",
  "voxel-greedy",
  "split-fit",
  "support-columns",
  "convex",
  "boxy-furniture",
  "concave-furniture",
  "coacd",
  "v-hacd",
  "hacd",
  "acd",
  "quickhull",
  "incremental-hull",
  "mvbb",
  "k-dop",
  "sphere-ritter",
  "sphere-ls",
  "capsule-fit",
  "cylinder-fit",
  "multi-sphere",
  "kmeans-seg",
  "spectral-seg",
  "region-grow",
  "bsp",
  "concavity-split",
  "sdf-convex",
  "qem-decimate",
  "edge-collapse"
] as const;

export type StrategyId = (typeof STRATEGY_IDS)[number];

export const ACTIVE_STRATEGY_IDS = [
  "concave-furniture",
  "concavity-split",
  "cylinder-fit",
  "qem-decimate",
  "kmeans-seg",
  "capsule-fit",
  "hacd",
  "boxy-furniture",
  "spectral-seg",
  "layered-y",
  "k-dop"
] as const satisfies readonly StrategyId[];

export type ActiveStrategyId = (typeof ACTIVE_STRATEGY_IDS)[number];

export type AabbParams = {
  inflate: number;
};

export type ObbPcaParams = {
  inflate: number;
};

export type LayeredYParams = {
  layerCount: number;
  minPointsPerLayer: number;
  mergeSimilarity: number;
  inflate: number;
};

export type LayeredXParams = LayeredYParams;
export type LayeredZParams = LayeredYParams;

export type VoxelGreedyParams = {
  resolution: number;
  maxParts: number;
  inflate: number;
};

export type SplitFitParams = {
  maxDepth: number;
  maxParts: number;
  minGain: number;
  inflate: number;
};

export type SupportColumnsParams = {
  resolution: number;
  baseLayers: number;
  topCoverageThreshold: number;
  maxParts: number;
  inflate: number;
};

export type LegacyConvexParams = {
  targetParts: number;
  maxSamplePoints: number;
  maxHullPoints: number;
  minClusterPoints: number;
  inflate: number;
};

export type LegacyFurnitureParams = {
  mode: number;
  budget: number;
  maxParts: number;
  inflate: number;
};

export type DecompositionParams = {
  resolution: number;
  detail: number;
  maxParts: number;
  inflate: number;
};

export type HullParams = {
  tighten: number;
  inflate: number;
};

export type MvbbParams = {
  sampleCount: number;
  inflate: number;
};

export type KDopParams = {
  directionCount: number;
  maxParts: number;
  inflate: number;
};

export type SphereFitParams = {
  maxParts: number;
  inflate: number;
};

export type CapsuleFitParams = {
  segments: number;
  inflate: number;
};

export type CylinderFitParams = {
  segments: number;
  radialSamples: number;
  inflate: number;
};

export type MultiSphereParams = {
  sphereCount: number;
  inflate: number;
};

export type SegmentationParams = {
  clusterCount: number;
  maxParts: number;
  inflate: number;
};

export type BspParams = {
  maxDepth: number;
  minPoints: number;
  maxParts: number;
  inflate: number;
};

export type ConcavitySplitParams = {
  resolution: number;
  maxParts: number;
  maxDepth: number;
  minLeafVoxels: number;
  splitCandidates: number;
  concavityThreshold: number;
  minConcavityGain: number;
  complexityPenalty: number;
  inflate: number;
};

export type SdfConvexParams = {
  resolution: number;
  smoothPasses: number;
  maxParts: number;
  inflate: number;
};

export type DecimationParams = {
  targetRatio: number;
  maxParts: number;
  inflate: number;
};

export type StrategyParamsById = {
  "aabb": AabbParams;
  "obb-pca": ObbPcaParams;
  "layered-y": LayeredYParams;
  "layered-x": LayeredXParams;
  "layered-z": LayeredZParams;
  "voxel-greedy": VoxelGreedyParams;
  "split-fit": SplitFitParams;
  "support-columns": SupportColumnsParams;
  "convex": LegacyConvexParams;
  "boxy-furniture": LegacyFurnitureParams;
  "concave-furniture": LegacyFurnitureParams;
  "coacd": DecompositionParams;
  "v-hacd": DecompositionParams;
  "hacd": DecompositionParams;
  "acd": DecompositionParams;
  "quickhull": HullParams;
  "incremental-hull": HullParams;
  "mvbb": MvbbParams;
  "k-dop": KDopParams;
  "sphere-ritter": SphereFitParams;
  "sphere-ls": SphereFitParams;
  "capsule-fit": CapsuleFitParams;
  "cylinder-fit": CylinderFitParams;
  "multi-sphere": MultiSphereParams;
  "kmeans-seg": SegmentationParams;
  "spectral-seg": SegmentationParams;
  "region-grow": SegmentationParams;
  "bsp": BspParams;
  "concavity-split": ConcavitySplitParams;
  "sdf-convex": SdfConvexParams;
  "qem-decimate": DecimationParams;
  "edge-collapse": DecimationParams;
};

export type ParamFieldType = "float" | "int";

export type StrategyParamSpec = {
  key: string;
  label: string;
  min: number;
  max: number;
  step: number;
  type: ParamFieldType;
};

export type StrategyParamSpecsById = {
  [K in StrategyId]: StrategyParamSpec[];
};

export type QualityWeights = {
  meshCoveragePenalty: number;
  emptyVolumePenalty: number;
  selfOverlapPenalty: number;
  thinPenalty: number;
  partPenalty: number;
  baseOverreachPenalty: number;
  flatBaseBonus: number;
};

export type QualityBreakdown = {
  voxelIoU: number;
  overlapAgreement: number;
  underfill: number;
  overfill: number;
  meshOverlap: number;
  colliderOverlap: number;
  meshVolume: number;
  colliderUnionVolume: number;
  overlapVolume: number;
  colliderPartVolume: number;
  colliderSelfOverlap: number;
  thinPenalty: number;
  partPenalty: number;
  baseOverreachPenalty: number;
  flatBaseBonus: number;
  finalScore: number;
};

export type PredictionBreakdown = {
  suitability: number;
  cues: Record<string, number>;
};

export type StrategyResult = {
  strategyId: StrategyId;
  parts: ColliderPart[];
  quality: QualityBreakdown;
  predicted: PredictionBreakdown;
  actualRank: number;
  predictedRank: number;
  elapsedMs: number;
};

export type RankAgreement = {
  spearman: number;
  top1Match: boolean;
};

export type PipelineOutput = {
  classification: PropClassification;
  strategyResults: StrategyResult[];
  rankAgreement: RankAgreement;
};

export type StrategyGenerator<K extends StrategyId> = (
  prop: NormalizedProp,
  params: StrategyParamsById[K]
) => ColliderPart[];

export type VoxelGrid = {
  resolution: number;
  occupied: Uint8Array<ArrayBufferLike>;
  min: Vec3Tuple;
  size: Vec3Tuple;
};
