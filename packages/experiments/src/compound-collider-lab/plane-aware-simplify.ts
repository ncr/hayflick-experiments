import * as THREE from "three";
import { MeshoptSimplifier } from "meshoptimizer";

type Cluster = {
  normal: THREE.Vector3;
  d: number;
  area: number;
};

type MeshData = {
  positions: Float32Array;
  indices: Uint32Array;
};

type Baseline = {
  normals: Float32Array;
  areas: Float32Array;
};

export type PlaneAwareSimplifyOptions = {
  vertexMerge?: number;
  creaseProtect?: number;
  planeSensitivity?: number;
  targetFaces?: number;
};

export type PlaneAwareSimplifyResult = {
  geometry: THREE.BufferGeometry;
  originalFaces: number;
  simplifiedFaces: number;
  boundaryEdges: number;
  watertight: boolean;
  clusterCount: number;
  protectedVertices: number;
  fallbackUsed: boolean;
};

const DEFAULT_OPTIONS: Required<PlaneAwareSimplifyOptions> = {
  vertexMerge: 0.006,
  creaseProtect: 0.65,
  planeSensitivity: 0.58,
  targetFaces: Number.POSITIVE_INFINITY
};

const MIN_AREA = 1e-8;
let simplifierReady: Promise<void> | undefined;

