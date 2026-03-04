import * as THREE from "three";
import { ConvexGeometry } from "three/examples/jsm/geometries/ConvexGeometry.js";
import type { BBox } from "./dimensions";

export type ColliderType =
  | "box"
  | "pill"
  | "capsule"
  | "sphere"
  | "cylinder"
  | "convex-hull"
  | "compound-boxes"
  | "compound-convex-hulls";

export type CompoundBoxPart = {
  position: [number, number, number];
  halfExtents: [number, number, number];
};

export interface ColliderParams {
  type: ColliderType;
  position: [number, number, number];
  params: Record<string, unknown>;
}

type ColliderAxis = "x" | "y" | "z";

function asNumber(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function asTuple3(value: unknown): [number, number, number] | null {
  if (!Array.isArray(value) || value.length !== 3) {
    return null;
  }
  const x = asNumber(value[0], Number.NaN);
  const y = asNumber(value[1], Number.NaN);
  const z = asNumber(value[2], Number.NaN);
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
    return null;
  }
  return [x, y, z];
}

function asColliderAxis(value: unknown, fallback: ColliderAxis = "y"): ColliderAxis {
  return value === "x" || value === "y" || value === "z" ? value : fallback;
}

function choosePrimaryAxis(sx: number, sy: number, sz: number): ColliderAxis {
  if (sx >= sy && sx >= sz) {
    return "x";
  }
  if (sy >= sz) {
    return "y";
  }
  return "z";
}

function axisDimensions(
  sx: number,
  sy: number,
  sz: number,
  axis: ColliderAxis
): { major: number; radialA: number; radialB: number } {
  if (axis === "x") {
    return {
      major: sx * 0.5,
      radialA: sy * 0.5,
      radialB: sz * 0.5
    };
  }
  if (axis === "z") {
    return {
      major: sz * 0.5,
      radialA: sx * 0.5,
      radialB: sy * 0.5
    };
  }
  return {
    major: sy * 0.5,
    radialA: sx * 0.5,
    radialB: sz * 0.5
  };
}

function applyAxisRotation(object: THREE.Object3D, axis: ColliderAxis): void {
  if (axis === "x") {
    object.rotation.z = -Math.PI * 0.5;
    return;
  }
  if (axis === "z") {
    object.rotation.x = Math.PI * 0.5;
  }
}

export function autoFitCollider(
  type: ColliderType,
  bbox: BBox,
  scale = 1
): ColliderParams {
  const sx = Math.max(0, bbox.width) * Math.max(0, scale);
  const sy = Math.max(0, bbox.height) * Math.max(0, scale);
  const sz = Math.max(0, bbox.depth) * Math.max(0, scale);
  const cx = bbox.center.x;
  const cy = bbox.center.y;
  const cz = bbox.center.z;

  switch (type) {
    case "box":
      return {
        type: "box",
        position: [cx, cy, cz],
        params: {
          halfWidth: sx * 0.5,
          halfHeight: sy * 0.5,
          halfDepth: sz * 0.5
        }
      };
    case "pill":
    case "capsule": {
      const axis = choosePrimaryAxis(sx, sy, sz);
      const dims = axisDimensions(sx, sy, sz, axis);
      const radius = Math.sqrt(
        dims.radialA * dims.radialA + dims.radialB * dims.radialB
      );
      const halfHeight = Math.max(0, dims.major - radius);
      return {
        type: type === "capsule" ? "capsule" : "pill",
        position: [cx, cy, cz],
        params: { axis, halfHeight, radius }
      };
    }
    case "sphere": {
      const radius = Math.sqrt(sx * sx + sy * sy + sz * sz) * 0.5;
      return {
        type: "sphere",
        position: [cx, cy, cz],
        params: { radius }
      };
    }
    case "cylinder": {
      const axis = choosePrimaryAxis(sx, sy, sz);
      const dims = axisDimensions(sx, sy, sz, axis);
      const radius = Math.sqrt(
        dims.radialA * dims.radialA + dims.radialB * dims.radialB
      );
      return {
        type: "cylinder",
        position: [cx, cy, cz],
        params: { axis, halfHeight: dims.major, radius }
      };
    }
    case "convex-hull":
      return {
        type: "convex-hull",
        position: [0, 0, 0],
        params: {}
      };
    case "compound-boxes":
      return {
        type: "compound-boxes",
        position: [0, 0, 0],
        params: { parts: [] }
      };
    case "compound-convex-hulls":
      return {
        type: "compound-convex-hulls",
        position: [0, 0, 0],
        params: { parts: [] }
      };
  }
}

