import * as THREE from "three";
import type { MaterialNameGroupMap } from "./outline-groups";

const WARN_PREFIX = "[@common/render]";

let warningsEnabled: boolean = (() => {
  try {
    if (typeof process !== "undefined" && process.env?.NODE_ENV === "production") {
      return false;
    }
  } catch {
    // process not defined in this environment
  }
  return true;
})();

/**
 * Enable or disable dev-time warnings from `@common/render`. Warnings are on
 * by default in non-production builds (Vite substitutes
 * `process.env.NODE_ENV` at build time). Call with `false` to silence them
 * in tests or specialised harnesses.
 */
export function setCommonRenderWarningsEnabled(enabled: boolean): void {
  warningsEnabled = enabled;
}

export function commonRenderWarningsEnabled(): boolean {
  return warningsEnabled;
}

export function warnCommonRender(context: string, message: string): void {
  if (!warningsEnabled) return;
  console.warn(`${WARN_PREFIX} ${context}: ${message}`);
}

export function warnIfSceneHasNoLights(
  scene: THREE.Scene,
  context: string
): void {
  if (!warningsEnabled) return;
  let hasLight = false;
  scene.traverse((obj) => {
    if (!hasLight && (obj as THREE.Light).isLight) {
      hasLight = true;
    }
  });
  if (hasLight) return;
  warnCommonRender(
    context,
    "scene has no lights. MeshStandardMaterial will render black. " +
      "Call addStandardGameLighting(scene) before construction, or pass `lighting: true` in config."
  );
}

function collectMaterialNames(root: THREE.Object3D): Set<string> {
  const names = new Set<string>();
  root.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    if (!mesh.isMesh) return;
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const mat of mats) {
      const name = mat?.name;
      if (typeof name === "string" && name.length > 0) {
        names.add(name);
      }
    }
  });
  return names;
}

export function warnIfOutlineGroupsUnmatched(
  root: THREE.Object3D,
  map: MaterialNameGroupMap,
  context: string
): void {
  if (!warningsEnabled) return;
  const verbose = map as {
    default?: unknown;
    byName?: Record<string, string>;
    predicate?: unknown;
  };
  const byName: Record<string, string> =
    typeof verbose.byName === "object" && verbose.byName !== null
      ? verbose.byName
      : (map as Record<string, string>);
  const requestedKeys = Object.keys(byName);
  if (requestedKeys.length === 0) return;
  const sceneNames = collectMaterialNames(root);
  const unmatched = requestedKeys.filter((k) => !sceneNames.has(k));
  if (unmatched.length === 0) return;
  warnCommonRender(
    context,
    "outlineGroups.byName keys did not match any mesh material: " +
      `${unmatched.join(", ")}. Fix the keys or remove them from the map.`
  );
}