function ensureReady(): Promise<void> {
  if (!simplifierReady) {
    simplifierReady = MeshoptSimplifier.ready;
  }
  return simplifierReady;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function quantize(value: number, step: number): number {
  const safe = Math.max(1e-9, step);
  return Math.round(value / safe);
}

function vertexKeyFromIndex(
  positions: Float32Array,
  vertexId: number,
  step: number
): string {
  const base = vertexId * 3;
  return `${quantize(positions[base], step)}|${quantize(positions[base + 1], step)}|${quantize(positions[base + 2], step)}`;
}

function edgeKey(
  positions: Float32Array,
  a: number,
  b: number,
  step: number
): string {
  const ka = vertexKeyFromIndex(positions, a, step);
  const kb = vertexKeyFromIndex(positions, b, step);
  return ka < kb ? `${ka}->${kb}` : `${kb}->${ka}`;
}

function countBoundaryEdges(
  positions: Float32Array,
  indices: Uint32Array,
  step: number
): number {
  const counts = new Map<string, number>();
  for (let i = 0; i + 2 < indices.length; i += 3) {
    const a = indices[i];
    const b = indices[i + 1];
    const c = indices[i + 2];
    const ab = edgeKey(positions, a, b, step);
    const bc = edgeKey(positions, b, c, step);
    const ca = edgeKey(positions, c, a, step);
    counts.set(ab, (counts.get(ab) ?? 0) + 1);
    counts.set(bc, (counts.get(bc) ?? 0) + 1);
    counts.set(ca, (counts.get(ca) ?? 0) + 1);
  }

  let boundary = 0;
  for (const count of counts.values()) {
    if (count === 1) {
      boundary += 1;
    }
  }
  return boundary;
}

function collectMesh(root: THREE.Object3D): MeshData {
  root.updateMatrixWorld(true);

  const positions: number[] = [];
  const indices: number[] = [];
  const temp = new THREE.Vector3();

  root.traverse((node) => {
    if (!(node instanceof THREE.Mesh)) {
      return;
    }
    if (!(node.geometry instanceof THREE.BufferGeometry)) {
      return;
    }

    const position = node.geometry.getAttribute("position");
    if (!(position instanceof THREE.BufferAttribute) || position.count < 3) {
      return;
    }

    const vertexBase = positions.length / 3;
    for (let i = 0; i < position.count; i += 1) {
      temp.fromBufferAttribute(position, i).applyMatrix4(node.matrixWorld);
      positions.push(temp.x, temp.y, temp.z);
    }

    const index = node.geometry.getIndex();
    if (index) {
      for (let i = 0; i + 2 < index.count; i += 3) {
        const a = vertexBase + index.getX(i);
        const b = vertexBase + index.getX(i + 1);
        const c = vertexBase + index.getX(i + 2);
        if (a !== b && b !== c && c !== a) {
          indices.push(a, b, c);
        }
      }
    } else {
      for (let i = 0; i + 2 < position.count; i += 3) {
        const a = vertexBase + i;
        const b = vertexBase + i + 1;
        const c = vertexBase + i + 2;
        if (a !== b && b !== c && c !== a) {
          indices.push(a, b, c);
        }
      }
    }
  });

  return {
    positions: new Float32Array(positions),
    indices: new Uint32Array(indices)
  };
}

function computeVertexNormals(
  positions: Float32Array,
  indices: Uint32Array
): Float32Array {
  const normals = new Float32Array(positions.length);
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  const ab = new THREE.Vector3();
  const ac = new THREE.Vector3();
  const cross = new THREE.Vector3();

  for (let i = 0; i + 2 < indices.length; i += 3) {
    const i0 = indices[i] * 3;
    const i1 = indices[i + 1] * 3;
    const i2 = indices[i + 2] * 3;
    a.set(positions[i0], positions[i0 + 1], positions[i0 + 2]);
    b.set(positions[i1], positions[i1 + 1], positions[i1 + 2]);
    c.set(positions[i2], positions[i2 + 1], positions[i2 + 2]);
    ab.copy(b).sub(a);
    ac.copy(c).sub(a);
    cross.copy(ab).cross(ac);

    normals[i0] += cross.x;
    normals[i0 + 1] += cross.y;
    normals[i0 + 2] += cross.z;
    normals[i1] += cross.x;
    normals[i1 + 1] += cross.y;
    normals[i1 + 2] += cross.z;
    normals[i2] += cross.x;
    normals[i2 + 1] += cross.y;
    normals[i2 + 2] += cross.z;
  }

  for (let i = 0; i < normals.length; i += 3) {
    const x = normals[i];
    const y = normals[i + 1];
    const z = normals[i + 2];
    const len = Math.hypot(x, y, z);
    if (len > 1e-9) {
      normals[i] = x / len;
      normals[i + 1] = y / len;
      normals[i + 2] = z / len;
    }
  }

  return normals;
}

function weldMesh(
  positions: Float32Array,
  indices: Uint32Array,
  normals: Float32Array,
  tolerance: number,
  normalDotMin: number
): MeshData {
  if (positions.length === 0 || indices.length === 0) {
    return { positions, indices };
  }

  const buckets = new Map<string, number[]>();
  const outPositions: number[] = [];
  const remap = new Uint32Array(Math.floor(positions.length / 3));
  const tolSq = tolerance * tolerance;

  for (let vertexId = 0; vertexId < remap.length; vertexId += 1) {
    const base = vertexId * 3;
    const x = positions[base];
    const y = positions[base + 1];
    const z = positions[base + 2];
    const nx = normals[base];
    const ny = normals[base + 1];
    const nz = normals[base + 2];

    const key = `${quantize(x, tolerance)}|${quantize(y, tolerance)}|${quantize(z, tolerance)}`;
    const candidates = buckets.get(key);

    let chosen = -1;
    let bestDistSq = Number.POSITIVE_INFINITY;

    if (candidates) {
      for (const candidateId of candidates) {
        const cBase = candidateId * 3;
        const cx = outPositions[cBase];
        const cy = outPositions[cBase + 1];
        const cz = outPositions[cBase + 2];
        const dx = x - cx;
        const dy = y - cy;
        const dz = z - cz;
        const distSq = dx * dx + dy * dy + dz * dz;
        if (distSq > tolSq) {
          continue;
        }

        const dot =
          nx * normals[cBase] +
          ny * normals[cBase + 1] +
          nz * normals[cBase + 2];
        if (dot < normalDotMin) {
          continue;
        }

        if (distSq < bestDistSq) {
          bestDistSq = distSq;
          chosen = candidateId;
        }
      }
    }

    if (chosen === -1) {
      chosen = outPositions.length / 3;
      outPositions.push(x, y, z);
      if (candidates) {
        candidates.push(chosen);
      } else {
        buckets.set(key, [chosen]);
      }
    }

    remap[vertexId] = chosen;
  }

  const outIndices: number[] = [];
  for (let i = 0; i + 2 < indices.length; i += 3) {
    const a = remap[indices[i]];
    const b = remap[indices[i + 1]];
    const c = remap[indices[i + 2]];
    if (a !== b && b !== c && c !== a) {
      outIndices.push(a, b, c);
    }
  }

  return {
    positions: new Float32Array(outPositions),
    indices: new Uint32Array(outIndices)
  };
}

function simplifyIndicesWithClosedPreference(
  positions: Float32Array,
  indices: Uint32Array,
  targetRatio: number,
  sourceClosed: boolean,
  boundaryStep: number
): Uint32Array {
  if (indices.length < 12) {
    return indices;
  }

  const candidates = [targetRatio, 0.55, 0.68, 0.82, 0.92];
  for (const ratioRaw of candidates) {
    const ratio = clamp(ratioRaw, 0.08, 0.98);
    const rawTarget = Math.floor(indices.length * ratio);
    const targetCount = Math.max(6, rawTarget - (rawTarget % 3));
    if (targetCount >= indices.length) {
      continue;
    }

    let simplified: Uint32Array;
    try {
      const [result] = MeshoptSimplifier.simplify(
        indices,
        positions,
        3,
        targetCount,
        0.01
      );
      simplified = new Uint32Array(result);
    } catch {
      continue;
    }

    if (simplified.length < 6) {
      continue;
    }

    if (sourceClosed) {
      const boundary = countBoundaryEdges(positions, simplified, boundaryStep);
      if (boundary > 0) {
        continue;
      }
    }

    return simplified;
  }

  return indices;
}

function clusterFacesByPlane(
  positions: Float32Array,
  indices: Uint32Array,
  planeSensitivity: number
): {
  clusters: Cluster[];
  faceClusterIds: Int32Array;
} {
  const normalTolDeg = lerp(24, 4, planeSensitivity);
  const planeStep = lerp(0.09, 0.006, planeSensitivity);
  const angleStep = THREE.MathUtils.degToRad(normalTolDeg);

  const clusters: Cluster[] = [];
  const clusterByKey = new Map<string, number>();
  const faceClusterIds = new Int32Array(Math.floor(indices.length / 3));

  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  const ab = new THREE.Vector3();
  const ac = new THREE.Vector3();
  const normal = new THREE.Vector3();
  const centroid = new THREE.Vector3();

  for (let face = 0, i = 0; i + 2 < indices.length; i += 3, face += 1) {
    const i0 = indices[i] * 3;
    const i1 = indices[i + 1] * 3;
    const i2 = indices[i + 2] * 3;
    a.set(positions[i0], positions[i0 + 1], positions[i0 + 2]);
    b.set(positions[i1], positions[i1 + 1], positions[i1 + 2]);
    c.set(positions[i2], positions[i2 + 1], positions[i2 + 2]);
    ab.copy(b).sub(a);
    ac.copy(c).sub(a);
    normal.copy(ab).cross(ac);
    const doubleArea = normal.length();
    if (doubleArea <= MIN_AREA) {
      faceClusterIds[face] = -1;
      continue;
    }

    normal.multiplyScalar(1 / doubleArea);
    const area = doubleArea * 0.5;
    centroid.copy(a).add(b).add(c).multiplyScalar(1 / 3);
    const d = normal.dot(centroid);

    const azimuth = Math.atan2(normal.z, normal.x);
    const polar = Math.acos(clamp(normal.y, -1, 1));
    const key = `${quantize(azimuth, angleStep)}|${quantize(polar, angleStep)}|${quantize(d, planeStep)}`;

    let clusterId = clusterByKey.get(key);
    if (clusterId === undefined) {
      clusterId = clusters.length;
      clusterByKey.set(key, clusterId);
      clusters.push({
        normal: new THREE.Vector3(),
        d: 0,
        area: 0
      });
    }

    const cluster = clusters[clusterId];
    cluster.normal.addScaledVector(normal, area);
    cluster.d += d * area;
    cluster.area += area;
    faceClusterIds[face] = clusterId;
  }

  for (const cluster of clusters) {
    if (cluster.area <= MIN_AREA) {
      continue;
    }
    cluster.normal.multiplyScalar(1 / cluster.area).normalize();
    cluster.d /= cluster.area;
  }

  return { clusters, faceClusterIds };
}

function detectProtectedVertices(
  positions: Float32Array,
  indices: Uint32Array,
  creaseProtect: number,
  edgeStep: number
): Set<number> {
  const protectedVertices = new Set<number>();
  const faceCount = Math.floor(indices.length / 3);
  if (faceCount === 0) {
    return protectedVertices;
  }

  const creaseAngleDeg = lerp(68, 8, creaseProtect);
  const creaseCos = Math.cos(THREE.MathUtils.degToRad(creaseAngleDeg));

  const faceNormals = new Float32Array(faceCount * 3);
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  const ab = new THREE.Vector3();
  const ac = new THREE.Vector3();
  const normal = new THREE.Vector3();

  for (let face = 0, i = 0; i + 2 < indices.length; i += 3, face += 1) {
    const i0 = indices[i] * 3;
    const i1 = indices[i + 1] * 3;
    const i2 = indices[i + 2] * 3;
    a.set(positions[i0], positions[i0 + 1], positions[i0 + 2]);
    b.set(positions[i1], positions[i1 + 1], positions[i1 + 2]);
    c.set(positions[i2], positions[i2 + 1], positions[i2 + 2]);
    ab.copy(b).sub(a);
    ac.copy(c).sub(a);
    normal.copy(ab).cross(ac);
    const len = normal.length();
    if (len <= MIN_AREA) {
      continue;
    }
    normal.multiplyScalar(1 / len);
    faceNormals[face * 3] = normal.x;
    faceNormals[face * 3 + 1] = normal.y;
    faceNormals[face * 3 + 2] = normal.z;
  }

  const edges = new Map<string, { faces: number[]; vertices: Set<number> }>();
  const addEdge = (face: number, v0: number, v1: number): void => {
    const key = edgeKey(positions, v0, v1, edgeStep);
    let entry = edges.get(key);
    if (!entry) {
      entry = { faces: [], vertices: new Set<number>() };
      edges.set(key, entry);
    }
    entry.faces.push(face);
    entry.vertices.add(v0);
    entry.vertices.add(v1);
  };

  for (let face = 0, i = 0; i + 2 < indices.length; i += 3, face += 1) {
    const v0 = indices[i];
    const v1 = indices[i + 1];
    const v2 = indices[i + 2];
    addEdge(face, v0, v1);
    addEdge(face, v1, v2);
    addEdge(face, v2, v0);
  }

  for (const { faces, vertices } of edges.values()) {
    if (faces.length !== 2) {
      for (const vertexId of vertices) {
        protectedVertices.add(vertexId);
      }
      continue;
    }

    const f0 = faces[0] * 3;
    const f1 = faces[1] * 3;
    const dot =
      faceNormals[f0] * faceNormals[f1] +
      faceNormals[f0 + 1] * faceNormals[f1 + 1] +
      faceNormals[f0 + 2] * faceNormals[f1 + 2];

    if (dot < creaseCos) {
      for (const vertexId of vertices) {
        protectedVertices.add(vertexId);
      }
    }
  }

  return protectedVertices;
}

function buildVertexFaceAdjacency(
  indices: Uint32Array,
  vertexCount: number
): number[][] {
  const adjacency = Array.from({ length: vertexCount }, () => [] as number[]);
  for (let face = 0, i = 0; i + 2 < indices.length; i += 3, face += 1) {
    const v0 = indices[i];
    const v1 = indices[i + 1];
    const v2 = indices[i + 2];
    adjacency[v0].push(face);
    adjacency[v1].push(face);
    adjacency[v2].push(face);
  }
  return adjacency;
}

function buildVertexNeighbors(
  indices: Uint32Array,
  vertexCount: number
): number[][] {
  const neighbors = Array.from({ length: vertexCount }, () => new Set<number>());
  for (let i = 0; i + 2 < indices.length; i += 3) {
    const v0 = indices[i];
    const v1 = indices[i + 1];
    const v2 = indices[i + 2];
    neighbors[v0].add(v1);
    neighbors[v0].add(v2);
    neighbors[v1].add(v0);
    neighbors[v1].add(v2);
    neighbors[v2].add(v0);
    neighbors[v2].add(v1);
  }
  return neighbors.map((entry) => [...entry]);
}

function computeBaseline(
  positions: Float32Array,
  indices: Uint32Array
): Baseline {
  const faceCount = Math.floor(indices.length / 3);
  const normals = new Float32Array(faceCount * 3);
  const areas = new Float32Array(faceCount);

  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  const ab = new THREE.Vector3();
  const ac = new THREE.Vector3();
  const normal = new THREE.Vector3();

  for (let face = 0, i = 0; i + 2 < indices.length; i += 3, face += 1) {
    const i0 = indices[i] * 3;
    const i1 = indices[i + 1] * 3;
    const i2 = indices[i + 2] * 3;
    a.set(positions[i0], positions[i0 + 1], positions[i0 + 2]);
    b.set(positions[i1], positions[i1 + 1], positions[i1 + 2]);
    c.set(positions[i2], positions[i2 + 1], positions[i2 + 2]);
    ab.copy(b).sub(a);
    ac.copy(c).sub(a);
    normal.copy(ab).cross(ac);
    const doubleArea = normal.length();
    const area = doubleArea * 0.5;
    areas[face] = area;

    if (doubleArea > MIN_AREA) {
      normal.multiplyScalar(1 / doubleArea);
      normals[face * 3] = normal.x;
      normals[face * 3 + 1] = normal.y;
      normals[face * 3 + 2] = normal.z;
    }
  }

  return { normals, areas };
}

function isVertexMoveValid(
  vertexId: number,
  candidate: THREE.Vector3,
  positions: Float32Array,
  indices: Uint32Array,
  vertexFaces: number[][],
  baseline: Baseline
): boolean {
  const faces = vertexFaces[vertexId];
  if (!faces || faces.length === 0) {
    return true;
  }

  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  const ab = new THREE.Vector3();
  const ac = new THREE.Vector3();
  const normal = new THREE.Vector3();

  const readVertex = (vertexIndex: number, out: THREE.Vector3): void => {
    if (vertexIndex === vertexId) {
      out.copy(candidate);
      return;
    }
    const base = vertexIndex * 3;
    out.set(positions[base], positions[base + 1], positions[base + 2]);
  };

  for (const face of faces) {
    const i = face * 3;
    const v0 = indices[i];
    const v1 = indices[i + 1];
    const v2 = indices[i + 2];

    readVertex(v0, a);
    readVertex(v1, b);
    readVertex(v2, c);

    ab.copy(b).sub(a);
    ac.copy(c).sub(a);
    normal.copy(ab).cross(ac);
    const doubleArea = normal.length();
    const area = doubleArea * 0.5;

    if (area <= MIN_AREA) {
      return false;
    }

    const baseArea = baseline.areas[face];
    if (baseArea > MIN_AREA && area < baseArea * 0.22) {
      return false;
    }

    const baseNx = baseline.normals[face * 3];
    const baseNy = baseline.normals[face * 3 + 1];
    const baseNz = baseline.normals[face * 3 + 2];
    if (Math.hypot(baseNx, baseNy, baseNz) > 1e-9) {
      normal.multiplyScalar(1 / Math.max(1e-9, doubleArea));
      const dot = normal.x * baseNx + normal.y * baseNy + normal.z * baseNz;
      if (dot < 0.12) {
        return false;
      }
    }
  }

  return true;
}

function applyPlaneAwareMoves(
  positions: Float32Array,
  indices: Uint32Array,
  clusters: Cluster[],
  faceClusterIds: Int32Array,
  protectedVertices: Set<number>,
  options: Required<PlaneAwareSimplifyOptions>
): Float32Array {
  const out = new Float32Array(positions);
  const vertexCount = Math.floor(out.length / 3);
  const vertexFaces = buildVertexFaceAdjacency(indices, vertexCount);
  const neighbors = buildVertexNeighbors(indices, vertexCount);
  const baseline = computeBaseline(positions, indices);

  const mergeNorm = clamp(options.vertexMerge / 0.05, 0, 1);
  const maxMove = Math.max(0.0008, lerp(0.001, 0.028, mergeNorm));
  const snapDistance = Math.max(0.0008, lerp(0.004, 0.14, mergeNorm));

  const vertexClusters = new Map<number, Set<number>>();
  for (let face = 0, i = 0; i + 2 < indices.length; i += 3, face += 1) {
    const clusterId = faceClusterIds[face];
    if (clusterId < 0) {
      continue;
    }
    const v0 = indices[i];
    const v1 = indices[i + 1];
    const v2 = indices[i + 2];

    let set0 = vertexClusters.get(v0);
    if (!set0) {
      set0 = new Set<number>();
      vertexClusters.set(v0, set0);
    }
    set0.add(clusterId);

    let set1 = vertexClusters.get(v1);
    if (!set1) {
      set1 = new Set<number>();
      vertexClusters.set(v1, set1);
    }
    set1.add(clusterId);

    let set2 = vertexClusters.get(v2);
    if (!set2) {
      set2 = new Set<number>();
      vertexClusters.set(v2, set2);
    }
    set2.add(clusterId);
  }

  const current = new THREE.Vector3();
  const projected = new THREE.Vector3();
  const accum = new THREE.Vector3();
  const candidate = new THREE.Vector3();
  const neighborMean = new THREE.Vector3();
  const neighbor = new THREE.Vector3();

  for (const [vertexId, clusterIds] of vertexClusters.entries()) {
    if (protectedVertices.has(vertexId)) {
      continue;
    }

    const base = vertexId * 3;
    current.set(out[base], out[base + 1], out[base + 2]);

    accum.set(0, 0, 0);
    let weight = 0;

    for (const clusterId of clusterIds) {
      const cluster = clusters[clusterId];
      if (!cluster || cluster.area <= MIN_AREA) {
        continue;
      }

      const dist = cluster.normal.dot(current) - cluster.d;
      if (Math.abs(dist) > snapDistance) {
        continue;
      }

      projected.copy(current).addScaledVector(cluster.normal, -dist);
      const w = Math.max(0.0001, Math.sqrt(cluster.area));
      accum.addScaledVector(projected, w);
      weight += w;
    }

    if (weight > 0) {
      accum.multiplyScalar(1 / weight);
      projected.copy(accum).sub(current);
      const len = projected.length();
      if (len > maxMove) {
        projected.multiplyScalar(maxMove / Math.max(1e-9, len));
      }
      candidate.copy(current).add(projected);
      if (
        isVertexMoveValid(
          vertexId,
          candidate,
          out,
          indices,
          vertexFaces,
          baseline
        )
      ) {
        current.copy(candidate);
      }
    }

    const ring = neighbors[vertexId];
    if (ring && ring.length >= 2) {
      neighborMean.set(0, 0, 0);
      let ringCount = 0;
      for (const neighborId of ring) {
        if (protectedVertices.has(neighborId)) {
          continue;
        }
        const nBase = neighborId * 3;
        neighbor.set(out[nBase], out[nBase + 1], out[nBase + 2]);
        neighborMean.add(neighbor);
        ringCount += 1;
      }

      if (ringCount >= 2) {
        neighborMean.multiplyScalar(1 / ringCount);
        projected.copy(neighborMean).sub(current);
        const blend = mergeNorm * 0.46;
        projected.multiplyScalar(blend);
        const len = projected.length();
        const maxMergeMove = Math.max(0.0006, options.vertexMerge * 0.8);
        if (len > maxMergeMove) {
          projected.multiplyScalar(maxMergeMove / Math.max(1e-9, len));
        }
        candidate.copy(current).add(projected);
        if (
          isVertexMoveValid(
            vertexId,
            candidate,
            out,
            indices,
            vertexFaces,
            baseline
          )
        ) {
          current.copy(candidate);
        }
      }
    }

    out[base] = current.x;
    out[base + 1] = current.y;
    out[base + 2] = current.z;
  }

  return out;
}

function buildGeometry(
  positions: Float32Array,
  indices: Uint32Array
): THREE.BufferGeometry {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setIndex(new THREE.Uint32BufferAttribute(indices, 1));
  geometry.computeVertexNormals();
  return geometry;
}

export function simplifyMeshPlaneAware(
  root: THREE.Object3D,
  opts: PlaneAwareSimplifyOptions = {}
): PlaneAwareSimplifyResult {
  const options: Required<PlaneAwareSimplifyOptions> = {
    vertexMerge: clamp(opts.vertexMerge ?? DEFAULT_OPTIONS.vertexMerge, 0.00005, 0.05),
    creaseProtect: clamp(opts.creaseProtect ?? DEFAULT_OPTIONS.creaseProtect, 0, 1),
    planeSensitivity: clamp(opts.planeSensitivity ?? DEFAULT_OPTIONS.planeSensitivity, 0, 1),
    targetFaces: Math.floor(clamp(opts.targetFaces ?? Number.POSITIVE_INFINITY, 4, 500000))
  };

  const raw = collectMesh(root);
  const originalFaces = Math.floor(raw.indices.length / 3);
  if (originalFaces === 0) {
    return {
      geometry: new THREE.BufferGeometry(),
      originalFaces: 0,
      simplifiedFaces: 0,
      boundaryEdges: 0,
      watertight: true,
      clusterCount: 0,
      protectedVertices: 0,
      fallbackUsed: false
    };
  }

  const rawNormals = computeVertexNormals(raw.positions, raw.indices);
  const allowedMergeAngleDeg = lerp(70, 6, options.creaseProtect);
  const normalDotMin = Math.cos(THREE.MathUtils.degToRad(allowedMergeAngleDeg));
  const weldTolerance = options.vertexMerge;

  const welded = weldMesh(
    raw.positions,
    raw.indices,
    rawNormals,
    weldTolerance,
    normalDotMin
  );

  const boundaryStep = Math.max(0.00005, options.vertexMerge * 0.25);
  const sourceBoundaryEdges = countBoundaryEdges(
    welded.positions,
    welded.indices,
    boundaryStep
  );
  const sourceClosed = sourceBoundaryEdges === 0;

  const mergeNorm = clamp(options.vertexMerge / 0.05, 0, 1);
  const autoTargetRatio = clamp(
    0.84 - mergeNorm * 0.52 - options.planeSensitivity * 0.24,
    0.08,
    0.9
  );
  const ratioFromFaceBudget = Number.isFinite(options.targetFaces)
    ? clamp((options.targetFaces * 3) / Math.max(6, welded.indices.length), 0.08, 0.98)
    : 0.98;
  const targetRatio = Math.min(autoTargetRatio, ratioFromFaceBudget);

  const simplifiedIndices = simplifyIndicesWithClosedPreference(
    welded.positions,
    welded.indices,
    targetRatio,
    sourceClosed,
    boundaryStep
  );

  const clustered = clusterFacesByPlane(
    welded.positions,
    simplifiedIndices,
    options.planeSensitivity
  );

  const protectedVertices = detectProtectedVertices(
    welded.positions,
    simplifiedIndices,
    options.creaseProtect,
    boundaryStep
  );

  const movedPositions = applyPlaneAwareMoves(
    welded.positions,
    simplifiedIndices,
    clustered.clusters,
    clustered.faceClusterIds,
    protectedVertices,
    options
  );

  let finalPositions = movedPositions;
  let finalIndices = simplifiedIndices;
  let boundaryEdges = countBoundaryEdges(finalPositions, finalIndices, boundaryStep);
  let fallbackUsed = false;

  if (sourceClosed && boundaryEdges > 0) {
    finalPositions = welded.positions;
    finalIndices = welded.indices;
    boundaryEdges = 0;
    fallbackUsed = true;
  }

  return {
    geometry: buildGeometry(finalPositions, finalIndices),
    originalFaces,
    simplifiedFaces: Math.floor(finalIndices.length / 3),
    boundaryEdges,
    watertight: boundaryEdges === 0,
    clusterCount: clustered.clusters.length,
    protectedVertices: protectedVertices.size,
    fallbackUsed
  };
}

void ensureReady();
