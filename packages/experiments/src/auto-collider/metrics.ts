import * as THREE from "three";
import type { ColliderBudget, ColliderMetrics, PreparedGeometry } from "./types";

type GridResolution = {
  xCount: number;
  yCount: number;
  zCount: number;
};

export type SolidVoxelVolume = {
  bounds: THREE.Box3;
  xCount: number;
  yCount: number;
  zCount: number;
  occupancy: Uint8Array;
  occupiedCells: number;
};

const MIN_EDGE = 1e-5;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function voxelIndex(
  x: number,
  y: number,
  z: number,
  xCount: number,
  yCount: number
): number {
  return x + xCount * (y + yCount * z);
}

function axisIndexToSignedBin(normal: THREE.Vector3): number {
  const ax = Math.abs(normal.x);
  const ay = Math.abs(normal.y);
  const az = Math.abs(normal.z);
  if (ax >= ay && ax >= az) {
    return normal.x >= 0 ? 0 : 1;
  }
  if (ay >= az) {
    return normal.y >= 0 ? 2 : 3;
  }
  return normal.z >= 0 ? 4 : 5;
}

function normalizedEntropy(counts: readonly number[]): number {
  const total = counts.reduce((sum, value) => sum + value, 0);
  if (total <= 0) {
    return 0;
  }

  let entropy = 0;
  for (const count of counts) {
    if (count <= 0) {
      continue;
    }
    const p = count / total;
    entropy -= p * Math.log2(p);
  }

  const maxEntropy = Math.log2(Math.max(2, counts.length));
  return maxEntropy <= 0 ? 0 : clamp(entropy / maxEntropy, 0, 1);
}

function chooseResolution(
  size: THREE.Vector3,
  pointCount: number,
  budget: ColliderBudget
): GridResolution {
  const maxDim = Math.max(size.x, size.y, size.z, MIN_EDGE);
  const density = clamp(Math.log10(Math.max(32, pointCount)) / 4.2, 0, 1);
  const baseMin = budget === "strict" ? 16 : 20;
  const baseMax = budget === "strict" ? 28 : 34;
  const base = Math.round(clamp(baseMin + density * (baseMax - baseMin), baseMin, baseMax));

  return {
    xCount: Math.round(clamp((size.x / maxDim) * base, 8, baseMax + 8)),
    yCount: Math.round(clamp((size.y / maxDim) * base, 8, baseMax + 8)),
    zCount: Math.round(clamp((size.z / maxDim) * base, 8, baseMax + 8))
  };
}

function collectBounds(points: readonly THREE.Vector3[]): THREE.Box3 {
  const bounds = new THREE.Box3();
  for (const point of points) {
    bounds.expandByPoint(point);
  }
  return bounds;
}

function remapForUpAxis(
  points: readonly THREE.Vector3[],
  upAxis: 0 | 1 | 2
): THREE.Vector3[] {
  if (upAxis === 1) {
    return points.map((point) => point.clone());
  }

  if (upAxis === 0) {
    return points.map((point) => new THREE.Vector3(point.y, point.x, point.z));
  }

  return points.map((point) => new THREE.Vector3(point.x, point.z, point.y));
}

function rasterizePoints(
  points: readonly THREE.Vector3[],
  bounds: THREE.Box3,
  resolution: GridResolution
): Uint8Array {
  const size = bounds.getSize(new THREE.Vector3());
  const occupancy = new Uint8Array(
    resolution.xCount * resolution.yCount * resolution.zCount
  );

  for (const point of points) {
    const xNorm = clamp((point.x - bounds.min.x) / Math.max(MIN_EDGE, size.x), 0, 0.999999);
    const yNorm = clamp((point.y - bounds.min.y) / Math.max(MIN_EDGE, size.y), 0, 0.999999);
    const zNorm = clamp((point.z - bounds.min.z) / Math.max(MIN_EDGE, size.z), 0, 0.999999);

    const x = Math.floor(xNorm * resolution.xCount);
    const y = Math.floor(yNorm * resolution.yCount);
    const z = Math.floor(zNorm * resolution.zCount);

    occupancy[voxelIndex(x, y, z, resolution.xCount, resolution.yCount)] = 1;
  }

  return occupancy;
}

