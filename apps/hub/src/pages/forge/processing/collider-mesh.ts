import * as THREE from "three";
import { MeshoptSimplifier } from "meshoptimizer";
import { countTotalFaces } from "./simplify";

export const DEFAULT_COLLIDER_FACE_TARGET = 96;
const MIN_COLLIDER_FACE_TARGET = 24;
const COLLIDER_SIMPLIFY_ERRORS = [0.05, 0.1, 0.2, 0.5, 1];

let simplifierReady: Promise<void> | undefined;

function ensureSimplifierReady(): Promise<void> {
  if (!simplifierReady) {
    simplifierReady = MeshoptSimplifier.ready;
  }
  return simplifierReady;
}

export type ColliderMeshBuildResult = {
  scene: THREE.Group;
  sourceFaces: number;
  targetFaces: number;
  colliderFaces: number;
};

function cloneToGroup(source: THREE.Object3D): THREE.Group {
  const clone = source.clone(true);
  if (clone instanceof THREE.Group) {
    return clone;
  }
  const group = new THREE.Group();
  group.add(clone);
  return group;
}

function compactGeometryForCollider(
  source: THREE.BufferGeometry
): THREE.BufferGeometry | null {
  const position = source.getAttribute("position");
  if (!position) {
    return null;
  }

  const geometry = new THREE.BufferGeometry();
  const index = source.getIndex();
  if (!index) {
    geometry.setAttribute("position", position.clone());
    return geometry;
  }

  const newPositions: number[] = [];
  const weldedToNew = new Map<string, number>();
  const newIndices = new Array<number>(index.count);

  for (let i = 0; i < index.count; i += 1) {
    const oldIndex = index.getX(i);
    const x = position.getX(oldIndex);
    const y = position.getY(oldIndex);
    const z = position.getZ(oldIndex);
    const key = `${x.toFixed(6)}|${y.toFixed(6)}|${z.toFixed(6)}`;
    let mapped = weldedToNew.get(key);
    if (mapped === undefined) {
      mapped = newPositions.length / 3;
      weldedToNew.set(key, mapped);
      newPositions.push(x, y, z);
    }
    newIndices[i] = mapped;
  }

  geometry.setAttribute(
    "position",
    new THREE.Float32BufferAttribute(newPositions, 3)
  );
  const vertexCount = newPositions.length / 3;
  const indexArray =
    vertexCount > 65535
      ? new Uint32Array(newIndices)
      : new Uint16Array(newIndices);
  geometry.setIndex(new THREE.BufferAttribute(indexArray, 1));
  return geometry;
}

function prepareGeometryForCollider(scene: THREE.Object3D): void {
  const material = new THREE.MeshBasicMaterial({ color: 0xffffff });

  scene.traverse((node) => {
    if (!(node instanceof THREE.Mesh)) {
      return;
    }
    if (!(node.geometry instanceof THREE.BufferGeometry)) {
      return;
    }

    const geometry = compactGeometryForCollider(node.geometry);
    if (!geometry) {
      return;
    }
    geometry.computeBoundingBox();
    geometry.computeBoundingSphere();
    node.geometry = geometry;
    node.material = material;
    node.castShadow = false;
    node.receiveShadow = false;
  });
}

async function simplifyGeometryForCollider(
  geometry: THREE.BufferGeometry,
  targetRatio: number
): Promise<THREE.BufferGeometry> {
  await ensureSimplifierReady();

  const position = geometry.getAttribute("position");
  if (!position) {
    return geometry.clone();
  }

  const vertexCount = position.count;
  if (vertexCount < 3) {
    return geometry.clone();
  }

  let indices: Uint32Array;
  if (geometry.index) {
    indices = new Uint32Array(geometry.index.array);
  } else {
    indices = new Uint32Array(vertexCount);
    for (let i = 0; i < vertexCount; i += 1) {
      indices[i] = i;
    }
  }
  if (indices.length < 3) {
    return geometry.clone();
  }

  const positions = new Float32Array(position.array);
  const rawTarget = Math.floor(indices.length * targetRatio);
  const targetCount = Math.max(3, rawTarget - (rawTarget % 3));
  if (targetCount >= indices.length) {
    return geometry.clone();
  }

  let simplifiedIndices: Uint32Array | null = null;
  for (const error of COLLIDER_SIMPLIFY_ERRORS) {
    try {
      const [result] = MeshoptSimplifier.simplify(
        indices,
        positions,
        3,
        targetCount,
        error
      );
      simplifiedIndices = new Uint32Array(result);
      if (simplifiedIndices.length <= targetCount) {
        break;
      }
    } catch {
      // Try a looser error tolerance before falling back.
    }
  }
  if (!simplifiedIndices) {
    return geometry.clone();
  }

  const simplified = geometry.clone();
  simplified.setIndex(new THREE.BufferAttribute(simplifiedIndices, 1));
  return simplified;
}

export async function buildSimplifiedColliderScene(
  sourceModel: THREE.Object3D,
  faceTarget = DEFAULT_COLLIDER_FACE_TARGET
): Promise<ColliderMeshBuildResult> {
  const sourceScene = cloneToGroup(sourceModel);
  const sourceFaces = Math.max(0, Math.round(countTotalFaces(sourceScene)));
  const targetFaces =
    sourceFaces <= 0
      ? 0
      : Math.min(
          sourceFaces,
          Math.max(MIN_COLLIDER_FACE_TARGET, Math.round(faceTarget))
        );
  const ratio =
    sourceFaces > 0 ? Math.min(1, Math.max(0, targetFaces / sourceFaces)) : 1;

  let colliderScene = sourceScene;
  if (sourceFaces > 0 && ratio < 0.999) {
    await ensureSimplifierReady();
    const jobs: Promise<void>[] = [];
    colliderScene.traverse((node) => {
      if (!(node instanceof THREE.Mesh)) {
        return;
      }
      if (!(node.geometry instanceof THREE.BufferGeometry)) {
        return;
      }
      jobs.push(
        simplifyGeometryForCollider(node.geometry, ratio).then((simplified) => {
          node.geometry = simplified;
        })
      );
    });
    await Promise.all(jobs);
  }

  prepareGeometryForCollider(colliderScene);

  return {
    scene: colliderScene,
    sourceFaces,
    targetFaces,
    colliderFaces: Math.max(0, Math.round(countTotalFaces(colliderScene)))
  };
}
