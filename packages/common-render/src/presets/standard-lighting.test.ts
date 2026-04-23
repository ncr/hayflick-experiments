import * as THREE from "three";
import { describe, it, expect } from "vitest";
import { addStandardGameLighting } from "./standard-lighting";

function countLightsOfType<T extends THREE.Light>(
  scene: THREE.Scene,
  ctor: new (...args: never[]) => T
): number {
  let count = 0;
  scene.traverse((obj) => {
    if (obj instanceof ctor) count += 1;
  });
  return count;
}

describe("addStandardGameLighting", () => {
  it("adds ambient + key + fill + hemisphere by default (rim opt-in)", () => {
    const scene = new THREE.Scene();
    const h = addStandardGameLighting(scene);

    expect(countLightsOfType(scene, THREE.AmbientLight)).toBe(1);
    expect(countLightsOfType(scene, THREE.DirectionalLight)).toBe(2);
    expect(countLightsOfType(scene, THREE.HemisphereLight)).toBe(1);
    expect(h.rim).toBeNull();
  });

  it("applies canonical defaults (intensities, colors, positions)", () => {
    const scene = new THREE.Scene();
    const h = addStandardGameLighting(scene);

    expect(h.ambient.intensity).toBe(0.7);
    expect(h.key.intensity).toBe(1.8);
    expect(h.key.color.getHex()).toBe(0xfff4e0);
    expect(h.key.position.toArray()).toEqual([2, 3, 4]);
    expect(h.fill.intensity).toBe(0.5);
    expect(h.fill.color.getHex()).toBe(0xb0c4de);
    expect(h.fill.position.toArray()).toEqual([-3, 4, -2]);
    expect(h.hemisphere?.intensity).toBe(0.5);
  });

  it("overrides individual fields without touching the rest", () => {
    const scene = new THREE.Scene();
    const h = addStandardGameLighting(scene, {
      ambient: 0.45,
      keyIntensity: 1.1,
      fillIntensity: 0.35,
      hemisphere: false
    });

    expect(h.ambient.intensity).toBe(0.45);
    expect(h.key.intensity).toBe(1.1);
    expect(h.fill.intensity).toBe(0.35);
    expect(h.hemisphere).toBeNull();
    // Key color unchanged because not overridden.
    expect(h.key.color.getHex()).toBe(0xfff4e0);
  });

  it("opts into rim backlight when passed an object", () => {
    const scene = new THREE.Scene();
    const h = addStandardGameLighting(scene, {
      rim: { intensity: 2.2, color: 0x9ec6ff, direction: [-1, 0.3, -1] }
    });

    expect(h.rim).not.toBeNull();
    expect(h.rim?.intensity).toBe(2.2);
    expect(h.rim?.color.getHex()).toBe(0x9ec6ff);
    expect(h.rim?.position.toArray()).toEqual([-1, 0.3, -1]);
  });

  it("enables key shadow casting only when shadows: true", () => {
    const scene = new THREE.Scene();
    const h1 = addStandardGameLighting(scene);
    expect(h1.key.castShadow).toBe(false);
    h1.remove();

    const h2 = addStandardGameLighting(scene, { shadows: true });
    expect(h2.key.castShadow).toBe(true);
  });

  it("accepts THREE.Vector3 for directions", () => {
    const scene = new THREE.Scene();
    const h = addStandardGameLighting(scene, {
      keyDirection: new THREE.Vector3(5, 6, 7)
    });
    expect(h.key.position.toArray()).toEqual([5, 6, 7]);
  });

  it("remove() takes lights out of the scene graph", () => {
    const scene = new THREE.Scene();
    const h = addStandardGameLighting(scene, { rim: {} });
    expect(countLightsOfType(scene, THREE.DirectionalLight)).toBe(3);
    h.remove();
    expect(countLightsOfType(scene, THREE.AmbientLight)).toBe(0);
    expect(countLightsOfType(scene, THREE.DirectionalLight)).toBe(0);
    expect(countLightsOfType(scene, THREE.HemisphereLight)).toBe(0);
  });
});