function buildConvexHullHelper(collider: ColliderParams): THREE.Object3D {
  const rawPoints = collider.params.points;
  const pointsArray = Array.isArray(rawPoints) ? rawPoints : [];
  const points = pointsArray
    .map((point) => asTuple3(point))
    .filter((point): point is [number, number, number] => point !== null)
    .map(([x, y, z]) => new THREE.Vector3(x, y, z));

  const rootOffset = asTuple3(collider.params.rootOffset) ?? [0, 0, 0];
  const center = new THREE.Vector3(-rootOffset[0], -rootOffset[1], -rootOffset[2]);

  const group = new THREE.Group();
  group.position.copy(center);
  group.name = "collider-helper";

  if (points.length < 4) {
    return group;
  }

  const geometry = new ConvexGeometry(points);
  const material = new THREE.MeshBasicMaterial({
    color: 0x44aaff,
    wireframe: true,
    transparent: true,
    opacity: 0.4
  });
  const mesh = new THREE.Mesh(geometry, material);
  group.add(mesh);
  return group;
}

function buildCompoundBoxesHelper(collider: ColliderParams): THREE.Object3D {
  const rawParts = collider.params.parts;
  const parts = Array.isArray(rawParts) ? rawParts : [];
  const group = new THREE.Group();
  group.name = "collider-helper";

  for (const part of parts) {
    if (typeof part !== "object" || part === null) {
      continue;
    }
    const record = part as Record<string, unknown>;
    const position = asTuple3(record.position);
    const halfExtents = asTuple3(record.halfExtents);
    if (!position || !halfExtents) {
      continue;
    }

    const geometry = new THREE.BoxGeometry(
      Math.max(halfExtents[0], 0.0001) * 2,
      Math.max(halfExtents[1], 0.0001) * 2,
      Math.max(halfExtents[2], 0.0001) * 2
    );
    const material = new THREE.MeshBasicMaterial({
      color: 0x44aaff,
      wireframe: true,
      transparent: true,
      opacity: 0.4
    });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.set(position[0], position[1], position[2]);
    group.add(mesh);
  }

  return group;
}

function buildCompoundConvexHullsHelper(collider: ColliderParams): THREE.Object3D {
  const rawParts = collider.params.parts;
  const parts = Array.isArray(rawParts) ? rawParts : [];
  const group = new THREE.Group();
  group.name = "collider-helper";

  const colorForIndex = (index: number): THREE.Color => {
    const hue = ((index * 137.508) % 360) / 360;
    return new THREE.Color().setHSL(hue, 0.68, 0.56);
  };

  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index];
    const partRecord = typeof part === "object" && part !== null ? (part as Record<string, unknown>) : null;
    if (!partRecord) {
      continue;
    }
    const position = asTuple3(partRecord.position);
    const pointsRaw = Array.isArray(partRecord.points) ? partRecord.points : [];
    if (!position || pointsRaw.length < 4) {
      continue;
    }

    const points = pointsRaw
      .map((value) => asTuple3(value))
      .filter((value): value is [number, number, number] => value !== null)
      .map(([x, y, z]) => new THREE.Vector3(x, y, z));

    if (points.length < 4) {
      continue;
    }

    const geometry = new ConvexGeometry(points);
    const material = new THREE.MeshStandardMaterial({
      color: colorForIndex(index),
      roughness: 0.58,
      metalness: 0.06,
      transparent: true,
      opacity: 0.48,
      side: THREE.DoubleSide,
      depthWrite: false
    });
    const mesh = new THREE.Mesh(geometry, material);

    const edgeGeometry = new THREE.EdgesGeometry(geometry, 25);
    const edgeMaterial = new THREE.LineBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0.65
    });
    const edges = new THREE.LineSegments(edgeGeometry, edgeMaterial);

    const partGroup = new THREE.Group();
    partGroup.position.set(position[0], position[1], position[2]);
    partGroup.add(mesh, edges);
    group.add(partGroup);
  }

  return group;
}

