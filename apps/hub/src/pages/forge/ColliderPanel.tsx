import { useCallback, useEffect, useRef, useState } from "react";
import type { ViewportHandle } from "./Viewport";
import type { ColliderParams } from "./processing/colliders";
import {
  buildSimplifiedColliderScene,
  DEFAULT_COLLIDER_FACE_TARGET,
  type AutoColliderStrategy,
  type ColliderAutoRecommendation,
  type ColliderVariantsSpec,
  type CompoundColliderSpec
} from "./processing/collider-mesh";
import {
  createColliderVariantsPreview,
  type ColliderPreviewMode
} from "./processing/collider-variants-preview";

interface Props {
  viewport: ViewportHandle | null;
  onColliderChange: (params: ColliderParams) => void;
  currentCollider?: ColliderParams | null;
  hideTitle?: boolean;
  refitTrigger?: number;
}

type EditableColliderMode = Exclude<ColliderPreviewMode, "all">;

const DEFAULT_COLLIDER_MODE: EditableColliderMode = "compound-boxes";
const DEFAULT_COLLIDER_SCALE = 1;
const DEFAULT_AUTO_COLLIDER_STRATEGY: AutoColliderStrategy = "concave-furniture";

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function mapCompoundParts(parts: CompoundColliderSpec["parts"]): Array<{
  position: [number, number, number];
  halfExtents: [number, number, number];
}> {
  return parts.map((part) => ({
    position: [part.position[0], part.position[1], part.position[2]],
    halfExtents: [part.halfExtents[0], part.halfExtents[1], part.halfExtents[2]]
  }));
}

function scaleCompoundSpec(
  compound: ColliderVariantsSpec["compoundBoxes"],
  scale: number
): ColliderVariantsSpec["compoundBoxes"] {
  if (compound.parts.length === 0 || scale === 1) {
    return {
      ...compound,
      parts: compound.parts.map((part) => ({
        ...part,
        position: [...part.position] as [number, number, number],
        halfExtents: [...part.halfExtents] as [number, number, number]
      }))
    };
  }

  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let minZ = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  let maxZ = Number.NEGATIVE_INFINITY;

  for (const part of compound.parts) {
    minX = Math.min(minX, part.position[0] - part.halfExtents[0]);
    minY = Math.min(minY, part.position[1] - part.halfExtents[1]);
    minZ = Math.min(minZ, part.position[2] - part.halfExtents[2]);
    maxX = Math.max(maxX, part.position[0] + part.halfExtents[0]);
    maxY = Math.max(maxY, part.position[1] + part.halfExtents[1]);
    maxZ = Math.max(maxZ, part.position[2] + part.halfExtents[2]);
  }

  const centerX = (minX + maxX) * 0.5;
  const centerY = (minY + maxY) * 0.5;
  const centerZ = (minZ + maxZ) * 0.5;

  return {
    ...compound,
    parts: compound.parts.map((part) => {
      const dx = part.position[0] - centerX;
      const dy = part.position[1] - centerY;
      const dz = part.position[2] - centerZ;
      return {
        ...part,
        position: [
          centerX + dx * scale,
          centerY + dy * scale,
          centerZ + dz * scale
        ],
        halfExtents: [
          part.halfExtents[0] * scale,
          part.halfExtents[1] * scale,
          part.halfExtents[2] * scale
        ]
      };
    })
  };
}

function scaleVariants(
  variants: ColliderVariantsSpec,
  scale: number
): ColliderVariantsSpec {
  const clampedScale = Math.max(0.01, scale);
  return {
    box: {
      ...variants.box,
      halfExtents: [
        variants.box.halfExtents[0] * clampedScale,
        variants.box.halfExtents[1] * clampedScale,
        variants.box.halfExtents[2] * clampedScale
      ]
    },
    pill: {
      ...variants.pill,
      radius: variants.pill.radius * clampedScale,
      halfHeight: variants.pill.halfHeight * clampedScale
    },
    sphere: {
      ...variants.sphere,
      radius: variants.sphere.radius * clampedScale
    },
    cylinder: {
      ...variants.cylinder,
      radius: variants.cylinder.radius * clampedScale,
      halfHeight: variants.cylinder.halfHeight * clampedScale
    },
    convexHull: {
      ...variants.convexHull,
      points: variants.convexHull.points.map((point) => [
        point[0] * clampedScale,
        point[1] * clampedScale,
        point[2] * clampedScale
      ])
    },
    compoundBoxes: scaleCompoundSpec(variants.compoundBoxes, clampedScale)
  };
}

