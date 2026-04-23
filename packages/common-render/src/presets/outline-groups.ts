import * as THREE from "three";
import type { OutlinePipeline } from "../outline/outline-pipeline";

/**
 * Mapping config for {@link assignOutlineGroupsByMaterialName}.
 *
 * Shorthand form: plain record of material name → group key (e.g.
 * `{ blockstudio_accent: "glass" }`). The unnamed fallback is "default".
 *
 * Verbose form: object with `byName`, optional `default`, and optional
 * `predicate`. When a predicate returns a string it wins over `byName`.
 * When it returns `null`, the lookup falls through to `byName`.
 */
export type MaterialNameGroupMap =
  | Record<string, string>
  | {
      /** Fallback group when no material name matches. Default `"default"`. */
      default?: string;
      /** Explicit material-name → group key lookup. First hit wins. */
      byName?: Record<string, string>;
      /** Per-mesh classifier that runs before `byName`. Return `null` to skip. */
      predicate?: (mesh: THREE.Mesh) => string | null;
    };

type ResolvedMap = {
  default: string;
  byName: Record<string, string>;
  predicate: ((mesh: THREE.Mesh) => string | null) | null;
};

function normalizeMap(map: MaterialNameGroupMap): ResolvedMap {
  const obj = map as {
    default?: unknown;
    byName?: unknown;
    predicate?: unknown;
  };
  const verbose =
    typeof obj.byName === "object" ||
    typeof obj.default === "string" ||
    typeof obj.predicate === "function";

  if (verbose) {
    const byName = obj.byName;
    const predicate = obj.predicate;
    const defaultKey = obj.default;
    return {
      default: typeof defaultKey === "string" ? defaultKey : "default",
      byName:
        typeof byName === "object" && byName !== null
          ? (byName as Record<string, string>)
          : {},
      predicate:
        typeof predicate === "function"
          ? (predicate as (mesh: THREE.Mesh) => string | null)
          : null
    };
  }
  return {
    default: "default",
    byName: map as Record<string, string>,
    predicate: null
  };
}

function resolveGroupKey(mesh: THREE.Mesh, resolved: ResolvedMap): string {
  if (resolved.predicate) {
    const hit = resolved.predicate(mesh);
    if (hit !== null) return hit;
  }
  const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
  for (const m of mats) {
    const name = m?.name ?? "";
    if (name in resolved.byName) return resolved.byName[name];
  }
  return resolved.default;
}

/**
 * Walk `root`'s subtree and assign every mesh to an outline group by looking
 * at its material name. Replaces the common inline `groupKeyForMesh` pattern.
 *
 * Example:
 * ```ts
 * assignOutlineGroupsByMaterialName(wallsGroup, view.outline!, {
 *   byName: { blockstudio_accent: "glass", blockstudio_trim: "trim" },
 *   default: "wall"
 * });
 * ```
 */
export function assignOutlineGroupsByMaterialName(
  root: THREE.Object3D,
  pipeline: OutlinePipeline,
  map: MaterialNameGroupMap
): void {
  const resolved = normalizeMap(map);
  pipeline.assignOutlineGroupsUnder(root, (mesh) => resolveGroupKey(mesh, resolved));
}
