import * as THREE from "three";
import { PALETTE } from "./palette";

// Simple particle system built on THREE.Points. Each particle has a slow
// drift velocity baked into a per-particle attribute; we advance them on
// CPU each frame and wrap them when they leave the spawn volume.
//
// Worth replacing with InstancedMesh + GPU advection if dust counts ever
// climb into the thousands, but at <500 motes CPU advection is invisible
// in the profile.

export type ParticleField = {
  points: THREE.Points;
  material: THREE.PointsMaterial;
  step: (deltaSeconds: number) => void;
};

type Box = {
  min: THREE.Vector3;
  max: THREE.Vector3;
};

function boxSize(box: Box, axis: "x" | "y" | "z"): number {
  return box.max[axis] - box.min[axis];
}

function makeWrapDrift(
  box: Box,
  count: number,
  baseDrift: THREE.Vector3,
  jitter: THREE.Vector3
): {
  positions: Float32Array;
  velocities: Float32Array;
} {
  const positions = new Float32Array(count * 3);
  const velocities = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    positions[i * 3] = box.min.x + Math.random() * boxSize(box, "x");
    positions[i * 3 + 1] = box.min.y + Math.random() * boxSize(box, "y");
    positions[i * 3 + 2] = box.min.z + Math.random() * boxSize(box, "z");
    velocities[i * 3] = baseDrift.x + (Math.random() - 0.5) * jitter.x;
    velocities[i * 3 + 1] = baseDrift.y + (Math.random() - 0.5) * jitter.y;
    velocities[i * 3 + 2] = baseDrift.z + (Math.random() - 0.5) * jitter.z;
  }
  return { positions, velocities };
}

function buildField(opts: {
  box: Box;
  count: number;
  drift: THREE.Vector3;
  jitter: THREE.Vector3;
  color: number;
  size: number;
  opacity: number;
}): ParticleField {
  const { positions, velocities } = makeWrapDrift(
    opts.box,
    opts.count,
    opts.drift,
    opts.jitter
  );

  const geom = new THREE.BufferGeometry();
  geom.setAttribute("position", new THREE.BufferAttribute(positions, 3));

  const mat = new THREE.PointsMaterial({
    color: opts.color,
    size: opts.size,
    sizeAttenuation: true,
    transparent: true,
    opacity: opts.opacity,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    fog: false
  });

  const points = new THREE.Points(geom, mat);
  points.frustumCulled = false;

  const sizeX = boxSize(opts.box, "x");
  const sizeY = boxSize(opts.box, "y");
  const sizeZ = boxSize(opts.box, "z");

  const step = (dt: number): void => {
    const arr = positions;
    const v = velocities;
    for (let i = 0; i < opts.count; i++) {
      const ix = i * 3;
      arr[ix] += v[ix] * dt;
      arr[ix + 1] += v[ix + 1] * dt;
      arr[ix + 2] += v[ix + 2] * dt;
      // Wrap inside box on each axis.
      if (arr[ix] < opts.box.min.x) arr[ix] += sizeX;
      else if (arr[ix] > opts.box.max.x) arr[ix] -= sizeX;
      if (arr[ix + 1] < opts.box.min.y) arr[ix + 1] += sizeY;
      else if (arr[ix + 1] > opts.box.max.y) arr[ix + 1] -= sizeY;
      if (arr[ix + 2] < opts.box.min.z) arr[ix + 2] += sizeZ;
      else if (arr[ix + 2] > opts.box.max.z) arr[ix + 2] -= sizeZ;
    }
    geom.getAttribute("position").needsUpdate = true;
  };

  return { points, material: mat, step };
}

export function createDustMotes(): ParticleField {
  // Volume covers the building interior + just outside it, so the camera
  // catches motes drifting through the god rays.
  return buildField({
    box: {
      min: new THREE.Vector3(-3.5, 0.4, -2.5),
      max: new THREE.Vector3(3.5, 2.6, 2.5)
    },
    count: 160,
    drift: new THREE.Vector3(0.04, -0.02, 0.02),
    jitter: new THREE.Vector3(0.05, 0.03, 0.05),
    color: PALETTE.dustMote,
    size: 0.05,
    opacity: 0.6
  });
}

export function createSmoke(origin: THREE.Vector3): ParticleField {
  // Loose smoke column rising from the chimney.
  return buildField({
    box: {
      min: new THREE.Vector3(origin.x - 0.4, origin.y, origin.z - 0.4),
      max: new THREE.Vector3(origin.x + 0.4, origin.y + 3.0, origin.z + 0.4)
    },
    count: 60,
    drift: new THREE.Vector3(0.04, 0.18, 0.0),
    jitter: new THREE.Vector3(0.04, 0.04, 0.04),
    color: PALETTE.smoke,
    size: 0.18,
    opacity: 0.55
  });
}

export function createSteam(origin: THREE.Vector3): ParticleField {
  // Steam jet from the broken pipe — sideways venting.
  return buildField({
    box: {
      min: new THREE.Vector3(origin.x - 0.05, origin.y - 0.2, origin.z - 0.4),
      max: new THREE.Vector3(origin.x + 1.6, origin.y + 0.4, origin.z + 0.4)
    },
    count: 50,
    drift: new THREE.Vector3(0.5, 0.05, 0.0),
    jitter: new THREE.Vector3(0.08, 0.06, 0.06),
    color: PALETTE.steam,
    size: 0.12,
    opacity: 0.7
  });
}