function fillVerticalColumns(
  occupancy: Uint8Array,
  resolution: GridResolution
): { occupancy: Uint8Array; occupiedCells: number } {
  const filled = occupancy.slice();

  for (let z = 0; z < resolution.zCount; z += 1) {
    for (let x = 0; x < resolution.xCount; x += 1) {
      let minY = Number.POSITIVE_INFINITY;
      let maxY = Number.NEGATIVE_INFINITY;

      for (let y = 0; y < resolution.yCount; y += 1) {
        if (filled[voxelIndex(x, y, z, resolution.xCount, resolution.yCount)] === 0) {
          continue;
        }
        minY = Math.min(minY, y);
        maxY = Math.max(maxY, y);
      }

      if (!Number.isFinite(minY) || !Number.isFinite(maxY)) {
        continue;
      }

      for (let y = minY; y <= maxY; y += 1) {
        filled[voxelIndex(x, y, z, resolution.xCount, resolution.yCount)] = 1;
      }
    }
  }

  let occupiedCells = 0;
  for (let i = 0; i < filled.length; i += 1) {
    occupiedCells += filled[i] === 0 ? 0 : 1;
  }

  return { occupancy: filled, occupiedCells };
}

function floodFillOutsideEmpty(
  occupancy: Uint8Array,
  resolution: GridResolution
): Uint8Array {
  const visited = new Uint8Array(occupancy.length);
  const queue: Array<[number, number, number]> = [];

  const enqueue = (x: number, y: number, z: number): void => {
    if (
      x < 0 ||
      y < 0 ||
      z < 0 ||
      x >= resolution.xCount ||
      y >= resolution.yCount ||
      z >= resolution.zCount
    ) {
      return;
    }
    const idx = voxelIndex(x, y, z, resolution.xCount, resolution.yCount);
    if (visited[idx] !== 0 || occupancy[idx] !== 0) {
      return;
    }
    visited[idx] = 1;
    queue.push([x, y, z]);
  };

  for (let x = 0; x < resolution.xCount; x += 1) {
    for (let z = 0; z < resolution.zCount; z += 1) {
      enqueue(x, 0, z);
      enqueue(x, resolution.yCount - 1, z);
    }
  }
  for (let y = 0; y < resolution.yCount; y += 1) {
    for (let z = 0; z < resolution.zCount; z += 1) {
      enqueue(0, y, z);
      enqueue(resolution.xCount - 1, y, z);
    }
  }
  for (let y = 0; y < resolution.yCount; y += 1) {
    for (let x = 0; x < resolution.xCount; x += 1) {
      enqueue(x, y, 0);
      enqueue(x, y, resolution.zCount - 1);
    }
  }

  let cursor = 0;
  while (cursor < queue.length) {
    const [x, y, z] = queue[cursor];
    cursor += 1;

    enqueue(x + 1, y, z);
    enqueue(x - 1, y, z);
    enqueue(x, y + 1, z);
    enqueue(x, y - 1, z);
    enqueue(x, y, z + 1);
    enqueue(x, y, z - 1);
  }

  return visited;
}