/**
 * Uniformly scale all positions and extents in a ColliderParams by `ratio`.
 * Used to keep colliders in sync when the mesh scale changes without
 * running a full VHACD regeneration.
 */
export function scaleColliderParams(collider: ColliderParams, ratio: number): ColliderParams {
  const sp = (v: [number, number, number]): [number, number, number] => [
    v[0] * ratio, v[1] * ratio, v[2] * ratio,
  ];

  const scaledPosition = sp(collider.position);

  if (collider.type === "compound-convex-hulls") {
    const parts = (Array.isArray(collider.params.parts) ? collider.params.parts : []) as {
      position: [number, number, number];
      points: [number, number, number][];
    }[];
    return {
      ...collider,
      position: scaledPosition,
      params: {
        ...collider.params,
        parts: parts.map((part) => ({
          ...part,
          position: sp(part.position),
          points: (part.points ?? []).map(sp),
        })),
      },
    };
  }

  if (collider.type === "box") {
    return {
      ...collider,
      position: scaledPosition,
      params: {
        ...collider.params,
        halfWidth: asNumber(collider.params.halfWidth) * ratio,
        halfHeight: asNumber(collider.params.halfHeight) * ratio,
        halfDepth: asNumber(collider.params.halfDepth) * ratio,
      },
    };
  }

  if (collider.type === "compound-boxes") {
    const parts = (Array.isArray(collider.params.parts) ? collider.params.parts : []) as CompoundBoxPart[];
    return {
      ...collider,
      position: scaledPosition,
      params: {
        ...collider.params,
        parts: parts.map((part) => ({
          ...part,
          position: sp(part.position),
          halfExtents: sp(part.halfExtents),
        })),
      },
    };
  }

  // sphere, cylinder, capsule, pill, convex-hull — scale radius/height/extents
  return {
    ...collider,
    position: scaledPosition,
    params: Object.fromEntries(
      Object.entries(collider.params).map(([k, v]) =>
        typeof v === "number" ? [k, v * ratio] : [k, v]
      )
    ),
  };
}

export function createColliderHelper(collider: ColliderParams): THREE.Object3D {
  const material = new THREE.MeshBasicMaterial({
    color: 0x44aaff,
    wireframe: true,
    transparent: true,
    opacity: 0.4
  });

  let geometry: THREE.BufferGeometry | null = null;

  switch (collider.type) {
    case "box":
      geometry = new THREE.BoxGeometry(
        asNumber(collider.params.halfWidth) * 2,
        asNumber(collider.params.halfHeight) * 2,
        asNumber(collider.params.halfDepth) * 2
      );
      break;
    case "pill":
    case "capsule":
      geometry = new THREE.CapsuleGeometry(
        asNumber(collider.params.radius),
        asNumber(collider.params.halfHeight) * 2,
        8,
        16
      );
      break;
    case "sphere":
      geometry = new THREE.SphereGeometry(asNumber(collider.params.radius), 16, 12);
      break;
    case "cylinder":
      geometry = new THREE.CylinderGeometry(
        asNumber(collider.params.radius),
        asNumber(collider.params.radius),
        asNumber(collider.params.halfHeight) * 2,
        16
      );
      break;
    case "convex-hull":
      return buildConvexHullHelper(collider);
    case "compound-boxes":
      return buildCompoundBoxesHelper(collider);
    case "compound-convex-hulls":
      return buildCompoundConvexHullsHelper(collider);
  }

  const mesh = new THREE.Mesh(
    geometry ?? new THREE.BufferGeometry(),
    material
  );
  if (collider.type === "pill" || collider.type === "capsule" || collider.type === "cylinder") {
    applyAxisRotation(mesh, asColliderAxis(collider.params.axis, "y"));
  }
  mesh.position.set(collider.position[0], collider.position[1], collider.position[2]);
  mesh.name = "collider-helper";
  return mesh;
}