function toColliderParams(
  variants: ColliderVariantsSpec,
  mode: EditableColliderMode
): ColliderParams {
  switch (mode) {
    case "box":
      return {
        type: "box",
        position: [
          variants.box.position[0],
          variants.box.position[1],
          variants.box.position[2]
        ],
        params: {
          halfWidth: variants.box.halfExtents[0],
          halfHeight: variants.box.halfExtents[1],
          halfDepth: variants.box.halfExtents[2]
        }
      };
    case "pill":
      return {
        type: "pill",
        position: [
          variants.pill.position[0],
          variants.pill.position[1],
          variants.pill.position[2]
        ],
        params: {
          axis: variants.pill.axis,
          radius: variants.pill.radius,
          halfHeight: variants.pill.halfHeight
        }
      };
    case "sphere":
      return {
        type: "sphere",
        position: [
          variants.sphere.position[0],
          variants.sphere.position[1],
          variants.sphere.position[2]
        ],
        params: {
          radius: variants.sphere.radius
        }
      };
    case "cylinder":
      return {
        type: "cylinder",
        position: [
          variants.cylinder.position[0],
          variants.cylinder.position[1],
          variants.cylinder.position[2]
        ],
        params: {
          axis: variants.cylinder.axis,
          radius: variants.cylinder.radius,
          halfHeight: variants.cylinder.halfHeight
        }
      };
    case "convex-hull":
      return {
        type: "convex-hull",
        position: [0, 0, 0],
        params: {
          points: variants.convexHull.points,
          rootOffset: variants.convexHull.rootOffset
        }
      };
    case "compound-boxes":
      return {
        type: "compound-boxes",
        position: [0, 0, 0],
        params: {
          parts: mapCompoundParts(variants.compoundBoxes.parts)
        }
      };
  }
}

