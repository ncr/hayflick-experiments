import { useCallback, useEffect, useRef, useState } from "react";
import type { ViewportHandle } from "./Viewport";
import type { ColliderParams } from "./processing/colliders";
import {
  buildSimplifiedColliderScene,
  DEFAULT_COLLIDER_FACE_TARGET,
  type ColliderVariantsSpec
} from "./processing/collider-mesh";
import {
  createColliderVariantsPreview,
  type ColliderPreviewMode
} from "./processing/collider-variants-preview";

interface Props {
  viewport: ViewportHandle | null;
  onColliderChange: (params: ColliderParams) => void;
  hideTitle?: boolean;
  refitTrigger?: number;
}

function toLegacyBoxColliderParams(
  variants: ColliderVariantsSpec
): ColliderParams {
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
}

export function ColliderPanel({
  viewport,
  onColliderChange,
  hideTitle,
  refitTrigger
}: Props) {
  const viewportRef = useRef<ViewportHandle | null>(viewport);
  const onColliderChangeRef = useRef(onColliderChange);
  const [previewMode, setPreviewMode] = useState<ColliderPreviewMode>("compound-boxes");
  const [variants, setVariants] = useState<ColliderVariantsSpec | null>(null);
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

  const rebuildVariants = useCallback(async () => {
    const currentViewport = viewportRef.current;
    if (!currentViewport) {
      setVariants(null);
      setError(null);
      return;
    }
    const model = currentViewport.getModel();
    if (!model) {
      setVariants(null);
      setError(null);
      currentViewport.setColliderPreviewObject(null);
      return;
    }

    const token = ++requestTokenRef.current;
    setBuilding(true);
    setError(null);

    try {
      const result = await buildSimplifiedColliderScene(
        model,
        DEFAULT_COLLIDER_FACE_TARGET
      );
      if (requestTokenRef.current !== token) {
        return;
      }

      setVariants(result.colliderVariants);
      onColliderChangeRef.current(toLegacyBoxColliderParams(result.colliderVariants));
    } catch (err) {
      if (requestTokenRef.current !== token) {
        return;
      }
      setVariants(null);
      setError(err instanceof Error ? err.message : "Collider build failed.");
      currentViewport.setColliderPreviewObject(null);
    } finally {
      if (requestTokenRef.current === token) {
        setBuilding(false);
      }
    }
  }, []);

  useEffect(() => {
    if (!hasViewport) {
      setVariants(null);
      setError(null);
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

    const helper = createColliderVariantsPreview(variants, previewMode);
    currentViewport.setColliderPreviewObject(helper);
  }, [previewMode, variants]);

  useEffect(() => {
    return () => {
      viewportRef.current?.setColliderPreviewObject(null);
    };
  }, []);

  const summary = variants
    ? {
        boxSize: `${(variants.box.halfExtents[0] * 2).toFixed(3)} x ${(variants.box.halfExtents[1] * 2).toFixed(3)} x ${(variants.box.halfExtents[2] * 2).toFixed(3)}m`,
        hullPoints: variants.convexHull.points.length,
        compoundParts: variants.compoundBoxes.parts.length
      }
    : null;

  return (
    <div className="forge-panel" data-testid="forge-collider">
      {!hideTitle && <h3>Collider Variants</h3>}

      <div className="forge-field">
        <label>Preview Mode</label>
        <select
          value={previewMode}
          onChange={(event) =>
            setPreviewMode(event.target.value as ColliderPreviewMode)
          }
          data-testid="collider-type"
        >
          <option value="box">Box</option>
          <option value="convex-hull">Convex Hull</option>
          <option value="compound-boxes">Compound Boxes</option>
          <option value="all">All Overlays</option>
        </select>
      </div>

      <button
        className="forge-btn"
        onClick={() => {
          void rebuildVariants();
        }}
        data-testid="collider-autofit"
        disabled={!hasViewport || building}
        style={{ marginBottom: "0.5rem" }}
      >
        {building ? "Building Collider Variants..." : "Rebuild Collider Variants"}
      </button>

      {summary && (
        <div className="forge-info">
          <div>Box: {summary.boxSize}</div>
          <div>Convex Hull Points: {summary.hullPoints}</div>
          <div>Compound Parts: {summary.compoundParts}</div>
        </div>
      )}

      {previewMode === "all" && (
        <div className="forge-info">
          Colors: cyan=box, amber=convex hull, green=compound boxes
        </div>
      )}

      {!variants && !building && !error && (
        <div className="forge-muted">
          No model loaded.
        </div>
      )}

      {error && <div className="forge-error">{error}</div>}
    </div>
  );
}
