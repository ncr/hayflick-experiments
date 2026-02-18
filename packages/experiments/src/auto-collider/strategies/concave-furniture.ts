import * as THREE from "three";
import type { RapierCompoundPart, StrategyContext, StrategyResult } from "../types";
import { choosePartBudget, tuple } from "./common";

type GridResolution = {
  xCount: number;
  yCount: number;
  zCount: number;
};

type VoxelBox = {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  minZ: number;
  maxZ: number;
};

type LayerRect = {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
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

function chooseResolution(
  size: THREE.Vector3,
  diagonal: number,
  budget: "strict" | "balanced"
): GridResolution {
  const targetVoxel = clamp(
    diagonal / (budget === "strict" ? 58 : 48),
    budget === "strict" ? 0.018 : 0.022,
    budget === "strict" ? 0.05 : 0.06
  );

  const maxAxis = budget === "strict" ? 60 : 52;

  return {
    xCount: Math.round(clamp(size.x / Math.max(MIN_EDGE, targetVoxel), 10, maxAxis)),
    yCount: Math.round(clamp(size.y / Math.max(MIN_EDGE, targetVoxel), 10, maxAxis)),
    zCount: Math.round(clamp(size.z / Math.max(MIN_EDGE, targetVoxel), 10, maxAxis))
  };
}

function coordToIndex(
  coord: number,
  min: number,
  size: number,
  count: number
): number {
  const normalized = clamp((coord - min) / Math.max(MIN_EDGE, size), 0, 0.999999);
  return clamp(Math.floor(normalized * count), 0, count - 1);
}

function rasterizeSurfaceTriangles(
  context: StrategyContext,
  bounds: THREE.Box3,
  resolution: GridResolution
): Uint8Array {
  const occupancy = new Uint8Array(resolution.xCount * resolution.yCount * resolution.zCount);
  const size = bounds.getSize(new THREE.Vector3());
  const stepX = size.x / resolution.xCount;
  const stepY = size.y / resolution.yCount;
  const stepZ = size.z / resolution.zCount;

  const triangle = new THREE.Triangle();
  const voxelBounds = new THREE.Box3();
  const min = new THREE.Vector3();
  const max = new THREE.Vector3();

  for (const preparedTriangle of context.prepared.triangles) {
    triangle.set(preparedTriangle.a, preparedTriangle.b, preparedTriangle.c);

    const triMinX = Math.min(preparedTriangle.a.x, preparedTriangle.b.x, preparedTriangle.c.x);
    const triMaxX = Math.max(preparedTriangle.a.x, preparedTriangle.b.x, preparedTriangle.c.x);
    const triMinY = Math.min(preparedTriangle.a.y, preparedTriangle.b.y, preparedTriangle.c.y);
    const triMaxY = Math.max(preparedTriangle.a.y, preparedTriangle.b.y, preparedTriangle.c.y);
    const triMinZ = Math.min(preparedTriangle.a.z, preparedTriangle.b.z, preparedTriangle.c.z);
    const triMaxZ = Math.max(preparedTriangle.a.z, preparedTriangle.b.z, preparedTriangle.c.z);

    const xStart = coordToIndex(triMinX, bounds.min.x, size.x, resolution.xCount);
    const xEnd = coordToIndex(triMaxX, bounds.min.x, size.x, resolution.xCount);
    const yStart = coordToIndex(triMinY, bounds.min.y, size.y, resolution.yCount);
    const yEnd = coordToIndex(triMaxY, bounds.min.y, size.y, resolution.yCount);
    const zStart = coordToIndex(triMinZ, bounds.min.z, size.z, resolution.zCount);
    const zEnd = coordToIndex(triMaxZ, bounds.min.z, size.z, resolution.zCount);

    for (let z = zStart; z <= zEnd; z += 1) {
      const z0 = bounds.min.z + z * stepZ;
      const z1 = z0 + stepZ;
      for (let y = yStart; y <= yEnd; y += 1) {
        const y0 = bounds.min.y + y * stepY;
        const y1 = y0 + stepY;
        for (let x = xStart; x <= xEnd; x += 1) {
          const idx = voxelIndex(x, y, z, resolution.xCount, resolution.yCount);
          if (occupancy[idx] !== 0) {
            continue;
          }

          const x0 = bounds.min.x + x * stepX;
          const x1 = x0 + stepX;

          min.set(x0, y0, z0);
          max.set(x1, y1, z1);
          voxelBounds.set(min, max);

          if (voxelBounds.intersectsTriangle(triangle)) {
            occupancy[idx] = 1;
          }
        }
      }
    }
  }

  return occupancy;
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

function buildSolidOccupancy(
  surface: Uint8Array,
  outsideEmpty: Uint8Array
): { occupancy: Uint8Array; occupiedCount: number } {
  const solid = new Uint8Array(surface.length);
  let occupiedCount = 0;

  for (let i = 0; i < solid.length; i += 1) {
    if (surface[i] !== 0 || outsideEmpty[i] === 0) {
      solid[i] = 1;
      occupiedCount += 1;
    }
  }

  return { occupancy: solid, occupiedCount };
}

function stripTinyComponents(
  occupancy: Uint8Array,
  resolution: GridResolution,
  occupiedCount: number
): { occupancy: Uint8Array; occupiedCount: number } {
  if (occupiedCount <= 0) {
    return { occupancy, occupiedCount };
  }

  const visited = new Uint8Array(occupancy.length);
  const kept = occupancy.slice();
  const queue: number[] = [];
  const component: number[] = [];
  const minComponent = Math.max(6, Math.floor(occupiedCount * 0.003));

  let keptCount = occupiedCount;

  for (let start = 0; start < occupancy.length; start += 1) {
    if (occupancy[start] === 0 || visited[start] !== 0) {
      continue;
    }

    queue.length = 0;
    component.length = 0;
    visited[start] = 1;
    queue.push(start);

    let cursor = 0;
    while (cursor < queue.length) {
      const current = queue[cursor];
      cursor += 1;
      component.push(current);

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

        const next = voxelIndex(nx, ny, nz, resolution.xCount, resolution.yCount);
        if (occupancy[next] === 0 || visited[next] !== 0) {
          return;
        }

        visited[next] = 1;
        queue.push(next);
      };

      pushNeighbor(x + 1, y, z);
      pushNeighbor(x - 1, y, z);
      pushNeighbor(x, y + 1, z);
      pushNeighbor(x, y - 1, z);
      pushNeighbor(x, y, z + 1);
      pushNeighbor(x, y, z - 1);
    }

    if (component.length < minComponent) {
      for (const index of component) {
        if (kept[index] !== 0) {
          kept[index] = 0;
          keptCount -= 1;
        }
      }
    }
  }

  return {
    occupancy: kept,
    occupiedCount: Math.max(0, keptCount)
  };
}

function extractLayerRectangles(
  occupancy: Uint8Array,
  resolution: GridResolution,
  y: number
): LayerRect[] {
  const used = new Uint8Array(resolution.xCount * resolution.zCount);
  const rectangles: LayerRect[] = [];

  const layerIndex = (x: number, z: number): number => x + resolution.xCount * z;

  const canUse = (x: number, z: number): boolean => {
    if (x < 0 || z < 0 || x >= resolution.xCount || z >= resolution.zCount) {
      return false;
    }

    const idx = voxelIndex(x, y, z, resolution.xCount, resolution.yCount);
    return occupancy[idx] !== 0 && used[layerIndex(x, z)] === 0;
  };

  for (let z = 0; z < resolution.zCount; z += 1) {
    for (let x = 0; x < resolution.xCount; x += 1) {
      if (!canUse(x, z)) {
        continue;
      }

      let maxX = x;
      while (canUse(maxX + 1, z)) {
        maxX += 1;
      }

      let maxZ = z;
      let canExpandZ = true;
      while (canExpandZ) {
        const testZ = maxZ + 1;
        if (testZ >= resolution.zCount) {
          break;
        }

        for (let xi = x; xi <= maxX; xi += 1) {
          if (!canUse(xi, testZ)) {
            canExpandZ = false;
            break;
          }
        }

        if (canExpandZ) {
          maxZ = testZ;
        }
      }

      for (let zi = z; zi <= maxZ; zi += 1) {
        for (let xi = x; xi <= maxX; xi += 1) {
          used[layerIndex(xi, zi)] = 1;
        }
      }

      rectangles.push({
        minX: x,
        maxX,
        minZ: z,
        maxZ
      });
    }
  }

  return rectangles;
}

function rectKey(rect: LayerRect): string {
  return `${rect.minX}:${rect.maxX}:${rect.minZ}:${rect.maxZ}`;
}

function extractVoxelBoxesFromLayers(
  occupancy: Uint8Array,
  resolution: GridResolution
): VoxelBox[] {
  const output: VoxelBox[] = [];
  const active = new Map<string, VoxelBox>();

  for (let y = 0; y < resolution.yCount; y += 1) {
    const rectangles = extractLayerRectangles(occupancy, resolution, y);
    const aliveKeys = new Set<string>();

    for (const rect of rectangles) {
      const key = rectKey(rect);
      aliveKeys.add(key);

      const existing = active.get(key);
      if (existing) {
        existing.maxY = y;
      } else {
        active.set(key, {
          minX: rect.minX,
          maxX: rect.maxX,
          minY: y,
          maxY: y,
          minZ: rect.minZ,
          maxZ: rect.maxZ
        });
      }
    }

    for (const [key, box] of active) {
      if (!aliveKeys.has(key)) {
        output.push({ ...box });
        active.delete(key);
      }
    }
  }

  for (const box of active.values()) {
    output.push({ ...box });
  }

  return output;
}

function boxVolumeVoxels(box: VoxelBox): number {
  return (
    (box.maxX - box.minX + 1) *
    (box.maxY - box.minY + 1) *
    (box.maxZ - box.minZ + 1)
  );
}

function canMerge(a: VoxelBox, b: VoxelBox): boolean {
  const xSame = a.minX === b.minX && a.maxX === b.maxX;
  const ySame = a.minY === b.minY && a.maxY === b.maxY;
  const zSame = a.minZ === b.minZ && a.maxZ === b.maxZ;

  if (xSame && ySame) {
    return a.maxZ + 1 === b.minZ || b.maxZ + 1 === a.minZ;
  }
  if (xSame && zSame) {
    return a.maxY + 1 === b.minY || b.maxY + 1 === a.minY;
  }
  if (ySame && zSame) {
    return a.maxX + 1 === b.minX || b.maxX + 1 === a.minX;
  }

  return false;
}

function mergeBoxes(a: VoxelBox, b: VoxelBox): VoxelBox {
  return {
    minX: Math.min(a.minX, b.minX),
    maxX: Math.max(a.maxX, b.maxX),
    minY: Math.min(a.minY, b.minY),
    maxY: Math.max(a.maxY, b.maxY),
    minZ: Math.min(a.minZ, b.minZ),
    maxZ: Math.max(a.maxZ, b.maxZ)
  };
}

function mergeAdjacentBoxes(boxes: VoxelBox[]): VoxelBox[] {
  const working = boxes.slice();

  let merged = true;
  while (merged) {
    merged = false;

    outer: for (let i = 0; i < working.length; i += 1) {
      for (let j = i + 1; j < working.length; j += 1) {
        if (!canMerge(working[i], working[j])) {
          continue;
        }

        const mergedBox = mergeBoxes(working[i], working[j]);
        working.splice(j, 1);
        working.splice(i, 1, mergedBox);
        merged = true;
        break outer;
      }
    }
  }

  return working;
}

function dropTinyBoxes(
  boxes: readonly VoxelBox[],
  occupiedCount: number
): VoxelBox[] {
  if (boxes.length <= 0) {
    return [];
  }

  const minCells = Math.max(4, Math.floor(occupiedCount * 0.0025));
  const kept = boxes.filter((box) => boxVolumeVoxels(box) >= minCells);
  return kept.length > 0 ? kept : [...boxes];
}

function axisGap(minA: number, maxA: number, minB: number, maxB: number): number {
  if (maxA < minB) {
    return minB - maxA - 1;
  }
  if (maxB < minA) {
    return minA - maxB - 1;
  }
  return 0;
}

function mergePenalty(a: VoxelBox, b: VoxelBox): number {
  const merged = mergeBoxes(a, b);
  const volumeA = boxVolumeVoxels(a);
  const volumeB = boxVolumeVoxels(b);
  const mergedVolume = boxVolumeVoxels(merged);
  const overfill = Math.max(0, mergedVolume - volumeA - volumeB);

  const gapX = axisGap(a.minX, a.maxX, b.minX, b.maxX);
  const gapY = axisGap(a.minY, a.maxY, b.minY, b.maxY);
  const gapZ = axisGap(a.minZ, a.maxZ, b.minZ, b.maxZ);
  const gap = gapX + gapY + gapZ;

  return overfill / Math.max(1, mergedVolume) + gap * 0.17;
}

function compactBoxesToBudget(
  boxes: readonly VoxelBox[],
  maxParts: number
): VoxelBox[] {
  if (boxes.length <= maxParts) {
    return [...boxes];
  }

  const working = boxes.slice();
  while (working.length > maxParts) {
    let bestI = -1;
    let bestJ = -1;
    let bestScore = Number.POSITIVE_INFINITY;

    for (let i = 0; i < working.length; i += 1) {
      for (let j = i + 1; j < working.length; j += 1) {
        const score = mergePenalty(working[i], working[j]);
        if (score < bestScore) {
          bestScore = score;
          bestI = i;
          bestJ = j;
        }
      }
    }

    if (bestI < 0 || bestJ < 0) {
      break;
    }

    const merged = mergeBoxes(working[bestI], working[bestJ]);
    working.splice(bestJ, 1);
    working.splice(bestI, 1, merged);
  }

  return working;
}

function toWorldPart(
  box: VoxelBox,
  bounds: THREE.Box3,
  resolution: GridResolution
): RapierCompoundPart {
  const size = bounds.getSize(new THREE.Vector3());

  const min = new THREE.Vector3(
    bounds.min.x + (box.minX / resolution.xCount) * size.x,
    bounds.min.y + (box.minY / resolution.yCount) * size.y,
    bounds.min.z + (box.minZ / resolution.zCount) * size.z
  );
  const max = new THREE.Vector3(
    bounds.min.x + ((box.maxX + 1) / resolution.xCount) * size.x,
    bounds.min.y + ((box.maxY + 1) / resolution.yCount) * size.y,
    bounds.min.z + ((box.maxZ + 1) / resolution.zCount) * size.z
  );

  const center = min.clone().add(max).multiplyScalar(0.5);
  const half = max.clone().sub(min).multiplyScalar(0.5);

  return {
    kind: "box",
    position: tuple(center.x, center.y, center.z),
    halfExtents: tuple(
      Math.max(0.005, half.x),
      Math.max(0.005, half.y),
      Math.max(0.005, half.z)
    )
  };
}

function partBounds(part: RapierCompoundPart): {
  minX: number;
  minY: number;
  minZ: number;
  maxX: number;
  maxY: number;
  maxZ: number;
} {
  return {
    minX: part.position[0] - part.halfExtents[0],
    minY: part.position[1] - part.halfExtents[1],
    minZ: part.position[2] - part.halfExtents[2],
    maxX: part.position[0] + part.halfExtents[0],
    maxY: part.position[1] + part.halfExtents[1],
    maxZ: part.position[2] + part.halfExtents[2]
  };
}

function mergeWorldParts(a: RapierCompoundPart, b: RapierCompoundPart): RapierCompoundPart {
  const ab = partBounds(a);
  const bb = partBounds(b);

  const minX = Math.min(ab.minX, bb.minX);
  const minY = Math.min(ab.minY, bb.minY);
  const minZ = Math.min(ab.minZ, bb.minZ);
  const maxX = Math.max(ab.maxX, bb.maxX);
  const maxY = Math.max(ab.maxY, bb.maxY);
  const maxZ = Math.max(ab.maxZ, bb.maxZ);

  return {
    kind: "box",
    position: tuple((minX + maxX) * 0.5, (minY + maxY) * 0.5, (minZ + maxZ) * 0.5),
    halfExtents: tuple(
      Math.max(0.005, (maxX - minX) * 0.5),
      Math.max(0.005, (maxY - minY) * 0.5),
      Math.max(0.005, (maxZ - minZ) * 0.5)
    )
  };
}

function nearEqual(a: number, b: number, eps: number): boolean {
  return Math.abs(a - b) <= eps;
}

function canMergeWorldParts(a: RapierCompoundPart, b: RapierCompoundPart): boolean {
  const ab = partBounds(a);
  const bb = partBounds(b);
  const eps = 0.0015;

  const xSame = nearEqual(ab.minX, bb.minX, eps) && nearEqual(ab.maxX, bb.maxX, eps);
  const ySame = nearEqual(ab.minY, bb.minY, eps) && nearEqual(ab.maxY, bb.maxY, eps);
  const zSame = nearEqual(ab.minZ, bb.minZ, eps) && nearEqual(ab.maxZ, bb.maxZ, eps);

  const touchY =
    nearEqual(ab.maxY, bb.minY, eps) || nearEqual(bb.maxY, ab.minY, eps);
  const touchX =
    nearEqual(ab.maxX, bb.minX, eps) || nearEqual(bb.maxX, ab.minX, eps);
  const touchZ =
    nearEqual(ab.maxZ, bb.minZ, eps) || nearEqual(bb.maxZ, ab.minZ, eps);

  if (xSame && zSame && touchY) {
    return true;
  }
  if (xSame && ySame && touchZ) {
    return true;
  }
  if (ySame && zSame && touchX) {
    return true;
  }

  return false;
}

function mergeAlignedWorldParts(parts: readonly RapierCompoundPart[]): RapierCompoundPart[] {
  const working = [...parts];
  let merged = true;

  while (merged) {
    merged = false;
    outer: for (let i = 0; i < working.length; i += 1) {
      for (let j = i + 1; j < working.length; j += 1) {
        if (!canMergeWorldParts(working[i], working[j])) {
          continue;
        }

        const mergedPart = mergeWorldParts(working[i], working[j]);
        working.splice(j, 1);
        working.splice(i, 1, mergedPart);
        merged = true;
        break outer;
      }
    }
  }

  return working;
}

function fallbackAabbPart(context: StrategyContext): RapierCompoundPart {
  const center = context.prepared.bounds.getCenter(new THREE.Vector3());
  const half = context.prepared.bounds
    .getSize(new THREE.Vector3())
    .multiplyScalar(0.5);

  return {
    kind: "box",
    position: tuple(center.x, center.y, center.z),
    halfExtents: tuple(
      Math.max(0.005, half.x),
      Math.max(0.005, half.y),
      Math.max(0.005, half.z)
    )
  };
}

export function generateConcaveFurnitureStrategy(
  context: StrategyContext
): StrategyResult {
  const bounds = context.prepared.bounds;
  const size = bounds.getSize(new THREE.Vector3());
  const resolution = chooseResolution(size, context.metrics.diagonal, context.options.budget);

  const surface = rasterizeSurfaceTriangles(context, bounds, resolution);
  const outsideEmpty = floodFillOutsideEmpty(surface, resolution);
  const solid = buildSolidOccupancy(surface, outsideEmpty);
  const denoised = stripTinyComponents(solid.occupancy, resolution, solid.occupiedCount);

  let boxes = extractVoxelBoxesFromLayers(denoised.occupancy, resolution);
  boxes = mergeAdjacentBoxes(boxes);
  boxes = dropTinyBoxes(boxes, denoised.occupiedCount);

  const maxParts = choosePartBudget(context.metrics.diagonal, context.options.budget);
  boxes = compactBoxesToBudget(boxes, maxParts);

  const parts = mergeAlignedWorldParts(
    boxes
    .sort((a, b) => boxVolumeVoxels(b) - boxVolumeVoxels(a))
    .map((box) => toWorldPart(box, bounds, resolution))
  )
    .sort(
      (a, b) =>
        b.halfExtents[0] * b.halfExtents[1] * b.halfExtents[2] -
        a.halfExtents[0] * a.halfExtents[1] * a.halfExtents[2]
    );

  return {
    kind: "concave-furniture",
    rapier: {
      type: "compound",
      parts: parts.length > 0 ? parts : [fallbackAabbPart(context)]
    }
  };
}
