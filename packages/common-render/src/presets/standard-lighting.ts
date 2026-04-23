import * as THREE from "three";

/**
 * Options for {@link addStandardGameLighting}. Every field is optional; the
 * defaults produce the lighting shape most consumers reach for (warm key,
 * cool fill, subtle hemisphere). Override individual fields to nudge a scene
 * — don't abandon the preset.
 */
export type StandardGameLightingOptions = {
  /** Ambient intensity. Default 0.7. */
  ambient?: number;
  /** Key directional-light color. Default 0xfff4e0 (warm white). */
  keyColor?: number;
  /** Key directional-light intensity. Default 1.8. */
  keyIntensity?: number;
  /** Key direction (looks from this point toward the origin). Default [2, 3, 4]. */
  keyDirection?: [number, number, number] | THREE.Vector3;
  /** Fill directional-light color. Default 0xb0c4de (cool blue). */
  fillColor?: number;
  /** Fill directional-light intensity. Default 0.5. */
  fillIntensity?: number;
  /** Fill direction. Default [-3, 4, -2]. */
  fillDirection?: [number, number, number] | THREE.Vector3;
  /**
   * Hemisphere light (sky/ground bounce). Pass `false` to disable, or an
   * object to override. Defaults: sky 0xe8edf5, ground 0x8a8070, intensity 0.5.
   */
  hemisphere?:
    | false
    | {
        skyColor?: number;
        groundColor?: number;
        intensity?: number;
      };
  /**
   * Rim backlight. Opt-in (default `false`). Pass an object to enable.
   * Defaults when enabled: color 0x9ec6ff, intensity 0.6, direction [-1, 0.3, -1].
   */
  rim?:
    | false
    | {
        color?: number;
        intensity?: number;
        direction?: [number, number, number] | THREE.Vector3;
      };
  /** When true, the key light casts shadows (also enables shadow map on fill=false). Default false. */
  shadows?: boolean;
};

/** Handle for managing the lights added by {@link addStandardGameLighting}. */
export type StandardGameLightingHandle = {
  ambient: THREE.AmbientLight;
  key: THREE.DirectionalLight;
  fill: THREE.DirectionalLight;
  hemisphere: THREE.HemisphereLight | null;
  rim: THREE.DirectionalLight | null;
  /** Remove all lights from the scene and dispose internal resources. */
  remove(): void;
};

function toVector3(
  value: [number, number, number] | THREE.Vector3 | undefined,
  fallback: [number, number, number]
): THREE.Vector3 {
  if (value === undefined) {
    return new THREE.Vector3(fallback[0], fallback[1], fallback[2]);
  }
  if (Array.isArray(value)) {
    return new THREE.Vector3(value[0], value[1], value[2]);
  }
  return value.clone();
}

/**
 * Add the project's standard 3–5-light game rig to `scene` in one call.
 * Replaces the near-identical rigs every experiment hand-rolls. Returns a
 * handle so callers can reach specific lights (e.g. to set shadow target)
 * and dispose cleanly.
 */
export function addStandardGameLighting(
  scene: THREE.Scene,
  options: StandardGameLightingOptions = {}
): StandardGameLightingHandle {
  const ambient = new THREE.AmbientLight(0xffffff, options.ambient ?? 0.7);
  scene.add(ambient);

  const key = new THREE.DirectionalLight(
    options.keyColor ?? 0xfff4e0,
    options.keyIntensity ?? 1.8
  );
  const keyDir = toVector3(options.keyDirection, [2, 3, 4]);
  key.position.copy(keyDir);
  if (options.shadows === true) {
    key.castShadow = true;
  }
  scene.add(key);

  const fill = new THREE.DirectionalLight(
    options.fillColor ?? 0xb0c4de,
    options.fillIntensity ?? 0.5
  );
  fill.position.copy(toVector3(options.fillDirection, [-3, 4, -2]));
  scene.add(fill);

  let hemi: THREE.HemisphereLight | null = null;
  if (options.hemisphere !== false) {
    const h = options.hemisphere ?? {};
    hemi = new THREE.HemisphereLight(
      h.skyColor ?? 0xe8edf5,
      h.groundColor ?? 0x8a8070,
      h.intensity ?? 0.5
    );
    scene.add(hemi);
  }

  let rim: THREE.DirectionalLight | null = null;
  if (options.rim) {
    rim = new THREE.DirectionalLight(
      options.rim.color ?? 0x9ec6ff,
      options.rim.intensity ?? 0.6
    );
    rim.position.copy(toVector3(options.rim.direction, [-1, 0.3, -1]));
    scene.add(rim);
  }

  return {
    ambient,
    key,
    fill,
    hemisphere: hemi,
    rim,
    remove() {
      scene.remove(ambient);
      scene.remove(key);
      scene.remove(fill);
      if (hemi) scene.remove(hemi);
      if (rim) scene.remove(rim);
      ambient.dispose();
      key.dispose();
      fill.dispose();
      hemi?.dispose();
      rim?.dispose();
    }
  };
}
