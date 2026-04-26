/**
 * Detect UV islands in a triangle mesh by union-find on vertex indices.
 *
 * Two vertices belong to the same island iff a triangle in the mesh
 * touches both. The output groups vertices into connected components
 * and reports each island's UV bounding box.
 *
 * Pure data manipulation — no DOM, no THREE.
 */

export type IslandBboxUv = {
  u0: number;
  v0: number;
  u1: number;
  v1: number;
};

export type DetectedIsland = {
  bboxUv: IslandBboxUv;
  triangleIndices: number[];
  vertexIndices: number[];
};

export type DetectedIslands = {
  islands: DetectedIsland[];
  /** vertexToIslandId[v] = islandIdx, or -1 if vertex is unused by any triangle. */
  vertexToIslandId: number[];
};

export function detectIslands(
  indices: Uint32Array | Uint16Array | number[],
  uv: Float32Array
): DetectedIslands {
  const vertexCount = uv.length / 2;
  const parent = new Int32Array(vertexCount);
  const rank = new Uint8Array(vertexCount);
  for (let i = 0; i < vertexCount; i++) parent[i] = i;

  const find = (x: number): number => {
    let r = x;
    while (parent[r] !== r) r = parent[r];
    let cur = x;
    while (parent[cur] !== r) {
      const next = parent[cur];
      parent[cur] = r;
      cur = next;
    }
    return r;
  };
  const union = (a: number, b: number) => {
    const ra = find(a);
    const rb = find(b);
    if (ra === rb) return;
    if (rank[ra] < rank[rb]) parent[ra] = rb;
    else if (rank[ra] > rank[rb]) parent[rb] = ra;
    else {
      parent[rb] = ra;
      rank[ra] = rank[ra] + 1;
    }
  };

  const triCount = Math.floor(indices.length / 3);
  for (let t = 0; t < triCount; t++) {
    const i0 = indices[t * 3];
    const i1 = indices[t * 3 + 1];
    const i2 = indices[t * 3 + 2];
    union(i0, i1);
    union(i0, i2);
  }

  const usedVertex = new Uint8Array(vertexCount);
  for (let t = 0; t < triCount; t++) {
    usedVertex[indices[t * 3]] = 1;
    usedVertex[indices[t * 3 + 1]] = 1;
    usedVertex[indices[t * 3 + 2]] = 1;
  }

  const rootToIslandId = new Map<number, number>();
  const islands: DetectedIsland[] = [];
  const vertexToIslandId = new Array<number>(vertexCount).fill(-1);

  for (let v = 0; v < vertexCount; v++) {
    if (!usedVertex[v]) continue;
    const r = find(v);
    let id = rootToIslandId.get(r);
    if (id === undefined) {
      id = islands.length;
      rootToIslandId.set(r, id);
      islands.push({
        bboxUv: { u0: Infinity, v0: Infinity, u1: -Infinity, v1: -Infinity },
        triangleIndices: [],
        vertexIndices: []
      });
    }
    vertexToIslandId[v] = id;
    const isl = islands[id];
    isl.vertexIndices.push(v);
    const u = uv[v * 2];
    const vCoord = uv[v * 2 + 1];
    if (u < isl.bboxUv.u0) isl.bboxUv.u0 = u;
    if (vCoord < isl.bboxUv.v0) isl.bboxUv.v0 = vCoord;
    if (u > isl.bboxUv.u1) isl.bboxUv.u1 = u;
    if (vCoord > isl.bboxUv.v1) isl.bboxUv.v1 = vCoord;
  }

  for (let t = 0; t < triCount; t++) {
    const id = vertexToIslandId[indices[t * 3]];
    if (id < 0) continue;
    islands[id].triangleIndices.push(t);
  }

  return { islands, vertexToIslandId };
}