function connectedComponentNoise(
  occupancy: Uint8Array,
  resolution: GridResolution,
  occupiedCells: number
): number {
  if (occupiedCells <= 0) {
    return 0;
  }

  const visited = new Uint8Array(occupancy.length);
  const smallThreshold = Math.max(6, Math.floor(occupiedCells * 0.018));
  let smallCells = 0;

  const queue: number[] = [];

  for (let index = 0; index < occupancy.length; index += 1) {
    if (occupancy[index] === 0 || visited[index] !== 0) {
      continue;
    }

    visited[index] = 1;
    queue.length = 0;
    queue.push(index);
    let cursor = 0;
    let componentSize = 0;

    while (cursor < queue.length) {
      const current = queue[cursor];
      cursor += 1;
      componentSize += 1;

      const x = current % resolution.xCount;
      const yz = Math.floor(current / resolution.xCount);
      const y = yz % resolution.yCount;
      const z = Math.floor(yz / resolution.yCount);

      const pushNeighbor = (nx: number, ny: number, nz: number): void => {
        if (
          nx < 0 ||
          ny < 0 ||
          nz < 0 ||
          nx >= resolution.xCount ||
          ny >= resolution.yCount ||
          nz >= resolution.zCount
        ) {
          return;
        }
        const neighbor = voxelIndex(nx, ny, nz, resolution.xCount, resolution.yCount);
        if (occupancy[neighbor] === 0 || visited[neighbor] !== 0) {
          return;
        }
        visited[neighbor] = 1;
        queue.push(neighbor);
      };

      pushNeighbor(x + 1, y, z);
      pushNeighbor(x - 1, y, z);
      pushNeighbor(x, y + 1, z);
      pushNeighbor(x, y - 1, z);
      pushNeighbor(x, y, z + 1);
      pushNeighbor(x, y, z - 1);
    }

    if (componentSize <= smallThreshold) {
      smallCells += componentSize;
    }
  }

  return clamp(smallCells / occupiedCells, 0, 1);
}

function computeLayerScore(
  occupancy: Uint8Array,
  resolution: GridResolution
): number {
  const layers: number[] = new Array(resolution.yCount).fill(0);
  const layerArea = Math.max(1, resolution.xCount * resolution.zCount);

  for (let y = 0; y < resolution.yCount; y += 1) {
    let count = 0;
    for (let z = 0; z < resolution.zCount; z += 1) {
      for (let x = 0; x < resolution.xCount; x += 1) {
        if (occupancy[voxelIndex(x, y, z, resolution.xCount, resolution.yCount)] !== 0) {
          count += 1;
        }
      }
    }
    layers[y] = count / layerArea;
  }

  let maxDelta = 0;
  let mean = 0;
  for (const value of layers) {
    mean += value;
  }
  mean /= Math.max(1, layers.length);

  let variance = 0;
  for (let i = 0; i < layers.length; i += 1) {
    if (i > 0) {
      maxDelta = Math.max(maxDelta, Math.abs(layers[i] - layers[i - 1]));
    }
    const diff = layers[i] - mean;
    variance += diff * diff;
  }

  const std = Math.sqrt(variance / Math.max(1, layers.length));
  return clamp(maxDelta * 1.8 + std * 2.2, 0, 1);
}

function computeCavityScore(
  occupancy: Uint8Array,
  outsideEmpty: Uint8Array,
  resolution: GridResolution
): number {
  const topByColumn = new Int32Array(resolution.xCount * resolution.zCount);
  topByColumn.fill(-1);

  for (let z = 0; z < resolution.zCount; z += 1) {
    for (let x = 0; x < resolution.xCount; x += 1) {
      for (let y = resolution.yCount - 1; y >= 0; y -= 1) {
        if (occupancy[voxelIndex(x, y, z, resolution.xCount, resolution.yCount)] !== 0) {
          topByColumn[x + resolution.xCount * z] = y;
          break;
        }
      }
    }
  }

  let recessCount = 0;
  const total = occupancy.length;

  for (let z = 1; z < resolution.zCount - 1; z += 1) {
    for (let x = 1; x < resolution.xCount - 1; x += 1) {
      const topY = topByColumn[x + resolution.xCount * z];
      if (topY < 2) {
        continue;
      }

      for (let y = 1; y < topY; y += 1) {
        const idx = voxelIndex(x, y, z, resolution.xCount, resolution.yCount);
        if (occupancy[idx] !== 0 || outsideEmpty[idx] === 0) {
          continue;
        }

        let sideContacts = 0;
        if (occupancy[voxelIndex(x + 1, y, z, resolution.xCount, resolution.yCount)] !== 0) sideContacts += 1;
        if (occupancy[voxelIndex(x - 1, y, z, resolution.xCount, resolution.yCount)] !== 0) sideContacts += 1;
        if (occupancy[voxelIndex(x, y, z + 1, resolution.xCount, resolution.yCount)] !== 0) sideContacts += 1;
        if (occupancy[voxelIndex(x, y, z - 1, resolution.xCount, resolution.yCount)] !== 0) sideContacts += 1;

        if (sideContacts >= 2) {
          recessCount += 1;
        }
      }
    }
  }

  return clamp((recessCount / Math.max(1, total)) * 11, 0, 1);
}

