/**
 * Pure motion math for the probe's dynamic objects, factored out so the
 * "is the scene actually moving every frame" contract is unit-testable
 * (a static scene would let the path tracer accumulate and give a falsely
 * optimistic result — the whole point of the spike is the moving case).
 */

export type Vec3 = { x: number; y: number; z: number };

/**
 * Position of object `i` (of `count`) on a double helix of orbits at time `t`
 * seconds. Distinct radius/phase/height per index so every object occupies a
 * different cell of the BVH and genuinely invalidates it each frame.
 */
export function orbitPosition(i: number, count: number, t: number): Vec3 {
  const golden = 2.399963229728653; // golden angle, spreads indices apart
  const phase = i * golden;
  const radius = 1.2 + (i % 7) * 0.45;
  const speed = 0.35 + ((i * 13) % 11) * 0.06;
  const angle = phase + t * speed;
  const height = 0.4 + Math.sin(t * 0.8 + phase) * (0.6 + (i % 5) * 0.18);
  return {
    x: Math.cos(angle) * radius,
    y: height,
    z: Math.sin(angle) * radius
  };
}

/** Euler rotation (radians) of object `i` at time `t`. */
export function spinRotation(i: number, t: number): Vec3 {
  const a = 0.5 + (i % 4) * 0.3;
  const b = 0.3 + (i % 6) * 0.2;
  return { x: t * a, y: t * b, z: t * (a - b) * 0.5 };
}
