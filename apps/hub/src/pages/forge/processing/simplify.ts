import * as THREE from "three";
import { MeshoptSimplifier } from "meshoptimizer";

let simplifierReady: Promise<void> | undefined;

function ensureReady(): Promise<void> {
  if (!simplifierReady) {
    simplifierReady = MeshoptSimplifier.ready;
  }
  return simplifierReady;
}

export async function simplifyGeometry(
  geometry: THREE.BufferGeometry,
  targetRatio: number
): Promise<THREE.BufferGeometry> {
  await ensureReady();

  const posAttr = geometry.getAttribute("position");
  if (!posAttr) throw new Error("No position attribute");

  const positions = new Float32Array(posAttr.array);
  const vertexCount = posAttr.count;

  let indices: Uint32Array;
  if (geometry.index) {
    indices = new Uint32Array(geometry.index.array);
  } else {
    indices = new Uint32Array(vertexCount);
    for (let i = 0; i < vertexCount; i++) indices[i] = i;
  }

  // targetCount must be a multiple of 3 (triangles) and at least 3
  const rawTarget = Math.floor(indices.length * targetRatio);
  const targetCount = Math.max(3, rawTarget - (rawTarget % 3));

  // Guard against degenerate geometry
  if (indices.length < 3 || vertexCount < 3) {
    return geometry.clone();
  }

  let newIndices: Uint32Array;
  try {
    const [result] = MeshoptSimplifier.simplify(
      indices,
      positions,
      3,
      targetCount,
      0.01
    );
    newIndices = new Uint32Array(result);
  } catch {
    // Simplifier can fail on degenerate geometry — return original
    return geometry.clone();
  }

  // Build simplified geometry
  const simplified = geometry.clone();
  simplified.setIndex(new THREE.BufferAttribute(newIndices, 1));

  return simplified;
}

export function countFaces(geometry: THREE.BufferGeometry): number {
  if (geometry.index) {
    return geometry.index.count / 3;
  }
  const pos = geometry.getAttribute("position");
  return pos ? pos.count / 3 : 0;
}

export function countTotalFaces(object: THREE.Object3D): number {
  let total = 0;
  object.traverse((child) => {
    if (child instanceof THREE.Mesh && child.geometry) {
      total += countFaces(child.geometry);
    }
  });
  return total;
}

export async function simplifyMesh(
  mesh: THREE.Mesh,
  targetRatio: number
): Promise<THREE.Mesh> {
  const simplified = await simplifyGeometry(mesh.geometry, targetRatio);
  const newMesh = mesh.clone();
  newMesh.geometry = simplified;
  return newMesh;
}

export async function simplifyScene(
  scene: THREE.Group,
  targetRatio: number
): Promise<THREE.Group> {
  await ensureReady();
  const clone = scene.clone(true);

  const promises: Promise<void>[] = [];
  clone.traverse((child) => {
    if (child instanceof THREE.Mesh && child.geometry) {
      promises.push(
        simplifyGeometry(child.geometry, targetRatio).then((g) => {
          child.geometry = g;
        })
      );
    }
  });

  await Promise.all(promises);
  return clone;
}