export function ColliderPanel({
  viewport,
  onColliderChange,
  currentCollider,
  hideTitle,
  refitTrigger
}: Props) {
  const viewportRef = useRef<ViewportHandle | null>(viewport);
  const onColliderChangeRef = useRef(onColliderChange);
  const [colliderMode, setColliderMode] = useState<EditableColliderMode>(
    DEFAULT_COLLIDER_MODE
  );
  const [colliderScale, setColliderScale] = useState(DEFAULT_COLLIDER_SCALE);
  const [variants, setVariants] = useState<ColliderVariantsSpec | null>(null);
  const [autoRecommendation, setAutoRecommendation] =
    useState<ColliderAutoRecommendation | null>(null);
  const [autoStrategy, setAutoStrategy] = useState<AutoColliderStrategy>(
    DEFAULT_AUTO_COLLIDER_STRATEGY
  );
  const [autoSummary, setAutoSummary] = useState<{
    strategy: AutoColliderStrategy;
    outsideRatio: number;
  } | null>(null);
  const [building, setBuilding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestTokenRef = useRef(0);
  const hasViewport = viewport !== null;

  useEffect(() => {
    viewportRef.current = viewport;
  }, [viewport]);

  useEffect(() => {
    onColliderChangeRef.current = onColliderChange;
  }, [onColliderChange]);

  const currentColliderType = currentCollider?.type ?? null;

  useEffect(() => {
    if (!currentColliderType) {
      return;
    }

    const nextMode: EditableColliderMode =
      currentColliderType === "capsule"
        ? "pill"
        : currentColliderType === "box" ||
            currentColliderType === "pill" ||
            currentColliderType === "sphere" ||
            currentColliderType === "cylinder" ||
            currentColliderType === "convex-hull" ||
            currentColliderType === "compound-boxes"
          ? currentColliderType
          : DEFAULT_COLLIDER_MODE;
    setColliderMode(nextMode);
  }, [currentColliderType]);

  const rebuildVariants = useCallback(async () => {
    const currentViewport = viewportRef.current;
    if (!currentViewport) {
      setVariants(null);
      setError(null);
      setAutoRecommendation(null);
      setAutoSummary(null);
      return;
    }
    const model = currentViewport.getModel();
    if (!model) {
      setVariants(null);
      setError(null);
      setAutoRecommendation(null);
      setAutoSummary(null);
      currentViewport.setColliderPreviewObject(null);
      return;
    }

    const token = ++requestTokenRef.current;
    setBuilding(true);
    setError(null);

    try {
      const result = await buildSimplifiedColliderScene(
        model,
        DEFAULT_COLLIDER_FACE_TARGET,
        autoStrategy
      );
      if (requestTokenRef.current !== token) {
        return;
      }

      setVariants(result.colliderVariants);
      setAutoRecommendation(result.autoRecommendation);
      setAutoSummary({
        strategy: result.autoSummary.strategy,
        outsideRatio: result.autoSummary.outsideRatio
      });
    } catch (err) {
      if (requestTokenRef.current !== token) {
        return;
      }
      setVariants(null);
      setAutoRecommendation(null);
      setAutoSummary(null);
      setError(err instanceof Error ? err.message : "Collider build failed.");
      currentViewport.setColliderPreviewObject(null);
    } finally {
      if (requestTokenRef.current === token) {
        setBuilding(false);
      }
    }
  }, [autoStrategy]);

  useEffect(() => {
    if (!hasViewport) {
      setVariants(null);
      setError(null);
      setAutoRecommendation(null);
      setAutoSummary(null);
      return;
    }
    void rebuildVariants();
  }, [hasViewport, rebuildVariants, refitTrigger]);

  useEffect(() => {
    const currentViewport = viewportRef.current;
    if (!currentViewport) {
      return;
    }
    if (!variants) {
      currentViewport.setColliderPreviewObject(null);
      return;
    }

    const scaled = scaleVariants(variants, colliderScale);
    const helper = createColliderVariantsPreview(scaled, colliderMode);
    currentViewport.setColliderPreviewObject(helper);
    onColliderChangeRef.current(toColliderParams(scaled, colliderMode));
  }, [variants, colliderMode, colliderScale]);

  useEffect(() => {
    return () => {
      viewportRef.current?.setColliderPreviewObject(null);
    };
  }, []);

  const summary = variants
    ? {
        boxSize: `${(variants.box.halfExtents[0] * 2).toFixed(3)} x ${(variants.box.halfExtents[1] * 2).toFixed(3)} x ${(variants.box.halfExtents[2] * 2).toFixed(3)}m`,
        pillRadius: variants.pill.radius,
        sphereRadius: variants.sphere.radius,
        hullPoints: variants.convexHull.points.length,
        compoundParts: variants.compoundBoxes.parts.length
      }
    : null;

  return (
    <div className="forge-panel" data-testid="forge-collider">
      {!hideTitle && <h3>Collider Variants</h3>}

      <div className="forge-field">
        <label>Collider Type</label>
        <select
          value={colliderMode}
          onChange={(event) =>
            setColliderMode(event.target.value as EditableColliderMode)
          }
          data-testid="collider-type"
        >
          <option value="box">Box</option>
          <option value="pill">Pill</option>
          <option value="sphere">Sphere</option>
          <option value="cylinder">Cylinder</option>
          <option value="convex-hull">Convex Hull</option>
          <option value="compound-boxes">Compound Boxes</option>
        </select>
      </div>

      <div className="forge-field">
        <label>Auto Collider Strategy</label>
        <select
          value={autoStrategy}
          onChange={(event) => {
            setAutoStrategy(event.target.value as AutoColliderStrategy);
          }}
          data-testid="auto-collider-strategy"
        >
          <option value="concave-furniture">Concave Furniture</option>
          <option value="boxy-furniture">Boxy Furniture</option>
        </select>
      </div>

      <div className="forge-field">
        <label>Collider Scale: {colliderScale.toFixed(2)}x</label>
        <input
          type="range"
          min={0.5}
          max={2}
          step={0.01}
          value={colliderScale}
          onChange={(event) => {
            const next = clamp(Number(event.target.value), 0.5, 2);
            setColliderScale(next);
          }}
          data-testid="collider-scale"
        />
        <input
          type="number"
          min={0.5}
          max={2}
          step={0.01}
          value={colliderScale.toFixed(2)}
          onChange={(event) => {
            const parsed = Number(event.target.value);
            if (!Number.isFinite(parsed)) {
              return;
            }
            setColliderScale(clamp(parsed, 0.5, 2));
          }}
        />
      </div>

      {building && (
        <div className="forge-muted" style={{ marginBottom: "0.5rem" }}>
          Building collider variants...
        </div>
      )}

      {summary && (
        <div className="forge-info">
          <div>Box: {summary.boxSize}</div>
          <div>
            Pill Radius: {summary.pillRadius.toFixed(3)}m | Sphere Radius: {summary.sphereRadius.toFixed(3)}m
          </div>
          <div>Convex Hull Points: {summary.hullPoints}</div>
          <div>Compound Parts: {summary.compoundParts}</div>
        </div>
      )}

      {autoSummary && (
        <div className="forge-info">
          <div>Strategy: {autoSummary.strategy}</div>
          <div>Auto Surface Miss Ratio: {(autoSummary.outsideRatio * 100).toFixed(1)}%</div>
        </div>
      )}

      {autoRecommendation && autoRecommendation !== colliderMode && (
        <button
          className="forge-btn"
          onClick={() =>
            setColliderMode(autoRecommendation as EditableColliderMode)
          }
        >
          Apply Auto Collider ({autoRecommendation})
        </button>
      )}

      <div className="forge-info">
        Sphere and pill are auto-fit to fully contain the mesh bounds by default.
      </div>

      {!variants && !building && !error && (
        <div className="forge-muted">No model loaded.</div>
      )}

      {error && <div className="forge-error">{error}</div>}
    </div>
  );
}
