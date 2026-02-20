import * as THREE from "three";
import type { StrategyGenerator, Vec3Tuple } from "../types";
import { clamp01, dot3, normalize3 } from "../pipeline/math";
import { partVolume, sanitizeParts } from "./common";

type Mat3 = [number, number, number, number, number, number, number, number, number];

function multiplyMat3Vec3(matrix: Mat3, vector: Vec3Tuple): Vec3Tuple {
  return [
    matrix[0] * vector[0] + matrix[1] * vector[1] + matrix[2] * vector[2],
    matrix[3] * vector[0] + matrix[4] * vector[1] + matrix[5] * vector[2],
    matrix[6] * vector[0] + matrix[7] * vector[1] + matrix[8] * vector[2]
  ];
}

function subtractProjection(base: Vec3Tuple, axis: Vec3Tuple): Vec3Tuple {
  const scale = dot3(base, axis);
  return [
    base[0] - axis[0] * scale,
    base[1] - axis[1] * scale,
    base[2] - axis[2] * scale
  ];
}

function powerIteration(
  matrix: Mat3,
  initial: Vec3Tuple,
  orthogonalTo: Vec3Tuple[] = [],
  iterations = 18
): Vec3Tuple {
  let axis = normalize3(initial);
  for (let i = 0; i < iterations; i += 1) {
    let value = multiplyMat3Vec3(matrix, axis);
    for (const rejectAxis of orthogonalTo) {
      value = subtractProjection(value, rejectAxis);
    }
    axis = normalize3(value);
  }
  return axis;
}

function covarianceMatrix(points: Vec3Tuple[]): {
  center: Vec3Tuple;
  matrix: Mat3;
} {
  if (points.length <= 0) {
    return {
      center: [0, 0, 0],
      matrix: [1, 0, 0, 0, 1, 0, 0, 0, 1]
    };
  }

  let cx = 0;
  let cy = 0;
  let cz = 0;
  for (const point of points) {
    cx += point[0];
    cy += point[1];
    cz += point[2];
  }
  cx /= points.length;
  cy /= points.length;
  cz /= points.length;

  let xx = 0;
  let xy = 0;
  let xz = 0;
  let yy = 0;
  let yz = 0;
  let zz = 0;
  for (const point of points) {
    const dx = point[0] - cx;
    const dy = point[1] - cy;
    const dz = point[2] - cz;
    xx += dx * dx;
    xy += dx * dy;
    xz += dx * dz;
    yy += dy * dy;
    yz += dy * dz;
    zz += dz * dz;
  }
  const inv = 1 / Math.max(1, points.length - 1);
  return {
    center: [cx, cy, cz],
    matrix: [
      xx * inv,
      xy * inv,
      xz * inv,
      xy * inv,
      yy * inv,
      yz * inv,
      xz * inv,
      yz * inv,
      zz * inv
    ]
  };
}

function principalAxes(points: Vec3Tuple[]): {
  center: Vec3Tuple;
  axisX: Vec3Tuple;
  axisY: Vec3Tuple;
  axisZ: Vec3Tuple;
} {
  const covariance = covarianceMatrix(points);
  const axisX = powerIteration(covariance.matrix, [1, 0.27, 0.11]);
  const axisY = powerIteration(covariance.matrix, [0.2, 1, 0.41], [axisX]);
  let axisZ: Vec3Tuple = normalize3([
    axisX[1] * axisY[2] - axisX[2] * axisY[1],
    axisX[2] * axisY[0] - axisX[0] * axisY[2],
    axisX[0] * axisY[1] - axisX[1] * axisY[0]
  ]);

  // Keep a right-handed basis to avoid mirrored quaternions.
  const handedness =
    axisX[0] * (axisY[1] * axisZ[2] - axisY[2] * axisZ[1]) -
    axisX[1] * (axisY[0] * axisZ[2] - axisY[2] * axisZ[0]) +
    axisX[2] * (axisY[0] * axisZ[1] - axisY[1] * axisZ[0]);
  if (handedness < 0) {
    axisZ = [-axisZ[0], -axisZ[1], -axisZ[2]];
  }

  return {
    center: covariance.center,
    axisX,
    axisY,
    axisZ
  };
}

export const generateObbPcaCollider: StrategyGenerator<"obb-pca"> = (
  prop,
  params
) => {
  if (prop.points.length <= 0) {
    return [];
  }

  const basis = principalAxes(prop.points);
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let minZ = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  let maxZ = Number.NEGATIVE_INFINITY;

  for (const point of prop.points) {
    const relative: Vec3Tuple = [
      point[0] - basis.center[0],
      point[1] - basis.center[1],
      point[2] - basis.center[2]
    ];
    const lx = dot3(relative, basis.axisX);
    const ly = dot3(relative, basis.axisY);
    const lz = dot3(relative, basis.axisZ);
    minX = Math.min(minX, lx);
    minY = Math.min(minY, ly);
    minZ = Math.min(minZ, lz);
    maxX = Math.max(maxX, lx);
    maxY = Math.max(maxY, ly);
    maxZ = Math.max(maxZ, lz);
  }

  const centerLocal: Vec3Tuple = [
    (minX + maxX) * 0.5,
    (minY + maxY) * 0.5,
    (minZ + maxZ) * 0.5
  ];
  const halfExtents: Vec3Tuple = [
    Math.max(1e-4, (maxX - minX) * 0.5 * (1 + clamp01(params.inflate * 20))),
    Math.max(1e-4, (maxY - minY) * 0.5 * (1 + clamp01(params.inflate * 20))),
    Math.max(1e-4, (maxZ - minZ) * 0.5 * (1 + clamp01(params.inflate * 20)))
  ];

  const centerWorld: Vec3Tuple = [
    basis.center[0] +
      basis.axisX[0] * centerLocal[0] +
      basis.axisY[0] * centerLocal[1] +
      basis.axisZ[0] * centerLocal[2],
    basis.center[1] +
      basis.axisX[1] * centerLocal[0] +
      basis.axisY[1] * centerLocal[1] +
      basis.axisZ[1] * centerLocal[2],
    basis.center[2] +
      basis.axisX[2] * centerLocal[0] +
      basis.axisY[2] * centerLocal[1] +
      basis.axisZ[2] * centerLocal[2]
  ];

  const rotationMatrix = new THREE.Matrix4().makeBasis(
    new THREE.Vector3(...basis.axisX),
    new THREE.Vector3(...basis.axisY),
    new THREE.Vector3(...basis.axisZ)
  );
  const quaternion = new THREE.Quaternion().setFromRotationMatrix(rotationMatrix);

  return sanitizeParts([
    {
      position: centerWorld,
      halfExtents,
      rotation: [quaternion.x, quaternion.y, quaternion.z, quaternion.w],
      volume: partVolume(halfExtents)
    }
  ]);
};

