import * as THREE from "three";

export type Vector3Tuple = [number, number, number];

export type ColliderMode = "dynamic" | "static";
export type ColliderBudget = "strict" | "balanced";

export type ColliderClass =
  | "Primitive"
  | "SingleConvex"
  | "BoxyFurniture"
  | "Layered"
  | "ConcaveFurniture"
  | "HardNoisy";

export type ColliderStrategyKind =
  | "primitive"
  | "single-convex"
  | "boxy-furniture"
  | "concave-furniture"
  | "hard-noisy";

export type ColliderAxis = "x" | "y" | "z";

export type RapierBallCollider = {
  type: "ball";
  center: Vector3Tuple;
  radius: number;
};

export type RapierCapsuleCollider = {
  type: "capsule";
  center: Vector3Tuple;
  axis: ColliderAxis;
  radius: number;
  halfHeight: number;
};

export type RapierConvexCollider = {
  type: "convex";
  points: Vector3Tuple[];
  rootOffset: Vector3Tuple;
};

export type RapierCompoundPart = {
  kind: "box";
  position: Vector3Tuple;
  halfExtents: Vector3Tuple;
};

export type RapierCompoundCollider = {
  type: "compound";
  parts: RapierCompoundPart[];
};

export type RapierTrimeshCollider = {
  type: "trimesh";
  vertices: Float32Array;
  indices: Uint32Array;
};

export type RapierColliderDescription =
  | RapierBallCollider
  | RapierCapsuleCollider
  | RapierConvexCollider
  | RapierCompoundCollider
  | RapierTrimeshCollider;

export type ColliderMetrics = {
  diagonal: number;
  dims: Vector3Tuple;
  slenderness: number;
  flatness: number;
  planarity: number;
  concavityProxy: number;
  layerScore: number;
  cavityScore: number;
  noiseScore: number;
  occupiedRatio: number;
};

export type ColliderClassScore = {
  kind: ColliderClass;
  score: number;
};

export type ColliderClassification = {
  selected: ColliderClass;
  confidence: number;
  scores: ColliderClassScore[];
  lowConfidenceFallback: boolean;
  strategyOrder: ColliderStrategyKind[];
};

export type ColliderErrorMetrics = {
  sampledPoints: number;
  outsideRatio: number;
  meanOutsideDistance: number;
  overfillRatio: number;
};

export type ColliderDebug = {
  three: THREE.Object3D;
};

export type ColliderQuality = {
  selectedStrategy: ColliderStrategyKind;
  attemptedStrategies: ColliderStrategyKind[];
  classification: ColliderClassification;
  error: ColliderErrorMetrics;
  passThreshold: number;
  partCount: number;
  signature: string;
};

export type ColliderResult = {
  rapier: RapierColliderDescription;
  metrics: ColliderMetrics;
  quality: ColliderQuality;
  debug?: ColliderDebug;
};

export type GenerateColliderOptions = {
  mode?: ColliderMode;
  budget?: ColliderBudget;
  allowStaticTrimeshFallback?: boolean;
  debug?: boolean;
};

export type PreparedTriangle = {
  a: THREE.Vector3;
  b: THREE.Vector3;
  c: THREE.Vector3;
  normal: THREE.Vector3;
  area: number;
};

export type PcaFrame = {
  origin: THREE.Vector3;
  axes: [THREE.Vector3, THREE.Vector3, THREE.Vector3];
  upAxis: 0 | 1 | 2;
};

export type PreparedGeometry = {
  points: THREE.Vector3[];
  triangles: PreparedTriangle[];
  samples: THREE.Vector3[];
  bounds: THREE.Box3;
  center: THREE.Vector3;
  size: THREE.Vector3;
  diagonal: number;
  pcaFrame: PcaFrame;
  pcaPoints: THREE.Vector3[];
  pcaBounds: THREE.Box3;
};

export type StrategyContext = {
  prepared: PreparedGeometry;
  metrics: ColliderMetrics;
  options: Required<GenerateColliderOptions>;
};

export type StrategyResult = {
  kind: ColliderStrategyKind;
  rapier: RapierColliderDescription;
};
