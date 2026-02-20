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
  "support-columns"
] as const;

export type StrategyId = (typeof STRATEGY_IDS)[number];

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

export type StrategyParamsById = {
  "aabb": AabbParams;
  "obb-pca": ObbPcaParams;
  "layered-y": LayeredYParams;
  "layered-x": LayeredXParams;
  "layered-z": LayeredZParams;
  "voxel-greedy": VoxelGreedyParams;
  "split-fit": SplitFitParams;
  "support-columns": SupportColumnsParams;
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
  underfill: number;
  overfill: number;
  thinPenalty: number;
  partPenalty: number;
  flatBaseBonus: number;
};

export type QualityBreakdown = {
  underfill: number;
  overfill: number;
  thinPenalty: number;
  partPenalty: number;
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
