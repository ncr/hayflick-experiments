import type { SavedPropDefinition } from "./prop-library";

export type PropAssetValidationSeverity = "warning" | "error";

export type PropAssetValidationIssue = {
  severity: PropAssetValidationSeverity;
  code:
    | "bbox-invalid"
    | "collider-box-missing"
    | "collider-box-fallback"
    | "collider-convex-missing"
    | "collider-compound-missing"
    | "physics-material-missing"
    | "physics-mass-invalid"
    | "physics-friction-out-of-range"
    | "physics-restitution-out-of-range"
    | "physics-damping-invalid"
    | "physics-activation-delay-invalid";
  message: string;
};

export type PropAssetValidationSummary = {
  propsWithIssues: number;
  warningCount: number;
  errorCount: number;
  totalIssues: number;
};

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

export function validateSavedPropDefinition(
  definition: SavedPropDefinition
): PropAssetValidationIssue[] {
  const issues: PropAssetValidationIssue[] = [];

  if (
    definition.bbox.width <= 0 ||
    definition.bbox.height <= 0 ||
    definition.bbox.depth <= 0
  ) {
    issues.push({
      severity: "error",
      code: "bbox-invalid",
      message: "BBox dimensions must all be > 0."
    });
  }

  const variants = definition.colliderVariants;
  if (!variants?.box) {
    issues.push({
      severity: "error",
      code: "collider-box-missing",
      message: "Missing required box collider variant."
    });
  } else if (variants.box.source === "bbox-fallback") {
    issues.push({
      severity: "warning",
      code: "collider-box-fallback",
      message: "Box collider uses synthesized bbox fallback."
    });
  }

  if (!variants?.convexHull) {
    issues.push({
      severity: "warning",
      code: "collider-convex-missing",
      message: "Convex-hull collider variant is missing."
    });
  }

  const hasCompoundBoxes =
    !!variants?.compoundBoxes && variants.compoundBoxes.parts.length > 0;
  const hasCompoundConvexHulls =
    !!variants?.compoundConvexHulls && variants.compoundConvexHulls.parts.length > 0;
  if (!hasCompoundBoxes && !hasCompoundConvexHulls) {
    issues.push({
      severity: "warning",
      code: "collider-compound-missing",
      message: "Compound collider variant (boxes or convex hulls) is missing."
    });
  }

  const hint = definition.physicsHint;
  if (!hint?.material) {
    issues.push({
      severity: "warning",
      code: "physics-material-missing",
      message: "Physics material hint is missing."
    });
  }

  if (hint) {
    if (hint.mass !== undefined && (!isFiniteNumber(hint.mass) || hint.mass <= 0)) {
      issues.push({
        severity: "error",
        code: "physics-mass-invalid",
        message: "Physics mass must be a finite value > 0."
      });
    }

    if (
      hint.friction !== undefined &&
      (!isFiniteNumber(hint.friction) || hint.friction < 0 || hint.friction > 2)
    ) {
      issues.push({
        severity: "warning",
        code: "physics-friction-out-of-range",
        message: "Physics friction should stay within [0, 2]."
      });
    }

    if (
      hint.restitution !== undefined &&
      (!isFiniteNumber(hint.restitution) ||
        hint.restitution < 0 ||
        hint.restitution > 1)
    ) {
      issues.push({
        severity: "warning",
        code: "physics-restitution-out-of-range",
        message: "Physics restitution should stay within [0, 1]."
      });
    }

    if (
      (hint.linearDamping !== undefined &&
        (!isFiniteNumber(hint.linearDamping) || hint.linearDamping < 0)) ||
      (hint.angularDamping !== undefined &&
        (!isFiniteNumber(hint.angularDamping) || hint.angularDamping < 0))
    ) {
      issues.push({
        severity: "warning",
        code: "physics-damping-invalid",
        message: "Physics damping values should be finite and >= 0."
      });
    }

    if (
      hint.activationDelayMs !== undefined &&
      (!isFiniteNumber(hint.activationDelayMs) || hint.activationDelayMs < 0)
    ) {
      issues.push({
        severity: "warning",
        code: "physics-activation-delay-invalid",
        message: "Activation delay must be finite and >= 0."
      });
    }
  }

  return issues;
}

export function summarizePropAssetValidation(
  issuesByPropId: Map<string, PropAssetValidationIssue[]>
): PropAssetValidationSummary {
  let warningCount = 0;
  let errorCount = 0;
  for (const issues of issuesByPropId.values()) {
    for (const issue of issues) {
      if (issue.severity === "error") {
        errorCount += 1;
      } else {
        warningCount += 1;
      }
    }
  }

  return {
    propsWithIssues: issuesByPropId.size,
    warningCount,
    errorCount,
    totalIssues: warningCount + errorCount
  };
}