export function buildSolidVoxelVolume(
  points: readonly THREE.Vector3[],
  bounds: THREE.Box3,
  budget: ColliderBudget
): SolidVoxelVolume {
  const size = bounds.getSize(new THREE.Vector3());
  const resolution = chooseResolution(size, points.length, budget);
  const surfaceOccupancy = rasterizePoints(points, bounds, resolution);
  const filled = fillVerticalColumns(surfaceOccupancy, resolution);

  return {
    bounds,
    xCount: resolution.xCount,
    yCount: resolution.yCount,
    zCount: resolution.zCount,
    occupancy: filled.occupancy,
    occupiedCells: filled.occupiedCells
  };
}

export function computeMetrics(
  prepared: PreparedGeometry,
  budget: ColliderBudget
): ColliderMetrics {
  const pcaSize = prepared.pcaBounds.getSize(new THREE.Vector3());
  const dims: [number, number, number] = [
    Math.max(MIN_EDGE, pcaSize.x),
    Math.max(MIN_EDGE, pcaSize.y),
    Math.max(MIN_EDGE, pcaSize.z)
  ];

  const sortedDims = [...dims].sort((a, b) => b - a);
  const maxDim = Math.max(MIN_EDGE, sortedDims[0]);
  const midDim = Math.max(MIN_EDGE, sortedDims[1]);
  const minDim = Math.max(MIN_EDGE, sortedDims[2]);

  const slenderness = maxDim / midDim;
  const flatness = minDim / maxDim;

  let planarityAccum = 0;
  const axis0 = prepared.pcaFrame.axes[0];
  const axis1 = prepared.pcaFrame.axes[1];
  const axis2 = prepared.pcaFrame.axes[2];

  const normalBins = [0, 0, 0, 0, 0, 0];
  for (const triangle of prepared.triangles) {
    const normal = triangle.normal;
    const alignment = Math.max(
      Math.abs(normal.dot(axis0)),
      Math.abs(normal.dot(axis1)),
      Math.abs(normal.dot(axis2))
    );
    planarityAccum += alignment;
    normalBins[axisIndexToSignedBin(normal)] += 1;
  }
  const planarity = clamp(planarityAccum / Math.max(1, prepared.triangles.length), 0, 1);

  const remappedPoints = remapForUpAxis(prepared.pcaPoints, prepared.pcaFrame.upAxis);
  const remappedBounds = collectBounds(remappedPoints);
  const solid = buildSolidVoxelVolume(remappedPoints, remappedBounds, budget);

  const totalCells = Math.max(1, solid.xCount * solid.yCount * solid.zCount);
  const occupiedRatio = solid.occupiedCells / totalCells;
  const concavityProxy = clamp((0.58 - occupiedRatio) / 0.58, 0, 1);

  const outsideEmpty = floodFillOutsideEmpty(
    solid.occupancy,
    { xCount: solid.xCount, yCount: solid.yCount, zCount: solid.zCount }
  );

  const cavityScore = computeCavityScore(
    solid.occupancy,
    outsideEmpty,
    { xCount: solid.xCount, yCount: solid.yCount, zCount: solid.zCount }
  );

  const layerScore = computeLayerScore(
    solid.occupancy,
    { xCount: solid.xCount, yCount: solid.yCount, zCount: solid.zCount }
  );

  const entropy = normalizedEntropy(normalBins);
  const componentNoise = connectedComponentNoise(
    solid.occupancy,
    { xCount: solid.xCount, yCount: solid.yCount, zCount: solid.zCount },
    solid.occupiedCells
  );
  const noiseScore = clamp(entropy * 0.6 + componentNoise * 0.7, 0, 1);

  return {
    diagonal: prepared.diagonal,
    dims,
    slenderness,
    flatness,
    planarity,
    concavityProxy,
    layerScore,
    cavityScore,
    noiseScore,
    occupiedRatio
  };
}
