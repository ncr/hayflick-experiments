/**
 * Remap a mesh's old UVs into the recomposed-atlas UV space.
 *
 * Per vertex: look up its island (or pass through unchanged if the vertex
 * is unused), apply the affine `(u, v) → ((scaleU*(u-bboxU0)+offsetX)/W,
 * (scaleV*(v-bboxV0)+offsetY)/H)`, and store. Output buffer length matches
 * input. glTF UV convention: (0, 0) at top-left of the texture image —
 * we preserve original orientation, no v flip.
 *
 * Pure data manipulation — no DOM, no THREE.
 */

import type { UvRemapEntry } from "./repack";

export function remapUvs(
  oldUv: Float32Array,
  vertexToIslandId: number[],
  uvRemap: UvRemapEntry[],
  templateWidth: number,
  templateHeight: number
): Float32Array {
  const out = new Float32Array(oldUv.length);
  for (let v = 0; v < vertexToIslandId.length; v++) {
    const id = vertexToIslandId[v];
    if (id < 0) {
      out[v * 2] = oldUv[v * 2];
      out[v * 2 + 1] = oldUv[v * 2 + 1];
      continue;
    }
    const remap = uvRemap[id];
    const uOld = oldUv[v * 2];
    const vOld = oldUv[v * 2 + 1];
    const uPx = remap.scaleU * (uOld - remap.bboxU0) + remap.offsetX;
    const vPx = remap.scaleV * (vOld - remap.bboxV0) + remap.offsetY;
    out[v * 2] = uPx / templateWidth;
    out[v * 2 + 1] = vPx / templateHeight;
  }
  return out;
}
